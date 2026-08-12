import 'dart:io';

import 'package:flutter/material.dart';

import 'services/securechat_api.dart';

class MiniAppsPage extends StatefulWidget {
  const MiniAppsPage({super.key, required this.api, required this.config});
  final SecureChatApi api;
  final dynamic config;
  @override
  State<MiniAppsPage> createState() => _MiniAppsPageState();
}

class _MiniAppsPageState extends State<MiniAppsPage> {
  final _apps = <Map<String, dynamic>>[];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _reload();
  }

  Future<void> _reload() async {
    setState(() { _loading = true; _error = null; });
    try {
      _apps
        ..clear()
        ..addAll(await widget.api.miniApps());
    } catch (e) {
      _error = e.toString().replaceFirst('Bad state: ', '');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _open(Map<String, dynamic> a) {
    final url = (a['url'] ?? '').toString();
    if (url.isEmpty) return;
    try {
      if (Platform.isWindows) {
        Process.start('cmd', ['/c', 'start', '', url]);
      } else if (Platform.isMacOS) {
        Process.start('open', [url]);
      } else {
        Process.start('xdg-open', [url]);
      }
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('无法打开：$e')));
    }
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
        title: Text('小程序', style: TextStyle(color: cs.onSurface, fontWeight: FontWeight.w700)),
        leading: IconButton(icon: Icon(Icons.arrow_back, color: cs.onSurface), onPressed: () => Navigator.of(context).maybePop()),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(child: Text(_error!, style: TextStyle(color: cs.error)))
              : _apps.isEmpty
                  ? Center(child: Text('暂无小程序', style: TextStyle(color: cs.onSurfaceVariant)))
                  : GridView.builder(
                      padding: const EdgeInsets.all(20),
                      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(crossAxisCount: 3, childAspectRatio: 0.85, mainAxisSpacing: 18, crossAxisSpacing: 14),
                      itemCount: _apps.length,
                      itemBuilder: (_, i) {
                        final a = _apps[i];
                        return InkWell(
                          onTap: () => _open(a),
                          borderRadius: BorderRadius.circular(14),
                          child: Column(mainAxisSize: MainAxisSize.min, children: [
                            Container(
                              width: 60, height: 60,
                              decoration: BoxDecoration(color: color.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(16)),
                              child: Icon(Icons.apps_rounded, color: color, size: 32),
                            ),
                            const SizedBox(height: 8),
                            Text(a['name'] ?? '', style: TextStyle(color: cs.onSurface, fontWeight: FontWeight.w600, fontSize: 13), maxLines: 1, overflow: TextOverflow.ellipsis),
                            if ((a['description'] ?? '').toString().isNotEmpty)
                              Text(a['description'], style: TextStyle(color: cs.onSurfaceVariant, fontSize: 11), maxLines: 1, overflow: TextOverflow.ellipsis),
                          ]),
                        );
                      },
                    ),
    );
  }
}