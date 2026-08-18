import 'package:file_picker/file_picker.dart';
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
        length: 12,
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
              Tab(text: '群组'),
              Tab(text: '反馈'),
              Tab(text: '公告'),
              Tab(text: '封禁IP'),
              Tab(text: '敏感词'),
              Tab(text: '审计'),
              Tab(text: '兑换码'),
              Tab(text: '发版'),
              Tab(text: 'Passkey'),
              Tab(text: 'EPay'),
            ],
          ),
          Expanded(
            child: TabBarView(children: [
              _OverviewTab(api: _api, config: _cfg),
              _UsersTab(api: _api, config: _cfg),
              _GroupsTab(api: _api, config: _cfg),
              _FeedbacksTab(api: _api, config: _cfg),
              _AnnouncementsTab(api: _api, config: _cfg),
              _BannedIpsTab(api: _api, config: _cfg),
              _SensitiveWordsTab(api: _api, config: _cfg),
              _AuditTab(api: _api, config: _cfg),
              _RedeemTab(api: _api, config: _cfg),
              _DeployTab(api: _api, config: _cfg),
              _PasskeyAdminTab(api: _api, config: _cfg),
              _EpayTab(api: _api, config: _cfg),
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
                // 生成 8 位随机密码
                const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
                final rnd = List.generate(8, (i) => chars[(DateTime.now().microsecondsSinceEpoch * 31 + i * 13) % chars.length]).join();
                await _act(() async {
                  await widget.api.adminResetPassword(u['id'] as int, rnd);
                  if (!mounted) return;
                  await showDialog<void>(
                    context: context,
                    builder: (c) => AlertDialog(
                      backgroundColor: _t.card,
                      title: Text('新密码', style: TextStyle(color: _t.text)),
                      content: SelectableText(rnd, style: TextStyle(color: _t.text, fontSize: 16, fontWeight: FontWeight.w700)),
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

// ---------------- 群组 ----------------
class _GroupsTab extends StatefulWidget {
  const _GroupsTab({required this.api, required this.config});
  final SecureChatApi api;
  final AppConfig config;
  @override
  State<_GroupsTab> createState() => _GroupsTabState();
}

class _GroupsTabState extends State<_GroupsTab> {
  List<Map<String, dynamic>> _groups = [];
  bool _loading = true;
  String? _error;
  String _q = '';

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
      final groups = await widget.api.adminGroups(q: _q.trim());
      if (!mounted) return;
      setState(() { _groups = groups; _loading = false; });
    } catch (e) {
      if (!mounted) return;
      setState(() { _loading = false; _error = e.toString().replaceFirst('Bad state: ', ''); });
    }
  }

  Future<void> _showDetail(Map<String, dynamic> g) async {
    try {
      final d = await widget.api.adminGroupDetail(g['id'] as int);
      final members = ((d['members'] as List?) ?? const []).cast<Map<String, dynamic>>();
      if (!mounted) return;
      await showModalBottomSheet(
        context: context,
        backgroundColor: _t.card,
        isScrollControlled: true,
        builder: (ctx) => SizedBox(
          height: MediaQuery.of(ctx).size.height * 0.7,
          child: Column(children: [
            ListTile(
              title: Text('${g['name'] ?? ''}（${members.length} 人）', style: TextStyle(color: _t.text, fontWeight: FontWeight.w700)),
              subtitle: Text('群ID #${g['id']} · 群主 #${g['ownerId'] ?? '-'} · 消息 ${g['msgCount'] ?? 0} 条', style: TextStyle(color: _t.subText, fontSize: 12)),
              trailing: IconButton(
                icon: const Icon(Icons.delete_forever, color: Colors.redAccent),
                onPressed: () async {
                  Navigator.pop(ctx);
                  final confirm = await _prompt('解散该群？输入群名确认', '${g['name'] ?? ''}');
                  if (confirm != g['name']) return;
                  try {
                    await widget.api.adminDissolveGroup(g['id'] as int);
                    if (!mounted) return;
                    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('群已解散')));
                    await _load();
                  } catch (e) {
                    if (!mounted) return;
                    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('操作失败：$e')));
                  }
                },
              ),
            ),
            const Divider(height: 1),
            Expanded(
              child: ListView.builder(
                itemCount: members.length,
                itemBuilder: (c, i) {
                  final m = members[i];
                  return ListTile(
                    dense: true,
                    leading: CircleAvatar(
                      radius: 16,
                      backgroundColor: Ux.cellIconBg(_t),
                      child: Text('${m['nickname'] ?? m['username'] ?? '?'}'.characters.first.toUpperCase(),
                          style: TextStyle(color: _t.text, fontSize: 13, fontWeight: FontWeight.w700)),
                    ),
                    title: Text('${m['nickname'] ?? m['username'] ?? ''}', style: TextStyle(color: _t.text, fontSize: 14)),
                    subtitle: Text('@${m['uid'] ?? ''}', style: TextStyle(color: _t.subText, fontSize: 11)),
                    trailing: (m['id'] == g['ownerId'])
                        ? Text('群主', style: TextStyle(fontSize: 11, color: Ux.green))
                        : IconButton(
                            icon: const Icon(Icons.remove_circle_outline, size: 18, color: Colors.redAccent),
                            onPressed: () async {
                              try {
                                await widget.api.adminRemoveGroupMember(g['id'] as int, m['id'] as int);
                                if (!c.mounted) return;
                                ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已移除成员')));
                                Navigator.pop(ctx);
                                await _showDetail(g);
                              } catch (e) {
                                if (!c.mounted) return;
                                ScaffoldMessenger.of(c).showSnackBar(SnackBar(content: Text('操作失败：$e')));
                              }
                            },
                          ),
                  );
                },
              ),
            ),
          ]),
        ),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('加载失败：$e')));
    }
  }

  Future<String?> _prompt(String title, String initial) async {
    final ctrl = TextEditingController(text: initial);
    final result = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: _t.card,
        title: Text(title, style: TextStyle(color: _t.text, fontSize: 16)),
        content: TextField(controller: ctrl, autofocus: true, style: TextStyle(color: _t.text)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, ctrl.text.trim()), child: const Text('确定')),
        ],
      ),
    );
    ctrl.dispose();
    return result;
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_error != null) {
      return Center(child: Text(_error!, style: TextStyle(color: _t.subText)));
    }
    return Column(children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(12, 10, 12, 6),
        child: Row(children: [
          Expanded(
            child: TextField(
              onChanged: (v) => setState(() => _q = v),
              onSubmitted: (_) => _load(),
              style: TextStyle(color: _t.text),
              decoration: InputDecoration(
                hintText: '搜索群名',
                hintStyle: TextStyle(color: _t.subText, fontSize: 13),
                prefixIcon: Icon(Icons.search, color: _t.subText, size: 20),
                isDense: true,
                filled: true,
                fillColor: _t.card,
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(Ux.cardRadius), borderSide: BorderSide.none),
              ),
            ),
          ),
          const SizedBox(width: 8),
          IconButton(
            onPressed: _load,
            icon: Icon(Icons.refresh, color: _t.text, size: 20),
          ),
        ]),
      ),
      Expanded(
        child: RefreshIndicator(
          onRefresh: _load,
          child: ListView.builder(
            padding: const EdgeInsets.only(bottom: 24),
            itemCount: _groups.length,
            itemBuilder: (ctx, i) {
              final g = _groups[i];
              return Padding(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 3),
                child: Material(
                  color: _t.card,
                  borderRadius: BorderRadius.circular(Ux.cardRadius),
                  child: InkWell(
                    borderRadius: BorderRadius.circular(Ux.cardRadius),
                    onTap: () => _showDetail(g),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                      child: Row(children: [
                        Container(
                          width: 38, height: 38,
                          decoration: BoxDecoration(color: Ux.cellIconBg(_t), borderRadius: BorderRadius.circular(8)),
                          child: Icon(Icons.groups_rounded, color: Ux.green, size: 22),
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                            Text('${g['name'] ?? ''}', overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: _t.text)),
                            Text('群主 #${g['ownerId'] ?? '-'} · ${g['memberCount'] ?? 0} 人 · ${g['msgCount'] ?? 0} 条消息', style: TextStyle(fontSize: 11, color: _t.subText)),
                          ]),
                        ),
                        Icon(Icons.chevron_right_rounded, color: _t.subText, size: 20),
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

// ---------------- 反馈 ----------------
class _FeedbacksTab extends StatefulWidget {
  const _FeedbacksTab({required this.api, required this.config});
  final SecureChatApi api;
  final AppConfig config;
  @override
  State<_FeedbacksTab> createState() => _FeedbacksTabState();
}

class _FeedbacksTabState extends State<_FeedbacksTab> {
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
      final d = await widget.api.adminOverview();
      final fbs = ((d['feedbacks'] as Map?) ?? const {});
      final all = ((fbs['all'] as List?) ?? const []).cast<Map<String, dynamic>>();
      if (!mounted) return;
      setState(() { _list = all; _loading = false; });
    } catch (e) {
      if (!mounted) return;
      setState(() { _loading = false; _error = e.toString().replaceFirst('Bad state: ', ''); });
    }
  }

  static const _kindName = {'bug': 'Bug', 'suggestion': '建议', 'complaint': '投诉', 'other': '其他'};
  static const _statusName = {'open': '待处理', 'processing': '处理中', 'closed': '已关闭'};

  Future<void> _changeStatus(Map<String, dynamic> f) async {
    final cur = '${f['status'] ?? 'open'}';
    final sel = await showDialog<String>(
      context: context,
      builder: (ctx) => SimpleDialog(
        backgroundColor: _t.card,
        title: Text('反馈 #${f['id']} 状态', style: TextStyle(color: _t.text, fontSize: 16)),
        children: ['open', 'processing', 'closed'].map((s) => SimpleDialogOption(
          onPressed: () => Navigator.pop(ctx, s),
          child: Text('${_statusName[s]}${s == cur ? '（当前）' : ''}',
              style: TextStyle(color: s == cur ? Ux.green : _t.text)),
        )).toList(),
      ),
    );
    if (sel == null || sel == cur) return;
    try {
      await widget.api.adminFeedbackStatus(f['id'] as int, sel);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('状态已更新')));
      await _load();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('操作失败：$e')));
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
        itemCount: _list.length,
        itemBuilder: (ctx, i) {
          final f = _list[i];
          final status = '${f['status'] ?? 'open'}';
          final statusColor = switch (status) {
            'closed' => _t.subText,
            'processing' => Colors.orange,
            _ => Colors.redAccent,
          };
          return Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 3),
            child: Material(
              color: _t.card,
              borderRadius: BorderRadius.circular(Ux.cardRadius),
              child: InkWell(
                borderRadius: BorderRadius.circular(Ux.cardRadius),
                onTap: () => _changeStatus(f),
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Row(children: [
                      Text('${_kindName['${f['kind'] ?? 'other'}'] ?? '其他'} · 用户 #${f['userId'] ?? '-'}',
                          style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: _t.subText)),
                      const Spacer(),
                      Text('${_statusName[status] ?? status}', style: TextStyle(fontSize: 11, color: statusColor)),
                    ]),
                    const SizedBox(height: 6),
                    Text('${f['content'] ?? ''}', maxLines: 3, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 13, color: _t.text)),
                    const SizedBox(height: 6),
                    Text(_fmtTime(f['created_at']), style: TextStyle(fontSize: 11, color: _t.subText)),
                  ]),
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}

// ---------------- 封禁 IP ----------------
class _BannedIpsTab extends StatefulWidget {
  const _BannedIpsTab({required this.api, required this.config});
  final SecureChatApi api;
  final AppConfig config;
  @override
  State<_BannedIpsTab> createState() => _BannedIpsTabState();
}

class _BannedIpsTabState extends State<_BannedIpsTab> {
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
      final list = await widget.api.adminBannedIps();
      if (!mounted) return;
      setState(() { _list = list; _loading = false; });
    } catch (e) {
      if (!mounted) return;
      setState(() { _loading = false; _error = e.toString().replaceFirst('Bad state: ', ''); });
    }
  }

  Future<void> _add() async {
    final ipC = TextEditingController();
    final reasonC = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: _t.card,
        title: Text('封禁 IP', style: TextStyle(color: _t.text, fontSize: 16)),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: ipC, style: TextStyle(color: _t.text),
              decoration: InputDecoration(labelText: 'IP 地址', labelStyle: TextStyle(color: _t.subText))),
          const SizedBox(height: 10),
          TextField(controller: reasonC, style: TextStyle(color: _t.text),
              decoration: InputDecoration(labelText: '原因（可选）', labelStyle: TextStyle(color: _t.subText))),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('封禁')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await widget.api.adminBanIp(ipC.text.trim(), reason: reasonC.text.trim());
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已封禁（该 IP 在线用户已被踢下线）')));
      await _load();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('操作失败：$e')));
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
            onPressed: _add,
            icon: const Icon(Icons.block, size: 18),
            label: const Text('封禁 IP'),
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
              final b = _list[i];
              return Padding(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 3),
                child: Container(
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(color: _t.card, borderRadius: BorderRadius.circular(Ux.cardRadius)),
                  child: Row(children: [
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text('${b['ip'] ?? ''}', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700, color: _t.text)),
                        Text('${b['reason'] ?? ''}'.isEmpty ? '封禁于 ${_fmtTime(b['created_at'])}' : '${b['reason']} · ${_fmtTime(b['created_at'])}',
                            style: TextStyle(fontSize: 11, color: _t.subText)),
                      ]),
                    ),
                    IconButton(
                      icon: const Icon(Icons.undo_rounded, size: 20, color: Ux.green),
                      onPressed: () async {
                        try {
                          await widget.api.adminUnbanIp('${b['ip']}');
                          if (!mounted) return;
                          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已解封')));
                          await _load();
                        } catch (e) {
                          if (!mounted) return;
                          ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('操作失败：$e')));
                        }
                      },
                    ),
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

// ---------------- 敏感词 ----------------
class _SensitiveWordsTab extends StatefulWidget {
  const _SensitiveWordsTab({required this.api, required this.config});
  final SecureChatApi api;
  final AppConfig config;
  @override
  State<_SensitiveWordsTab> createState() => _SensitiveWordsTabState();
}

class _SensitiveWordsTabState extends State<_SensitiveWordsTab> {
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
      final list = await widget.api.adminSensitiveWords();
      if (!mounted) return;
      setState(() { _list = list; _loading = false; });
    } catch (e) {
      if (!mounted) return;
      setState(() { _loading = false; _error = e.toString().replaceFirst('Bad state: ', ''); });
    }
  }

  Future<void> _add() async {
    final ctrl = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: _t.card,
        title: Text('添加敏感词', style: TextStyle(color: _t.text, fontSize: 16)),
        content: TextField(controller: ctrl, autofocus: true, style: TextStyle(color: _t.text)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('添加')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await widget.api.adminAddSensitiveWord(ctrl.text.trim());
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已添加')));
      await _load();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('操作失败：$e')));
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
            onPressed: _add,
            icon: const Icon(Icons.gpp_bad_outlined, size: 18),
            label: const Text('添加敏感词'),
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
              final w = _list[i];
              return Padding(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 3),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                  decoration: BoxDecoration(color: _t.card, borderRadius: BorderRadius.circular(Ux.cardRadius)),
                  child: Row(children: [
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                      decoration: BoxDecoration(color: Ux.cellIconBg(_t), borderRadius: BorderRadius.circular(6)),
                      child: Text('${w['word'] ?? ''}', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: _t.text)),
                    ),
                    const Spacer(),
                    Text('命中即拦截', style: TextStyle(fontSize: 10, color: _t.subText)),
                    IconButton(
                      icon: const Icon(Icons.delete_outline, size: 18, color: Colors.redAccent),
                      onPressed: () async {
                        try {
                          await widget.api.adminDeleteSensitiveWord('${w['word']}');
                          if (!mounted) return;
                          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已删除')));
                          await _load();
                        } catch (e) {
                          if (!mounted) return;
                          ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('操作失败：$e')));
                        }
                      },
                    ),
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

// ---------------- 发版 / 安装包 ----------------
class _DeployTab extends StatefulWidget {
  const _DeployTab({required this.api, required this.config});
  final SecureChatApi api;
  final AppConfig config;
  @override
  State<_DeployTab> createState() => _DeployTabState();
}

class _DeployTabState extends State<_DeployTab> {
  Map<String, dynamic>? _version;
  String? _upState;
  bool _loading = true;
  String? _error;
  bool _busy = false;

  AppConfig get _cfg => widget.config;
  AppTheme get _t => _cfg.theme;

  static const _platforms = <(String, String, String)>[
    ('windows', 'Windows 安装包', 'exe'),
    ('windowsPortable', 'Windows 便携版', 'zip'),
    ('macos', 'macOS', 'dmg'),
    ('android', 'Android', 'apk'),
    ('harmony', '鸿蒙', 'hap'),
    ('ios', 'iOS', 'ipa'),
  ];

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() { _loading = true; _error = null; });
    try {
      final up = await widget.api.adminUpdateStatus();
      final u = (up['update'] as Map?) ?? const {};
      final vresp = await widget.api.checkVersion();
      if (!mounted) return;
      setState(() {
        _upState = '${u['state'] ?? 'idle'}';
        _version = vresp;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() { _loading = false; _error = e.toString().replaceFirst('Bad state: ', ''); });
    }
  }

  Future<void> _setVersion() async {
    final latestC = TextEditingController(text: '${_version?['latest'] ?? ''}');
    final notesC = TextEditingController(text: '${_version?['releaseNotes'] ?? ''}');
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: _t.card,
        title: Text('更新版本配置', style: TextStyle(color: _t.text, fontSize: 16)),
        content: SizedBox(
          width: 380,
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            TextField(controller: latestC, style: TextStyle(color: _t.text),
                decoration: InputDecoration(labelText: '最新版本（x.y.z）', labelStyle: TextStyle(color: _t.subText))),
            const SizedBox(height: 10),
            TextField(controller: notesC, maxLines: 4, style: TextStyle(color: _t.text),
                decoration: InputDecoration(labelText: '更新说明', labelStyle: TextStyle(color: _t.subText))),
          ]),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('保存')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await widget.api.adminSetVersion(latestC.text.trim(), releaseNotes: notesC.text.trim());
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('版本配置已保存（上传安装包需按此版本命名）')));
      await _load();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('保存失败：$e')));
    }
  }

  Future<void> _upload(String platform, String label) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      final result = await FilePicker.platform.pickFiles(withData: true);
      if (result == null || result.files.isEmpty) return;
      final file = result.files.first;
      if (file.bytes == null) {
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('读取文件失败（请选择本地文件）')));
        return;
      }
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('正在上传 $label（${(file.bytes!.length / 1024 / 1024).toStringAsFixed(1)} MB）...')));
      final r = await widget.api.adminUploadPackage(platform, file.bytes!);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('上传成功：${r['file'] ?? ''}')));
      await _load();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('上传失败：$e')));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _delete(String platform, String label) async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: _t.card,
        title: Text('删除 $label 安装包？', style: TextStyle(color: _t.text, fontSize: 16)),
        content: Text('将从服务器 downloads 目录移除当前版本的文件，客户端将无法再下载该平台的此版本。', style: TextStyle(color: _t.subText, fontSize: 12)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('删除')),
        ],
      ),
    );
    if (confirm != true) return;
    try {
      await widget.api.adminDeletePackage(platform);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已删除')));
      await _load();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('操作失败：$e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_error != null) {
      return Center(child: Text(_error!, style: TextStyle(color: _t.subText)));
    }
    final dl = (_version?['downloads'] as Map?) ?? const {};
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.all(12),
        children: [
          SectionCard(
            config: _cfg,
            children: [
              ListTile(
                contentPadding: const EdgeInsets.symmetric(horizontal: 6),
                title: Text('当前版本：${_version?['current'] ?? '-'}', style: TextStyle(color: _t.text, fontSize: 14)),
                subtitle: Text('最新版本：${_version?['latest'] ?? '-'} · 更新时间 ${_fmtTime(_version?['updatedAt'])}', style: TextStyle(color: _t.subText, fontSize: 12)),
                trailing: FilledButton(onPressed: _setVersion, child: const Text('修改版本/说明')),
              ),
            ],
          ),
          const SizedBox(height: 10),
          SectionCard(
            config: _cfg,
            children: [
              ListTile(
                contentPadding: const EdgeInsets.symmetric(horizontal: 6),
                leading: Icon(Icons.update, color: _upState == 'pending' ? Colors.orange : (['applied', 'idle'].contains(_upState) ? Ux.green : _t.subText)),
                title: Text('整包更新状态：${_upState ?? 'idle'}', style: TextStyle(color: _t.text, fontSize: 14)),
                subtitle: Text('上传 ZIP 后需在服务端执行替换并重启（建议直接上传各平台安装包）', style: TextStyle(color: _t.subText, fontSize: 12)),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Text('安装包管理（上传的文件按「最新版本」命名，供客户端自动更新下载）', style: TextStyle(fontSize: 12, color: _t.subText)),
          const SizedBox(height: 8),
          ..._platforms.map((p) {
            final (key, label, _) = p;
            final path = dl[key];
            final exists = path != null && '$path'.isNotEmpty;
            return Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Material(
                color: _t.card,
                borderRadius: BorderRadius.circular(Ux.cardRadius),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                  child: Row(children: [
                    Icon(Icons.archive_outlined, color: Ux.green, size: 22),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text(label, style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: _t.text)),
                        Text(exists ? '$path' : '未上传', overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 11, color: exists ? Ux.green : _t.subText)),
                      ]),
                    ),
                    IconButton(
                      tooltip: '上传',
                      icon: Icon(Icons.upload_file_rounded, color: _t.text),
                      onPressed: () => _upload(key, label),
                    ),
                    if (exists)
                      IconButton(
                        tooltip: '删除',
                        icon: const Icon(Icons.delete_outline, color: Colors.redAccent),
                        onPressed: () => _delete(key, label),
                      ),
                  ]),
                ),
              ),
            );
          }),
        ],
      ),
    );
  }
}

// ---------------- QQ 互联配置 ----------------
class _QqConfigTab extends StatefulWidget {
  const _QqConfigTab({required this.api, required this.config});
  final SecureChatApi api;
  final AppConfig config;
  @override
  State<_QqConfigTab> createState() => _QqConfigTabState();
}

class _QqConfigTabState extends State<_QqConfigTab> {
  bool _loading = true;
  String? _error;
  final appid = TextEditingController();
  final secret = TextEditingController();
  final redirect = TextEditingController();
  bool enabled = false;
  bool _saving = false;

  AppConfig get _cfg => widget.config;
  AppTheme get _t => _cfg.theme;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    appid.dispose();
    secret.dispose();
    redirect.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() { _loading = true; _error = null; });
    try {
      final d = await widget.api.adminQqConfig();
      final c = (d['config'] as Map?) ?? const {};
      if (!mounted) return;
      appid.text = '${c['appid'] ?? ''}';
      secret.text = '${c['secret'] ?? ''}';
      redirect.text = '${c['redirect'] ?? ''}';
      enabled = c['enabled'] == true;
      setState(() => _loading = false);
    } catch (e) {
      if (!mounted) return;
      setState(() { _loading = false; _error = e.toString().replaceFirst('Bad state: ', ''); });
    }
  }

  Future<void> _save() async {
    if (_saving) return;
    setState(() => _saving = true);
    try {
      await widget.api.adminSaveQqConfig(
        appid: appid.text.trim(),
        secret: secret.text.trim(),
        redirect: redirect.text.trim(),
        enabled: enabled,
      );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已保存（QQ 授权回调地址必须与互联后台完全一致）')));
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('保存失败：$e')));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
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
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.all(12),
        children: [
          SectionCard(
            config: _cfg,
            padding: const EdgeInsets.all(14),
            children: [
              Text('QQ 互联（OAuth2.0）登录', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700, color: _t.text)),
              const SizedBox(height: 6),
              Text('在 connect.qq.com 创建「网站应用」获取 AppID 与 AppKey，并填写「授权回调地址」，客户端登录页即可出现「QQ登录」入口。',
                  style: TextStyle(fontSize: 12, color: _t.subText, height: 1.5)),
            ],
          ),
          const SizedBox(height: 10),
          SectionCard(
            config: _cfg,
            padding: const EdgeInsets.all(14),
            children: [
              Text('应用信息', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: _t.subText)),
              const SizedBox(height: 12),
              TextField(
                controller: appid,
                style: TextStyle(color: _t.text),
                decoration: InputDecoration(labelText: 'AppID', labelStyle: TextStyle(color: _t.subText), hintText: '例如 101234567', hintStyle: TextStyle(color: _t.subText.withValues(alpha: 0.5))),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: secret,
                obscureText: true,
                style: TextStyle(color: _t.text),
                decoration: InputDecoration(labelText: 'AppKey', labelStyle: TextStyle(color: _t.subText)),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: redirect,
                style: TextStyle(color: _t.text),
                decoration: InputDecoration(
                  labelText: '授权回调地址',
                  labelStyle: TextStyle(color: _t.subText),
                  hintText: 'https://mc.32768.top:8888/oauth/qq/callback',
                  hintStyle: TextStyle(color: _t.subText.withValues(alpha: 0.5)),
                  helperText: '必须与 QQ 互联后台「授权回调域」填写的完全一致，否则授权失败',
                  helperStyle: TextStyle(fontSize: 10, color: _t.subText),
                ),
              ),
              const SizedBox(height: 8),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                value: enabled,
                onChanged: (v) => setState(() => enabled = v),
                title: Text('启用 QQ 登录', style: TextStyle(color: _t.text, fontSize: 14)),
                subtitle: Text('关闭后登录页不再显示 QQ 入口', style: TextStyle(color: _t.subText, fontSize: 11)),
                activeThumbColor: Ux.green,
              ),
            ],
          ),
          const SizedBox(height: 10),
          Row(children: [
            Expanded(
              child: FilledButton.icon(
                onPressed: _saving ? null : _save,
                icon: const Icon(Icons.save_outlined, size: 18),
                label: Text(_saving ? '保存中…' : '保存配置'),
              ),
            ),
          ]),
        ],
      ),
    );
  }
}

// ---------------- GitHub OAuth 配置 ----------------
class _GithubConfigTab extends StatefulWidget {
  const _GithubConfigTab({required this.api, required this.config});
  final SecureChatApi api;
  final AppConfig config;
  @override
  State<_GithubConfigTab> createState() => _GithubConfigTabState();
}

class _GithubConfigTabState extends State<_GithubConfigTab> {
  bool _loading = true;
  String? _error;
  final clientId = TextEditingController();
  final clientSecret = TextEditingController();
  final redirect = TextEditingController();
  bool enabled = false;
  bool _saving = false;

  AppConfig get _cfg => widget.config;
  AppTheme get _t => _cfg.theme;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    clientId.dispose();
    clientSecret.dispose();
    redirect.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() { _loading = true; _error = null; });
    try {
      final d = await widget.api.adminGithubConfig();
      final c = (d['config'] as Map?) ?? const {};
      if (!mounted) return;
      clientId.text = '${c['clientId'] ?? ''}';
      clientSecret.text = '${c['clientSecret'] ?? ''}';
      redirect.text = '${c['redirect'] ?? ''}';
      enabled = c['enabled'] == true;
      setState(() => _loading = false);
    } catch (e) {
      if (!mounted) return;
      setState(() { _loading = false; _error = e.toString().replaceFirst('Bad state: ', ''); });
    }
  }

  Future<void> _save() async {
    if (_saving) return;
    setState(() => _saving = true);
    try {
      await widget.api.adminSaveGithubConfig(
        clientId: clientId.text.trim(),
        clientSecret: clientSecret.text.trim(),
        redirect: redirect.text.trim(),
        enabled: enabled,
      );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已保存（回调地址需与 GitHub OAuth App 完全一致）')));
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('保存失败：$e')));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
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
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.all(12),
        children: [
          SectionCard(
            config: _cfg,
            padding: const EdgeInsets.all(14),
            children: [
              Text('GitHub OAuth 登录', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700, color: _t.text)),
              const SizedBox(height: 6),
              Text('在 github.com/settings/developers 创建 OAuth App，填写 Client ID / Secret / 授权回调地址，无需备案，审核即时生效。',
                  style: TextStyle(fontSize: 12, color: _t.subText, height: 1.5)),
            ],
          ),
          const SizedBox(height: 10),
          SectionCard(
            config: _cfg,
            padding: const EdgeInsets.all(14),
            children: [
              Text('应用信息', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: _t.subText)),
              const SizedBox(height: 12),
              TextField(
                controller: clientId,
                style: TextStyle(color: _t.text),
                decoration: InputDecoration(labelText: 'Client ID', labelStyle: TextStyle(color: _t.subText), hintText: 'OAuth App 的 Client ID', hintStyle: TextStyle(color: _t.subText.withValues(alpha: 0.5))),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: clientSecret,
                obscureText: true,
                style: TextStyle(color: _t.text),
                decoration: InputDecoration(labelText: 'Client Secret', labelStyle: TextStyle(color: _t.subText)),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: redirect,
                style: TextStyle(color: _t.text),
                decoration: InputDecoration(
                  labelText: '授权回调地址',
                  labelStyle: TextStyle(color: _t.subText),
                  hintText: 'https://mc.32768.top:8888/oauth/github/callback',
                  hintStyle: TextStyle(color: _t.subText.withValues(alpha: 0.5)),
                  helperText: '必须与 GitHub OAuth App 填写的 Authorization callback URL 完全一致',
                  helperStyle: TextStyle(fontSize: 10, color: _t.subText),
                ),
              ),
              const SizedBox(height: 8),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                value: enabled,
                onChanged: (v) => setState(() => enabled = v),
                title: Text('启用 GitHub 登录', style: TextStyle(color: _t.text, fontSize: 14)),
                subtitle: Text('关闭后登录页不再显示 GitHub 入口', style: TextStyle(color: _t.subText, fontSize: 11)),
                activeThumbColor: Ux.green,
              ),
            ],
          ),
          const SizedBox(height: 10),
          Row(children: [
            Expanded(
              child: FilledButton.icon(
                onPressed: _saving ? null : _save,
                icon: const Icon(Icons.save_outlined, size: 18),
                label: Text(_saving ? '保存中…' : '保存配置'),
              ),
            ),
          ]),
        ],
      ),
    );
  }
}

class _PasskeyAdminTab extends StatefulWidget {
  const _PasskeyAdminTab({required this.api, required this.config});
  final SecureChatApi api;
  final AppConfig config;
  @override
  State<_PasskeyAdminTab> createState() => _PasskeyAdminTabState();
}

class _PasskeyAdminTabState extends State<_PasskeyAdminTab> {
  List<Map<String, dynamic>> _items = [];
  bool _loading = true;
  AppTheme get _t => widget.config.theme;

  @override
  void initState() { super.initState(); _load(); }

  Future<void> _load() async {
    try {
      final rows = await widget.api.adminPasskeys();
      if (mounted) setState(() { _items = rows; _loading = false; });
    } catch (e) {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.all(12),
        children: [
          SectionCard(config: widget.config, padding: const EdgeInsets.all(14), children: [
            Text('Passkey 凭据管理', style: TextStyle(color: _t.text, fontWeight: FontWeight.w700)),
            const SizedBox(height: 6),
            Text('用户创建的本地设备凭据。删除后对应设备将无法免密登录和授权扣款。', style: TextStyle(color: _t.subText, fontSize: 12)),
          ]),
          const SizedBox(height: 10),
          ..._items.map((p) => Card(
            color: _t.card,
            child: ListTile(
              leading: const Icon(Icons.key_rounded, color: Ux.green),
              title: Text('${p['device_name'] ?? '设备'} · ${p['nickname'] ?? p['username'] ?? ''}', style: TextStyle(color: _t.text)),
              subtitle: Text('${p['email'] ?? ''}\n创建：${_fmtTime(p['created_at'])} · 最近使用：${_fmtTime(p['last_used_at'])}', style: TextStyle(color: _t.subText, fontSize: 11)),
              isThreeLine: true,
              trailing: IconButton(
                icon: const Icon(Icons.delete_outline, color: Colors.redAccent),
                onPressed: () async {
                  await widget.api.adminDeletePasskey('${p['credential_id']}');
                  await _load();
                },
              ),
            ),
          )),
        ],
      ),
    );
  }
}

class _EpayTab extends StatefulWidget {
  const _EpayTab({required this.api, required this.config});
  final SecureChatApi api;
  final AppConfig config;

  @override
  State<_EpayTab> createState() => _EpayTabState();
}

class _EpayTabState extends State<_EpayTab> {
  final _base = TextEditingController();
  final _gateway = TextEditingController();
  final _gatewayId = TextEditingController();
  final _pid = TextEditingController();
  final _key = TextEditingController();
  final _notify = TextEditingController();
  final _return = TextEditingController();
  bool _enabled = false;
  bool _sandbox = false;
  bool _loading = true;
  bool _saving = false;
  String? _error;

  AppTheme get _t => widget.config.theme;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final r = await widget.api.adminEpayConfig();
      final c = (r['config'] as Map?)?.cast<String, dynamic>() ?? {};
      if (!mounted) return;
      setState(() {
        _enabled = c['enabled'] == true;
        _sandbox = c['sandbox'] == true;
        _base.text = '${c['baseUrl'] ?? ''}';
        _gateway.text = '${c['gatewayUrl'] ?? ''}';
        _gatewayId.text = '${c['gatewayId'] ?? ''}';
        _pid.text = '${c['merchantPid'] ?? ''}';
        _key.text = '${c['key'] ?? ''}';
        _notify.text = '${c['notifyUrl'] ?? ''}';
        _return.text = '${c['returnUrl'] ?? ''}';
        _loading = false;
      });
    } catch (e) {
      if (mounted) setState(() { _loading = false; _error = e.toString().replaceFirst('Bad state: ', ''); });
    }
  }

  Future<void> _save() async {
    setState(() => _saving = true);
    try {
      await widget.api.adminSaveEpayConfig({
        'enabled': _enabled,
        'sandbox': _sandbox,
        'baseUrl': _base.text.trim(),
        'gatewayUrl': _gateway.text.trim(),
        'gatewayId': _gatewayId.text.trim(),
        'merchantPid': _pid.text.trim(),
        'key': _key.text.trim(),
        'notifyUrl': _notify.text.trim(),
        'returnUrl': _return.text.trim(),
      });
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('EPay 配置已保存')));
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('保存失败：$e')));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  void dispose() {
    for (final c in [_base, _gateway, _gatewayId, _pid, _key, _notify, _return]) {
      c.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_error != null) return Center(child: Text(_error!, style: TextStyle(color: _t.text)));
    Widget field(TextEditingController c, String label, {bool secret = false}) => Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: TextField(controller: c, obscureText: secret, style: TextStyle(color: _t.text), decoration: InputDecoration(labelText: label, labelStyle: TextStyle(color: _t.subText), filled: true, fillColor: _t.inputBg, border: const OutlineInputBorder())),
    );
    return ListView(padding: const EdgeInsets.all(12), children: [
      SectionCard(config: widget.config, padding: const EdgeInsets.all(14), children: [
        Row(children: [Expanded(child: Text('EPay 支付通道', style: TextStyle(color: _t.text, fontWeight: FontWeight.w700))), Switch(value: _enabled, onChanged: (v) => setState(() => _enabled = v))]),
        Row(children: [Expanded(child: Text('模拟模式（沙箱，无需真实商户参数）', style: TextStyle(color: _t.text, fontSize: 13))), Switch(value: _sandbox, onChanged: (v) => setState(() => _sandbox = v))]),
        Text('保存后由服务端生成签名并接收异步回调。Key 不会回显明文。', style: TextStyle(color: _t.subText, fontSize: 12)),
        const SizedBox(height: 14),
        field(_base, '基础地址，例如 https://pay.example.com'),
        field(_gateway, '网关地址，例如 https://pay.example.com/submit.php'),
        field(_gatewayId, '网关标识（可选）'),
        field(_pid, '商户 PID'),
        field(_key, '商户密钥（留 ******** 表示不修改）', secret: true),
        field(_notify, '异步回调地址'),
        field(_return, '同步返回地址（可选）'),
        SizedBox(height: 44, child: FilledButton(onPressed: _saving ? null : _save, child: Text(_saving ? '保存中…' : '保存 EPay 配置'))),
      ]),
    ]);
  }
}
