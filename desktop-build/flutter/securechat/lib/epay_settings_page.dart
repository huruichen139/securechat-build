import 'package:flutter/material.dart';
import 'services/securechat_api.dart';
import 'services/app_config.dart';
import 'widgets/ux.dart';

class EpaySettingsPage extends StatefulWidget {
  const EpaySettingsPage({super.key, required this.api, required this.config});
  final SecureChatApi api;
  final AppConfig config;
  @override
  State<EpaySettingsPage> createState() => _EpaySettingsPageState();
}

class _EpaySettingsPageState extends State<EpaySettingsPage> {
  final _keyCtrl = TextEditingController();
  bool _loading = true;
  String _error = '';
  bool _saved = false;

  @override
  void initState() {
    super.initState();
    _loadSettings();
  }

  Future<void> _loadSettings() async {
    setState(() { _loading = true; _error = ''; });
    try {
      final res = await widget.api.getEpaySettings();
      if (!mounted) return;
      setState(() {
        _keyCtrl.text = res['gatewayKey'] ?? '';
        _loading = false;
      });
    } catch (e) {
      if (mounted) setState(() { _error = e.toString(); _loading = false; });
    }
  }

  Future<void> _save() async {
    if (_keyCtrl.text.trim().isEmpty) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('密钥不能为空')));
      return;
    }
    setState(() { _saved = false; });
    try {
      await widget.api.setEpaySettings(_keyCtrl.text.trim());
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已保存')));
        setState(() { _saved = true; });
      }
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('保存失败: $e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = widget.config.theme;
    return Scaffold(
      backgroundColor: t.bg,
      appBar: AppBar(title: const Text('EPay 网关设置'), backgroundColor: t.panel, foregroundColor: t.text),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : SingleChildScrollView(
              padding: const EdgeInsets.all(16),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                if (_error != '') Text(_error, style: TextStyle(color: Colors.red, fontSize: 13)),
                const SizedBox(height: 16),
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(16),
                  decoration: BoxDecoration(color: t.panel, borderRadius: BorderRadius.circular(12)),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    const Text('网关密钥 (Gateway Key)', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
                    const SizedBox(height: 8),
                    TextField(
                      controller: _keyCtrl,
                      style: TextStyle(color: t.text),
                      decoration: InputDecoration(
                        hintText: '输入商户网关密钥',
                        hintStyle: TextStyle(color: t.subText),
                        filled: true,
                        fillColor: t.inputBg,
                        border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
                      ),
                      maxLines: 2,
                    ),
                    const SizedBox(height: 8),
                    const Text('用于签名/验签易支付接口请求，修改后需重启服务生效。', style: TextStyle(fontSize: 11, color: Colors.grey)),
                    const SizedBox(height: 16),
                    Row(children: [
                      Expanded(
                        child: FilledButton(
                          onPressed: _save,
                          style: FilledButton.styleFrom(backgroundColor: _saved ? _wechatGreen : null),
                          child: Text(_saved ? '已保存' : '保存密钥'),
                        ),
                      ),
                      const SizedBox(width: 12),
                      OutlinedButton(onPressed: _loadSettings, child: const Text('重置')),
                    ]),
                  ]),
                ),
                const SizedBox(height: 24),
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(16),
                  decoration: BoxDecoration(color: t.panel, borderRadius: BorderRadius.circular(12)),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    const Text('说明', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
                    const SizedBox(height: 8),
                    Text('• Gateway Key：易支付签名密钥，客户端和服务器需保持一致', style: TextStyle(color: t.subText, fontSize: 13)),
                    const SizedBox(height: 4),
                    Text('• 修改后需在服务器重新加载配置或重启服务', style: TextStyle(color: t.subText, fontSize: 13)),
                    const SizedBox(height: 4),
                    Text('• 当前使用 mock-key 模式，适合本地测试', style: TextStyle(color: t.subText, fontSize: 13)),
                  ]),
                ),
              ]),
            ),
    );
  }

  static const _wechatGreen = Color(0xff07c160);
}
