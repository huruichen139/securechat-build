import 'package:flutter/material.dart';

import 'services/securechat_api.dart';

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
    setState(() { _loading = true; _error = null; });
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
    setState(() => _input.clear());
    try {
      await widget.api.addNote(text);
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
    final cs = Theme.of(context).colorScheme;
    final color = widget.config.theme.primary;
    return Scaffold(
      backgroundColor: cs.surface,
      appBar: AppBar(
        backgroundColor: cs.surface,
        elevation: 0,
        title: Text('我的笔记', style: TextStyle(color: cs.onSurface, fontWeight: FontWeight.w700)),
        leading: IconButton(icon: Icon(Icons.arrow_back, color: cs.onSurface), onPressed: () => Navigator.of(context).maybePop()),
      ),
      body: Column(children: [
        Container(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
          child: Row(children: [
            Expanded(child: TextField(controller: _input, maxLines: null, decoration: const InputDecoration(hintText: '写下一条笔记...'))),
            const SizedBox(width: 10),
            FilledButton(onPressed: _add, child: const Text('保存')),
          ]),
        ),
        Divider(height: 1, color: cs.outlineVariant),
        Expanded(
          child: _loading
              ? const Center(child: CircularProgressIndicator())
              : _error != null
                  ? Center(child: Text(_error!, style: TextStyle(color: cs.error)))
                  : _notes.isEmpty
                      ? Center(child: Text('还没有笔记', style: TextStyle(color: cs.onSurfaceVariant)))
                      : ListView.separated(
                          padding: const EdgeInsets.all(16),
                          itemCount: _notes.length,
                          separatorBuilder: (_, i) => const SizedBox(height: 8),
                          itemBuilder: (_, i) {
                            final n = _notes[i];
                            return Container(
                              padding: const EdgeInsets.all(14),
                              decoration: BoxDecoration(color: cs.surface, borderRadius: BorderRadius.circular(12), border: Border.all(color: cs.outlineVariant.withValues(alpha: 0.4))),
                              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                Icon(Icons.sticky_note_2_outlined, color: color, size: 20),
                                const SizedBox(width: 10),
                                Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                  Text(n['content'] ?? '', style: TextStyle(color: cs.onSurface, fontSize: 14)),
                                  const SizedBox(height: 4),
                                  Text(_fmt(n['createdAt']), style: TextStyle(color: cs.onSurfaceVariant, fontSize: 11)),
                                ])),
                                IconButton(icon: Icon(Icons.delete_outline, color: cs.error, size: 20), onPressed: () => _delete(n['id'] as int)),
                              ]),
                            );
                          },
                        ),
        ),
      ]),
    );
  }
}