import 'dart:convert';
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

  test('重复消息不会回滚接收链', () {
    final aId = genEcKeyPair();
    final bId = genEcKeyPair();
    final ec = ECDHBasicAgreement()..init(aId.priv);
    final skBig = ec.calculateAgreement(bId.pub);
    final hex = skBig.toRadixString(16).padLeft(64, '0');
    final sk = Uint8List(32);
    for (var i = 0; i < 64; i += 2) {
      sk[i ~/ 2] = int.parse(hex.substring(i, i + 2), radix: 16);
    }
    final sender = initAsSender(sk, bId.pub);
    final receiver = initAsReceiver(sk, bId);
    final cipher = encryptMessage(sender, 'once');

    expect(decryptMessage(receiver, cipher), 'once');
    expect(() => decryptMessage(receiver, cipher), throwsStateError);
    expect(receiver.recvN, 1);

    final next = encryptMessage(sender, 'next');
    expect(decryptMessage(receiver, next), 'next');
  });

  test('拒绝消息序号超大跳跃', () {
    final aId = genEcKeyPair();
    final bId = genEcKeyPair();
    final ec = ECDHBasicAgreement()..init(aId.priv);
    final skBig = ec.calculateAgreement(bId.pub);
    final hex = skBig.toRadixString(16).padLeft(64, '0');
    final sk = Uint8List(32);
    for (var i = 0; i < 64; i += 2) {
      sk[i ~/ 2] = int.parse(hex.substring(i, i + 2), radix: 16);
    }
    final sender = initAsSender(sk, bId.pub);
    final receiver = initAsReceiver(sk, bId);
    final packet = base64.decode(encryptMessage(sender, 'jump'));
    packet[96] = 0x00;
    packet[97] = 0x00;
    packet[98] = 0x10;
    packet[99] = 0x00;

    expect(
      () => decryptMessage(receiver, base64.encode(packet)),
      throwsStateError,
    );
  });
}
