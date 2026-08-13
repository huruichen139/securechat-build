import 'package:flutter_test/flutter_test.dart';
import 'package:securechat/services/chat_crypto.dart';

void main() {
  test('明文/非密文原样返回', () {
    expect(looksLikeRatchetCipher(''), isFalse);
    expect(looksLikeRatchetCipher('REST_DIAG_1785815495329'), isFalse);
    expect(looksLikeRatchetCipher('hi'), isFalse);
    expect(looksLikeRatchetCipher('[语音消息:abc]'), isFalse);
  });

  test('识别双棘轮密文包', () {
    // 构造一个假的 v2 封包（长度需 >= 1+91+4+4+12+16=128）
    final fakeBlob = List<int>.generate(128, (i) => i % 256);
    fakeBlob[0] = 0x02;
    final b64 = _b64(fakeBlob);
    expect(looksLikeRatchetCipher(b64), isTrue);
  });
}

String _b64(List<int> bytes) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  final sb = StringBuffer();
  for (var i = 0; i < bytes.length; i += 3) {
    final b0 = bytes[i];
    final b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    final b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    sb.write(chars[(b0 >> 2) & 0x3f]);
    sb.write(chars[((b0 << 4) | (b1 >> 4)) & 0x3f]);
    if (i + 1 < bytes.length) {
      sb.write(chars[((b1 << 2) | (b2 >> 6)) & 0x3f]);
    } else {
      sb.write('=');
    }
    if (i + 2 < bytes.length) {
      sb.write(chars[b2 & 0x3f]);
    } else {
      sb.write('=');
    }
  }
  return sb.toString();
}