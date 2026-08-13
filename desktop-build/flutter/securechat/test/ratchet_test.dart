import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:pointycastle/export.dart';
import 'package:securechat/services/ratchet.dart';

void main() {
  test('双棘轮往返加解密', () {
    final aId = genEcKeyPair();
    final bId = genEcKeyPair();
    final ec = ECDHBasicAgreement()..init(aId.priv);
    final skBig = ec.calculateAgreement(bId.pub);
    final hex = skBig.toRadixString(16).padLeft(64, '0');
    final sk = Uint8List(32);
    for (var i = 0; i < 64; i += 2) {
      sk[i ~/ 2] = int.parse(hex.substring(i, i + 2), radix: 16);
    }
    final stateA = initAsSender(sk, bId.pub);
    final stateB = initAsReceiver(sk, bId);

    final c1 = encryptMessage(stateA, 'Hello B');
    expect(decryptMessage(stateB, c1), 'Hello B');

    final c2 = encryptMessage(stateB, 'Hi A');
    expect(decryptMessage(stateA, c2), 'Hi A');

    final c3 = encryptMessage(stateA, 'msg2');
    expect(decryptMessage(stateB, c3), 'msg2');

    final c4 = encryptMessage(stateB, 'ack');
    expect(decryptMessage(stateA, c4), 'ack');
  });
}