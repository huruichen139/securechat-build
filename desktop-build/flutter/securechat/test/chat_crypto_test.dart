import 'package:flutter_test/flutter_test.dart';
import 'package:securechat/services/chat_crypto.dart';

void main() {
  test('roundtrip plaintext', () {
    const msg = '你好Bob，全程加密消息';
    final enc = writeChatText(msg);
    expect(enc, isNot(msg));
    expect(looksLikeCipher(enc), isTrue);
    expect(decrypt(enc), msg);
    expect(readChatText(enc), msg);
  });

  test('decrypts server-side node ciphertext', () {
    // Produced by shared/crypto.js encrypt("你好Bob，全程加密消息")
    const serverCipher = 'rhGlle82uQeJukQYYv5TyOfvORmxe2bAukYkoN0PlnC/I8B1dFqZLRuXJknm4WSFFh4PbWJ9zK6opg==';
    expect(readChatText(serverCipher), '你好Bob，全程加密消息');
  });

  test('passes plaintext through', () {
    expect(readChatText('REST_DIAG_1785815495329'), 'REST_DIAG_1785815495329');
    expect(readChatText('hi'), 'hi');
  });
}
