// module: miniapp (worker batch5) —— 小程序开放平台：列表/发布/搜索/收藏/最近使用/打开
// 依赖：services/securechat_api.dart、services/lifestyle_api.dart、widgets/app_scaffold.dart
import 'dart:io';

import 'package:flutter/material.dart';

import 'services/app_config.dart';
import 'services/lifestyle_api.dart';
import 'services/securechat_api.dart';
import 'widgets/ux.dart';

class MiniAppStorePage extends StatefulWidget {
  const MiniAppStorePage({super.key, required this.api, required this.config});
  final SecureChatApi api;
  final AppConfig config;
  @override
  State<MiniAppStorePage> createState() => _MiniAppStorePageState();
}

class _MiniAppStorePageState extends State<MiniAppStorePage> {
  late final LifestyleService _svc;
  final _search = TextEditingController();
  final _apps = <Map<String, dynamic>>[];
  String _mode = 'all'; // all | recent | favs | search
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _svc = LifestyleService(widget.api);
    _reload();
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  Future<void> _reload() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final List<Map<String, dynamic>> data = switch (_mode) {
        'recent' => await _svc.recentMiniPrograms(),
        'favs' => await _svc.favoriteMiniPrograms(),
        'search' => await _svc.searchMiniPrograms(_search.text.trim()),
        _ => await _svc.miniPrograms(),
      };
      _apps
        ..clear()
        ..addAll(data);
    } catch (e) {
      _error = e.toString().replaceFirst('Bad state: ', '');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _setMode(String m) {
    if (_mode == m) return;
    setState(() => _mode = m);
    _reload();
  }

  Future<void> _publish() async {
    final name = _search.text.trim();
    final urlC = TextEditingController();
    final iconC = TextEditingController();
    final descC = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('发布小程序'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: urlC, decoration: const InputDecoration(hintText: 'Web 入口（http:// 或 https://）')),
          const SizedBox(height: 8),
          TextField(controller: iconC, decoration: const InputDecoration(hintText: '图标地址（可留空）')),
          const SizedBox(height: 8),
          TextField(controller: descC, decoration: const InputDecoration(hintText: '描述（可留空）')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('发布')),
        ],
      ),
    );
    if (ok != true) return;
    if (name.isEmpty || urlC.text.trim().isEmpty) {
      _snack('名称和入口不能为空');
      return;
    }
    try {
      await _svc.publishMiniApp(name, urlC.text.trim(), icon: iconC.text.trim(), description: descC.text.trim());
      _snack('发布成功');
      _search.clear();
      _setMode('all');
    } catch (e) {
      _snack('发布失败：${e.toString().replaceFirst('Bad state: ', '')}');
    }
  }

  Future<void> _open(Map<String, dynamic> a) async {
    final url = (a['url'] ?? '').toString();
    if (url.isEmpty) return;
    final id = _svc.toInt(a['id']);
    try {
      await _svc.openMiniProgram(id);
    } catch (_) {
      // 记录使用失败不影响打开
    }
    try {
      if (Platform.isWindows) {
        Process.start('cmd', ['/c', 'start', '', url]);
      } else if (Platform.isMacOS) {
        Process.start('open', [url]);
      } else {
        Process.start('xdg-open', [url]);
      }
    } catch (e) {
      _snack('无法打开：$e（网页端可用内嵌窗口打开）');
    }
  }

  Future<void> _toggleFav(Map<String, dynamic> a, bool on) async {
    try {
      await _svc.favoriteMiniProgram(_svc.toInt(a['id']), on: on);
      _snack(on ? '已收藏' : '取消收藏');
      if (_mode == 'favs') _reload();
    } catch (e) {
      _snack('操作失败：${e.toString().replaceFirst('Bad state: ', '')}');
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
        PageHeader(title: '小程序', config: widget.config, trailing: IconButton(tooltip: '发布小程序', onPressed: _publish, icon: Icon(Icons.add_circle_outline, color: Ux.green))),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
          child: TextField(
            controller: _search,
            onSubmitted: (_) => _setMode('search'),
            decoration: InputDecoration(hintText: '搜索小程序', prefixIcon: Icon(Icons.search, color: t.subText), suffixIcon: IconButton(onPressed: () => _setMode('search'), icon: Icon(Icons.arrow_forward, color: t.subText))),
          ),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: Wrap(spacing: 8, children: [
            ChoiceChip(label: const Text('全部'), selected: _mode == 'all', onSelected: (_) => _setMode('all')),
            ChoiceChip(label: const Text('最近使用'), selected: _mode == 'recent', onSelected: (_) => _setMode('recent')),
            ChoiceChip(label: const Text('我的收藏'), selected: _mode == 'favs', onSelected: (_) => _setMode('favs')),
          ]),
        ),
        const SizedBox(height: 4),
        Expanded(
          child: _loading
              ? const Center(child: CircularProgressIndicator())
              : _error != null
                  ? Center(child: Text(_error!, style: TextStyle(color: t.subText)))
                  : _apps.isEmpty
                      ? Center(child: Text('暂无小程序', style: TextStyle(color: t.subText)))
                      : GridView.builder(
                          padding: const EdgeInsets.all(16),
                          gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(crossAxisCount: 3, childAspectRatio: 0.85, mainAxisSpacing: 18, crossAxisSpacing: 14),
                          itemCount: _apps.length,
                          itemBuilder: (_, i) {
                            final a = _apps[i];
                            final fav = a['favoritedByMe'] == true;
                            return InkWell(
                              onTap: () => _open(a),
                              borderRadius: BorderRadius.circular(12),
                              child: Column(mainAxisSize: MainAxisSize.min, children: [
                                Stack(children: [
                                  Container(width: 60, height: 60, decoration: BoxDecoration(color: Ux.cellIconBg(t), borderRadius: BorderRadius.circular(16)), child: Icon(Icons.apps_rounded, color: t.text, size: 30)),
                                  Positioned(
                                    right: 0,
                                    bottom: 0,
                                    child: InkWell(
                                      onTap: () => _toggleFav(a, !fav),
                                      child: Icon(fav ? Icons.star : Icons.star_border, color: fav ? Ux.green : t.subText, size: 18),
                                    ),
                                  ),
                                ]),
                                const SizedBox(height: 8),
                                Text((a['name'] ?? '').toString(), style: TextStyle(color: t.text, fontWeight: FontWeight.w600, fontSize: 13), maxLines: 1, overflow: TextOverflow.ellipsis),
                                if ((a['description'] ?? '').toString().isNotEmpty)
                                  Text((a['description'] ?? '').toString(), style: TextStyle(color: t.subText, fontSize: 11), maxLines: 1, overflow: TextOverflow.ellipsis),
                              ]),
                            );
                          },
                        ),
        ),
      ]),
    );
  }
}
