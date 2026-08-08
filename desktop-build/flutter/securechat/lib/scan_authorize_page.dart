import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'qr_confirm_page.dart';
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

  Future<void> _openScanner() async {
    setState(() => _info = null);
    final ok = await Navigator.push<bool>(
      context,
      MaterialPageRoute(builder: (_) => QrConfirmPage(api: widget.api, config: widget.config)),
    );
    if (!mounted) return;
    if (ok == true) {
      setState(() => _info = null);
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已确认，对方设备现在可以登录了')));
    }
  }

  @override
  void dispose() {
    _tokenCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = widget.config.theme;
    return AnimatedBuilder(
      animation: widget.config,
      builder: (context, _) => Scaffold(
        backgroundColor: Colors.transparent,
        appBar: AppBar(
          backgroundColor: Colors.transparent,
          title: const Text('扫码授权登录'),
          leading: const CloseButton(),
          actions: [
            TextButton.icon(
              onPressed: _busy ? null : _openScanner,
              icon: const Icon(Icons.qr_code_scanner),
              label: const Text('扫码'),
            ),
          ],
        ),
        body: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Container(
              height: 120,
              decoration: BoxDecoration(
                color: t.card,
                borderRadius: BorderRadius.circular(20),
                border: Border.all(color: t.div.withValues(alpha: 0.5)),
                boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: t.isDark ? 0.25 : 0.06), blurRadius: 16, offset: const Offset(0, 6))],
              ),
              child: Center(
                child: FilledButton.icon(
                  onPressed: _busy ? null : _openScanner,
                  style: FilledButton.styleFrom(minimumSize: const Size(200, 44)),
                  icon: const Icon(Icons.qr_code_scanner),
                  label: const Text('拍摄电脑上的二维码'),
                ),
              ),
            ),
            const SizedBox(height: 16),
            Text('手机扫码确认登录', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800, color: t.text)),
            const SizedBox(height: 6),
            Text('打开电脑端的「手机快捷登录」二维码，用手机的相机扫描确认后，电脑即可登录你的账号。', style: TextStyle(color: t.subText)),
            const SizedBox(height: 8),
            Text('每台设备登录需重新扫描确认，未授权的设备无法获取登录凭证。', style: TextStyle(color: t.subText, fontSize: 12)),
            const SizedBox(height: 20),
            Text('也可以手动粘贴扫码内容 / Token', style: TextStyle(fontWeight: FontWeight.w600, color: t.text)),
            const SizedBox(height: 8),
            TextField(
              controller: _tokenCtrl,
              maxLines: 2,
              style: TextStyle(color: t.text),
              decoration: InputDecoration(hintText: '粘贴二维码中的 token 或完整 securechat:// 链接', hintStyle: TextStyle(color: t.subText)),
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
      ),
    );
  }
}
