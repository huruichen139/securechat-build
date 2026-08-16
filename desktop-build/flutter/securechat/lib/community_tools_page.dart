// module: community-tools (worker batch8)
// 聊天民生工具 Flutter 页面（独立可编译）。
// 提供：群投票 / 群接龙 / 群待办 / 定时提醒 / 翻译 的独立操作界面。
// 数据源：CommunityToolsService（/api/polls /api/solang /api/todos /api/reminders /api/translate）。
import 'package:flutter/material.dart';

import 'services/app_config.dart';
import 'services/community_tools_service.dart';
import 'services/securechat_api.dart';
import 'widgets/ux.dart';

class CommunityToolsPage extends StatefulWidget {
  const CommunityToolsPage({super.key, required this.api, required this.config});
  final SecureChatApi api;
  final AppConfig config;

  @override
  State<CommunityToolsPage> createState() => _CommunityToolsPageState();
}

class _CommunityToolsPageState extends State<CommunityToolsPage> with SingleTickerProviderStateMixin {
  late final CommunityToolsService _svc = CommunityToolsService(widget.api);
  late final TabController _tab = TabController(length: 4, vsync: this);

  List<Map<String, dynamic>> _polls = [];
  List<Map<String, dynamic>> _solangs = [];
  List<Map<String, dynamic>> _todos = [];
  List<Map<String, dynamic>> _reminders = [];
  int _groupId = 0;

  @override
  void initState() {
    super.initState();
    _groupId = widget.api.myId ?? 0;
  }

  Future<void> _refreshAll() async {
    try {
      if (_groupId > 0) {
        final (a, b, c) = await (Future.wait<Object>([
          _svc.pollsOfGroup(_groupId),
          _svc.solangsOfGroup(_groupId),
          _svc.todosOfGroup(_groupId),
        ]).then((r) => (r[0] as List<Map<String, dynamic>>, r[1] as List<Map<String, dynamic>>, r[2] as List<Map<String, dynamic>>)));
        _polls = a;
        _solangs = b;
        _todos = c;
      }
      _reminders = await _svc.myReminders();
    } catch (_) {}
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _tab.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = widget.config.theme;
    return Scaffold(
      backgroundColor: t.bg,
      body: Column(children: [
        PageHeader(title: '社区民生工具', config: widget.config),
        Container(
          color: t.card.withValues(alpha: 0.85),
          child: TabBar(
            controller: _tab,
            isScrollable: true,
            labelColor: widget.config.primary,
            indicatorColor: widget.config.primary,
            unselectedLabelColor: t.subText,
            labelStyle: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
            tabs: const [
              Tab(text: '群投票'),
              Tab(text: '群接龙'),
              Tab(text: '群待办'),
              Tab(text: '提醒/翻译'),
            ],
          ),
        ),
        Expanded(
          child: TabBarView(
            controller: _tab,
            children: [
              _PollsView(svc: _svc, state: this, items: _polls, groupId: _groupId, onChanged: _refreshAll),
              _SolangView(svc: _svc, state: this, items: _solangs, groupId: _groupId, onChanged: _refreshAll),
              _TodosView(svc: _svc, state: this, items: _todos, groupId: _groupId, onChanged: _refreshAll),
              _RemindTranslateView(svc: _svc, state: this, reminders: _reminders, onChanged: _refreshAll),
            ],
          ),
        ),
      ]),
    );
  }
}

// ---------- 群投票 ----------
class _PollsView extends StatefulWidget {
  const _PollsView({required this.svc, required this.state, required this.items, required this.groupId, required this.onChanged});
  final CommunityToolsService svc;
  final _CommunityToolsPageState state;
  final List<Map<String, dynamic>> items;
  final int groupId;
  final VoidCallback onChanged;
  @override
  State<_PollsView> createState() => _PollsViewState();
}

class _PollsViewState extends State<_PollsView> {
  AppConfig get _cfg => widget.state.widget.config;
  AppTheme get _t => _cfg.theme;

  @override
  void initState() {
    super.initState();
    widget.onChanged();
  }

  Future<void> _create() async {
    final titleCtrl = TextEditingController();
    final optsCtrl = TextEditingController(text: '');
    final multi = ValueNotifier<bool>(false);
    final anon = ValueNotifier<bool>(false);
    final minCtrl = TextEditingController(text: '120');
    await showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('发起群投票'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(controller: titleCtrl, decoration: const InputDecoration(labelText: '标题')),
              TextField(controller: optsCtrl, decoration: const InputDecoration(labelText: '选项（用换行分隔）'), maxLines: 5),
              ValueListenableBuilder<bool>(
                valueListenable: multi,
                builder: (_, v, _) => CheckboxListTile(
                  dense: true, contentPadding: EdgeInsets.zero, title: const Text('多选'),
                  value: v, onChanged: (x) => multi.value = x ?? false),
              ),
              ValueListenableBuilder<bool>(
                valueListenable: anon,
                builder: (_, v, _) => CheckboxListTile(
                  dense: true, contentPadding: EdgeInsets.zero, title: const Text('匿名（不展示明细，只展示饼图）'),
                  value: v, onChanged: (x) => anon.value = x ?? false),
              ),
              TextField(controller: minCtrl, decoration: const InputDecoration(labelText: '截止分钟（0=长期）'), keyboardType: TextInputType.number),
            ],
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(
            onPressed: () async {
              final title = titleCtrl.text.trim();
              final opts = optsCtrl.text.split(RegExp(r'[\n\r]+')).map((e) => e.trim()).where((e) => e.isNotEmpty).toList();
              if (title.isEmpty || opts.length < 2) {
                ScaffoldMessenger.of(ctx).showSnackBar(const SnackBar(content: Text('请填写标题和至少两个选项')));
                return;
              }
              final min = int.tryParse(minCtrl.text.trim()) ?? 0;
              final deadline = min > 0 ? DateTime.now().add(Duration(minutes: min)).millisecondsSinceEpoch : null;
              try {
                await widget.svc.createPoll(widget.groupId,
                    title: title, options: opts, multi: multi.value, anonymous: anon.value, deadline: deadline);
                if (ctx.mounted) Navigator.pop(ctx);
                widget.onChanged();
              } catch (e) {
                if (ctx.mounted) ScaffoldMessenger.of(ctx).showSnackBar(SnackBar(content: Text('发布失败：$e')));
              }
            },
            child: const Text('发布'),
          ),
        ],
      ),
    );
  }

  Future<void> _vote(Map<String, dynamic> p, int optionId) async {
    try {
      await widget.svc.votePoll(p['id'] as int, [optionId]);
      widget.onChanged();
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(12),
      children: [
        Row(children: [
          Expanded(child: Text('请先在聊天页进入某群，再回到本页填入群号开关：', style: TextStyle(fontSize: 12, color: _t.subText))),
          FilledButton.icon(onPressed: _create, icon: const Icon(Icons.add), label: const Text('发起投票')),
        ]),
        const SizedBox(height: 12),
        if (widget.items.isEmpty)
          Padding(padding: const EdgeInsets.all(32), child: Center(child: Text('暂无投票', style: TextStyle(color: _t.subText)))),
        ...widget.items.map((p) => _PollCard(poll: p, onVote: (oid) => _vote(p, oid), onChanged: widget.onChanged, svc: widget.svc, config: _cfg)),
      ],
    );
  }
}

class _PollCard extends StatelessWidget {
  const _PollCard({required this.poll, required this.onVote, required this.onChanged, required this.svc, required this.config});
  final Map<String, dynamic> poll;
  final void Function(int) onVote;
  final VoidCallback onChanged;
  final CommunityToolsService svc;
  final AppConfig config;

  String _time(Object? ms) {
    final t = int.tryParse('$ms') ?? 0;
    if (t <= 0) return '长期有效';
    final d = DateTime.fromMillisecondsSinceEpoch(t);
    String p(int n) => n.toString().padLeft(2, '0');
    return '${p(d.month)}-${p(d.day)} ${p(d.hour)}:${p(d.minute)}';
  }

  @override
  Widget build(BuildContext context) {
    final t = config.theme;
    final options = ((poll['options'] as List?) ?? const []).cast<Map<String, dynamic>>();
    final total = (poll['totalVotes'] as num?)?.toInt() ?? 0;
    final myVotes = ((poll['myVotes'] as List?) ?? const []).cast<num>().map((e) => e.toInt()).toList();
    final closed = poll['status'] == 'closed' || (poll['deadline'] != null && int.tryParse('${poll['deadline']}') != null && DateTime
        .fromMillisecondsSinceEpoch(int.tryParse('${poll['deadline']}')!).isBefore(DateTime.now()));
    final showDetail = (poll['voted'] as bool? ?? false) || closed || (poll['anonymous'] as bool? ?? false);
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: t.card.withValues(alpha: 0.85),
        borderRadius: BorderRadius.circular(Ux.cardRadius),
        border: Border.all(color: t.div.withValues(alpha: 0.6)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('${poll['title']}', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 16, color: t.text)),
          const SizedBox(height: 4),
          Text('多人 · ${poll['multi'] == true ? '多选' : '单选'} · 截止 ${_time(poll['deadline'])}', style: TextStyle(fontSize: 12, color: t.subText)),
          const SizedBox(height: 8),
          ...options.map((o) {
            final oid = (o['id'] as num).toInt();
            final votes = (o['votes'] as num?)?.toInt() ?? 0;
            final pct = total > 0 ? (votes / total * 100).round() : 0;
            final on = myVotes.contains(oid);
            return InkWell(
              onTap: poll['voted'] == true || closed ? null : () => onVote(oid),
              child: Container(
                margin: const EdgeInsets.only(bottom: 6),
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                decoration: BoxDecoration(
                  border: Border.all(color: on ? config.primary : t.div.withValues(alpha: 0.7)),
                  borderRadius: BorderRadius.circular(8),
                  color: on ? config.primary.withValues(alpha: .1) : null,
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(o['content'].toString(), style: TextStyle(color: on ? config.primary : t.text)),
                    if (showDetail) ...[
                      const SizedBox(height: 4),
                      LinearProgressIndicator(value: total > 0 ? votes / total : 0, minHeight: 5, color: config.primary, backgroundColor: Ux.cellIconBg(t)),
                      const SizedBox(height: 2),
                      Text('$votes 票 · $pct%', style: TextStyle(fontSize: 11, color: t.subText)),
                    ],
                  ],
                ),
              ),
            );
          }),
          Row(children: [
            Text('共 $total 人参与', style: TextStyle(fontSize: 12, color: t.subText)),
            const Spacer(),
            if (poll['createdByMe'] == true && poll['status'] == 'open')
              TextButton(onPressed: () async { try { await svc.closePoll(poll['id'] as int); onChanged(); } catch (_) {} }, child: const Text('结束投票')),
          ]),
        ],
      ),
    );
  }
}

// ---------- 群接龙 ----------
class _SolangView extends StatefulWidget {
  const _SolangView({required this.svc, required this.state, required this.items, required this.groupId, required this.onChanged});
  final CommunityToolsService svc;
  final _CommunityToolsPageState state;
  final List<Map<String, dynamic>> items;
  final int groupId;
  final VoidCallback onChanged;
  @override
  State<_SolangView> createState() => _SolangViewState();
}

class _SolangViewState extends State<_SolangView> {
  AppConfig get _cfg => widget.state.widget.config;
  AppTheme get _t => _cfg.theme;

  @override
  void initState() {
    super.initState();
    widget.onChanged();
  }

  Future<void> _create() async {
    final text = await showDialog<String>(
      context: context,
      builder: (ctx) {
        final ctrl = TextEditingController();
        return AlertDialog(
          title: const Text('发起群接龙'),
          content: TextField(controller: ctrl, decoration: const InputDecoration(labelText: '接龙主题'), autofocus: true),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
            FilledButton(onPressed: () => Navigator.pop(ctx, ctrl.text.trim()), child: const Text('发布')),
          ],
        );
      },
    );
    if (text == null || text.isEmpty) return;
    try {
      await widget.svc.createSolang(widget.groupId, text);
      widget.onChanged();
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  Future<void> _join(Map<String, dynamic> s) async {
    final note = await showDialog<String>(
      context: context,
      builder: (ctx) {
        final ctrl = TextEditingController();
        return AlertDialog(
          title: const Text('接龙报名'),
          content: TextField(controller: ctrl, decoration: const InputDecoration(labelText: '备注（可选）')),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
            FilledButton(onPressed: () => Navigator.pop(ctx, ctrl.text.trim()), child: const Text('我接')),
          ],
        );
      },
    );
    if (note == null) return;
    try {
      await widget.svc.joinSolang(s['id'] as int, note);
      widget.onChanged();
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(12),
      children: [
        Row(children: [
          Expanded(child: Text('序号自动递增，报名接龙', style: TextStyle(fontSize: 12, color: _t.subText))),
          FilledButton.icon(onPressed: _create, icon: const Icon(Icons.add), label: const Text('发起接龙')),
        ]),
        const SizedBox(height: 12),
        if (widget.items.isEmpty)
          Padding(padding: const EdgeInsets.all(32), child: Center(child: Text('暂无接龙', style: TextStyle(color: _t.subText)))),
        ...widget.items.map((s) {
          final entries = ((s['entries'] as List?) ?? const []).cast<Map<String, dynamic>>();
          final closed = s['status'] == 'closed';
          return Container(
            margin: const EdgeInsets.only(bottom: 10),
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: _t.card.withValues(alpha: 0.85),
              borderRadius: BorderRadius.circular(Ux.cardRadius),
              border: Border.all(color: _t.div.withValues(alpha: 0.6)),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(s['title'].toString(), style: TextStyle(fontWeight: FontWeight.w600, fontSize: 16, color: _t.text)),
                const SizedBox(height: 4),
                Text('${s['count']} 人报名 · ${closed ? '已结束' : '进行中'}', style: TextStyle(fontSize: 12, color: _t.subText)),
                const SizedBox(height: 8),
                ...entries.map((e) => Padding(
                      padding: const EdgeInsets.symmetric(vertical: 2),
                      child: Row(children: [
                        CircleAvatar(radius: 11, backgroundColor: _cfg.primary, child: Text('${e['seq']}', style: const TextStyle(color: Colors.white, fontSize: 11))),
                        const SizedBox(width: 8),
                        Expanded(child: Text((e['nickname'] ?? '用户${e['userId']}').toString(), style: TextStyle(color: _t.text))),
                        if (e['note'] != null && '${e['note']}'.isNotEmpty)
                          Text('${e['note']}', style: TextStyle(fontSize: 12, color: _t.subText)),
                      ]),
                    )),
                const SizedBox(height: 8),
                if (!closed)
                  Align(
                    alignment: Alignment.centerRight,
                    child: FilledButton(onPressed: () => _join(s), child: Text('我接 ${(s['count'] as num? ?? 0).toInt() + 1} 号')),
                  ),
              ],
            ),
          );
        }),
      ],
    );
  }
}

// ---------- 群待办 ----------
class _TodosView extends StatefulWidget {
  const _TodosView({required this.svc, required this.state, required this.items, required this.groupId, required this.onChanged});
  final CommunityToolsService svc;
  final _CommunityToolsPageState state;
  final List<Map<String, dynamic>> items;
  final int groupId;
  final VoidCallback onChanged;
  @override
  State<_TodosView> createState() => _TodosViewState();
}

class _TodosViewState extends State<_TodosView> {
  AppConfig get _cfg => widget.state.widget.config;
  AppTheme get _t => _cfg.theme;

  @override
  void initState() {
    super.initState();
    widget.onChanged();
  }

  Future<void> _create() async {
    final titleCtrl = TextEditingController(text: '今日待办');
    final itemsCtrl = TextEditingController();
    await showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('发布今日待办'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(controller: titleCtrl, decoration: const InputDecoration(labelText: '标题')),
            TextField(controller: itemsCtrl, decoration: const InputDecoration(labelText: '待办项（每行一项）'), maxLines: 6),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(
            onPressed: () async {
              final items = itemsCtrl.text.split(RegExp(r'[\n\r]+')).map((e) => e.trim()).where((e) => e.isNotEmpty).toList();
              if (items.isEmpty) return;
              try {
                await widget.svc.createTodo(widget.groupId, title: titleCtrl.text.trim(), items: items);
                if (ctx.mounted) Navigator.pop(ctx);
                widget.onChanged();
              } catch (e) {
                if (ctx.mounted) ScaffoldMessenger.of(ctx).showSnackBar(SnackBar(content: Text('$e')));
              }
            },
            child: const Text('发布'),
          ),
        ],
      ),
    );
  }

  Future<void> _toggle(Map<String, dynamic> t, Map<String, dynamic> it) async {
    try {
      await widget.svc.checkTodoItem(t['id'] as int, it['id'] as int, !(it['myDone'] == true));
      widget.onChanged();
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(12),
      children: [
        Row(children: [
          Expanded(child: Text('成员勾选完成，实时进度条', style: TextStyle(fontSize: 12, color: _t.subText))),
          FilledButton.icon(onPressed: _create, icon: const Icon(Icons.add), label: const Text('发布待办')),
        ]),
        const SizedBox(height: 12),
        if (widget.items.isEmpty)
          Padding(padding: const EdgeInsets.all(32), child: Center(child: Text('暂无待办', style: TextStyle(color: _t.subText)))),
        ...widget.items.map((t) {
          final items = ((t['items'] as List?) ?? const []).cast<Map<String, dynamic>>();
          final progress = (t['progress'] as num?)?.toInt() ?? 0;
          return Container(
            margin: const EdgeInsets.only(bottom: 10),
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: _t.card.withValues(alpha: 0.85),
              borderRadius: BorderRadius.circular(Ux.cardRadius),
              border: Border.all(color: _t.div.withValues(alpha: 0.6)),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(t['title'].toString(), style: TextStyle(fontWeight: FontWeight.w600, fontSize: 16, color: _t.text)),
                const SizedBox(height: 8),
                Row(children: [
                  Expanded(
                    child: LinearProgressIndicator(
                      value: progress / 100.0,
                      minHeight: 8,
                      borderRadius: BorderRadius.circular(4),
                      color: _cfg.primary,
                      backgroundColor: Ux.cellIconBg(_t),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Text('$progress%', style: TextStyle(fontSize: 12, color: _t.subText)),
                ]),
                const SizedBox(height: 8),
                ...items.map((it) => CheckboxListTile(
                      dense: true,
                      contentPadding: EdgeInsets.zero,
                      value: it['myDone'] == true,
                      activeColor: _cfg.primary,
                      title: Text(it['content'].toString(), style: TextStyle(fontSize: 14, color: _t.text)),
                      onChanged: (_) => _toggle(t, it),
                    )),
              ],
            ),
          );
        }),
      ],
    );
  }
}

// ---------- 提醒 + 翻译 ----------
class _RemindTranslateView extends StatefulWidget {
  const _RemindTranslateView({required this.svc, required this.state, required this.reminders, required this.onChanged});
  final CommunityToolsService svc;
  final _CommunityToolsPageState state;
  final List<Map<String, dynamic>> reminders;
  final VoidCallback onChanged;
  @override
  State<_RemindTranslateView> createState() => _RemindTranslateViewState();
}

class _RemindTranslateViewState extends State<_RemindTranslateView> {
  final _textCtrl = TextEditingController();
  final _contentCtrl = TextEditingController();
  String _translated = '';
  String _transResult = '';

  AppConfig get _cfg => widget.state.widget.config;
  AppTheme get _t => _cfg.theme;

  @override
  void initState() {
    super.initState();
    widget.onChanged();
  }

  @override
  void dispose() {
    _textCtrl.dispose();
    _contentCtrl.dispose();
    super.dispose();
  }

  String _fmt(Object? ms) {
    final t = int.tryParse('$ms') ?? 0;
    if (t <= 0) return '';
    final d = DateTime.fromMillisecondsSinceEpoch(t);
    String p(int n) => n.toString().padLeft(2, '0');
    return '${d.year}-${p(d.month)}-${p(d.day)} ${p(d.hour)}:${p(d.minute)}';
  }

  Future<void> _addReminder() async {
    final atText = _contentCtrl.text.isNotEmpty ? _contentCtrl.text : '';
    final targetId = widget.state._groupId;
    if (targetId <= 0) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('请先设置群号（我的ID）')));
      return;
    }
    // 用当前时间+10分钟作为默认提醒时间示例
    final at = DateTime.now().add(const Duration(minutes: 10)).millisecondsSinceEpoch;
    try {
      await widget.svc.createReminder(targetType: 'direct', targetId: targetId, at: at, content: atText.isEmpty ? '示例提醒' : atText);
      _contentCtrl.clear();
      widget.onChanged();
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已设置提醒（10分钟后触发）')));
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  Future<void> _deleteReminder(int id) async {
    try {
      await widget.svc.deleteReminder(id);
      widget.onChanged();
    } catch (_) {}
  }

  Future<void> _doTranslate() async {
    final text = _textCtrl.text.trim();
    if (text.isEmpty) return;
    try {
      final r = await widget.svc.translate(text, target: 'zh');
      setState(() {
        _translated = r['translated'].toString();
        _transResult = r['source'] == 'mymemory' ? '在线翻译' : '本地词典';
      });
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(12),
      children: [
        Text('定时提醒（到点 server 推送一条消息）', style: TextStyle(fontWeight: FontWeight.w600, color: _t.text)),
        const SizedBox(height: 8),
        Row(children: [
          Expanded(
            child: TextField(controller: _contentCtrl, decoration: const InputDecoration(labelText: '提醒内容示例', isDense: true)),
          ),
          const SizedBox(width: 8),
          FilledButton(onPressed: _addReminder, child: const Text('设置提醒')),
        ]),
        const SizedBox(height: 12),
        ...widget.reminders.map((r) => Container(
              margin: const EdgeInsets.only(bottom: 6),
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              decoration: BoxDecoration(
                color: _t.card.withValues(alpha: 0.85),
                borderRadius: BorderRadius.circular(Ux.radius),
                border: Border.all(color: _t.div.withValues(alpha: 0.6)),
              ),
              child: Row(children: [
                Icon(Icons.alarm, color: _cfg.primary, size: 20),
                const SizedBox(width: 10),
                Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(r['content'].toString(), style: TextStyle(color: _t.text)),
                  Text('${r['targetType'] == 'group' ? '群' : '单聊'} · ${_fmt(r['at'])}${r['fired'] == true ? ' · 已触发' : ''}', style: TextStyle(color: _t.subText, fontSize: 11)),
                ])),
                if (r['fired'] != true)
                  IconButton(icon: Icon(Icons.delete_outline, color: _t.subText), onPressed: () => _deleteReminder(r['id'] as int)),
              ]),
            )),
        const SizedBox(height: 12),
        Text('消息翻译（长按消息 → 翻译成中文/英文）', style: TextStyle(fontWeight: FontWeight.w600, color: _t.text)),
        const SizedBox(height: 8),
        TextField(
          controller: _textCtrl,
          maxLines: 3,
          decoration: const InputDecoration(labelText: '输入要翻译的文本'),
        ),
        const SizedBox(height: 8),
        Row(children: [
          FilledButton(onPressed: _doTranslate, child: const Text('翻译成中文')),
          const SizedBox(width: 8),
          OutlinedButton(
            onPressed: () async {
              final text = _textCtrl.text.trim();
              if (text.isEmpty) return;
              final messenger = ScaffoldMessenger.of(context);
              try {
                final r = await widget.svc.translate(text, target: 'en');
                setState(() { _translated = r['translated'].toString(); _transResult = r['source'] == 'mymemory' ? '在线翻译' : '本地词典'; });
              } catch (e) {
                messenger.showSnackBar(SnackBar(content: Text('$e')));
              }
            },
            child: const Text('翻译成英文'),
          ),
        ]),
        if (_translated.isNotEmpty) ...[
          const SizedBox(height: 12),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(color: Ux.cellIconBg(_t), borderRadius: BorderRadius.circular(Ux.radius)),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('翻译结果（$_transResult）', style: TextStyle(fontSize: 12, color: _cfg.primary)),
                const SizedBox(height: 4),
                Text(_translated, style: TextStyle(color: _t.text)),
              ],
            ),
          ),
        ],
      ],
    );
  }
}
