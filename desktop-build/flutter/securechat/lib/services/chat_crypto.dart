import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:pointycastle/export.dart';

const String _kKeyHex =
    'a3f5c1e09b7d4f2e8a1c3b5d7e9f0a2c4b6d8e0f2a4c6d8e0b2d4f6a8c0e2b4d6';

Uint8List _key() {
  final s = _kKeyHex.substring(0, 64);
  final bytes = <int>[];
  for (var i = 0; i < s.length; i += 2) {
    bytes.add(int.parse(s.substring(i, i + 2), radix: 16));
  }
  return Uint8List.fromList(bytes);
}

String encrypt(String? plain) {
  if (plain == null || plain.isEmpty) return '';
  final random = Random.secure();
  final iv = Uint8List(12);
  for (var i = 0; i < iv.length; i++) {
    iv[i] = random.nextInt(256);
  }
  final key = _key();
  final cipher =
      GCMBlockCipher(AESEngine())..init(true, AEADParameters(KeyParameter(key), 128, iv, Uint8List(0)));
  final input = Uint8List.fromList(utf8.encode(plain));
  final out = cipher.process(input);
  final tag = cipher.mac;
  final ct = out.length >= tag.length ? Uint8List.sublistView(out, 0, out.length - tag.length) : input;
  final blob = Uint8List(12 + tag.length + ct.length);
  blob.setRange(0, 12, iv);
  blob.setRange(12, 12 + tag.length, Uint8List.sublistView(tag, 0, tag.length));
  blob.setRange(12 + tag.length, blob.length, ct);
  return base64.encode(blob);
}

Uint8List? _tryDecodeBlob(String b64) {
  try {
    return base64.decode(b64);
  } catch (_) {
    return null;
  }
}

String decrypt(String b64) {
  if (b64.isEmpty) return '';
  final blob = _tryDecodeBlob(b64);
  if (blob == null || blob.length < 28) return '';
  final iv = Uint8List.sublistView(blob, 0, 12);
  final tag = Uint8List.sublistView(blob, 12, 28);
  final body = Uint8List.sublistView(blob, 28);
  try {
    final key = _key();
    final cipher =
        GCMBlockCipher(AESEngine())..init(false, AEADParameters(KeyParameter(key), 128, iv, Uint8List(0)));
    final ct = Uint8List.fromList([...body, ...tag]);
    final dec = cipher.process(ct);
    return utf8.decode(dec, allowMalformed: false);
  } catch (e) {
    return '';
  }
}

bool looksLikeCipher(String s) {
  if (s.isEmpty) return false;
  if (RegExp(r'^[A-Za-z0-9+/]+={0,2}$').hasMatch(s.trim()) == false) return false;
  final decoded = _tryDecodeBlob(s.trim());
  return decoded != null && decoded.length >= 28;
}

String readChatText(String raw) {
  if (!looksLikeCipher(raw)) return raw;
  final plain = decrypt(raw);
  return plain.isEmpty ? raw : plain;
}

String writeChatText(String plain) => encrypt(plain);
