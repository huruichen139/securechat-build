// X3DH identity-only 协商 + 双棘轮加解密链路测试
//
// 模拟两个身份密钥对 A、B：
//   - A 用 deriveSk(A.priv, B.pub) 得 sk 并 initAsSender 加密
//   - B 用 deriveSk(B.priv, A.pub) 得同一 sk 并 initAsReceiver 解密
//   验证 X3DH + 双棘轮能正确往返加解密。

import 'package:flutter_test/flutter_test.dart';
import 'package:securechat/services/ratchet.dart';
import 'package:securechat/services/x3dh.dart';

void main() {
  test('identity-only X3DH 协商出同一 sk，双棘轮可往返加解密', () {
    final aPair = genEcKeyPair();
    final bPair = genEcKeyPair();

    // 发起方 A
    final skA = deriveSk(aPair.priv, bPair.pub);
    final stateA = initAsSender(skA, bPair.pub);

    // 接收方 B：用自己身份私钥 + 对方身份公钥算同一 sk
    final skB = deriveSk(bPair.priv, aPair.pub);
    expect(skB, skA, reason: 'DH 对称性应得出同一 sk');

    final stateB = initAsReceiver(skB, bPair);

    // A -> B
    final c1 = encryptMessage(stateA, 'Hello B from A');
    expect(decryptMessage(stateB, c1), 'Hello B from A');

    // B -> A
    final c2 = encryptMessage(stateB, 'Hi A, got it');
    expect(decryptMessage(stateA, c2), 'Hi A, got it');

    // 连续多轮，验证棘轮正确推进
    final c3 = encryptMessage(stateA, 'third message');
    expect(decryptMessage(stateB, c3), 'third message');
    final c4 = encryptMessage(stateB, 'ack');
    expect(decryptMessage(stateA, c4), 'ack');
  });
}