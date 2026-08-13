// module: status_page (worker batch7) —— Flutter 状态页：设文字+图标状态、查看好友状态、留言互动
import 'package:flutter/material.dart';

import 'services/moment_collar_service.dart';
import 'services/securechat_api.dart';

class StatusPage extends StatefulWidget {
  const StatusPage({super.key, required this.api, required this.config});
  final SecureChatApi api;
  final dynamic config;
  @override
  State<StatusPage> createState() => _StatusPageState();
}

class _StatusPageState extends State<StatusPage> {
  late final MomentCollarService _svc = MomentCollarService(widget.api);
  Map<String, dynamic>? _my;
  List<Map<String, dynamic>> _feed = [];
  bool _loading = true;
  String? _error;
  final _text = TextEditingController();
  String _icon = '😄';
  String _bgUrl = '';

  static const icons = ['😄', '😴', '🌙', '💼', '🏃', '📚', '🎵', '🍜', '✈️', '❤️', '💪', '🎮', '🧘', '☕', '📱', '🚴'];

  @override
  void initState() {
    super.initState();
    _reload();
  }

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  Future<void> _reload() async {
    setState(() { _loading = true; _error = null; });
    try {
      final d = await _svc.statusFeed();
      _my = d['myStatus'] as Map<String, dynamic>?;
      _feed = ((d['feed'] as List?) ?? const []).cast<Map<String, dynamic>>();
    } catch (e) {
      _error = e.toString().replaceFirst('Bad state: ', '');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _set() async {
    final text = _text.text.trim();
    if (text.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('请输入状态内容')));
      return;
    }
    try {
      await _svc.setStatus(text, icon: _icon, bgUrl: _bgUrl);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已设置，24 小时后自动消失')));
        _text.clear();
      }
      await _reload();
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('设置失败：$e')));
    }
  }

  Future<void> _clear() async {
    try {
      await _svc.clearStatus();
      await _reload();
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('清除失败：$e')));
    }
  }

  Future<void> _openDetail(Map<String, dynamic> s) async {
    final userId = (s['userId'] as num?)?.toInt() ?? 0;
    try {
      final msgs = await _svc.statusMessages(userId);
      if (!mounted) return;
      await showModalBottomSheet<void>(
        context: context,
        builder: (ctx) => _StatusDetailSheet(svc: _svc, userId: userId, status: s, msgs: msgs),
      );
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('加载失败：$e')));
    }
  }

  Widget _card(Map<String, dynamic> s, bool self) {
    final bg = s['bgUrl'] as String? ?? '';
    final text = (s['text'] ?? '').toString();
    final icon = (s['icon'] ?? '😄').toString();
    final msgs = (s['messageCount'] as num?)?.toInt() ?? 0;
    final color = widget.config.theme.primary;
    return Container(
      margin: EdgeInsets.only(right: self ? 0 : 10),
      width: 120,
      height: 160,
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(16),
        color: bg.isEmpty ? const Color(0xFF2A9D8F) : null,
        image: bg.isEmpty
            ? null
            : DecorationImage(image: NetworkImage('${widget.api.baseUrl}$bg'), fit: BoxFit.cover),
      ),
      child: Stack(children: [
        Positioned(top: 0, child: Text(icon, style: const TextStyle(fontSize: 26))),
        Align(
          alignment: Alignment.bottomLeft,
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(text, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Colors.white, fontSize: 15, fontWeight: FontWeight.w700)),
            if (msgs > 0) Text('$msgs 条留言', style: const TextStyle(color: Colors.white70, fontSize: 11)),
          ]),
        ),
        if (self)
          Positioned(top: 0, right: 0, child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
            decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(8)),
            child: const Text('状态', style: TextStyle(color: Colors.white, fontSize: 10)),
          )),
      ]),
    );
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Scaffold(
      backgroundColor: cs.surface,
      appBar: AppBar(
        backgroundColor: cs.surface,
        elevation: 0,
        title: Text('状态', style: TextStyle(color: cs.onSurface, fontWeight: FontWeight.w700)),
        leading: IconButton(icon: Icon(Icons.arrow_back, color: cs.onSurface), onPressed: () => Navigator.of(context).maybePop()),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(child: Text(_error!, style: TextStyle(color: cs.error)))
              : SingleChildScrollView(
                  padding: const EdgeInsets.all(16),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text('我的一天', style: TextStyle(color: cs.onSurface, fontWeight: FontWeight.w700)),
                    const SizedBox(height: 10),
                    if (_my == null) ...[
                      Row(children: [
                        for (final i in icons)
                          InkWell(
                            onTap: () => setState(() => _icon = i),
                            child: Container(
                              margin: const EdgeInsets.only(right: 6),
                              padding: const EdgeInsets.all(4),
                              decoration: BoxDecoration(
                                shape: BoxShape.circle,
                                color: _icon == i ? cs.primaryContainer : Colors.transparent,
                              ),
                              child: Text(i, style: const TextStyle(fontSize: 20)),
                            ),
                          ),
                      ]),
                      const SizedBox(height: 10),
                      TextField(
                        controller: _text,
                        maxLength: 40,
                        decoration: const InputDecoration(hintText: '此刻的想法...', counterText: ''),
                      ),
                      Row(children: [
                        Text('背景图(选填)', style: TextStyle(color: cs.onSurfaceVariant)),
                        const SizedBox(width: 8),
                        IconButton(
                          icon: const Icon(Icons.wallpaper),
                          onPressed: () => _pickBg(),
                          tooltip: '选择背景图',
                        ),
                      ]),
                      const SizedBox(height: 8),
                      FilledButton.icon(onPressed: _set, icon: const Icon(Icons.check, size: 16), label: const Text('设为状态')),
                    ] else ...[
                      InkWell(onTap: () => _openDetail(_my!), child: _card(_my!, true)),
                      const SizedBox(height: 8),
                      TextButton(onPressed: _clear, child: const Text('清除状态')),
                    ],
                    const SizedBox(height: 16),
                    Text('好友状态', style: TextStyle(color: cs.onSurface, fontWeight: FontWeight.w700)),
                    const SizedBox(height: 10),
                    if (_feed.isEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 30),
                        child: Center(child: Text('还没有好友设置状态', style: TextStyle(color: cs.onSurfaceVariant))),
                      )
                    else
                      SingleChildScrollView(
                        scrollDirection: Axis.horizontal,
                        child: Row(children: [for (final s in _feed) _clickable(s)]),
                      ),
                  ]),
                ),
    );
  }

  Widget _clickable(Map<String, dynamic> s) {
    return InkWell(onTap: () => _openDetail(s), child: _card(s, false));
  }

  Future<void> _pickBg() async {
    // 说明：Flutter 端背景图上传可复用 /api/media；此处保留占位，
    // 若已集成 file_picker 则可开放。完整可运行不依赖上传。
  }
}

class _StatusDetailSheet extends StatefulWidget {
  const _StatusDetailSheet({required this.svc, required this.userId, required this.status, required this.msgs});
  final MomentCollarService svc;
  final int userId;
  final Map<String, dynamic> status;
  final List<Map<String, dynamic>> msgs;
  @override
  State<_StatusDetailSheet> createState() => _StatusDetailSheetState();
}

class _StatusDetailSheetState extends State<_StatusDetailSheet> {
  late List<Map<String, dynamic>> _msgs = widget.msgs;
  late final TextEditingController _input = TextEditingController();

  @override
  void dispose() {
    _input.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final content = _input.text.trim();
    if (content.isEmpty) return;
    try {
      await widget.svc.postStatusMessage(widget.userId, content);
      _input.clear();
      final d = await widget.svc.statusMessages(widget.userId);
      if (mounted) setState(() => _msgs = d);
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('留言失败：$e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final color = Theme.of(context).colorScheme.primary;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Row(children: [
            Text((widget.status['text'] ?? '').toString(), style: TextStyle(color: cs.onSurface, fontWeight: FontWeight.w700)),
            const Spacer(),
            IconButton(icon: const Icon(Icons.close), onPressed: () => Navigator.of(context).pop()),
          ]),
          const SizedBox(height: 8),
          Flexible(
            child: ListView(
              shrinkWrap: true,
              children: [
                for (final m in _msgs)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 6),
                    child: RichText(
                      text: TextSpan(style: TextStyle(color: cs.onSurface, fontSize: 13), children: [
                        TextSpan(text: (m['nickname'] ?? '?').toString(), style: TextStyle(color: color, fontWeight: FontWeight.w600)),
                        TextSpan(text: '：${m['content'] ?? ''}'),
                      ]),
                    ),
                  ),
                if (_msgs.isEmpty) Center(child: Text('暂无留言', style: TextStyle(color: cs.onSurfaceVariant))),
              ],
            ),
          ),
          Row(children: [
            Expanded(
              child: TextField(controller: _input, decoration: const InputDecoration(hintText: '留言鼓励一下...')),
            ),
            const SizedBox(width: 8),
            FilledButton(onPressed: _send, child: const Text('发送')),
          ]),
        ]),
      ),
    );
  }
}