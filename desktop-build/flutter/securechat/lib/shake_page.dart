// module: shake (worker batch5) —— 摇一摇：搜索同时"摇"的用户，可打招呼/加好友
// 依赖：services/securechat_api.dart、services/lifestyle_api.dart
// Flutter 桌面端点没有 devicemotion，故用按钮触发作为主入口（符合 web 端手动按钮降级约定）。
import 'dart:async';

import 'package:flutter/material.dart';

import 'services/app_config.dart';
import 'services/lifestyle_api.dart';
import 'services/securechat_api.dart';
import 'widgets/ux.dart';

class ShakePage extends StatefulWidget {
  const ShakePage({super.key, required this.api, required this.config});
  final SecureChatApi api;
  final AppConfig config;
  @override
  State<ShakePage> createState() => _ShakePageState();
}

class _ShakePageState extends State<ShakePage> {
  late final LifestyleService _svc;
  final _matches = <Map<String, dynamic>>[];
  bool _shaking = false;
  bool _loading = false;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _svc = LifestyleService(widget.api);
  }

  @override
  void dispose() {
    _timer?.cancel();
    _svc.shakeStop().catchError((_) {});
    super.dispose();
  }

  Future<void> _toggle() async {
    if (_shaking) {
      _timer?.cancel();
      _timer = null;
      await _svc.shakeStop().catchError((_) {});
      if (mounted) setState(() { _shaking = false; _matches.clear(); });
      return;
    }
    try {
      await _svc.shakeStart();
      if (mounted) setState(() { _shaking = true; _matches.clear(); _loading = true; });
      await _pull();
      _timer?.cancel();
      _timer = Timer.periodic(const Duration(seconds: 4), (_) => _pull());
    } catch (e) {
      _snack('摇一摇启动失败：${e.toString().replaceFirst('Bad state: ', '')}');
    }
  }

  Future<void> _pull() async {
    if (!mounted) return;
    try {
      final data = await _svc.shakeMatches();
      if (!mounted) return;
      setState(() { _matches..clear()..addAll(data); _loading = false; });
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _hello(Map<String, dynamic> p) async {
    try {
      final r = await _svc.shakeHello(_svc.toInt(p['userId']));
      _snack((r['already'] == true ? '你们已是好友' : '已打招呼').toString());
      if (mounted) {
        setState(() {
          p['done'] = r['already'] == true;
        });
      }
    } catch (e) {
      _snack('打招呼失败：${e.toString().replaceFirst('Bad state: ', '')}');
    }
  }

  void _snack(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  @override
  Widget build(BuildContext context) {
    final t = widget.config.theme;
    return Scaffold(
      backgroundColor: t.bg,
      body: Column(children: [
        PageHeader(title: '摇一摇', config: widget.config),
        Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(vertical: 24),
          decoration: BoxDecoration(
            color: t.card.withValues(alpha: 0.85),
            border: Border(bottom: BorderSide(color: t.div.withValues(alpha: 0.6))),
          ),
          child: Column(children: [
            Icon(Icons.phone_iphone, size: 72, color: widget.config.primary),
            const SizedBox(height: 12),
            Text(_shaking ? '正在寻找同时摇一摇的人…' : '点击下方按钮开始摇一摇', style: TextStyle(color: t.subText)),
            const SizedBox(height: 16),
            FilledButton.icon(
              onPressed: _toggle,
              icon: Icon(_shaking ? Icons.stop : Icons.gesture),
              label: Text(_shaking ? '停止摇 ' : '现在摇 '),
              style: FilledButton.styleFrom(padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 12)),
            ),
          ]),
        ),
        Expanded(
          child: _shaking && _loading
              ? const Center(child: CircularProgressIndicator())
              : _matches.isEmpty
                  ? Center(child: Text(_shaking ? '还没有人同时摇，再等等…' : '点击「现在摇」开始', style: TextStyle(color: t.subText)))
                  : ListView.separated(
                      itemCount: _matches.length,
                      separatorBuilder: (_, i) => const SizedBox(height: 8),
                      padding: const EdgeInsets.all(12),
                      itemBuilder: (_, i) {
                        final p = _matches[i];
                        final name = (p['nickname'] ?? p['username'] ?? '用户').toString();
                        final done = p['done'] == true;
                        return Container(
                          padding: const EdgeInsets.all(12),
                          decoration: BoxDecoration(
                            color: t.card.withValues(alpha: 0.85),
                            borderRadius: BorderRadius.circular(Ux.cardRadius),
                            border: Border.all(color: t.div.withValues(alpha: 0.6)),
                          ),
                          child: Row(children: [
                            CircleAvatar(backgroundColor: widget.config.primary.withValues(alpha: 0.15), child: Text(name.characters.first, style: TextStyle(color: widget.config.primary, fontWeight: FontWeight.w600))),
                            const SizedBox(width: 12),
                            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                              Text(name, style: TextStyle(color: t.text, fontWeight: FontWeight.w600)),
                              if ((p['city'] ?? '').toString().isNotEmpty) ...[
                                const SizedBox(height: 3),
                                Text(p['city'].toString(), style: TextStyle(color: t.subText, fontSize: 12)),
                              ],
                            ])),
                            const SizedBox(width: 8),
                            if (done)
                              Chip(label: Text('已是好友', style: TextStyle(color: t.subText, fontSize: 12)), visualDensity: VisualDensity.compact)
                            else
                              FilledButton(onPressed: () => _hello(p), child: const Text('打招呼')),
                          ]),
                        );
                      },
                    ),
        ),
      ]),
    );
  }
}
