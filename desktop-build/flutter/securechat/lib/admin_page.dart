import 'package:flutter/material.dart';

import 'services/securechat_api.dart';
import 'services/app_config.dart';
import 'widgets/ux.dart';

/// 管理员后台（仅 3509403074@qq.com 在「我」页可见入口）。
/// 数据全部来自 /api/admin/*（服务端 adminGuard 白名单校验）。
class AdminPage extends StatefulWidget {
  const AdminPage({super.key, this.api, required this.config});
  final SecureChatApi? api;
  final AppConfig config;

  @override
  State<AdminPage> createState() => _AdminPageState();
}

class _AdminPageState extends State<AdminPage> {
  late final SecureChatApi _api = widget.api ?? SecureChatApi();
  AppConfig get _cfg => widget.config;
  AppTheme get _t => _cfg.theme;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: _t.bg,
      appBar: AppBar(
        backgroundColor: _t.bg,
        elevation: 0,
        leading: IconButton(icon: const Icon(Icons.arrow_back_ios_new_rounded), color: _t.text, onPressed: () => Navigator.of(context).maybePop()),
        title: Text('管理员', style: TextStyle(color: _t.text, fontWeight: FontWeight.w700)),
      ),
      body: DefaultTabController(
        length: 5,
        child: Column(children: [
          TabBar(
            isScrollable: true,
            labelColor: Ux.green,
            unselectedLabelColor: _t.subText,
            indicatorColor: Ux.green,
            indicatorSize: TabBarIndicatorSize.label,
            labelStyle: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
            tabs: const [
              Tab(text: '概览'),
              Tab(text: '用户'),
              Tab(text: '公告'),
              Tab(text: '审计'),
              Tab(text: '兑换码'),
            ],
          ),
          Expanded(
            child: TabBarView(children: [
              _OverviewTab(api: _api, config: _cfg),
              _UsersTab(api: _api, config: _cfg),
              _AnnouncementsTab(api: _api, config: _cfg),
              _AuditTab(api: _api, config: _cfg),
              _RedeemTab(api: _api, config: _cfg),
            ]),
          ),
        ]),
      ),
    );
  }
}

String _fmtTime(Object? ts) {
  if (ts == null) return '-';
  final n = int.tryParse('$ts');
  if (n == null || n <= 0) return '-';
  final d = DateTime.fromMillisecondsSinceEpoch(n);
  final p = (int v) => v.toString().padLeft(2, '0');
  return '${d.year}-${p(d.month)}-${p(d.day)} ${p(d.hour)}:${p(d.minute)}';
}

class _StatGrid extends StatelessWidget {
  const _StatGrid({required this.items});
  final List<(String, String)> items;
  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return GridView.count(
      crossAxisCount: 3,
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      childAspectRatio: 1.5,
      mainAxisSpacing: 10,
      crossAxisSpacing: 10,
      children: items.map((it) {
        return Container(
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(color: t.cardColor, borderRadius: BorderRadius.circular(Ux.cardRadius)),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisAlignment: MainAxisAlignment.center, children: [
            Text(it.$2, style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800, color: Ux.green)),
            const SizedBox(height: 4),
            Text(it.$1, style: TextStyle(fontSize: 11, color: t.hintColor)),
          ]),
        );
      }).toList(),
    );
  }
}

// ---------------- 概览 ----------------
class _OverviewTab extends StatefulWidget {
  const _OverviewTab({required this.api, required this.config});
  final SecureChatApi api;
  final AppConfig config;
  @override
  State<_OverviewTab> createState() => _OverviewTabState();
}

class _OverviewTabState extends State<_OverviewTab> {
  Map<String, dynamic>? _data;
  String? _error;
  bool _loading = true;

  AppConfig get _cfg => widget.config;
  AppTheme get _t => _cfg.theme;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() { _loading = true; _error = null; });
    try {
      final data = await widget.api.adminOverview();
      if (!mounted) return;
      setState(() { _data = data; _loading = false; });
    } catch (e) {
      if (!mounted) return;
      setState(() { _loading = false; _error = e.toString().replaceFirst('Bad state: ', ''); });
    }
  }

  Widget _sec(String title, Widget child) {
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text(title, style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: _t.subText)),
      const SizedBox(height: 8),
      child,
      const SizedBox(height: 18),
    ]);
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_error != null) {
      return Center(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Text(_error!, style: TextStyle(color: _t.subText)),
          const SizedBox(height: 12),
          OutlinedButton(onPressed: _load, child: const Text('重试')),
        ]),
      );
    }
    final d = _data!;
    final sys = (d['system'] as Map?) ?? {};
    final realtime = (d['realtime'] as Map?) ?? {};
    final users = (d['users'] as Map?) ?? {};
    final groups = (d['groups'] as Map?) ?? {};
    final msgs = (d['messages'] as Map?) ?? {};
    final friends = (d['friendships'] as Map?) ?? {};
    final fb = (d['feedbacks'] as Map?) ?? {};
    final storage = (d['storage'] as Map?) ?? {};
    final admin = (d['admin'] as Map?) ?? {};

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.all(12),
        children: [
          _sec('实时', _StatGrid(items: [
            ('在线用户', '${realtime['onlineCount'] ?? 0}'),
            ('历史峰值并发', '${realtime['peakConcurrent'] ?? 0}'),
            ('近1分钟收/发', '${realtime['recvMsgsLastMin'] ?? 0}/${realtime['sentMsgsLastMin'] ?? 0}'),
            ('峰值消息/分钟', '${realtime['peakMsgsPerMin'] ?? 0}'),
            ('今日新增用户', '${users['newUsersToday'] ?? 0}'),
            ('服务器运行', '${sys['uptimeHuman'] ?? '-'}'),
          ])),
          _sec('用户', _StatGrid(items: [
            ('总用户数', '${users['total'] ?? 0}'),
            ('在线', '${users['online'] ?? 0}'),
            ('近7天新增', '${users['newUsers7d'] ?? 0}'),
            ('近30天新增', '${users['newUsers30d'] ?? 0}'),
            ('填写邮箱', '${users['withEmail'] ?? 0}'),
            ('填写头像', '${users['withAvatar'] ?? 0}'),
          ])),
          _sec('内容', _StatGrid(items: [
            ('单聊消息', '${msgs['privateTotal'] ?? 0}'),
            ('群聊消息', '${msgs['groupTotal'] ?? 0}'),
            ('消息总数', '${msgs['allTotal'] ?? 0}'),
            ('今日全部', '${msgs['allToday'] ?? 0}'),
            ('群组数', '${groups['total'] ?? 0}'),
            ('好友关系', '${friends['accepted'] ?? 0}'),
          ])),
          _sec('反馈 / 存储', _StatGrid(items: [
            ('待处理', '${fb['open'] ?? 0}'),
            ('处理中', '${fb['processing'] ?? 0}'),
            ('已关闭', '${fb['closed'] ?? 0}'),
            ('数据库大小', '${storage['dbSizeHuman'] ?? '-'}'),
            ('Node', '${sys['nodeVersion'] ?? '-'}'),
            ('主机', '${sys['hostname'] ?? '-'}'),
          ])),
          Text(
            '管理员：${admin['youAre'] is Map ? '${((admin['youAre'] as Map)['username'] ?? '')} <${((admin['youAre'] as Map)['email'] ?? '')}>' : '-'}',
            style: TextStyle(fontSize: 11, color: _t.subText.withValues(alpha: 0.8)),
          ),
        ],
      ),
    );
  }
}

// ---------------- 用户 ----------------
class _UsersTab extends StatefulWidget {
  const _UsersTab({required this.api, required this.config});
  final SecureChatApi api;
  final AppConfig config;
  @override
  State<_UsersTab> createState() => _UsersTabState();
}

class _UsersTabState extends State<_UsersTab> {
  List<Map<String, dynamic>> _users = [];
  bool _loading = true;
  String? _error;
  String _q = '';
  bool _busy = false;

  AppConfig get _cfg => widget.config;
  AppTheme get _t => _cfg.theme;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() { _loading = true; _error = null; });
    try {
      final users = await widget.api.adminUsers();
      if (!mounted) return;
      setState(() { _users = users; _loading = false; });
    } catch (e) {
      if (!mounted) return;
      setState(() { _loading = false; _error = e.toString().replaceFirst('Bad state: ', ''); });
    }
  }

  Future<void> _act(Future<void> Function() fn, {required String okMsg}) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await fn();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(okMsg), duration: const Duration(seconds: 2)));
      await _load();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('操作失败：$e')));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<String?> _prompt(String title, String initial) async {
    final ctrl = TextEditingController(text: initial);
    final result = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: _t.card,
        title: Text(title, style: TextStyle(color: _t.text, fontSize: 16)),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          style: TextStyle(color: _t.text),
          decoration: InputDecoration(hintText: '请输入', hintStyle: TextStyle(color: _t.subText)),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, ctrl.text.trim()), child: const Text('确定')),
        ],
      ),
    );
    ctrl.dispose();
    return result;
  }

  void _showActions(Map<String, dynamic> u) {
    showModalBottomSheet(
      context: context,
      backgroundColor: _t.card,
      builder: (ctx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          ListTile(
            title: Text('${u['nickname'] ?? u['username'] ?? ''} (#${u['id']})',
                style: TextStyle(color: _t.text, fontWeight: FontWeight.w700)),
            subtitle: Text('${u['email'] ?? '-'} · 注册于 ${_fmtTime(u['createdAt'])}', style: TextStyle(color: _t.subText)),
          ),
          const Divider(height: 1),
          if ((u['role'] ?? 'user') != 'admin') ...[
            ListTile(
              leading: Icon(Icons.block, color: (u['banned'] == true) ? Ux.green : Colors.redAccent),
              title: Text((u['banned'] == true) ? '解封用户' : '封禁用户', style: TextStyle(color: _t.text)),
              onTap: () async {
                Navigator.pop(ctx);
                final reason = (u['banned'] == true) ? '' : await _prompt('封禁原因（可选）', '');
                if (reason == null) return;
                await _act(
                  () => widget.api.adminBan(u['id'] as int, banned: (u['banned'] != true), reason: reason),
                  okMsg: (u['banned'] == true) ? '已解封' : '已封禁',
                );
              },
            ),
            ListTile(
              leading: const Icon(Icons.logout_rounded, color: Colors.orange),
              title: Text('强制下线', style: TextStyle(color: _t.text)),
              onTap: () async {
                Navigator.pop(ctx);
                await _act(() => widget.api.adminKick(u['id'] as int), okMsg: '已强制下线');
              },
            ),
            ListTile(
              leading: const Icon(Icons.badge_outlined, color: Colors.blue),
              title: Text('修改昵称', style: TextStyle(color: _t.text)),
              onTap: () async {
                Navigator.pop(ctx);
                final nick = await _prompt('新昵称', '${u['nickname'] ?? ''}');
                if (nick == null || nick.isEmpty) return;
                await _act(() => widget.api.adminUpdateUser(u['id'] as int, nickname: nick), okMsg: '昵称已修改');
              },
            ),
            ListTile(
              leading: const Icon(Icons.key_off_outlined, color: Colors.deepPurple),
              title: Text('重置密码', style: TextStyle(color: _t.text)),
              onTap: () async {
                Navigator.pop(ctx);
                final confirm = await _prompt('重置该用户密码为随机值？输入「重置」确认', '');
                if (confirm != '重置') return;
                await _act(() async {
                  final r = await widget.api.adminResetPassword(u['id'] as int);
                  if (!mounted) return;
                  final pwd = r['password'] ?? r['newPassword'] ?? '';
                  await showDialog<void>(
                    context: context,
                    builder: (c) => AlertDialog(
                      backgroundColor: _t.card,
                      title: Text('新密码', style: TextStyle(color: _t.text)),
                      content: SelectableText('$pwd', style: TextStyle(color: _t.text, fontSize: 16, fontWeight: FontWeight.w700)),
                      actions: [
                        FilledButton(onPressed: () => Navigator.pop(c), child: const Text('已复制')),
                      ],
                    ),
                  );
                }, okMsg: '密码已重置');
              },
            ),
            ListTile(
              leading: const Icon(Icons.star_outline_rounded, color: Colors.amber),
              title: Text('设为 VIP', style: TextStyle(color: _t.text)),
              onTap: () async {
                Navigator.pop(ctx);
                await _act(() => widget.api.adminUpdateUser(u['id'] as int, role: 'vip'), okMsg: '已设为 VIP');
              },
            ),
          ] else
            ListTile(
              leading: const Icon(Icons.shield_outlined, color: Ux.green),
              title: Text('管理员账号（不可操作）', style: TextStyle(color: _t.subText)),
            ),
          const SizedBox(height: 8),
        ]),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_error != null) {
      return Center(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Text(_error!, style: TextStyle(color: _t.subText)),
          const SizedBox(height: 12),
          OutlinedButton(onPressed: _load, child: const Text('重试')),
        ]),
      );
    }
    final q = _q.trim().toLowerCase();
    final list = q.isEmpty
        ? _users
        : _users.where((u) => [u['username'], u['nickname'], u['uid'], u['email']]
                .any((v) => '$v'.toLowerCase().contains(q)))
            .toList();
    return Column(children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(12, 10, 12, 6),
        child: TextField(
          onChanged: (v) => setState(() => _q = v),
          style: TextStyle(color: _t.text),
          decoration: InputDecoration(
            hintText: '搜索用户名 / 昵称 / 微信号 / 邮箱',
            hintStyle: TextStyle(color: _t.subText, fontSize: 13),
            prefixIcon: Icon(Icons.search, color: _t.subText, size: 20),
            isDense: true,
            filled: true,
            fillColor: _t.card,
            border: OutlineInputBorder(borderRadius: BorderRadius.circular(Ux.cardRadius), borderSide: BorderSide.none),
          ),
        ),
      ),
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12),
        child: Align(
          alignment: Alignment.centerLeft,
          child: Text('共 ${_users.length} 人${q.isEmpty ? '' : '，匹配 $list.length 人'}', style: TextStyle(fontSize: 11, color: _t.subText)),
        ),
      ),
      Expanded(
        child: RefreshIndicator(
          onRefresh: _load,
          child: ListView.builder(
            padding: const EdgeInsets.only(bottom: 24),
            itemCount: list.length,
            itemBuilder: (ctx, i) {
              final u = list[i];
              final online = u['online'] == true;
              final banned = u['banned'] == true;
              final role = '${u['role'] ?? 'user'}';
              final isAdmin = role == 'admin';
              return Padding(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 3),
                child: Material(
                  color: _t.card,
                  borderRadius: BorderRadius.circular(Ux.cardRadius),
                  child: InkWell(
                    borderRadius: BorderRadius.circular(Ux.cardRadius),
                    onTap: isAdmin ? null : () => _showActions(u),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                      child: Row(children: [
                        CircleAvatar(
                          radius: 18,
                          backgroundColor: isAdmin ? Ux.green : (banned ? Colors.redAccent : _t.div),
                          child: Text(
                            '${u['nickname'] ?? u['username'] ?? '?'}'.isEmpty
                                ? '?'
                                : '${u['nickname'] ?? u['username']}'.characters.first.toUpperCase(),
                            style: const TextStyle(color: Colors.white, fontSize: 14, fontWeight: FontWeight.w700),
                          ),
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                            Row(children: [
                              Flexible(child: Text('${u['nickname'] ?? u['username'] ?? ''}', overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: _t.text))),
                              if (banned) ...[
                                const SizedBox(width: 6),
                                const Text('已封禁', style: TextStyle(fontSize: 10, color: Colors.redAccent)),
                              ],
                              if (isAdmin) ...[
                                const SizedBox(width: 6),
                                Text('管理员', style: TextStyle(fontSize: 10, color: Ux.green)),
                              ],
                            ]),
                            const SizedBox(height: 2),
                            Text('@${u['uid'] ?? ''}${(u['email'] ?? '').toString().isEmpty ? '' : ' · ${u['email']}'}', overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 11, color: _t.subText)),
                          ]),
                        ),
                        const SizedBox(width: 8),
                        Text(online ? '在线' : '离线', style: TextStyle(fontSize: 11, color: online ? Ux.green : _t.subText)),
                        if (!isAdmin) Icon(Icons.more_horiz, color: _t.subText),
                      ]),
                    ),
                  ),
                ),
              );
            },
          ),
        ),
      ),
    ]);
  }
}

// ---------------- 公告 ----------------
class _AnnouncementsTab extends StatefulWidget {
  const _AnnouncementsTab({required this.api, required this.config});
  final SecureChatApi api;
  final AppConfig config;
  @override
  State<_AnnouncementsTab> createState() => _AnnouncementsTabState();
}

class _AnnouncementsTabState extends State<_AnnouncementsTab> {
  List<Map<String, dynamic>> _list = [];
  bool _loading = true;
  String? _error;

  AppConfig get _cfg => widget.config;
  AppTheme get _t => _cfg.theme;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() { _loading = true; _error = null; });
    try {
      final list = await widget.api.adminAnnouncements();
      if (!mounted) return;
      setState(() { _list = list; _loading = false; });
    } catch (e) {
      if (!mounted) return;
      setState(() { _loading = false; _error = e.toString().replaceFirst('Bad state: ', ''); });
    }
  }

  Future<void> _create() async {
    final titleC = TextEditingController();
    final contentC = TextEditingController();
    var top = false;
    var level = 'info';
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDlg) => AlertDialog(
          backgroundColor: _t.card,
          title: Text('发布公告', style: TextStyle(color: _t.text, fontSize: 16)),
          content: SizedBox(
            width: 380,
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              TextField(
                controller: titleC,
                style: TextStyle(color: _t.text),
                decoration: InputDecoration(labelText: '标题', labelStyle: TextStyle(color: _t.subText), hintStyle: TextStyle(color: _t.subText)),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: contentC,
                maxLines: 4,
                style: TextStyle(color: _t.text),
                decoration: InputDecoration(labelText: '内容', labelStyle: TextStyle(color: _t.subText), hintStyle: TextStyle(color: _t.subText)),
              ),
              const SizedBox(height: 10),
              Row(children: [
                DropdownButton<String>(
                  value: level,
                  dropdownColor: _t.card,
                  items: const [
                    DropdownMenuItem(value: 'info', child: Text('普通')),
                    DropdownMenuItem(value: 'warning', child: Text('警告')),
                    DropdownMenuItem(value: 'danger', child: Text('危险')),
                  ],
                  onChanged: (v) => setDlg(() => level = v ?? 'info'),
                ),
                const SizedBox(width: 16),
                Row(children: [
                  Checkbox(value: top, onChanged: (v) => setDlg(() => top = v ?? false)),
                  Text('置顶', style: TextStyle(color: _t.text)),
                ]),
              ]),
            ]),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
            FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('发布')),
          ],
        ),
      ),
    );
    if (ok != true) return;
    try {
      await widget.api.adminCreateAnnouncement(titleC.text.trim(), contentC.text.trim(), level: level, top: top);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已发布，并已推送给所有在线用户')));
      await _load();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('发布失败：$e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_error != null) {
      return Center(child: Text(_error!, style: TextStyle(color: _t.subText)));
    }
    return Column(children: [
      Padding(
        padding: const EdgeInsets.all(12),
        child: SizedBox(
          width: double.infinity,
          child: FilledButton.icon(
            onPressed: _create,
            icon: const Icon(Icons.add_alert_outlined, size: 18),
            label: const Text('发布公告'),
          ),
        ),
      ),
      Expanded(
        child: RefreshIndicator(
          onRefresh: _load,
          child: ListView.builder(
            padding: const EdgeInsets.only(bottom: 24),
            itemCount: _list.length,
            itemBuilder: (ctx, i) {
              final a = _list[i];
              final levelColor = switch ('${a['level'] ?? 'info'}') {
                'danger' => Colors.redAccent,
                'warning' => Colors.orange,
                _ => Ux.green,
              };
              return Padding(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                child: Material(
                  color: _t.card,
                  borderRadius: BorderRadius.circular(Ux.cardRadius),
                  child: Padding(
                    padding: const EdgeInsets.all(12),
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Row(children: [
                        Container(width: 6, height: 6, decoration: BoxDecoration(color: levelColor, shape: BoxShape.circle)),
                        const SizedBox(width: 8),
                        Expanded(child: Text('${a['title'] ?? ''}', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700, color: _t.text))),
                        if (a['top'] == 1) ...[
                          const SizedBox(width: 6),
                          Text('置顶', style: TextStyle(fontSize: 10, color: Ux.green)),
                        ],
                        IconButton(
                          icon: const Icon(Icons.delete_outline, size: 18, color: Colors.redAccent),
                          onPressed: () async {
                            try {
                              await widget.api.adminDeleteAnnouncement(a['id'] as int);
                              if (!mounted) return;
                              ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已删除')));
                              await _load();
                            } catch (e) {
                              if (!mounted) return;
                              ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('删除失败：$e')));
                            }
                          },
                        ),
                      ]),
                      const SizedBox(height: 6),
                      Text('${a['content'] ?? ''}', style: TextStyle(fontSize: 13, color: _t.text.withValues(alpha: 0.85))),
                      const SizedBox(height: 6),
                      Text(_fmtTime(a['createdAt']), style: TextStyle(fontSize: 11, color: _t.subText)),
                    ]),
                  ),
                ),
              );
            },
          ),
        ),
      ),
    ]);
  }
}

// ---------------- 审计 ----------------
class _AuditTab extends StatefulWidget {
  const _AuditTab({required this.api, required this.config});
  final SecureChatApi api;
  final AppConfig config;
  @override
  State<_AuditTab> createState() => _AuditTabState();
}

class _AuditTabState extends State<_AuditTab> {
  List<Map<String, dynamic>> _logs = [];
  bool _loading = true;
  String? _error;

  AppConfig get _cfg => widget.config;
  AppTheme get _t => _cfg.theme;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() { _loading = true; _error = null; });
    try {
      final logs = await widget.api.adminAudit();
      if (!mounted) return;
      setState(() { _logs = logs; _loading = false; });
    } catch (e) {
      if (!mounted) return;
      setState(() { _loading = false; _error = e.toString().replaceFirst('Bad state: ', ''); });
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_error != null) {
      return Center(child: Text(_error!, style: TextStyle(color: _t.subText)));
    }
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView.builder(
        padding: const EdgeInsets.only(bottom: 24),
        itemCount: _logs.length,
        itemBuilder: (ctx, i) {
          final l = _logs[i];
          return Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 3),
            child: Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(color: _t.card, borderRadius: BorderRadius.circular(Ux.cardRadius)),
              child: Row(children: [
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                  decoration: BoxDecoration(color: Ux.cellIconBg(_t), borderRadius: BorderRadius.circular(6)),
                  child: Text('${l['action'] ?? ''}', style: TextStyle(fontSize: 11, color: _t.text, fontWeight: FontWeight.w600)),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text('${l['detail'] ?? ''}'.isEmpty ? '${l['targetType'] ?? ''} #${l['targetId'] ?? '-'}' : '${l['detail'] ?? ''}',
                        overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 13, color: _t.text)),
                    Text('${_fmtTime(l['createdAt'])} · IP ${l['ip'] ?? '-'}', style: TextStyle(fontSize: 11, color: _t.subText)),
                  ]),
                ),
              ]),
            ),
          );
        },
      ),
    );
  }
}

// ---------------- 兑换码 ----------------
class _RedeemTab extends StatefulWidget {
  const _RedeemTab({required this.api, required this.config});
  final SecureChatApi api;
  final AppConfig config;
  @override
  State<_RedeemTab> createState() => _RedeemTabState();
}

class _RedeemTabState extends State<_RedeemTab> {
  List<Map<String, dynamic>> _codes = [];
  bool _loading = true;
  String? _error;
  int _filter = -1; // -1 全部, 0 未使用, 1 已使用

  AppConfig get _cfg => widget.config;
  AppTheme get _t => _cfg.theme;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() { _loading = true; _error = null; });
    try {
      final codes = await widget.api.adminRedeem(claimed: _filter < 0 ? null : _filter);
      if (!mounted) return;
      setState(() { _codes = codes; _loading = false; });
    } catch (e) {
      if (!mounted) return;
      setState(() { _loading = false; _error = e.toString().replaceFirst('Bad state: ', ''); });
    }
  }

  Future<void> _issue() async {
    final valueC = TextEditingController();
    final countC = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: _t.card,
        title: Text('生成兑换码', style: TextStyle(color: _t.text, fontSize: 16)),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(
            controller: valueC,
            keyboardType: TextInputType.number,
            style: TextStyle(color: _t.text),
            decoration: InputDecoration(labelText: '面额（元）', labelStyle: TextStyle(color: _t.subText)),
          ),
          const SizedBox(height: 10),
          TextField(
            controller: countC,
            keyboardType: TextInputType.number,
            style: TextStyle(color: _t.text),
            decoration: InputDecoration(labelText: '数量（最多500）', labelStyle: TextStyle(color: _t.subText)),
          ),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('生成')),
        ],
      ),
    );
    if (ok != true) return;
    final value = double.tryParse(valueC.text.trim());
    final count = int.tryParse(countC.text.trim()) ?? 1;
    if (value == null || value <= 0 || count < 1) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('请输入有效面额和数量')));
      return;
    }
    try {
      final r = await widget.api.adminIssueRedeem(value, count);
      final codes = ((r['codes'] as List?) ?? const []).map((c) => '$c').join('\n');
      if (!mounted) return;
      await showDialog<void>(
        context: context,
        builder: (ctx) => AlertDialog(
          backgroundColor: _t.card,
          title: Text('已生成 ${r['count'] ?? count} 个兑换码', style: TextStyle(color: _t.text, fontSize: 16)),
          content: SizedBox(
            width: 300,
            child: SingleChildScrollView(child: SelectableText(codes, style: TextStyle(color: _t.text, fontSize: 12, letterSpacing: 0.5))),
          ),
          actions: [
            FilledButton(onPressed: () => Navigator.pop(ctx), child: const Text('关闭')),
          ],
        ),
      );
      await _load();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('生成失败：$e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_error != null) {
      return Center(child: Text(_error!, style: TextStyle(color: _t.subText)));
    }
    return Column(children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(12, 10, 12, 4),
        child: Row(children: [
          Expanded(
            child: FilledButton.icon(
              onPressed: _issue,
              icon: const Icon(Icons.confirmation_number_outlined, size: 18),
              label: const Text('生成兑换码'),
            ),
          ),
          const SizedBox(width: 10),
          DropdownButton<int>(
            value: _filter,
            dropdownColor: _t.card,
            style: TextStyle(color: _t.text, fontSize: 13),
            items: const [
              DropdownMenuItem(value: -1, child: Text('全部')),
              DropdownMenuItem(value: 0, child: Text('未使用')),
              DropdownMenuItem(value: 1, child: Text('已使用')),
            ],
            onChanged: (v) async {
              setState(() => _filter = v ?? -1);
              await _load();
            },
          ),
        ]),
      ),
      Expanded(
        child: RefreshIndicator(
          onRefresh: _load,
          child: ListView.builder(
            padding: const EdgeInsets.only(bottom: 24),
            itemCount: _codes.length,
            itemBuilder: (ctx, i) {
              final c = _codes[i];
              final claimed = c['claimed_by'] != null;
              return Padding(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 3),
                child: Container(
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(color: _t.card, borderRadius: BorderRadius.circular(Ux.cardRadius)),
                  child: Row(children: [
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        SelectableText('${c['code'] ?? ''}', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: _t.text, letterSpacing: 0.5)),
                        Text('面额 ${c['value'] ?? 0} 元 · 生成于 ${_fmtTime(c['created_at'])}', style: TextStyle(fontSize: 11, color: _t.subText)),
                        if (claimed)
                          Text('已被用户 ${c['claimed_by'] ?? ''} 使用于 ${_fmtTime(c['claimed_at'])}', style: TextStyle(fontSize: 11, color: Ux.green)),
                      ]),
                    ),
                    Text(claimed ? '已使用' : '未使用', style: TextStyle(fontSize: 11, color: claimed ? _t.subText : Ux.green)),
                  ]),
                ),
              );
            },
          ),
        ),
      ),
    ]);
  }
}
