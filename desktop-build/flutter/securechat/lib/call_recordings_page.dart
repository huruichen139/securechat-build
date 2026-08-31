import 'dart:io';

import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';

import 'services/securechat_api.dart';
import 'services/app_config.dart';
import 'widgets/ux.dart';

class CallRecordingsPage extends StatefulWidget {
  const CallRecordingsPage({super.key, required this.api, required this.config, this.peerId});
  final SecureChatApi api;
  final AppConfig config;
  final int? peerId;
  @override
  State<CallRecordingsPage> createState() => _CallRecordingsPageState();
}

class _CallRecordingsPageState extends State<CallRecordingsPage> {
  List<Map<String, dynamic>> _items = [];
  bool _loading = true;
  String? _error;
  AppTheme get _t => widget.config.theme;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final rows = await widget.api.callRecordings(peerId: widget.peerId);
      if (!mounted) return;
      setState(() { _items = rows; _loading = false; });
    } catch (e) {
      if (mounted) setState(() { _error = e.toString().replaceFirst('Bad state: ', ''); _loading = false; });
    }
  }

  Future<void> _play(Map<String, dynamic> r) async {
    final id = (r['id'] ?? '').toString();
    if (id.isEmpty) return;
    final ctx = context;
    showDialog(context: ctx, barrierDismissible: false, builder: (_) => const AlertDialog(content: Row(children: [CircularProgressIndicator(), SizedBox(width: 16), Text('正在获取回放…')])));
    try {
      final bytes = await widget.api.fetchCallRecording(id);
      final dir = await getTemporaryDirectory();
      final kind = (r['kind'] ?? 'audio').toString();
      final path = '${dir.path}/securechat-call-$id.${kind == 'video' ? 'webm' : 'webm'}';
      await File(path).writeAsBytes(bytes);
      if (Navigator.canPop(ctx)) Navigator.pop(ctx);
      if (!mounted) return;
      if (Platform.isWindows) {
        await Process.run('cmd', ['/c', 'start', '', path]);
      } else if (Platform.isMacOS) {
        await Process.run('open', [path]);
      } else if (Platform.isLinux) {
        await Process.run('xdg-open', [path]);
      } else {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('已保存回放：$path')));
      }
    } catch (e) {
      if (Navigator.canPop(ctx)) Navigator.pop(ctx);
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('回放失败：$e')));
    }
  }

  String _fmtTime(dynamic v) {
    final ms = v is int ? v : int.tryParse('$v') ?? 0;
    if (ms == 0) return '';
    final dt = DateTime.fromMillisecondsSinceEpoch(ms);
    String two(int x) => x.toString().padLeft(2, '0');
    return '${dt.month}/${dt.day} ${two(dt.hour)}:${two(dt.minute)}';
  }

  String _fmtSize(dynamic v) {
    final n = v is num ? v.toDouble() : 0;
    if (n <= 0) return '';
    if (n >= 1024 * 1024) return '${(n / 1024 / 1024).toStringAsFixed(1)} MB';
    if (n >= 1024) return '${(n / 1024).toStringAsFixed(0)} KB';
    return '${n.toInt()} B';
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: _t.bg,
      appBar: AppBar(backgroundColor: _t.bg, title: Text('通话回放', style: TextStyle(color: _t.text)), iconTheme: IconThemeData(color: _t.text)),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(child: Text(_error!, style: TextStyle(color: _t.subText)))
              : RefreshIndicator(
                  onRefresh: _load,
                  color: Ux.green,
                  child: _items.isEmpty
                      ? ListView(children: [const SizedBox(height: 80), Center(child: Text('暂无通话回放记录', style: TextStyle(color: _t.subText)))])
                      : ListView.separated(
                          padding: const EdgeInsets.all(12),
                          itemCount: _items.length,
                          separatorBuilder: (_, i) => const SizedBox(height: 10),
                          itemBuilder: (_, i) {
                            final r = _items[i];
                            final video = (r['kind'] ?? 'audio').toString() == 'video';
                            return Card(
                              color: _t.card,
                              elevation: 0,
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(Ux.cardRadius),
                                side: BorderSide(color: _t.div.withValues(alpha: 0.6)),
                              ),
                              child: ListTile(
                                onTap: () => _play(r),
                                leading: Container(
                                  width: 44,
                                  height: 44,
                                  decoration: BoxDecoration(color: Ux.cellIconBg(_t), borderRadius: BorderRadius.circular(10)),
                                  child: Icon(video ? Icons.videocam_rounded : Icons.call_rounded, color: Ux.green),
                                ),
                                title: Text(video ? '视频通话回放' : '语音通话回放', style: TextStyle(color: _t.text, fontWeight: FontWeight.w600)),
                                subtitle: Text(
                                  '${_fmtTime(r['createdAt'])}${_fmtSize(r['size']).isNotEmpty ? ' · ${_fmtSize(r['size'])}' : ''}',
                                  style: TextStyle(color: _t.subText, fontSize: 12),
                                ),
                                trailing: const Icon(Icons.play_circle_outline, color: Ux.green),
                              ),
                            );
                          },
                        ),
                ),
    );
  }
}
