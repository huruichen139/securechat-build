import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'services/securechat_api.dart';

const _kNotesKey = 'notes_list';
const _kTodoKey = 'todo_list';
const _kQuickRepliesKey = 'quick_replies';
const _kRemindersKey = 'reminders_list';
const _kMoodStatusKey = 'mood_status';
const _kMoodTextKey = 'mood_text';

class NotesPage extends StatelessWidget {
  const NotesPage({super.key});

  @override
  Widget build(BuildContext context) {
    return _Scaffold('安全便签', const _NotesBody());
  }
}

class _NotesBody extends StatefulWidget {
  const _NotesBody();
  @override
  State<_NotesBody> createState() => _NotesBodyState();
}

class _NotesBodyState extends State<_NotesBody> {
  final controller = TextEditingController();
  final notes = <(String, int)>[];
  bool _loaded = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final sp = await SharedPreferences.getInstance();
    final raw = sp.getString(_kNotesKey);
    if (raw != null) {
      try {
        final list = jsonDecode(raw) as List;
        notes.clear();
        for (final e in list) {
          if (e is Map) {
            notes.add(((e['text'] ?? '').toString(), (e['ts'] ?? 0) as int));
          } else if (e is String) {
            notes.add((e, 0));
          }
        }
      } catch (_) {}
    }
    if (mounted) setState(() => _loaded = true);
  }

  Future<void> _persist() async {
    final sp = await SharedPreferences.getInstance();
    final list = notes.map((n) => {'text': n.$1, 'ts': n.$2}).toList();
    await sp.setString(_kNotesKey, jsonEncode(list));
  }

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  void _save() {
    final text = controller.text.trim();
    if (text.isEmpty) return;
    setState(() {
      notes.insert(0, (text, DateTime.now().millisecondsSinceEpoch));
      controller.clear();
    });
    _persist();
  }

  void _delete(int i) {
    setState(() => notes.removeAt(i));
    _persist();
  }

  String _fmtTime(int ts) {
    if (ts == 0) return '';
    final dt = DateTime.fromMillisecondsSinceEpoch(ts);
    String two(int v) => v.toString().padLeft(2, '0');
    return '${dt.month}/${dt.day} ${two(dt.hour)}:${two(dt.minute)}';
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.all(20),
      child: Column(children: [
        Row(children: [
          Expanded(child: TextField(controller: controller, decoration: const InputDecoration(hintText: '输入便签内容'))),
          const SizedBox(width: 10),
          FilledButton(onPressed: _save, child: const Text('保存')),
        ]),
        const SizedBox(height: 16),
        Expanded(
          child: !_loaded
              ? const Center(child: CircularProgressIndicator())
              : notes.isEmpty
                  ? Center(child: Text('还没有便签，写下一条吧', style: TextStyle(color: cs.onSurfaceVariant)))
                  : ListView.separated(
                      itemCount: notes.length,
                      separatorBuilder: (_, i) => const SizedBox(height: 8),
                      itemBuilder: (_, i) {
                        final (text, ts) = notes[i];
                        return Container(
                          padding: const EdgeInsets.all(14),
                          decoration: BoxDecoration(color: cs.surface, borderRadius: BorderRadius.circular(12), boxShadow: [BoxShadow(color: cs.shadow.withValues(alpha: 0.08), blurRadius: 8, offset: const Offset(0, 2))]),
                          child: Row(children: [
                            Icon(Icons.sticky_note_2_outlined, color: cs.primary),
                            const SizedBox(width: 10),
                            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                              Text(text, style: TextStyle(color: cs.onSurface)),
                              if (ts > 0) ...[
                                const SizedBox(height: 3),
                                Text(_fmtTime(ts), style: TextStyle(color: cs.onSurfaceVariant, fontSize: 11)),
                              ],
                            ])),
                            IconButton(icon: Icon(Icons.delete_outline, color: cs.error), onPressed: () => _delete(i)),
                          ]),
                        );
                      },
                    ),
        ),
      ]),
    );
  }
}

class TodoPage extends StatelessWidget {
  const TodoPage({super.key});

  @override
  Widget build(BuildContext context) {
    return _Scaffold('待办清单', const _TodoBody());
  }
}

class _TodoBody extends StatefulWidget {
  const _TodoBody();
  @override
  State<_TodoBody> createState() => _TodoBodyState();
}

class _TodoItem {
  String text;
  bool done = false;
  _TodoItem(this.text);
  Map<String, dynamic> toJson() => {'text': text, 'done': done};
  factory _TodoItem.fromJson(Map<String, dynamic> j) {
    final it = _TodoItem((j['text'] ?? '').toString());
    it.done = j['done'] == true;
    return it;
  }
}

class _TodoBodyState extends State<_TodoBody> {
  final controller = TextEditingController();
  final items = <_TodoItem>[];
  bool _loaded = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final sp = await SharedPreferences.getInstance();
    final raw = sp.getString(_kTodoKey);
    if (raw != null) {
      try {
        final list = jsonDecode(raw) as List;
        items.clear();
        for (final e in list) {
          if (e is Map) items.add(_TodoItem.fromJson(e.cast<String, dynamic>()));
        }
      } catch (_) {}
    }
    if (mounted) setState(() => _loaded = true);
  }

  Future<void> _persist() async {
    final sp = await SharedPreferences.getInstance();
    await sp.setString(_kTodoKey, jsonEncode(items.map((e) => e.toJson()).toList()));
  }

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  void _add() {
    final text = controller.text.trim();
    if (text.isEmpty) return;
    setState(() {
      items.add(_TodoItem(text));
      controller.clear();
    });
    _persist();
  }

  void _toggle(int i, bool v) {
    setState(() => items[i].done = v);
    _persist();
  }

  void _delete(int i) {
    setState(() => items.removeAt(i));
    _persist();
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.all(20),
      child: Column(children: [
        Row(children: [
          Expanded(child: TextField(controller: controller, decoration: const InputDecoration(hintText: '添加待办事项'))),
          const SizedBox(width: 10),
          FilledButton(onPressed: _add, child: const Text('添加')),
        ]),
        const SizedBox(height: 16),
        Expanded(
          child: !_loaded
              ? const Center(child: CircularProgressIndicator())
              : items.isEmpty
                  ? Center(child: Text('还没有待办', style: TextStyle(color: cs.onSurfaceVariant)))
                  : ListView.separated(
                      itemCount: items.length,
                      separatorBuilder: (_, i) => const SizedBox(height: 4),
                      itemBuilder: (_, i) {
                        final item = items[i];
                        return Container(
                          padding: const EdgeInsets.symmetric(horizontal: 8),
                          decoration: BoxDecoration(color: cs.surface, borderRadius: BorderRadius.circular(12)),
                          child: Row(children: [
                            Checkbox(value: item.done, activeColor: cs.primary, onChanged: (v) => _toggle(i, v ?? false)),
                            Expanded(child: Text(item.text, style: TextStyle(color: cs.onSurface, decoration: item.done ? TextDecoration.lineThrough : null, decorationColor: cs.onSurfaceVariant))),
                            IconButton(icon: Icon(Icons.delete_outline, color: cs.error), onPressed: () => _delete(i)),
                          ]),
                        );
                      },
                    ),
        ),
      ]),
    );
  }
}

class QuickRepliesPage extends StatelessWidget {
  const QuickRepliesPage({super.key});

  @override
  Widget build(BuildContext context) {
    return _Scaffold('快捷回复', const _QuickRepliesBody());
  }
}

class _QuickRepliesBody extends StatefulWidget {
  const _QuickRepliesBody();
  @override
  State<_QuickRepliesBody> createState() => _QuickRepliesBodyState();
}

class _QuickRepliesBodyState extends State<_QuickRepliesBody> {
  static const _defaults = ['收到', '好的', '稍等，我在忙', '爱你', '晚安', 'OK', 'Got it', 'One moment please', 'Thanks!', 'See you soon', 'Good night', 'Yes', 'No problem', 'Let me check'];
  final controller = TextEditingController();
  final replies = <String>[];
  bool _loaded = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final sp = await SharedPreferences.getInstance();
    final raw = sp.getString(_kQuickRepliesKey);
    if (raw == null) {
      replies.addAll(_defaults);
    } else {
      try {
        final list = jsonDecode(raw) as List;
        replies.clear();
        for (final e in list) {
          if (e is String && e.isNotEmpty) replies.add(e);
        }
        if (replies.isEmpty) replies.addAll(_defaults);
      } catch (_) {
        replies.addAll(_defaults);
      }
    }
    if (mounted) setState(() => _loaded = true);
  }

  Future<void> _persist() async {
    final sp = await SharedPreferences.getInstance();
    await sp.setString(_kQuickRepliesKey, jsonEncode(replies));
  }

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  void _copy(String text) {
    Clipboard.setData(ClipboardData(text: text));
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('已复制：$text')));
  }

  void _add() {
    final text = controller.text.trim();
    if (text.isEmpty) return;
    setState(() {
      replies.add(text);
      controller.clear();
    });
    _persist();
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.all(20),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('点击短语即可复制到剪贴板', style: TextStyle(color: cs.onSurfaceVariant)),
        const SizedBox(height: 12),
        Row(children: [
          Expanded(child: TextField(controller: controller, decoration: const InputDecoration(hintText: '添加自定义短语'))),
          const SizedBox(width: 10),
          FilledButton(onPressed: _add, child: const Text('添加')),
        ]),
        const SizedBox(height: 16),
        Expanded(
          child: !_loaded
              ? const Center(child: CircularProgressIndicator())
              : Align(
                  alignment: Alignment.topLeft,
                  child: Wrap(spacing: 10, runSpacing: 10, children: [
                    for (final r in replies)
                      ActionChip(label: Text(r), backgroundColor: cs.surface, side: BorderSide(color: cs.outlineVariant), onPressed: () => _copy(r)),
                  ]),
                ),
        ),
      ]),
    );
  }
}

class FileCenterPage extends StatelessWidget {
  const FileCenterPage({super.key, this.api});

  final SecureChatApi? api;

  @override
  Widget build(BuildContext context) {
    return _Scaffold('我的文件', _FileCenterBody(api: api));
  }
}

class _FileItem {
  final String name;
  final String mime;
  final int size;
  final int time;
  _FileItem(this.name, this.mime, this.size, this.time);
}

class _FileCenterBody extends StatefulWidget {
  const _FileCenterBody({this.api});
  final SecureChatApi? api;
  @override
  State<_FileCenterBody> createState() => _FileCenterBodyState();
}

class _FileCenterBodyState extends State<_FileCenterBody> {
  final query = TextEditingController();
  final files = <_FileItem>[];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _reload();
  }

  Future<void> _reload() async {
    final api = widget.api;
    if (api == null) {
      setState(() {
        _loading = false;
        _error = '请从主界面进入';
      });
      return;
    }
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final data = await api.myFiles();
      files.clear();
      for (final f in data) {
        files.add(_FileItem(
          (f['name'] ?? '').toString(),
          (f['mime'] ?? '').toString(),
          f['size'] is int ? f['size'] as int : int.tryParse('${f['size']}') ?? 0,
          f['time'] is int ? f['time'] as int : int.tryParse('${f['time']}') ?? 0,
        ));
      }
    } catch (e) {
      _error = e.toString().replaceFirst('Bad state: ', '');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  void dispose() {
    query.dispose();
    super.dispose();
  }

  List<_FileItem> get _filtered {
    final q = query.text.trim().toLowerCase();
    if (q.isEmpty) return files;
    return files.where((f) => f.name.toLowerCase().contains(q)).toList();
  }

  String _fmtSize(int bytes) {
    if (bytes < 1024) return '$bytes B';
    if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
    if (bytes < 1024 * 1024 * 1024) return '${(bytes / 1024 / 1024).toStringAsFixed(1)} MB';
    return '${(bytes / 1024 / 1024 / 1024).toStringAsFixed(1)} GB';
  }

  String _fmtTime(int ms) {
    if (ms == 0) return '';
    final dt = DateTime.fromMillisecondsSinceEpoch(ms);
    String two(int v) => v.toString().padLeft(2, '0');
    return '${dt.year}/${dt.month}/${dt.day} ${two(dt.hour)}:${two(dt.minute)}';
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.all(20),
      child: Column(children: [
        Row(children: [
          Expanded(child: TextField(controller: query, decoration: InputDecoration(hintText: '搜索文件', prefixIcon: Icon(Icons.search, color: cs.onSurfaceVariant)), onChanged: (_) => setState(() {}))),
          const SizedBox(width: 10),
          IconButton(
            tooltip: '刷新',
            onPressed: _reload,
            icon: Icon(Icons.refresh, color: cs.primary),
          ),
        ]),
        const SizedBox(height: 16),
        Expanded(
          child: _loading
              ? const Center(child: CircularProgressIndicator())
              : _error != null
                  ? Center(child: Text(_error!, style: TextStyle(color: cs.error)))
                  : _filtered.isEmpty
                      ? Center(child: Text('没有匹配的文件', style: TextStyle(color: cs.onSurfaceVariant)))
                      : ListView.separated(
                          itemCount: _filtered.length,
                          separatorBuilder: (_, i) => const SizedBox(height: 8),
                          itemBuilder: (_, i) {
                            final f = _filtered[i];
                            return Container(
                              padding: const EdgeInsets.all(14),
                              decoration: BoxDecoration(color: cs.surface, borderRadius: BorderRadius.circular(12), boxShadow: [BoxShadow(color: cs.shadow.withValues(alpha: 0.08), blurRadius: 8, offset: const Offset(0, 2))]),
                              child: Row(children: [
                                Icon(Icons.insert_drive_file_outlined, color: cs.primary),
                                const SizedBox(width: 12),
                                Expanded(
                                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                    Text(f.name, style: TextStyle(color: cs.onSurface, fontWeight: FontWeight.w600)),
                                    const SizedBox(height: 3),
                                    Text('${_fmtSize(f.size)} · ${_fmtTime(f.time)}', style: TextStyle(color: cs.onSurfaceVariant, fontSize: 12)),
                                  ]),
                                ),
                              ]),
                            );
                          },
                        ),
        ),
      ]),
    );
  }
}

class FavoritesPage extends StatelessWidget {
  const FavoritesPage({super.key, this.api});

  final SecureChatApi? api;

  @override
  Widget build(BuildContext context) {
    return _Scaffold('我的收藏', _FavoritesBody(api: api));
  }
}

class _FavoritesBody extends StatefulWidget {
  const _FavoritesBody({this.api});
  final SecureChatApi? api;
  @override
  State<_FavoritesBody> createState() => _FavoritesBodyState();
}

class _FavoritesBodyState extends State<_FavoritesBody> {
  final favorites = <Map<String, dynamic>>[];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _reload();
  }

  Future<void> _reload() async {
    final api = widget.api;
    if (api == null) {
      setState(() {
        _loading = false;
        _error = '请从主界面进入';
      });
      return;
    }
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      favorites.clear();
      favorites.addAll(await api.favorites());
    } catch (e) {
      _error = e.toString().replaceFirst('Bad state: ', '');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _unfavorite(int id) async {
    final api = widget.api;
    if (api == null) return;
    try {
      await api.setFavorite(id, favorite: false);
      await _reload();
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('取消收藏失败：$e')));
    }
  }

  int _toInt(dynamic v) => v is int ? v : int.tryParse('$v') ?? 0;

  String _fmtTime(dynamic v) {
    final ms = _toInt(v);
    if (ms == 0) return '';
    final dt = DateTime.fromMillisecondsSinceEpoch(ms);
    String two(int x) => x.toString().padLeft(2, '0');
    return '${dt.month}/${dt.day} ${two(dt.hour)}:${two(dt.minute)}';
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    if (widget.api == null && !_loading) {
      return Padding(
        padding: const EdgeInsets.all(20),
        child: Center(child: Text('请从主界面进入', style: TextStyle(color: cs.onSurfaceVariant))),
      );
    }
    return Padding(
      padding: const EdgeInsets.all(20),
      child: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(child: Text(_error!, style: TextStyle(color: cs.error)))
              : favorites.isEmpty
                  ? Center(child: Text('还没有收藏消息', style: TextStyle(color: cs.onSurfaceVariant)))
                  : ListView.separated(
                      itemCount: favorites.length,
                      separatorBuilder: (_, i) => const SizedBox(height: 8),
                      itemBuilder: (_, i) {
                        final m = favorites[i];
                        final content = (m['content'] ?? '').toString();
                        final from = _toInt(m['from']);
                        final favAt = _fmtTime(m['favoritedAt']);
                        return Container(
                          padding: const EdgeInsets.all(14),
                          decoration: BoxDecoration(color: cs.surface, borderRadius: BorderRadius.circular(12), boxShadow: [BoxShadow(color: cs.shadow.withValues(alpha: 0.08), blurRadius: 8, offset: const Offset(0, 2))]),
                          child: Row(children: [
                            Icon(Icons.favorite, color: cs.error),
                            const SizedBox(width: 12),
                            Expanded(child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(content, style: TextStyle(color: cs.onSurface)),
                                const SizedBox(height: 4),
                                Text('来自 $from${favAt.isEmpty ? '' : ' · 收藏于 $favAt'}', style: TextStyle(color: cs.onSurfaceVariant, fontSize: 11)),
                              ],
                            )),
                            IconButton(
                              icon: Icon(Icons.favorite, color: cs.error),
                              tooltip: '取消收藏',
                              onPressed: () => _unfavorite(_toInt(m['id'])),
                            ),
                          ]),
                        );
                      },
                    ),
    );
  }
}

class ReminderPage extends StatelessWidget {
  const ReminderPage({super.key});

  @override
  Widget build(BuildContext context) {
    return _Scaffold('定时提醒', const _ReminderBody());
  }
}

class _ReminderBody extends StatefulWidget {
  const _ReminderBody();
  @override
  State<_ReminderBody> createState() => _ReminderBodyState();
}

class _ReminderBodyState extends State<_ReminderBody> {
  final controller = TextEditingController();
  TimeOfDay? time;
  final reminders = <(String, TimeOfDay)>[];
  bool _loaded = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final sp = await SharedPreferences.getInstance();
    final raw = sp.getString(_kRemindersKey);
    if (raw != null) {
      try {
        final list = jsonDecode(raw) as List;
        reminders.clear();
        for (final e in list) {
          if (e is Map) {
            final text = (e['text'] ?? '').toString();
            final hour = e['hour'] as int?;
            final minute = e['minute'] as int?;
            if (hour != null && minute != null) reminders.add((text, TimeOfDay(hour: hour, minute: minute)));
          }
        }
      } catch (_) {}
    }
    if (mounted) setState(() => _loaded = true);
  }

  Future<void> _persist() async {
    final sp = await SharedPreferences.getInstance();
    final list = reminders.map((r) => {'text': r.$1, 'hour': r.$2.hour, 'minute': r.$2.minute}).toList();
    await sp.setString(_kRemindersKey, jsonEncode(list));
  }

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  Future<void> _pickTime() async {
    final picked = await showTimePicker(context: context, initialTime: TimeOfDay.now());
    if (picked != null) setState(() => time = picked);
  }

  void _add() {
    final text = controller.text.trim();
    if (text.isEmpty || time == null) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('请输入提醒内容并选择时间')));
      return;
    }
    setState(() {
      reminders.add((text, time!));
      controller.clear();
    });
    _persist();
  }

  void _delete(int i) {
    setState(() => reminders.removeAt(i));
    _persist();
  }

  String _format(TimeOfDay t) {
    final h = t.hourOfPeriod.toString().padLeft(2, '0');
    final m = t.minute.toString().padLeft(2, '0');
    return '$h:$m ${t.period == DayPeriod.am ? '上午' : '下午'}';
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.all(20),
      child: Column(children: [
        Row(children: [
          Expanded(child: TextField(controller: controller, decoration: const InputDecoration(hintText: '提醒内容'))),
          const SizedBox(width: 10),
          OutlinedButton(
            onPressed: _pickTime,
            child: Text(time == null ? '选择时间' : _format(time!), style: TextStyle(color: cs.primary)),
          ),
          const SizedBox(width: 10),
          FilledButton(onPressed: _add, child: const Text('设置')),
        ]),
        const SizedBox(height: 16),
        Expanded(
          child: !_loaded
              ? const Center(child: CircularProgressIndicator())
              : reminders.isEmpty
                  ? Center(child: Text('还没有提醒', style: TextStyle(color: cs.onSurfaceVariant)))
                  : ListView.separated(
                      itemCount: reminders.length,
                      separatorBuilder: (_, i) => const SizedBox(height: 8),
                      itemBuilder: (_, i) {
                        final (text, t) = reminders[i];
                        return Container(
                          padding: const EdgeInsets.all(14),
                          decoration: BoxDecoration(color: cs.surface, borderRadius: BorderRadius.circular(12), boxShadow: [BoxShadow(color: cs.shadow.withValues(alpha: 0.08), blurRadius: 8, offset: const Offset(0, 2))]),
                          child: Row(children: [
                            Icon(Icons.alarm, color: cs.primary),
                            const SizedBox(width: 12),
                            Expanded(child: Text(text, style: TextStyle(color: cs.onSurface))),
                            const SizedBox(width: 8),
                            Text(_format(t), style: TextStyle(color: cs.primary, fontWeight: FontWeight.w600)),
                            IconButton(icon: Icon(Icons.delete_outline, color: cs.error), onPressed: () => _delete(i)),
                          ]),
                        );
                      },
                    ),
        ),
      ]),
    );
  }
}

class EmojiBoard extends StatefulWidget {
  const EmojiBoard({super.key, required this.onPick});
  final ValueChanged<String> onPick;

  @override
  State<EmojiBoard> createState() => _EmojiBoardState();
}

class _EmojiBoardState extends State<EmojiBoard> {
  final recent = <String>['😀', '👍', '❤️'];

  void _pick(String e) {
    widget.onPick(e);
    setState(() => recent.insert(0, e));
    if (recent.length > 8) recent.removeRange(8, recent.length);
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    const rows = [
      ['😀', '😁', '😂', '🤣', '😊', '😇', '🙂', '😉'],
      ['😍', '😘', '😜', '🤪', '😎', '🥳', '😴', '🤗'],
      ['🤔', '😐', '😴', '😬', '😢', '😭', '😡', '🤯'],
      ['👍', '👎', '👏', '🙌', '🤝', '💪', '🙏', '🤞'],
      ['❤️', '💕', '💖', '💗', '💛', '💚', '💙', '💜'],
      ['🎉', '🎊', '😮', '🤩', '🥺', '🤤', '😳', '😱'],
    ];
    return Column(children: [
      for (final row in rows)
        Expanded(
          child: Row(children: [
            for (final e in row)
              Expanded(child: InkWell(onTap: () => _pick(e), child: Center(child: Text(e, style: const TextStyle(fontSize: 24))))),
          ]),
        ),
      Divider(height: 1, color: cs.outlineVariant),
      Container(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Row(children: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 10),
            child: Text('最近', style: TextStyle(color: cs.onSurfaceVariant, fontSize: 12)),
          ),
          for (final e in recent)
            InkWell(onTap: () => _pick(e), child: Padding(padding: const EdgeInsets.symmetric(horizontal: 6), child: Text(e, style: const TextStyle(fontSize: 22)))),
        ]),
      ),
    ]);
  }
}

class MoodStatusPage extends StatelessWidget {
  const MoodStatusPage({super.key});

  @override
  Widget build(BuildContext context) {
    return _Scaffold('心情 / 在线状态', const _MoodStatusBody());
  }
}

class _MoodStatusBody extends StatefulWidget {
  const _MoodStatusBody();
  @override
  State<_MoodStatusBody> createState() => _MoodStatusBodyState();
}

class _MoodStatusBodyState extends State<_MoodStatusBody> {
  static const statuses = ['在线', '忙碌', '离开', '隐身', '请勿打扰'];
  static const icons = [Icons.circle, Icons.alarm_on, Icons.timer_off, Icons.visibility_off, Icons.remove_circle_outline];
  static const colors = [Color(0xff18a66a), Color(0xfff59e0b), Color(0xffd8a03a), Color(0xff77818a), Color(0xffef4444)];

  int status = 0;
  final moodController = TextEditingController();

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final sp = await SharedPreferences.getInstance();
    final s = sp.getInt(_kMoodStatusKey);
    if (s != null && s >= 0 && s < statuses.length) status = s;
    final text = sp.getString(_kMoodTextKey);
    if (text != null) moodController.text = text;
    if (mounted) setState(() {});
  }

  Future<void> _persist() async {
    final sp = await SharedPreferences.getInstance();
    await sp.setInt(_kMoodStatusKey, status);
    await sp.setString(_kMoodTextKey, moodController.text);
  }

  @override
  void dispose() {
    moodController.dispose();
    super.dispose();
  }

  void _update() {
    _persist();
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('状态已更新：${statuses[status]} · ${moodController.text.trim().isEmpty ? '无短语' : moodController.text.trim()}')));
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.all(20),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('选择在线状态', style: TextStyle(fontWeight: FontWeight.w600, color: cs.onSurface)),
        const SizedBox(height: 10),
        for (var i = 0; i < statuses.length; i++)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: InkWell(
              onTap: () {
                setState(() => status = i);
                _persist();
              },
              child: Container(
                width: double.infinity,
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(color: status == i ? cs.primary.withValues(alpha: 0.15) : cs.surface, borderRadius: BorderRadius.circular(12)),
                child: Row(children: [
                  Icon(icons[i], color: colors[i]),
                  const SizedBox(width: 12),
                  Text(statuses[i], style: TextStyle(color: cs.onSurface, fontWeight: status == i ? FontWeight.w700 : FontWeight.w500)),
                  const Spacer(),
                  if (status == i) Icon(Icons.check_circle, color: cs.primary),
                ]),
              ),
            ),
          ),
        const SizedBox(height: 12),
        Text('心情短语', style: TextStyle(fontWeight: FontWeight.w600, color: cs.onSurface)),
        const SizedBox(height: 10),
        Row(children: [
          Expanded(child: TextField(controller: moodController, decoration: const InputDecoration(hintText: '例如：今天心情很好'))),
          const SizedBox(width: 10),
          FilledButton(
            onPressed: _update,
            child: const Text('更新状态'),
          ),
        ]),
      ]),
    );
  }
}

class _Scaffold extends StatelessWidget {
  const _Scaffold(this.title, this.body);
  final String title;
  final Widget body;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Scaffold(
      backgroundColor: cs.surface,
      appBar: AppBar(
        backgroundColor: cs.surface,
        elevation: 0,
        title: Text(title, style: TextStyle(color: cs.onSurface, fontWeight: FontWeight.w700)),
        leading: IconButton(icon: Icon(Icons.arrow_back, color: cs.onSurface), onPressed: () => Navigator.of(context).maybePop()),
      ),
      body: body,
    );
  }
}
