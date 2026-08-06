import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

const _primary = Color(0xff18a66a);
const _text = Color(0xff17212b);
const _subText = Color(0xff77818a);
const _div = Color(0xffe3e8eb);
const _bg = Color(0xfff4f6f8);

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
  final notes = <String>[];

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  void _save() {
    final text = controller.text.trim();
    if (text.isEmpty) return;
    setState(() {
      notes.insert(0, text);
      controller.clear();
    });
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(20),
      child: Column(children: [
        Row(children: [
          Expanded(child: TextField(controller: controller, decoration: const InputDecoration(hintText: '输入便签内容'))),
          const SizedBox(width: 10),
          FilledButton(onPressed: _save, child: const Text('保存')),
        ]),
        const SizedBox(height: 16),
        Expanded(child: notes.isEmpty
            ? const Center(child: Text('还没有便签，写下一条吧', style: TextStyle(color: _subText)))
            : ListView.separated(
                itemCount: notes.length,
                separatorBuilder: (_, i) => const SizedBox(height: 8),
                itemBuilder: (_, i) => Container(
                  padding: const EdgeInsets.all(14),
                  decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(12), boxShadow: const [BoxShadow(color: Colors.black12, blurRadius: 8, offset: Offset(0, 2))]),
                  child: Row(children: [
                    const Icon(Icons.sticky_note_2_outlined, color: _primary),
                    const SizedBox(width: 10),
                    Expanded(child: Text(notes[i], style: const TextStyle(color: _text))),
                    IconButton(icon: const Icon(Icons.delete_outline, color: Colors.redAccent), onPressed: () => setState(() => notes.removeAt(i))),
                  ]),
                ),
              )),
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
}

class _TodoBodyState extends State<_TodoBody> {
  final controller = TextEditingController();
  final items = <_TodoItem>[];

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
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(20),
      child: Column(children: [
        Row(children: [
          Expanded(child: TextField(controller: controller, decoration: const InputDecoration(hintText: '添加待办事项'))),
          const SizedBox(width: 10),
          FilledButton(onPressed: _add, child: const Text('添加')),
        ]),
        const SizedBox(height: 16),
        Expanded(child: items.isEmpty
            ? const Center(child: Text('还没有待办', style: TextStyle(color: _subText)))
            : ListView.separated(
                itemCount: items.length,
                separatorBuilder: (_, i) => const SizedBox(height: 4),
                itemBuilder: (_, i) {
                  final item = items[i];
                  return Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8),
                    decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(12)),
                    child: Row(children: [
                      Checkbox(value: item.done, activeColor: _primary, onChanged: (v) => setState(() => item.done = v ?? false)),
                      Expanded(child: Text(item.text, style: TextStyle(color: _text, decoration: item.done ? TextDecoration.lineThrough : null, decorationColor: _subText))),
                      IconButton(icon: const Icon(Icons.delete_outline, color: Colors.redAccent), onPressed: () => setState(() => items.removeAt(i))),
                    ]),
                  );
                },
              )),
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
  final controller = TextEditingController();
  final replies = <String>['收到', '好的', '稍等，我在忙', '爱你', '晚安', 'OK', 'Got it', 'One moment please', 'Thanks!', 'See you soon', 'Good night', 'Yes', 'No problem', 'Let me check'];

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
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(20),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const Text('点击短语即可复制到剪贴板', style: TextStyle(color: _subText)),
        const SizedBox(height: 12),
        Row(children: [
          Expanded(child: TextField(controller: controller, decoration: const InputDecoration(hintText: '添加自定义短语'))),
          const SizedBox(width: 10),
          FilledButton(onPressed: _add, child: const Text('添加')),
        ]),
        const SizedBox(height: 16),
        Expanded(child: Align(
          alignment: Alignment.topLeft,
          child: Wrap(spacing: 10, runSpacing: 10, children: [
            for (final r in replies)
              ActionChip(label: Text(r), backgroundColor: Colors.white, side: const BorderSide(color: _div), onPressed: () => _copy(r)),
          ]),
        )),
      ]),
    );
  }
}

class FileCenterPage extends StatelessWidget {
  const FileCenterPage({super.key});

  @override
  Widget build(BuildContext context) {
    return _Scaffold('我的文件', const _FileCenterBody());
  }
}

class _FileCenterBody extends StatefulWidget {
  const _FileCenterBody();
  @override
  State<_FileCenterBody> createState() => _FileCenterBodyState();
}

class _FileCenterBodyState extends State<_FileCenterBody> {
  final query = TextEditingController();
  final files = <Map<String, String>>[
    {'name': '项目报告.pdf', 'size': '1.2 MB', 'time': '今天 09:24'},
    {'name': '会议纪要.docx', 'size': '240 KB', 'time': '昨天 18:02'},
    {'name': '证件照.png', 'size': '3.8 MB', 'time': '两天前 14:10'},
    {'name': '演示文稿.pptx', 'size': '5.1 MB', 'time': '三天前 11:45'},
    {'name': '照片合集.zip', 'size': '82 MB', 'time': '上周 16:30'},
  ];

  @override
  void dispose() {
    query.dispose();
    super.dispose();
  }

  List<Map<String, String>> get _filtered {
    final q = query.text.trim().toLowerCase();
    if (q.isEmpty) return files;
    return files.where((f) => f['name']!.toLowerCase().contains(q)).toList();
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(20),
      child: Column(children: [
        Row(children: [
          Expanded(child: TextField(controller: query, decoration: const InputDecoration(hintText: '搜索文件', prefixIcon: Icon(Icons.search)))),
          const SizedBox(width: 10),
          IconButton(
            tooltip: '刷新',
            onPressed: () => ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已刷新'))),
            icon: const Icon(Icons.refresh, color: _primary),
          ),
        ]),
        const SizedBox(height: 16),
        Expanded(child: _filtered.isEmpty
            ? const Center(child: Text('没有匹配的文件', style: TextStyle(color: _subText)))
            : ListView.separated(
                itemCount: _filtered.length,
                separatorBuilder: (_, i) => const SizedBox(height: 8),
                itemBuilder: (_, i) {
                  final f = _filtered[i];
                  return Container(
                    padding: const EdgeInsets.all(14),
                    decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(12), boxShadow: const [BoxShadow(color: Colors.black12, blurRadius: 8, offset: Offset(0, 2))]),
                    child: Row(children: [
                      const Icon(Icons.insert_drive_file_outlined, color: _primary),
                      const SizedBox(width: 12),
                      Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text(f['name']!, style: const TextStyle(color: _text, fontWeight: FontWeight.w600)),
                        const SizedBox(height: 3),
                        Text("${f['size']} · ${f['time']}", style: const TextStyle(color: _subText, fontSize: 12)),
                      ])),
                    ]),
                  );
                },
              )),
      ]),
    );
  }
}

class FavoritesPage extends StatelessWidget {
  const FavoritesPage({super.key});

  @override
  Widget build(BuildContext context) {
    return _Scaffold('我的收藏', const _FavoritesBody());
  }
}

class _FavoritesBody extends StatefulWidget {
  const _FavoritesBody();
  @override
  State<_FavoritesBody> createState() => _FavoritesBodyState();
}

class _FavoritesBodyState extends State<_FavoritesBody> {
  final favorites = <String, bool>{
    '【收到】分享的那份清单很有用。': true,
    '【语音】今天的会议记录。': true,
    '【图片】设计参考图。': false,
    '【链接】好用的工具网站。': true,
    '【文字】别忘记明天上午十点的会议。': false,
  };

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(20),
      child: ListView.separated(
        itemCount: favorites.length,
        separatorBuilder: (_, i) => const SizedBox(height: 8),
        itemBuilder: (_, i) {
          final entry = favorites.entries.elementAt(i);
          return Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(12), boxShadow: const [BoxShadow(color: Colors.black12, blurRadius: 8, offset: Offset(0, 2))]),
            child: Row(children: [
              Expanded(child: Text(entry.key, style: const TextStyle(color: _text))),
              IconButton(
                icon: Icon(entry.value ? Icons.favorite : Icons.favorite_border, color: entry.value ? Colors.redAccent : _subText),
                onPressed: () => setState(() => favorites[entry.key] = !entry.value),
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
  }

  String _format(TimeOfDay t) {
    final h = t.hourOfPeriod.toString().padLeft(2, '0');
    final m = t.minute.toString().padLeft(2, '0');
    return "$h:$m ${t.period == DayPeriod.am ? '上午' : '下午'}";
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(20),
      child: Column(children: [
        Row(children: [
          Expanded(child: TextField(controller: controller, decoration: const InputDecoration(hintText: '提醒内容'))),
          const SizedBox(width: 10),
          OutlinedButton(
            onPressed: _pickTime,
            child: Text(time == null ? '选择时间' : _format(time!), style: const TextStyle(color: _primary)),
          ),
          const SizedBox(width: 10),
          FilledButton(onPressed: _add, child: const Text('设置')),
        ]),
        const SizedBox(height: 16),
        Expanded(child: reminders.isEmpty
            ? const Center(child: Text('还没有提醒', style: TextStyle(color: _subText)))
            : ListView.separated(
                itemCount: reminders.length,
                separatorBuilder: (_, i) => const SizedBox(height: 8),
                itemBuilder: (_, i) {
                  final (text, t) = reminders[i];
                  return Container(
                    padding: const EdgeInsets.all(14),
                    decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(12), boxShadow: const [BoxShadow(color: Colors.black12, blurRadius: 8, offset: Offset(0, 2))]),
                    child: Row(children: [
                      const Icon(Icons.alarm, color: _primary),
                      const SizedBox(width: 12),
                      Expanded(child: Text(text, style: const TextStyle(color: _text))),
                      const SizedBox(width: 8),
                      Text(_format(t), style: const TextStyle(color: _primary, fontWeight: FontWeight.w600)),
                      IconButton(icon: const Icon(Icons.delete_outline, color: Colors.redAccent), onPressed: () => setState(() => reminders.removeAt(i))),
                    ]),
                  );
                },
              )),
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
        Expanded(child: Row(children: [
          for (final e in row)
            Expanded(child: InkWell(onTap: () => _pick(e), child: Center(child: Text(e, style: const TextStyle(fontSize: 24))))),
        ])),
      const Divider(height: 1, color: _div),
      Container(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Row(children: [
          const Padding(padding: EdgeInsets.symmetric(horizontal: 10), child: Text('最近', style: TextStyle(color: _subText, fontSize: 12))),
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
  void dispose() {
    moodController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(20),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const Text('选择在线状态', style: TextStyle(fontWeight: FontWeight.w600)),
        const SizedBox(height: 10),
        for (var i = 0; i < statuses.length; i++)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: InkWell(
              onTap: () => setState(() => status = i),
              child: Container(
                width: double.infinity,
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(color: status == i ? const Color(0xffe5f6ed) : Colors.white, borderRadius: BorderRadius.circular(12)),
                child: Row(children: [
                  Icon(icons[i], color: colors[i]),
                  const SizedBox(width: 12),
                  Text(statuses[i], style: TextStyle(color: _text, fontWeight: status == i ? FontWeight.w700 : FontWeight.w500)),
                  const Spacer(),
                  if (status == i) const Icon(Icons.check_circle, color: _primary),
                ]),
              ),
            ),
          ),
        const SizedBox(height: 12),
        const Text('心情短语', style: TextStyle(fontWeight: FontWeight.w600)),
        const SizedBox(height: 10),
        Row(children: [
          Expanded(child: TextField(controller: moodController, decoration: const InputDecoration(hintText: '例如：今天心情很好'))),
          const SizedBox(width: 10),
          FilledButton(
            onPressed: () => ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('状态已更新：${statuses[status]} · ${moodController.text.trim().isEmpty ? '无短语' : moodController.text.trim()}'))),
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
    return Scaffold(
      backgroundColor: _bg,
      appBar: AppBar(
        backgroundColor: Colors.white,
        elevation: 0,
        title: Text(title, style: const TextStyle(color: _text, fontWeight: FontWeight.w700)),
        leading: IconButton(icon: const Icon(Icons.arrow_back, color: _text), onPressed: () => Navigator.of(context).maybePop()),
      ),
      body: body,
    );
  }
}
