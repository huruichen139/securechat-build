import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import 'services/securechat_api.dart';

class QrConfirmPage extends StatefulWidget {
  const QrConfirmPage({super.key, required this.api});
  final SecureChatApi api;

  @override
  State<QrConfirmPage> createState() => _QrConfirmPageState();
}

class _QrConfirmPageState extends State<QrConfirmPage> {
  bool busy = false;
  String? error;

  String? _token(String raw) {
    final uri = Uri.tryParse(raw);
    if (uri != null && uri.queryParameters['token'] != null) return uri.queryParameters['token'];
    if (raw.startsWith('securechat://login?token=')) return Uri.decodeComponent(raw.split('token=').last);
    return null;
  }

  Future<void> _confirm(String raw) async {
    if (busy) return;
    final token = _token(raw);
    if (token == null) {
      setState(() => error = '不是 SecureChat 登录二维码');
      return;
    }
    setState(() { busy = true; error = null; });
    try {
      await widget.api.confirmQrLogin(token);
      if (mounted) Navigator.pop(context, true);
    } catch (e) {
      if (mounted) setState(() => error = e.toString().replaceFirst('Bad state: ', ''));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('扫描电脑二维码')),
        body: Stack(children: [
          MobileScanner(onDetect: (capture) {
            final value = capture.barcodes.isEmpty ? null : capture.barcodes.first.rawValue;
            if (value != null) _confirm(value);
          }),
          Align(alignment: Alignment.bottomCenter, child: Container(width: double.infinity, padding: const EdgeInsets.all(18), color: Colors.black54, child: Text(error ?? (busy ? '正在确认此电脑…' : '将电脑上的二维码放入框内'), textAlign: TextAlign.center, style: const TextStyle(color: Colors.white)))),
        ]),
      );
}
