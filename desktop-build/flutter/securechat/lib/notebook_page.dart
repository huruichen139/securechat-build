import 'package:flutter/material.dart';

import 'services/app_config.dart';
import 'services/securechat_api.dart';
import 'widgets/ux.dart';

class NotebookPage extends StatefulWidget {
  const NotebookPage({super.key, required this.api, required this.config});
  final SecureChatApi api;
  final dynamic config;
  @override
  State<NotebookPage> createState() => _NotebookPageState();
}

class _NotebookPageState extends State<NotebookPage> {
  final _notes = <Map<String, dynamic>>[];
  bool _loading = true;
  String? _error;
  final _input = TextEditingController();

  @override
  void initState() {
    super.initState();
    _reload();
  }

  Future<void> _reload() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      _notes
        ..clear()
        ..addAll(await widget.api.notes());
    } catch (e) {
      _error = e.toString().replaceFirst('Bad state: ', '');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _add() async {
    final text = _input.text.trim();
    if (text.isEmpty) return;
    try {
      await widget.api.addNote(text);
      setState(() => _input.clear());
      await _reload();
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('保存失败：$e')));
    }
  }

  Future<void> _delete(int id) async {
    try {
      await widget.api.deleteNote(id);
      await _reload();
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('删除失败：$e')));
    }
  }

  String _fmt(dynamic v) {
    final ms = v is int ? v : int.tryParse('$v') ?? 0;
    if (ms == 0) return '';
    final dt = DateTime.fromMillisecondsSinceEpoch(ms);
    String two(int x) => x.toString().padLeft(2, '0');
    return '${dt.month}/${dt.day} ${two(dt.hour)}:${two(dt.minute)}';
  }

  @override
  void dispose() {
    _input.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final cfg = widget.config as AppConfig;
    final t = cfg.theme;
    return Scaffold(
      backgroundColor: t.bg,
      body: Column(children: [
        PageHeader(title: '我的笔记', config: cfg),
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
          child: Row(children: [
            Expanded(
              child: TextField(
                controller: _input,
                maxLines: null,
                style: TextStyle(color: t.text),
                decoration: const InputDecoration(hintText: '写下一条笔记...'),
              ),
            ),
            const SizedBox(width: 10),
            FilledButton(onPressed: _add, child: const Text('保存')),
          ]),
        ),
        Divider(height: 1, color: t.div.withValues(alpha: 0.6)),
        Expanded(
          child: _loading
              ? const Center(child: CircularProgressIndicator())
              : _error != null
                  ? Center(child: Text(_error!, style: TextStyle(color: t.subText)))
                  : _notes.isEmpty
                      ? Center(child: Text('还没有笔记', style: TextStyle(color: t.subText)))
                      : ListView.builder(
                          padding: const EdgeInsets.all(12),
                          itemCount: _notes.length,
                          itemBuilder: (_, i) {
                            final n = _notes[i];
                            return Container(
                              margin: const EdgeInsets.only(bottom: 8),
                              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                              decoration: BoxDecoration(color: t.card.withValues(alpha: 0.85), borderRadius: BorderRadius.circular(Ux.cardRadius), border: Border.all(color: t.div.withValues(alpha: 0.6))),
                              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                Icon(Icons.sticky_note_2_outlined, color: t.subText, size: 20),
                                const SizedBox(width: 10),
                                Expanded(
                                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                    Text((n['content'] ?? '').toString(), style: TextStyle(color: t.text, fontSize: 14)),
                                    const SizedBox(height: 4),
                                    Text(_fmt(n['createdAt']), style: TextStyle(color: t.subText, fontSize: 11)),
                                  ]),
                                ),
                                IconButton(icon: Icon(Icons.delete_outline, color: t.subText, size: 20), onPressed: () => _delete(n['id'] as int)),
                              ]),
                            );
                          },
                        ),
        ),
      ]),
    );
  }
}
