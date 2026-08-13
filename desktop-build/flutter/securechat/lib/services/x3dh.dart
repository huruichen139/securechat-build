// SecureChat X3DH 密钥协商核心
//
// 本模块实现 identity-only 的 X3DH（Signal 三方迪啡-赫尔曼）简化版，
// 用于在发起方/接收方之间安全协商出共享密钥 sk：
//   sk = HKDF( DH(IK_A, IK_B) )[:32]
// 双方各自用自己的身份私钥 + 对方身份公钥计算，得到同一个 sk（ECDH 对称性），
// 服务器只保存双方的身份公钥，无法算出 sk。
//
// 之后的密文交换交给双棘轮 ratchet.dart，实现前向保密。

import 'dart:typed_data';

import 'package:pointycastle/export.dart';

import 'ratchet.dart';
import 'securechat_api.dart';

// ============================================================
// ECDH 工具
// ============================================================

/// 计算 P-256 共享密秘（priv * peerPub 的 x 坐标，32 字节大端）
Uint8List ecdhShare(ECPrivateKey priv, ECPublicKey peerPub, ECDomainParameters domain) {
  final ec = ECDHBasicAgreement()..init(priv);
  final z = ec.calculateAgreement(peerPub);
  final hex = z.toRadixString(16).padLeft(64, '0');
  final out = Uint8List(32);
  for (var i = 0; i < 64; i += 2) {
    out[i ~/ 2] = int.parse(hex.substring(i, i + 2), radix: 16);
  }
  return out;
}

// ============================================================
// HKDF 密钥派生（RFC 5869，HMAC-SHA256）
// ============================================================

/// 用 HKDF-SHA256 从输入派生长密钥（默认 64 字节：前 32 作 sk，后 32 作 extra）
Uint8List x3dhKdf(Uint8List input, {int len = 64}) {
  final kdf = HKDFKeyDerivator(SHA256Digest())
    ..init(HkdfParameters(input, len, null, Uint8List.fromList([0x00])));
  final out = Uint8List(len);
  kdf.deriveKey(input, 0, out, 0);
  return out;
}

/// 从 BigInt 私钥 d 构造 ECPrivateKey
ECPrivateKey privFromD(BigInt d) => ECPrivateKey(d, secureDomain);

/// identity-only X3DH：sk = HKDF(DH(myPriv, peerPub))[:32]
/// 发起方传 (A.priv, B.pub)，接收方传 (B.priv, A.pub)，两者结果一致。
Uint8List deriveSk(ECPrivateKey myPriv, ECPublicKey peerPub) {
  final dh = ecdhShare(myPriv, peerPub, secureDomain);
  final out = x3dhKdf(dh);
  return Uint8List.sublistView(out, 0, 32);
}

// ============================================================
// 全局状态：api 与身份公钥缓存
// ============================================================

/// 全局 SecureChatApi，由 main.dart 登录后赋值一次。
/// e2eeEncrypt / e2eeDecrypt 内部直接取用，调用点无需改签名。
SecureChatApi? x3dhApi;

/// peerId → 对方身份公钥（SPKI base64）的内存缓存。
final Map<int, String> identityPubCache = <int, String>{};

/// 记录某 peer 的身份公钥（可由 friends 列表或 bundle 填充）。
void cacheIdentityPub(int peerId, String pubB64) {
  identityPubCache[peerId] = pubB64;
}

/// 从内存缓存或服务器 bundle 取对方身份公钥（SPKI base64）。
/// 拿不到返回 null。
Future<String?> getPeerIdentityPub(int peerId) async {
  final cached = identityPubCache[peerId];
  if (cached != null) return cached;
  final api = x3dhApi;
  if (api == null) return null;
  try {
    final bundle = await api.fetchKeyBundle(peerId);
    final idKey = bundle['identityKey'];
    if (idKey is String && idKey.isNotEmpty) {
      identityPubCache[peerId] = idKey;
      return idKey;
    }
    final spk = bundle['signedPreKey'];
    if (spk is Map && spk['pubKey'] is String && (spk['pubKey'] as String).isNotEmpty) {
      identityPubCache[peerId] = spk['pubKey'] as String;
      return spk['pubKey'] as String;
    }
  } catch (_) {}
  return null;
}