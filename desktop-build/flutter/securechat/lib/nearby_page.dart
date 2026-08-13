// module: nearby (worker batch5) —— 附近的人：列出附近活跃用户，设置位置，打招呼/加好友
// 依赖：services/securechat_api.dart、services/lifestyle_api.dart、widgets/app_scaffold.dart
import 'package:flutter/material.dart';

import 'services/app_config.dart';
import 'services/lifestyle_api.dart';
import 'services/securechat_api.dart';

class NearbyPage extends StatefulWidget {
  const NearbyPage({super.key, required this.api, required this.config});
  final SecureChatApi api;
  final AppConfig config;
  @override
  State<NearbyPage> createState() => _NearbyPageState();
}

class _NearbyPageState extends State<NearbyPage> {
  late final LifestyleService _svc;
  final _people = <Map<String, dynamic>>[];
  String _city = '';
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _svc = LifestyleService(widget.api);
    _reload();
  }

  Future<void> _reload() async {
    setState(() { _loading = true; _error = null; });
    try {
      final data = await _svc.nearbyData();
      _city = (data['city'] ?? '').toString();
      _people
        ..clear()
        ..addAll(((data['people'] as List?) ?? const []).cast<Map<String, dynamic>>());
    } catch (e) {
      _error = e.toString().replaceFirst('Bad state: ', '');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _setCity() async {
    final c = TextEditingController(text: _city);
    final r = TextEditingController();
    await showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('设置我的位置'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: c, decoration: const InputDecoration(hintText: '城市（留空自动按 IP/mock 估算）')),
          const SizedBox(height: 8),
          TextField(controller: r, decoration: const InputDecoration(hintText: '区 / 详细（可留空）')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(onPressed: () async {
            try {
              await _svc.setNearby(city: c.text.trim(), region: r.text.trim());
              Navigator.pop(ctx);
              _snack('位置已更新');
              _reload();
            } catch (e) {
              _snack('设置失败：${e.toString().replaceFirst('Bad state: ', '')}');
            }
          }, child: const Text('保存')),
        ],
      ),
    );
  }

  Future<void> _hello(Map<String, dynamic> p) async {
    try {
      await _svc.nearbyHello(_svc.toInt(p['userId']));
      _snack('已打招呼');
      setState(() {
        p['friendRequested'] = true;
      });
    } catch (e) {
      _snack('打招呼失败：${e.toString().replaceFirst('Bad state: ', '')}');
    }
  }

  void _snack(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  String _rel(int ts) {
    if (ts == 0) return '';
    final diff = DateTime.now().millisecondsSinceEpoch - ts;
    final m = diff ~/ 60000;
    if (m < 1) return '刚刚在线';
    if (m < 60) return '$m 分钟前';
    final h = m ~/ 60;
    if (h < 24) return '$h 小时前';
    return '${h ~/ 24} 天前';
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final color = widget.config.theme.primary;
    return Scaffold(
      backgroundColor: cs.surface,
      appBar: AppBar(
        backgroundColor: cs.surface,
        elevation: 0,
        title: Text('附近的人', style: TextStyle(color: cs.onSurface, fontWeight: FontWeight.w700)),
        leading: IconButton(icon: Icon(Icons.arrow_back, color: cs.onSurface), onPressed: () => Navigator.of(context).maybePop()),
        actions: [
          IconButton(tooltip: '我的位置', onPressed: _setCity, icon: Icon(Icons.location_on_outlined, color: color)),
          IconButton(tooltip: '刷新', onPressed: _reload, icon: Icon(Icons.refresh, color: color)),
        ],
      ),
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
          child: Row(children: [
            Icon(Icons.place, color: color, size: 18),
            const SizedBox(width: 6),
            Text('附近 · ${_city.isEmpty ? '…' : _city}', style: TextStyle(color: cs.onSurfaceVariant)),
          ]),
        ),
        const Divider(height: 1),
        Expanded(
          child: _loading
              ? const Center(child: CircularProgressIndicator())
              : _error != null
                  ? Center(child: Text(_error!, style: TextStyle(color: cs.error)))
                  : _people.isEmpty
                      ? Center(child: Text('附近还没有活跃的人', style: TextStyle(color: cs.onSurfaceVariant)))
                      : ListView.separated(
                          itemCount: _people.length,
                          separatorBuilder: (_, i) => const SizedBox(height: 8),
                          padding: const EdgeInsets.all(12),
                          itemBuilder: (_, i) {
                            final p = _people[i];
                            final name = (p['nickname'] ?? p['username'] ?? '用户').toString();
                            final online = p['online'] == true;
                            final isFriend = p['isFriend'] == true;
                            final requested = p['friendRequested'] == true;
                            return Container(
                              padding: const EdgeInsets.all(12),
                              decoration: BoxDecoration(color: cs.surface, borderRadius: BorderRadius.circular(14)),
                              child: Row(children: [
                                CircleAvatar(
                                  backgroundColor: color.withValues(alpha: 0.15),
                                  child: Text(name.characters.first, style: TextStyle(color: color, fontWeight: FontWeight.w600)),
                                ),
                                const SizedBox(width: 12),
                                Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                  Row(children: [
                                    Text(name, style: TextStyle(color: cs.onSurface, fontWeight: FontWeight.w600)),
                                    if (online) ...[
                                      const SizedBox(width: 6),
                                      Container(width: 8, height: 8, decoration: BoxDecoration(color: const Color(0xff18a66a), shape: BoxShape.circle)),
                                    ],
                                  ]),
                                  const SizedBox(height: 3),
                                  Text('${p['city'] ?? ''}${((p['region'] ?? '').toString().isNotEmpty ? ' · ${p['region']}' : '')} · ${_rel(_svc.toInt(p['lastSeen']))}', style: TextStyle(color: cs.onSurfaceVariant, fontSize: 12)),
                                ])),
                                const SizedBox(width: 8),
                                if (isFriend)
                                  const Chip(label: Text('已是好友'), visualDensity: VisualDensity.compact)
                                else if (requested)
                                  Chip(label: Text('已打招呼'), visualDensity: VisualDensity.compact)
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
