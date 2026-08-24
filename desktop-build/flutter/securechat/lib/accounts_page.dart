import 'package:flutter/material.dart';

import 'services/app_config.dart';
import 'services/securechat_api.dart';
import 'widgets/ux.dart';

class AccountsPage extends StatefulWidget {
  const AccountsPage({super.key, required this.api, required this.config});
  final SecureChatApi api;
  final dynamic config;
  @override
  State<AccountsPage> createState() => _AccountsPageState();
}

class _AccountsPageState extends State<AccountsPage> {
  final _accounts = <Map<String, dynamic>>[];
  bool _loading = true;
  String? _error;

  AppConfig get _cfg => widget.config as AppConfig;
  AppTheme get _t => _cfg.theme;

  @override
  void initState() {
    super.initState();
    _reload();
  }

  Future<void> _reload() async {
    if (!mounted) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      _accounts
        ..clear()
        ..addAll(await widget.api.accounts());
    } catch (e) {
      _error = e.toString().replaceFirst('Bad state: ', '');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _toggleFollow(Map<String, dynamic> a) async {
    final id = a['id'] as int;
    final followed = a['followed'] == 1 || a['followed'] == true;
    final newOn = !(followed);
    setState(() => a['followed'] = newOn ? 1 : 0);
    try {
      await widget.api.followAccount(id, on: newOn);
    } catch (_) {
      if (!mounted) return;
      setState(() => a['followed'] = followed ? 1 : 0);
    }
  }

  Future<void> _openPosts(Map<String, dynamic> a) async {
    final id = a['id'] as int;
    final posts = await widget.api.accountPosts(id);
    if (!mounted) return;
    final t = _t;
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: t.bg,
      builder: (ctx) {
        return SafeArea(
          child: Container(
            height: MediaQuery.of(ctx).size.height * 0.7,
            padding: const EdgeInsets.fromLTRB(20, 18, 20, 24),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(a['name'] ?? '公众号', style: TextStyle(color: t.text, fontWeight: FontWeight.w700, fontSize: 17)),
              if ((a['intro'] ?? '').toString().isNotEmpty) ...[
                const SizedBox(height: 4),
                Text(a['intro'], style: TextStyle(color: t.subText, fontSize: 13)),
              ],
              const SizedBox(height: 12),
              Divider(height: 1, color: t.div.withValues(alpha: 0.6)),
              Expanded(
                child: posts.isEmpty
                    ? Center(child: Text('暂无文章', style: TextStyle(color: t.subText)))
                    : ListView.separated(
                        itemCount: posts.length,
                        separatorBuilder: (_, i) => Divider(height: 1, color: t.div.withValues(alpha: 0.6)),
                        itemBuilder: (_, i) {
                          final p = posts[i];
                          return ListTile(
                            contentPadding: EdgeInsets.zero,
                            title: Text(p['title'] ?? '', style: TextStyle(color: t.text, fontWeight: FontWeight.w600)),
                            subtitle: Text((p['content'] ?? '').toString().split('\n').first, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.subText, fontSize: 12)),
                            onTap: () => _readPost(ctx, p),
                          );
                        },
                      ),
              ),
            ]),
          ),
        );
      },
    );
  }

  void _readPost(BuildContext ctx, Map<String, dynamic> p) {
    final t = _t;
    showModalBottomSheet(
      context: ctx,
      isScrollControlled: true,
      backgroundColor: t.bg,
      builder: (c) => SafeArea(
        child: Container(
          height: MediaQuery.of(c).size.height * 0.85,
          padding: const EdgeInsets.fromLTRB(22, 22, 22, 24),
          child: SingleChildScrollView(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(p['title'] ?? '', style: TextStyle(color: t.text, fontSize: 20, fontWeight: FontWeight.w800)),
              const SizedBox(height: 14),
              Text(p['content'] ?? '', style: TextStyle(color: t.text, fontSize: 15, height: 1.6)),
            ]),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final t = _t;
    return Scaffold(
      backgroundColor: t.bg,
      body: Column(children: [
        PageHeader(
          title: '公众号',
          config: _cfg,
          trailing: IconButton(
            onPressed: _reload,
            icon: Icon(Icons.refresh, color: t.text, size: 20),
          ),
        ),
        Expanded(
          child: _loading
              ? Center(child: CircularProgressIndicator(color: t.subText))
              : _error != null
                  ? Center(child: Text(_error!, style: TextStyle(color: t.subText)))
                  : _accounts.isEmpty
                      ? Center(child: Text('还没有关注的公众号', style: TextStyle(color: t.subText)))
                      : ListView.separated(
                          padding: const EdgeInsets.symmetric(vertical: 8),
                          itemCount: _accounts.length,
                          separatorBuilder: (_, i) => CellDivider(config: _cfg, indent: 72),
                          itemBuilder: (_, i) {
                            final a = _accounts[i];
                            final followed = a['followed'] == 1 || a['followed'] == true;
                            final name = (a['name'] ?? 'A').toString();
                            return ListTile(
                              contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 4),
                              leading: CircleAvatar(backgroundColor: Ux.cellIconBg(t), child: Text(name.isNotEmpty ? name[0] : 'A', style: TextStyle(color: t.text))),
                              title: Text(a['name'] ?? '', style: TextStyle(color: t.text, fontWeight: FontWeight.w600)),
                              subtitle: Text((a['intro'] ?? '暂无简介').toString(), maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.subText, fontSize: 12)),
                              trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                                if (followed) TextButton(onPressed: () => _openPosts(a), child: Text('查看文章', style: TextStyle(color: Ux.green))),
                                FilledButton.tonal(
                                  onPressed: () => _toggleFollow(a),
                                  style: FilledButton.styleFrom(
                                    backgroundColor: followed ? Ux.cellIconBg(t) : Ux.green,
                                    foregroundColor: followed ? t.subText : Colors.white,
                                  ),
                                  child: Text(followed ? '已关注' : '关注'),
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
