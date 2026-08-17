import 'package:flutter/material.dart';

import 'services/securechat_api.dart';
import 'services/app_config.dart';
import 'widgets/ux.dart';

class SearchPage extends StatefulWidget {
  const SearchPage({super.key, required this.api, required this.config, this.onOpenChat});
  final SecureChatApi api;
  final AppConfig config;
  final void Function(int id, bool isGroup, String name)? onOpenChat;

  @override
  State<SearchPage> createState() => _SearchPageState();
}

class _SearchPageState extends State<SearchPage> {
  final _ctrl = TextEditingController();
  List<Map<String, dynamic>> _friends = [];
  List<Map<String, dynamic>> _groups = [];

  AppConfig get _cfg => widget.config;
  AppTheme get _t => _cfg.theme;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final f = await widget.api.friends();
      final g = await widget.api.groups();
      if (mounted) setState(() {
        _friends = f;
        _groups = g;
      });
    } catch (_) {}
  }

  List<Map<String, dynamic>> _filter(List<Map<String, dynamic>> list) {
    final q = _ctrl.text.trim().toLowerCase();
    if (q.isEmpty) return [];
    return list.where((m) {
      final name = ((m['nickname'] ?? m['username'] ?? m['name'] ?? '').toString()).toLowerCase();
      return name.contains(q);
    }).toList();
  }

  void _open(Map<String, dynamic> m, bool isGroup) {
    final name = (m['nickname'] ?? m['username'] ?? m['name'] ?? '').toString();
    final id = m['id'];
    if (id is! int) return;
    widget.onOpenChat?.call(id, isGroup, name);
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final t = _t;
    return Scaffold(
      backgroundColor: t.bg,
      body: Column(children: [
        PageHeader(title: '搜一搜', config: _cfg),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 10),
          child: TextField(
            controller: _ctrl,
            autofocus: true,
            onChanged: (_) => setState(() {}),
            style: TextStyle(color: t.text, fontSize: 14),
            decoration: InputDecoration(
              hintText: '搜索好友 / 群聊',
              hintStyle: TextStyle(color: t.subText),
              prefixIcon: Icon(Icons.search, color: t.subText, size: 20),
              filled: true,
              fillColor: t.inputBg,
              border: OutlineInputBorder(borderRadius: BorderRadius.circular(20), borderSide: BorderSide.none),
            ),
          ),
        ),
        Expanded(
          child: _ctrl.text.trim().isEmpty
              ? Center(child: Text('输入关键字搜索好友或群聊', style: TextStyle(color: t.subText, fontSize: 13)))
              : ListView(
                  padding: const EdgeInsets.only(bottom: 24),
                  children: [
                    _section('好友', _filter(_friends), false),
                    _section('群聊', _filter(_groups), true),
                  ],
                ),
        ),
      ]),
    );
  }

  Widget _section(String title, List<Map<String, dynamic>> list, bool isGroup) {
    final t = _t;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 6),
        child: Text('$title（${list.length}）', style: TextStyle(color: t.subText, fontSize: 12, fontWeight: FontWeight.w600)),
      ),
      if (list.isEmpty)
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: Text('无匹配结果', style: TextStyle(color: t.subText, fontSize: 12)),
        )
      else
        SectionCard(
          config: _cfg,
          margin: const EdgeInsets.symmetric(horizontal: 12),
          children: [
            for (var i = 0; i < list.length; i++) ...[
              if (i > 0) CellDivider(config: _cfg),
              ListTile(
                dense: true,
                leading: CircleAvatar(
                  radius: 18,
                  backgroundColor: Ux.cellIconBg(t),
                  child: Icon(isGroup ? Icons.groups_rounded : Icons.person, size: 18, color: Ux.green),
                ),
                title: Text(((list[i]['nickname'] ?? list[i]['username'] ?? list[i]['name'] ?? '').toString()), style: TextStyle(color: t.text, fontSize: 14)),
                trailing: Text('去聊天', style: TextStyle(color: Ux.green, fontSize: 12)),
                onTap: () => _open(list[i], isGroup),
              ),
            ],
          ],
        ),
    ]);
  }
}