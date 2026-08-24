// SecureChat 双棘轮实现 - 对齐默信/BatChat 内容加密体系
//
// 设计参考 Signal Double Ratchet，分两层：
//   1) DH 棘轮：消息方向反转时生成新 ECDH 对，与对方的当前 DH 公钥计算 rootKey
//   2) 对称棘轮（KDF chain）：每条消息派生新 chainKey → messageKey，保证按序前向保密
//
// 密文封包格式（base64）：
//   version(1B=0x02) | dhPub(91B SPKI) | pn(uint32 BE) | ns(uint32 BE) | iv(12B) | ct+tag
// 远端收到后按 (dhPub, pn, ns) 定位 ratchet 状态并解密。

import 'dart:convert';
import 'dart:typed_data';

import 'package:pointycastle/export.dart';

// ============================================================
// 工具
// ============================================================

import 'dart:math';

SecureRandom _secureRandom() {
  final sr = FortunaRandom();
  final os = Random.secure();
  final b = Uint8List(32);
  for (var i = 0; i < b.length; i++) {
    b[i] = os.nextInt(256);
  }
  sr.seed(KeyParameter(b));
  return sr;
}

final SecureRandom _rng = _secureRandom();

Uint8List _randomBytes(int n) {
  final b = Uint8List(n);
  for (var i = 0; i < n; i++) {
    b[i] = _rng.nextUint8();
  }
  return b;
}

// HKDF-SHA256
Uint8List _hkdf(Uint8List ikm, Uint8List salt, Uint8List info, int len) {
  final kdf = HKDFKeyDerivator(SHA256Digest())
    ..init(HkdfParameters(ikm, len, salt.isEmpty ? null : salt, info));
  final out = Uint8List(len);
  kdf.deriveKey(ikm, 0, out, 0);
  return out;
}

// AES-256-GCM 加密（12B iv，16B tag）
class _GcmOut {
  final Uint8List iv;
  final Uint8List ctWithTag;
  _GcmOut(this.iv, this.ctWithTag);
}

_GcmOut _aesGcmEncrypt(
  Uint8List key,
  Uint8List plain,
  Uint8List iv, [
  Uint8List? aad,
]) {
  final cipher = GCMBlockCipher(AESEngine())
    ..init(
      true,
      AEADParameters(KeyParameter(key), 128, iv, aad ?? Uint8List(0)),
    );
  final out = cipher.process(plain); // 返回已含 16 字节 tag
  return _GcmOut(iv, out);
}

Uint8List _aesGcmDecrypt(
  Uint8List key,
  Uint8List iv,
  Uint8List ctWithTag, [
  Uint8List? aad,
]) {
  final cipher = GCMBlockCipher(AESEngine())
    ..init(
      false,
      AEADParameters(KeyParameter(key), 128, iv, aad ?? Uint8List(0)),
    );
  return cipher.process(ctWithTag);
}

// ============================================================
// ECDH P-256 密钥对
// ============================================================

class EcKeyPair {
  final ECPrivateKey priv;
  final ECPublicKey pub;
  EcKeyPair(this.priv, this.pub);
}

final _domain = ECDomainParameters('prime256v1');
final ECDomainParameters secureDomain = _domain;

EcKeyPair genEcKeyPair() {
  final gen = ECKeyGenerator()
    ..init(ParametersWithRandom(ECKeyGeneratorParameters(_domain), _rng));
  final pair = gen.generateKeyPair();
  return EcKeyPair(pair.privateKey, pair.publicKey);
}

// SPKI 头（固定的 prime256v1 OID + uncompressed point）
// 0x30 0x59 0x30 0x13 06 07 2A 86 48 CE 3D 02 01 06 08 2A 86 48 CE 3D 03 01 07 03 42 00 [65 bytes point]
final _spkiHead = Uint8List.fromList([
  0x30,
  0x59,
  0x30,
  0x13,
  0x06,
  0x07,
  0x2a,
  0x86,
  0x48,
  0xce,
  0x3d,
  0x02,
  0x01,
  0x06,
  0x08,
  0x2a,
  0x86,
  0x48,
  0xce,
  0x3d,
  0x03,
  0x01,
  0x07,
  0x03,
  0x42,
  0x00,
]);

Uint8List _pubToSpki(ECPublicKey pub) {
  final unc = pub.Q!.getEncoded(false);
  final out = Uint8List(_spkiHead.length + unc.length);
  out.setRange(0, _spkiHead.length, _spkiHead);
  out.setRange(_spkiHead.length, out.length, unc);
  return out;
}

void _hexToBytes(String hex, Uint8List dst, int offset) {
  for (var i = 0; i < hex.length; i += 2) {
    dst[offset + i ~/ 2] = int.parse(hex.substring(i, i + 2), radix: 16);
  }
}

ECPublicKey _spkiToPub(Uint8List spki) {
  final unc = spki.sublist(26);
  if (unc.length != 65 || unc[0] != 0x04) throw FormatException('bad SPKI');
  final point = _domain.curve.decodePoint(unc);
  return ECPublicKey(point, _domain);
}

String _b64(Uint8List b) => base64.encode(b);
Uint8List _db64(String s) => base64.decode(s);

String pubToBase64(ECPublicKey pub) => _b64(_pubToSpki(pub));
ECPublicKey base64ToPub(String b64) => _spkiToPub(_db64(b64));

Uint8List _ecdh(ECPrivateKey priv, ECPublicKey peerPub) {
  final ec = ECDHBasicAgreement()..init(priv);
  final z = ec.calculateAgreement(peerPub);
  final hex = z.toRadixString(16).padLeft(64, '0');
  final out = Uint8List(32);
  _hexToBytes(hex, out, 0);
  return out;
}

// ============================================================
// 双棘轮状态
// ============================================================

class RatchetState {
  Uint8List rootKey;
  EcKeyPair? dhSelf; // 我方当前 DH 密钥对
  ECPublicKey? dhRemote; // 对方当前 DH 公钥
  Uint8List? sendChainKey;
  Uint8List? recvChainKey;
  int sendN = 0;
  int recvN = 0;
  int pn = 0;

  RatchetState(this.rootKey);

  Map<String, dynamic> toJson() => {
    'rk': _b64(rootKey),
    'dhS_priv_d': dhSelf == null
        ? null
        : (dhSelf!.priv.d as BigInt).toRadixString(16).padLeft(64, '0'),
    'dhS_pub': dhSelf == null ? null : _b64(_pubToSpki(dhSelf!.pub)),
    'dhR': dhRemote == null ? null : _b64(_pubToSpki(dhRemote!)),
    'ckS': sendChainKey == null ? null : _b64(sendChainKey!),
    'ckR': recvChainKey == null ? null : _b64(recvChainKey!),
    'nS': sendN,
    'nR': recvN,
    'pn': pn,
  };

  factory RatchetState.fromJson(Map<String, dynamic> j) {
    final s = RatchetState(_db64(j['rk'] as String));
    if (j['dhS_priv_d'] != null && j['dhS_pub'] != null) {
      final privHex = j['dhS_priv_d'] as String;
      final d = BigInt.parse(privHex, radix: 16);
      final priv = ECPrivateKey(d, _domain);
      final pub = _spkiToPub(_db64(j['dhS_pub'] as String));
      s.dhSelf = EcKeyPair(priv, pub);
    }
    if (j['dhR'] != null) s.dhRemote = _spkiToPub(_db64(j['dhR'] as String));
    if (j['ckS'] != null) s.sendChainKey = _db64(j['ckS'] as String);
    if (j['ckR'] != null) s.recvChainKey = _db64(j['ckR'] as String);
    s.sendN = j['nS'] as int? ?? 0;
    s.recvN = j['nR'] as int? ?? 0;
    s.pn = j['pn'] as int? ?? 0;
    return s;
  }
}

// HKDF 派生 DH 棘轮一步：rootKey + dhOut → (newRoot, chainKey)
List<Uint8List> _kdfRk(Uint8List rootKey, Uint8List dhOut) {
  final out = _hkdf(dhOut, rootKey, Uint8List.fromList([0x01]), 64);
  return [
    Uint8List.sublistView(out, 0, 32),
    Uint8List.sublistView(out, 32, 64),
  ];
}

// 对称棘轮：chainKey → (newChainKey, messageKey)
List<Uint8List> _kdfChain(Uint8List chainKey) {
  final mk = _hkdf(chainKey, Uint8List(0), Uint8List.fromList([0x01]), 32);
  final newCk = _hkdf(chainKey, Uint8List(0), Uint8List.fromList([0x02]), 32);
  return [newCk, mk];
}

// ============================================================
// 初始化
// ============================================================

// 发起方 A：用 sk 作 rootKey，使用身份密钥对作为 DH 密钥对（identity-only 模式）
// 与 web 端 e2ee.js initAsSender 对齐，确保双方能互解互发。
RatchetState initAsSender(Uint8List sk, ECPublicKey remoteIdentityPub) {
  final dh = genEcKeyPair();
  // 首次 DH-step：用 A 的新 dh 私钥与 B 的身份公钥做 ECDH
  final dhOut = _ecdh(dh.priv, remoteIdentityPub);
  final parts = _kdfRk(sk, dhOut);
  return RatchetState(parts[0])
    ..dhSelf = dh
    ..dhRemote = remoteIdentityPub
    ..sendChainKey = parts[1];
}

// identity-only 发送者初始化：使用身份密钥对作为 dhSelf，与 web 端对齐。
RatchetState initAsSenderIdentity(
  Uint8List sk,
  EcKeyPair identity,
  ECPublicKey remoteIdentityPub,
) {
  final dhOut = _ecdh(identity.priv, remoteIdentityPub);
  final parts = _kdfRk(sk, dhOut);
  return RatchetState(parts[0])
    ..dhSelf = identity
    ..dhRemote = remoteIdentityPub
    ..sendChainKey = parts[1];
}

// 接收方 B：sk + 自己的身份私钥（用来跟对方首条消息里的 dhPub 做 ECDH）
RatchetState initAsReceiver(Uint8List sk, EcKeyPair identity) {
  return RatchetState(sk)..dhSelf = identity;
}

// ============================================================
// 加密 → 密文封包（base64）
// ============================================================

String encryptMessage(RatchetState state, String plain) {
  if (state.dhRemote == null) throw StateError('RatchetState.dhRemote 为空');
  if (state.sendChainKey == null) {
    // 需要 DH-step（接收方收到首轮后会进入这里）
    state.pn = state.sendN;
    final dh = genEcKeyPair();
    final dhOut = _ecdh(dh.priv, state.dhRemote!);
    final parts = _kdfRk(state.rootKey, dhOut);
    state.rootKey = parts[0];
    state.sendChainKey = parts[1];
    state.dhSelf = dh;
    state.sendN = 0;
  }
  final kdfOut = _kdfChain(state.sendChainKey!);
  state.sendChainKey = kdfOut[0];
  final messageKey = kdfOut[1];
  final n = state.sendN;
  state.sendN = n + 1;
  final iv = _randomBytes(12);
  final plainBytes = Uint8List.fromList(utf8.encode(plain));
  final enc = _aesGcmEncrypt(messageKey, plainBytes, iv);
  final dhPubSpki = _pubToSpki(state.dhSelf!.pub);
  final pkt = BytesBuilder();
  pkt.addByte(0x02);
  pkt.add(dhPubSpki);
  pkt.add(_uint32BE(state.pn));
  pkt.add(_uint32BE(n));
  pkt.add(iv);
  pkt.add(enc.ctWithTag);
  return _b64(pkt.toBytes());
}

Uint8List _uint32BE(int v) => Uint8List.fromList([
  (v >> 24) & 0xff,
  (v >> 16) & 0xff,
  (v >> 8) & 0xff,
  v & 0xff,
]);
int _readUint32BE(Uint8List b, int off) =>
    (b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3];

// ============================================================
// 解密 ← 密文封包
// ============================================================

String decryptMessage(RatchetState state, String b64) {
  final pkt = _db64(b64);
  if (pkt.length < 1 + 91 + 4 + 4 + 12 + 16) throw FormatException('封包过短');
  if (pkt[0] != 0x02) throw FormatException('版本不符');
  final dhPubSpki = Uint8List.sublistView(pkt, 1, 92);
  final pn = _readUint32BE(pkt, 92);
  final n = _readUint32BE(pkt, 96);
  final iv = Uint8List.sublistView(pkt, 100, 112);
  final ctWithTag = Uint8List.sublistView(pkt, 112);
  final dhPub = _spkiToPub(dhPubSpki);
  // DH-step 判断
  final sameRemote =
      state.dhRemote != null &&
      _bytesEqual(_pubToSpki(dhPub), _pubToSpki(state.dhRemote!));
  if (!sameRemote) {
    // 简化：不维护 skipped-key；假设消息严格按序到达
    // 用当前 dhSelf 的私钥跟新的 dhPub 做 ECDH（接收方首次 dhSelf = 身份密钥对）
    if (state.dhSelf == null) throw StateError('无身份私钥，无法完成 DH-step');
    final dhOut = _ecdh(state.dhSelf!.priv, dhPub);
    final parts = _kdfRk(state.rootKey, dhOut);
    final newRoot = parts[0];
    final newRecvChain = parts[1];
    if (n < 0) throw StateError('消息序号无效');
    var chainKey = newRecvChain;
    var recvIdx = 0;
    if (n - recvIdx > 1000) throw StateError('消息序号跳跃过大');
    while (recvIdx < n) {
      final k = _kdfChain(chainKey);
      chainKey = k[0];
      recvIdx++;
    }
    final k = _kdfChain(chainKey);
    final messageKey = k[1];
    final plain = _aesGcmDecrypt(messageKey, iv, ctWithTag);
    state.dhRemote = dhPub;
    state.pn = pn;
    state.recvN = recvIdx + 1;
    state.sendN = 0;
    state.rootKey = newRoot;
    state.recvChainKey = k[0];
    state.sendChainKey = null; // 下次我发送时会用新 dh 做 DH-step
    return utf8.decode(plain);
  }
  if (state.recvChainKey == null) throw StateError('接收链未初始化');
  if (n < state.recvN) throw StateError('消息已处理或序号过旧');
  if (n - state.recvN > 1000) throw StateError('消息序号跳跃过大');
  while (state.recvN < n) {
    final k = _kdfChain(state.recvChainKey!);
    state.recvChainKey = k[0];
    state.recvN++;
  }
  final k = _kdfChain(state.recvChainKey!);
  final nextChainKey = k[0];
  final messageKey = k[1];
  final plain = _aesGcmDecrypt(messageKey, iv, ctWithTag);
  state.recvChainKey = nextChainKey;
  state.recvN = n + 1;
  return utf8.decode(plain);
}

bool _bytesEqual(Uint8List a, Uint8List b) {
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}
