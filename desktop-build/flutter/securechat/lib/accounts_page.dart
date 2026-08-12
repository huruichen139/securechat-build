import 'package:flutter/material.dart';

import 'services/securechat_api.dart';

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

  @override
  void initState() {
    super.initState();
    _reload();
  }

  Future<void> _reload() async {
    setState(() { _loading = true; _error = null; });
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
    final followed = a['followed'] == 1 || a['followed'] == true || a['followed'] != 0;
    final newOn = !(followed);
    setState(() => a['followed'] = newOn ? 1 : 0);
    try {
      await widget.api.followAccount(id, on: newOn);
    } catch (_) {
      setState(() => a['followed'] = followed ? 1 : 0);
    }
  }

  Future<void> _openPosts(Map<String, dynamic> a) async {
    final id = a['id'] as int;
    final posts = await widget.api.accountPosts(id);
    if (!mounted) return;
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      builder: (ctx) {
        final cs = Theme.of(ctx).colorScheme;
        return SafeArea(
          child: Container(
            height: MediaQuery.of(ctx).size.height * 0.7,
            padding: const EdgeInsets.fromLTRB(20, 18, 20, 24),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(a['name'] ?? '公众号', style: TextStyle(color: cs.onSurface, fontWeight: FontWeight.w700, fontSize: 17)),
              if ((a['intro'] ?? '').toString().isNotEmpty) ...[
                const SizedBox(height: 4),
                Text(a['intro'], style: TextStyle(color: cs.onSurfaceVariant, fontSize: 13)),
              ],
              const SizedBox(height: 12),
              const Divider(),
              Expanded(
                child: posts.isEmpty
                    ? Center(child: Text('暂无文章', style: TextStyle(color: cs.onSurfaceVariant)))
                    : ListView.separated(
                        itemCount: posts.length,
                        separatorBuilder: (_, i) => const Divider(height: 1),
                        itemBuilder: (_, i) {
                          final p = posts[i];
                          return ListTile(
                            contentPadding: EdgeInsets.zero,
                            title: Text(p['title'] ?? '', style: TextStyle(color: cs.onSurface, fontWeight: FontWeight.w600)),
                            subtitle: Text((p['content'] ?? '').toString().split('\n').first, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(color: cs.onSurfaceVariant, fontSize: 12)),
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
    final cs = Theme.of(ctx).colorScheme;
    showModalBottomSheet(
      context: ctx,
      isScrollControlled: true,
      builder: (c) => SafeArea(
        child: Container(
          height: MediaQuery.of(c).size.height * 0.85,
          padding: const EdgeInsets.fromLTRB(22, 22, 22, 24),
          child: SingleChildScrollView(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(p['title'] ?? '', style: TextStyle(color: cs.onSurface, fontSize: 20, fontWeight: FontWeight.w800)),
              const SizedBox(height: 14),
              Text(p['content'] ?? '', style: TextStyle(color: cs.onSurface, fontSize: 15, height: 1.6)),
            ]),
          ),
        ),
      ),
    );
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
        title: Text('公众号', style: TextStyle(color: cs.onSurface, fontWeight: FontWeight.w700)),
        leading: IconButton(icon: Icon(Icons.arrow_back, color: cs.onSurface), onPressed: () => Navigator.of(context).maybePop()),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(child: Text(_error!, style: TextStyle(color: cs.error)))
              : _accounts.isEmpty
                  ? Center(child: Text('还没有关注的公众号', style: TextStyle(color: cs.onSurfaceVariant)))
                  : ListView.separated(
                      padding: const EdgeInsets.symmetric(vertical: 8),
                      itemCount: _accounts.length,
                      separatorBuilder: (_, i) => const Divider(height: 1, indent: 72),
                      itemBuilder: (_, i) {
                        final a = _accounts[i];
                        final followed = a['followed'] == 1 || a['followed'] == true;
                        return ListTile(
                          leading: CircleAvatar(backgroundColor: color.withValues(alpha: 0.15), child: Text((a['name'] ?? 'A').toString().isNotEmpty ? (a['name'] as String)[0] : 'A', style: TextStyle(color: color))),
                          title: Text(a['name'] ?? '', style: TextStyle(color: cs.onSurface, fontWeight: FontWeight.w600)),
                          subtitle: Text((a['intro'] ?? '暂无简介').toString(), maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: cs.onSurfaceVariant, fontSize: 12)),
                          trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                            if (followed) TextButton(onPressed: () => _openPosts(a), child: Text('查看文章', style: TextStyle(color: color))),
                            FilledButton.tonal(
                              onPressed: () => _toggleFollow(a),
                              style: FilledButton.styleFrom(
                                backgroundColor: followed ? cs.surfaceContainerHighest : color,
                                foregroundColor: followed ? cs.onSurfaceVariant : cs.onPrimary,
              ),
                              child: Text(followed ? '已关注' : '关注'),
                            ),
                          ]),
                        );
                      },
                    ),
    );
  }
}