import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'services/app_config.dart';
import 'services/securechat_api.dart';

class ScanAuthorizePage extends StatefulWidget {
  const ScanAuthorizePage({super.key, required this.api, required this.config});

  final SecureChatApi api;
  final AppConfig config;

  @override
  State<ScanAuthorizePage> createState() => _ScanAuthorizePageState();
}

class _ScanAuthorizePageState extends State<ScanAuthorizePage> {
  final _tokenCtrl = TextEditingController();
  bool _busy = false;
  String? _info;

  static const _kHistory = 'scan_authorize_history';

  Future<void> _loadHistory() async {
    final sp = await SharedPreferences.getInstance();
    setState(() => _tokenCtrl.text = sp.getString(_kHistory) ?? '');
  }

  @override
  void initState() {
    super.initState();
    _loadHistory();
  }

  Future<void> _extractAndSave(String input) async {
    final sp = await SharedPreferences.getInstance();
    await sp.setString(_kHistory, input.trim());
  }

  String? _extractToken(String input) {
    final s = input.trim();
    if (s.isEmpty) return null;
    // 支持直接粘贴 token，或粘贴完整 QR 内容(securechat://login?token=xxx)
    final uriPattern = RegExp(r'token=([^&\s]+)');
    final m = uriPattern.firstMatch(s);
    if (m != null) return Uri.decodeComponent(m.group(1)!);
    if (s.startsWith('securechat://')) {
      return null;
    }
    return s;
  }

  Future<void> _doConfirm(String input) async {
    final token = _extractToken(input);
    if (token == null) {
      setState(() => _info = '请输入二维码中的 token 或完整扫描内容');
      return;
    }
    setState(() {
      _busy = true;
      _info = null;
    });
    await _extractAndSave(token);
    try {
      await widget.api.confirmQrLogin(token);
      if (!mounted) return;
      setState(() => _info = null);
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已确认，对方设备现在可以登录了')));
    } catch (e) {
      if (!mounted) return;
      setState(() => _info = e.toString().replaceFirst('Bad state: ', ''));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  void dispose() {
    _tokenCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('扫码授权登录'),
        leading: const CloseButton(),
      ),
      body: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Container(
            height: 200,
            decoration: BoxDecoration(
              color: const Color(0xffedf7f1),
              borderRadius: BorderRadius.circular(20),
            ),
            child: const Center(
              child: Icon(Icons.qr_code_2_rounded, size: 120, color: Color(0xff18a66a)),
            ),
          ),
          const SizedBox(height: 16),
          const Text('手机扫码确认登录', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
          const SizedBox(height: 6),
          const Text('在其他电脑上打开「手机快捷登录」二维码，用此页面的扫码/粘贴方式确认后，对方电脑即可登录你的账号。', style: TextStyle(color: Color(0xff77818a))),
          const SizedBox(height: 8),
          const Text('每台设备登录需重新扫描确认，未授权的设备无法获取登录凭证。', style: TextStyle(color: Color(0xff9aa5ab), fontSize: 12)),
          const SizedBox(height: 20),
          const Text('扫描内容 / Token', style: TextStyle(fontWeight: FontWeight.w600)),
          const SizedBox(height: 8),
          TextField(
            controller: _tokenCtrl,
            maxLines: 2,
            decoration: const InputDecoration(hintText: '粘贴二维码中的 token 或完整 securechat:// 链接'),
          ),
          const SizedBox(height: 12),
          SizedBox(
            width: double.infinity,
            height: 48,
            child: FilledButton(
              onPressed: _busy ? null : () => _doConfirm(_tokenCtrl.text),
              child: Text(_busy ? '确认中…' : '确认登录'),
            ),
          ),
          if (_info != null)
            Padding(
              padding: const EdgeInsets.only(top: 14),
              child: Text(_info!, style: const TextStyle(color: Color(0xffc0392b), fontSize: 13)),
            ),
        ]),
      ),
    );
  }
}
