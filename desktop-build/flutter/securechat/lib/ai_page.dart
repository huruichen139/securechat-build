import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'services/app_config.dart';
import 'services/securechat_api.dart';

class AiPage extends StatefulWidget {
  const AiPage({super.key, required this.api, required this.config});

  final SecureChatApi api;
  final AppConfig config;

  @override
  State<AiPage> createState() => _AiPageState();
}

class _AiPageState extends State<AiPage> {
  final _input = TextEditingController();
  final _baseUrlCtrl = TextEditingController();
  final _apiKeyCtrl = TextEditingController();
  final _modelCtrl = TextEditingController();
  final _messages = <({bool user, String text})>[];
  bool _busy = false;
  bool _showConfig = false;
  bool _ready = false;

  static const _kBaseUrl = 'ai_base_url';
  static const _kApiKey = 'ai_api_key';
  static const _kModel = 'ai_model';

  @override
  void initState() {
    super.initState();
    _loadConfig();
    _loadMessages();
  }

  Future<void> _loadConfig() async {
    final sp = await SharedPreferences.getInstance();
    setState(() {
      _baseUrlCtrl.text = sp.getString(_kBaseUrl) ?? 'https://api.ltzy.top/v1';
      _apiKeyCtrl.text = sp.getString(_kApiKey) ?? '';
      _modelCtrl.text = sp.getString(_kModel) ?? '';
      _syncReady();
    });
  }

  void _syncReady() {
    _ready = _baseUrlCtrl.text.trim().isNotEmpty &&
        _apiKeyCtrl.text.trim().isNotEmpty &&
        _modelCtrl.text.trim().isNotEmpty;
  }

  Future<void> _saveConfig() async {
    final sp = await SharedPreferences.getInstance();
    await sp.setString(_kBaseUrl, _baseUrlCtrl.text.trim());
    await sp.setString(_kApiKey, _apiKeyCtrl.text.trim());
    await sp.setString(_kModel, _modelCtrl.text.trim());
    setState(() {
      _syncReady();
      _showConfig = false;
    });
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('AI 配置已保存')));
    }
  }

  Future<void> _loadMessages() async {
    try {
      final sp = await SharedPreferences.getInstance();
      final raw = sp.getStringList('ai_history') ?? const [];
      setState(() {
        _messages.clear();
        for (final line in raw) {
          if (line.startsWith('u:')) {
            _messages.add((user: true, text: line.substring(2)));
          } else if (line.startsWith('a:')) {
            _messages.add((user: false, text: line.substring(2)));
          }
        }
      });
    } catch (_) {}
  }

  Future<void> _persist(List<({bool user, String text})> msgs) async {
    final sp = await SharedPreferences.getInstance();
    final raw = msgs
        .where((m) => m.text.isNotEmpty)
        .map((m) => (m.user ? 'u:' : 'a:') + m.text)
        .toList();
    await sp.setStringList('ai_history', raw);
  }

  Future<void> _send() async {
    final text = _input.text.trim();
    if (text.isEmpty || _busy || !_ready) return;
    setState(() {
      _input.clear();
      _messages.add((user: true, text: text));
      _messages.add((user: false, text: ''));
      _busy = true;
    });
    final history = _messages
        .where((m) => m.text.isNotEmpty)
        .map((m) => {'role': m.user ? 'user' : 'assistant', 'content': m.text})
        .toList();
    try {
      final reply = await widget.api.aiChat(
        baseUrl: _baseUrlCtrl.text.trim(),
        apiKey: _apiKeyCtrl.text.trim(),
        model: _modelCtrl.text.trim(),
        messages: history.cast<Map<String, dynamic>>(),
      );
      if (!mounted) return;
      setState(() => _messages[_messages.length - 1] = (user: false, text: reply));
      await _persist(_messages);
    } catch (e) {
      if (!mounted) return;
      setState(() => _messages[_messages.length - 1] = (user: false, text: '请求失败：${e.toString().replaceFirst('Bad state: ', '')}'));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  void dispose() {
    _input.dispose();
    _baseUrlCtrl.dispose();
    _apiKeyCtrl.dispose();
    _modelCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final config = widget.config;
    return Scaffold(
      appBar: AppBar(
        title: const Text('AI 助手'),
        leading: const CloseButton(),
        actions: [
          IconButton(
            tooltip: _ready ? 'AI 配置' : '未配置 AI，请点击设置',
            onPressed: () => setState(() {
              _showConfig = !_showConfig;
              _syncReady();
            }),
            icon: Icon(_ready ? Icons.settings_outlined : Icons.error_outline),
          ),
        ],
      ),
      body: Column(children: [
        if (_showConfig)
          _configCard(config)
        else if (!_ready)
          _setupPrompt()
        else
          Expanded(
            child: _messages.isEmpty
                ? const Center(child: Text('开始和 AI 对话吧', style: TextStyle(color: Color(0xff9aa5ab))))
                : ListView.builder(
                    padding: const EdgeInsets.all(16),
                    itemCount: _messages.length,
                    itemBuilder: (_, i) => _bubble(_messages[i]),
                  ),
          ),
        _composer(),
      ]),
    );
  }

  Widget _configCard(AppConfig config) {
    return AnimatedBuilder(
      animation: config,
      builder: (context, _) => Container(
        padding: const EdgeInsets.all(16),
        color: config.theme.card,
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('AI 服务配置', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700, color: config.theme.text)),
          const SizedBox(height: 12),
          TextField(controller: _baseUrlCtrl, onChanged: (_) => setState(_syncReady), decoration: const InputDecoration(labelText: 'Base URL', hintText: 'https://api.example.com/v1')),
          const SizedBox(height: 10),
          TextField(controller: _apiKeyCtrl, onChanged: (_) => setState(_syncReady), obscureText: true, decoration: const InputDecoration(labelText: 'API Key')),
          const SizedBox(height: 10),
          TextField(controller: _modelCtrl, onChanged: (_) => setState(_syncReady), decoration: const InputDecoration(labelText: '模型', hintText: '例如 gpt-4o-mini')),
          const SizedBox(height: 12),
          Row(children: [
            Expanded(child: FilledButton(onPressed: _saveConfig, child: const Text('保存'))),
            const SizedBox(width: 10),
            OutlinedButton(onPressed: () => setState(() => _showConfig = false), child: const Text('取消')),
          ]),
        ]),
      ),
    );
  }

  Widget _setupPrompt() {
    return Container(
      padding: const EdgeInsets.all(16),
      color: const Color(0xfffff3e0),
      child: Row(children: [
        const Icon(Icons.info_outline, color: Color(0xffef6c00)),
        const SizedBox(width: 10),
        const Expanded(child: Text('尚未配置 AI 服务，请点击右上角设置 Base URL / API Key / 模型。')),
        TextButton(onPressed: () => setState(() => _showConfig = true), child: const Text('立即配置')),
      ]),
    );
  }

  Widget _bubble(({bool user, String text}) m) {
    final mine = m.user;
    return Align(
      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.only(bottom: 10),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        constraints: const BoxConstraints(maxWidth: 480),
        decoration: BoxDecoration(
          color: mine ? const Color(0xffb7efd2) : const Color(0xffeef1f4),
          borderRadius: BorderRadius.circular(16),
        ),
        child: Text(m.text.isEmpty ? '…' : m.text, style: const TextStyle(color: Color(0xff17212b), fontSize: 14, height: 1.4)),
      ),
    );
  }

  Widget _composer() {
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 10, 14, 14),
      color: Colors.white,
      child: Row(children: [
        Expanded(
          child: TextField(
            controller: _input,
            minLines: 1,
            maxLines: 4,
            enabled: _ready && !_busy,
            onSubmitted: (_) => _send(),
            decoration: const InputDecoration(hintText: '向 AI 提问…'),
          ),
        ),
        const SizedBox(width: 10),
        FilledButton(onPressed: _send, child: Text(_busy ? '…' : '发送')),
      ]),
    );
  }
}
