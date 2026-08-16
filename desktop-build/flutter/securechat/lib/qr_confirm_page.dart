import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import 'services/app_config.dart';
import 'services/securechat_api.dart';
import 'widgets/ux.dart';

class QrConfirmPage extends StatefulWidget {
  const QrConfirmPage({super.key, required this.api, required this.config});
  final SecureChatApi api;
  final AppConfig config;

  @override
  State<QrConfirmPage> createState() => _QrConfirmPageState();
}

class _QrConfirmPageState extends State<QrConfirmPage> {
  bool busy = false;
  String? error;
  String? doneText;

  String? _queryParam(String raw, String key) {
    final uri = Uri.tryParse(raw);
    if (uri != null && uri.queryParameters[key] != null) return uri.queryParameters[key];
    final marker = '?$key=';
    if (raw.contains(marker)) return Uri.decodeComponent(raw.split('$key=').last.split('&').first);
    return null;
  }

  Future<void> _handle(String raw) async {
    if (busy) return;
    // securechat://friend?uid=xxx → 加好友
    if (raw.startsWith('securechat://friend')) {
      final uid = _queryParam(raw, 'uid');
      if (uid == null || uid.isEmpty) {
        setState(() => error = '无效的好友二维码');
        return;
      }
      setState(() { busy = true; error = null; });
      try {
        final result = await widget.api.addFriend(uid);
        if (mounted) {
          setState(() { busy = false; doneText = (result['friend']?['nickname'] ?? (result['friend']?['username'] ?? '')) + ' 已发送好友请求'; });
        }
      } catch (e) {
        if (mounted) setState(() { busy = false; error = e.toString().replaceFirst('Bad state: ', ''); });
      }
      return;
    }
    // securechat://login?token=xxx → 确认电脑登录
    final token = _queryParam(raw, 'token');
    if (raw.startsWith('securechat://login') && token == null) {
      setState(() => error = '无效的登录二维码');
      return;
    }
    if (token == null) {
      setState(() => error = '不是 SecureChat 二维码');
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
  Widget build(BuildContext context) {
    final t = widget.config.theme;
    return Scaffold(
      backgroundColor: t.bg,
      body: Column(children: [
        PageHeader(title: '扫一扫', config: widget.config),
        Expanded(
          child: Stack(children: [
            MobileScanner(onDetect: (capture) {
              final value = capture.barcodes.isEmpty ? null : capture.barcodes.first.rawValue;
              if (value != null) _handle(value);
            }),
            Align(alignment: Alignment.bottomCenter, child: Container(width: double.infinity, padding: const EdgeInsets.all(18), color: Colors.black54,
              child: Text(doneText ?? (error ?? (busy ? '处理中…' : '将二维码放入框内，支持登录码与好友码')), textAlign: TextAlign.center, style: const TextStyle(color: Colors.white, fontSize: 14)))),
            if (doneText != null)
              Align(alignment: Alignment.topCenter, child: Padding(padding: const EdgeInsets.only(top: 16), child: FilledButton(onPressed: () => Navigator.pop(context), child: const Text('完成')))),
          ]),
        ),
      ]),
    );
  }
}
