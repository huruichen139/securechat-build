import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'services/securechat_api.dart';
import 'services/app_config.dart';
import 'widgets/ux.dart';

class PasskeyPage extends StatefulWidget {
  const PasskeyPage({super.key, required this.api, required this.config});
  final SecureChatApi api;
  final AppConfig config;
  @override
  State<PasskeyPage> createState() => _PasskeyPageState();
}

class _PasskeyPageState extends State<PasskeyPage> {
  List<Map<String, dynamic>> _keys = [];
  bool _loading = true;
  AppTheme get _t => widget.config.theme;

  @override
  void initState() { super.initState(); _load(); }

  Future<void> _load() async {
    try {
      final sp = await SharedPreferences.getInstance();
      final raw = sp.getString('sc_passkeys');
      final local = raw == null ? <Map<String, dynamic>>[] : (jsonDecode(raw) as List).cast<Map<String, dynamic>>();
      final remote = await widget.api.passkeyList();
      if (!mounted) return;
      setState(() { _keys = local.map((p) => {...p, '_remote': remote.any((r) => r['credential_id'] == p['credentialId'])}).toList(); _loading = false; });
    } catch (e) { if (mounted) setState(() => _loading = false); }
  }

  Future<void> _create() async {
    final c = TextEditingController(text: '我的设备');
    final name = await showDialog<String>(context: context, builder: (ctx) => AlertDialog(
      backgroundColor: _t.card,
      title: Text('创建本地 Passkey', style: TextStyle(color: _t.text)),
      content: TextField(controller: c, style: TextStyle(color: _t.text), decoration: InputDecoration(labelText: '设备名称', labelStyle: TextStyle(color: _t.subText))),
      actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')), FilledButton(onPressed: () => Navigator.pop(ctx, c.text.trim()), child: const Text('创建'))],
    ));
    c.dispose();
    if (name == null || name.isEmpty) return;
    try {
      final r = await widget.api.passkeyRegister(name);
      final sp = await SharedPreferences.getInstance();
      final raw = sp.getString('sc_passkeys');
      final list = raw == null ? <dynamic>[] : jsonDecode(raw) as List;
      list.add({'credentialId': r['credentialId'], 'secret': r['secret'], 'deviceName': name});
      await sp.setString('sc_passkeys', jsonEncode(list));
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Passkey 已创建，密钥只保存在本地')));
      await _load();
    } catch (e) { if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('创建失败：$e'))); }
  }

  Future<void> _delete(Map<String, dynamic> key) async {
    try {
      await widget.api.passkeyDelete('${key['credentialId']}');
      final sp = await SharedPreferences.getInstance();
      final raw = sp.getString('sc_passkeys');
      final list = raw == null ? <dynamic>[] : jsonDecode(raw) as List;
      list.removeWhere((p) => p['credentialId'] == key['credentialId']);
      await sp.setString('sc_passkeys', jsonEncode(list));
      await _load();
    } catch (e) { if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('删除失败：$e'))); }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    return Scaffold(
      backgroundColor: _t.bg,
      appBar: AppBar(backgroundColor: _t.bg, title: Text('Passkey', style: TextStyle(color: _t.text)), iconTheme: IconThemeData(color: _t.text)),
      body: ListView(padding: const EdgeInsets.all(12), children: [
        SectionCard(config: widget.config, padding: const EdgeInsets.all(14), children: [
          Text('本地 Passkey', style: TextStyle(color: _t.text, fontWeight: FontWeight.w700)),
          const SizedBox(height: 6),
          Text('登录后创建本地设备密钥。私钥只保存在当前设备，支付授权也会要求本地确认。', style: TextStyle(color: _t.subText, fontSize: 12, height: 1.5)),
        ]),
        const SizedBox(height: 10),
        FilledButton.icon(onPressed: _create, icon: const Icon(Icons.add), label: const Text('创建 Passkey')),
        const SizedBox(height: 10),
        ..._keys.map((k) => Card(color: _t.card, child: ListTile(
          leading: const Icon(Icons.key_rounded, color: Ux.green),
          title: Text('${k['deviceName'] ?? '设备'}', style: TextStyle(color: _t.text)),
          subtitle: Text('本地密钥 · ${k['_remote'] == true ? '已同步验证' : '未同步'}', style: TextStyle(color: _t.subText, fontSize: 12)),
          trailing: IconButton(icon: const Icon(Icons.delete_outline, color: Colors.redAccent), onPressed: () => _delete(k)),
        )))
      ]),
    );
  }
}
