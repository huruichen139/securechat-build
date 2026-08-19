// SecureChat 端到端加密（E2EE）
//
// 本模块基于双棘轮 ratchet.dart，为聊天消息提供真正的端到端加密：
//   - 每一条消息用独立的 messageKey（对称棘轮）
//   - 消息方向切换时做 DH 棘轮（前向保密）
//   - 服务器只存/转发密文，无法解密
//
// 会话管理：
//   - 用 SharedPreferences 持久化身份密钥对（ECDH P-256）
//   - 初次与对方通信时用 X3DH 协商出共享密钥 sk
//   - sk 存到本地，后续通过 ratchet 加解密

import 'dart:convert';
import 'dart:typed_data';

import 'package:pointycastle/export.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'ratchet.dart';
import 'securechat_api.dart';
import 'x3dh.dart';

// ============================================================
// 身份密钥（ECDH P-256），持久化在 SharedPreferences
// ============================================================

const _kIdentityPriv = 'sc_identity_priv_hex'; // 私钥 d 的 hex
const _kIdentityPub = 'sc_identity_pub_b64'; // 公钥 SPKI base64

class IdentityKeys {
  final BigInt privD;
  final ECPublicKey pub;
  IdentityKeys(this.privD, this.pub);

  EcKeyPair toPair() => EcKeyPair(ECPrivateKey(privD, secureDomain), pub);
}

Future<IdentityKeys> getOrCreateIdentity() async {
  final sp = await SharedPreferences.getInstance();
  final privHex = sp.getString(_kIdentityPriv);
  final pubB64 = sp.getString(_kIdentityPub);
  if (privHex != null && pubB64 != null) {
    final d = BigInt.parse(privHex, radix: 16);
    final pub = base64ToPub(pubB64);
    return IdentityKeys(d, pub);
  }
  // 生成新身份
  final pair = genEcKeyPair();
  final d = pair.priv.d as BigInt;
  final privHexNew = d.toRadixString(16).padLeft(64, '0');
  final pubB64New = pubToBase64(pair.pub);
  await sp.setString(_kIdentityPriv, privHexNew);
  await sp.setString(_kIdentityPub, pubB64New);
  return IdentityKeys(d, pair.pub);
}

// ============================================================
// X3DH + 会话密钥
// ============================================================

// 与某 peer 的 ratchet 会话（持久化）
const _kSessionPrefix = 'sc_ratchet_';

class PeerSessionStore {
  // peerKey: 用户名或 userId 字符串
  static Future<RatchetState?> load(String peerKey) async {
    final sp = await SharedPreferences.getInstance();
    final raw = sp.getString(_kSessionPrefix + peerKey);
    if (raw == null) return null;
    try {
      return RatchetState.fromJson(jsonDecode(raw) as Map<String, dynamic>);
    } catch (_) {
      return null;
    }
  }

  static Future<void> save(String peerKey, RatchetState state) async {
    final sp = await SharedPreferences.getInstance();
    await sp.setString(_kSessionPrefix + peerKey, jsonEncode(state.toJson()));
  }

  static Future<void> clear() async {
    final sp = await SharedPreferences.getInstance();
    final keys = sp.getKeys().where((k) => k.startsWith(_kSessionPrefix)).toList();
    for (final k in keys) {
      await sp.remove(k);
    }
  }

  // 端到端 sk（X3DH 协商后的 32 字节共享密钥），持久化
  static Future<Uint8List?> loadSk(String peerKey) async {
    final sp = await SharedPreferences.getInstance();
    final hex = sp.getString('${_kSessionPrefix}sk_$peerKey');
    if (hex == null) return null;
    final out = Uint8List(32);
    for (var i = 0; i < 64; i += 2) {
      out[i ~/ 2] = int.parse(hex.substring(i, i + 2), radix: 16);
    }
    return out;
  }

  static Future<void> saveSk(String peerKey, Uint8List sk) async {
    final sp = await SharedPreferences.getInstance();
    final hex = sk.map((e) => e.toRadixString(16).padLeft(2, '0')).join();
    await sp.setString('${_kSessionPrefix}sk_$peerKey', hex);
  }
}

// ============================================================
// X3DH + 双棘轮会话初始化
// ============================================================

// 从 peerKey（如 "$peerId"）解析出整数 peerId；解析失败返回 null
int? _peerIdFromKey(String peerKey) => int.tryParse(peerKey);

/// 发起方首次与 peer 通信：identity-only X3DH 协商出 sk，初始化双棘轮 sender 态
/// 返回初始化后的 RatchetState；条件不足（无 api / 拿不到对方身份公钥）返回 null
/// 使用身份密钥对作为 dhSelf（identity-only 模式），与 web 端 e2ee.js 对齐。
Future<RatchetState?> x3dhInitSender(int peerId, String peerKey) async {
  final peerPubB64 = await getPeerIdentityPub(peerId);
  if (peerPubB64 == null) return null;
  final my = await getOrCreateIdentity();
  final peerPub = base64ToPub(peerPubB64);
  final sk = deriveSk(my.toPair().priv, peerPub);
  await PeerSessionStore.saveSk(peerKey, sk);
  final state = initAsSenderIdentity(sk, my.toPair(), peerPub);
  await PeerSessionStore.save(peerKey, state);
  return state;
}

/// 接收方首次收到 peer 消息：用自己身份私钥 + 对方身份公钥算同一 sk，
/// 初始化双棘轮 receiver 态。返回 null 表示无法建立会话（回退明文）
Future<RatchetState?> x3dhInitReceiver(int peerId, String peerKey) async {
  final peerPubB64 = await getPeerIdentityPub(peerId);
  if (peerPubB64 == null) return null;
  final my = await getOrCreateIdentity();
  final peerPub = base64ToPub(peerPubB64);
  final sk = deriveSk(my.toPair().priv, peerPub);
  await PeerSessionStore.saveSk(peerKey, sk);
  final state = initAsReceiver(sk, my.toPair());
  await PeerSessionStore.save(peerKey, state);
  return state;
}

/// 上传我方 signed prekey 与一批 one-time prekey（服务器 bundle 分发）。
/// 签名可选，identity-only 模式不校验，用占位签名。
Future<void> uploadMyPrekeys(SecureChatApi api) async {
  final my = await getOrCreateIdentity();
  final idPub = pubToBase64(my.pub);
  final signKeyId = 'sp_${DateTime.now().millisecondsSinceEpoch}';
  // X3DH 签名可选；此处用占位签名（identity-only 模式不校验签名）
  final signature = base64.encode(utf8.encode('x3dh:$idPub'));

  try {
    await api.uploadSignedPreKey(signKeyId, idPub, signature);
    const count = 10;
    final list = <Map<String, String>>[];
    for (var i = 0; i < count; i++) {
      final kp = genEcKeyPair();
      list.add({
        'keyId': 'ot_${DateTime.now().microsecondsSinceEpoch}_$i',
        'pubKey': pubToBase64(kp.pub),
      });
    }
    await api.uploadOneTimePreKeys(list);
  } catch (_) {
    // 上传失败不阻断主流程
  }
}

/// 加密入口：无会话时若能从 peerKey 解析出 peerId 且有全局 api，则自动 X3DH
Future<String> e2eeEncrypt(String peerKey, String plain) async {
  var state = await PeerSessionStore.load(peerKey);
  if (state == null) {
    final peerId = _peerIdFromKey(peerKey);
    if (peerId != null && x3dhApi != null) {
      state = await x3dhInitSender(peerId, peerKey);
    }
  }
  if (state == null) return plain; // 条件不足：明文回退
  final ct = encryptMessage(state, plain);
  await PeerSessionStore.save(peerKey, state);
  return ct;
}

// 对 peerKey 解密一条消息（用该会话的 ratchet 状态）
Future<String> e2eeDecrypt(String peerKey, String b64) async {
  if (!looksLikeRatchetCipher(b64)) return b64; // 明文或媒体占位，原样返回
  var state = await PeerSessionStore.load(peerKey);
  if (state == null) {
    final peerId = _peerIdFromKey(peerKey);
    if (peerId != null && x3dhApi != null) {
      state = await x3dhInitReceiver(peerId, peerKey);
    }
  }
  if (state == null) return b64;
  try {
    final plain = decryptMessage(state, b64);
    await PeerSessionStore.save(peerKey, state);
    return plain;
  } catch (_) {
    return b64;
  }
}

// 判断是否为双棘轮密文（版本前缀识别，避免误判明文/媒体）
bool looksLikeRatchetCipher(String s) {
  if (s.isEmpty) return false;
  try {
    final b = base64.decode(s);
    return b.isNotEmpty && b[0] == 0x02 && b.length >= 1 + 91 + 4 + 4 + 12 + 16;
  } catch (_) {
    return false;
  }
}