// module: oa_page (worker batch4) —— Flutter 公众号页：关注/文章/留言/在看
import 'package:flutter/material.dart';

import 'services/media_api.dart';
import 'services/securechat_api.dart';

class OaPage extends StatefulWidget {
  const OaPage({super.key, required this.api, required this.config});
  final SecureChatApi api;
  final dynamic config;
  @override
  State<OaPage> createState() => _OaPageState();
}

class _OaPageState extends State<OaPage> {
  late final MediaService _svc = MediaService(widget.api);
  final _tab = ValueNotifier(0); // 0=公众号列表 1=订阅 2=在看
  List<Map<String, dynamic>> _accounts = [];
  List<Map<String, dynamic>> _feed = [];
  List<Map<String, dynamic>> _present = [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
    _tab.addListener(_load);
  }

  @override
  void dispose() {
    _tab.removeListener(_load);
    _tab.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() { _loading = true; _error = null; });
    try {
      if (_tab.value == 0) {
        _accounts = await _svc.accounts();
      } else if (_tab.value == 1) {
        _feed = await _svc.oaFeed();
      } else {
        _present = await _svc.myPresent();
      }
    } catch (e) {
      _error = e.toString().replaceFirst('Bad state: ', '');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  List<Map<String, dynamic>> get _cur => _tab.value == 1 ? _feed : (_tab.value == 2 ? _present : _accounts);

  String _fmt(dynamic v) {
    final ms = v is int ? v : int.tryParse('$v') ?? 0;
    if (ms == 0) return '';
    final dt = DateTime.fromMillisecondsSinceEpoch(ms);
    String two(int x) => x.toString().padLeft(2, '0');
    return '${dt.year}/${dt.month}/${dt.day} ${two(dt.hour)}:${two(dt.minute)}';
  }

  Future<void> _registerOa() async {
    final name = TextEditingController();
    final intro = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('注册公众号'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: name, decoration: const InputDecoration(hintText: '公众号名称')),
          const SizedBox(height: 8),
          TextField(controller: intro, decoration: const InputDecoration(hintText: '简介（可选）')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('注册')),
        ],
      ),
    );
    if (ok != true || name.text.trim().isEmpty) return;
    try {
      await _svc.registerOa(name.text.trim(), intro.text.trim());
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('公众号创建成功')));
      _load();
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('失败：$e')));
    }
  }

  void _openAccount(Map<String, dynamic> a) {
    Navigator.of(context).push(MaterialPageRoute(builder: (_) => _AccountDetail(svc: _svc, account: a)));
  }

  void _openArticle(Map<String, dynamic> a) {
    Navigator.of(context).push(MaterialPageRoute(builder: (_) => _ArticleDetail(svc: _svc, article: a)));
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
        actions: [IconButton(icon: Icon(Icons.refresh, color: color), onPressed: _load)],
      ),
      body: Column(children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: Row(children: [
            for (final (i, label) in const [(0, '公众号'), (1, '订阅'), (2, '在看')])
              Expanded(child: ValueListenableBuilder<int>(
                valueListenable: _tab,
                builder: (_, v, __) => InkWell(
                  onTap: () => _tab.value = i,
                  child: Container(
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    alignment: Alignment.center,
                    decoration: BoxDecoration(border: Border(bottom: BorderSide(color: v == i ? color : Colors.transparent, width: 2))),
                    child: Text(label, style: TextStyle(color: v == i ? color : cs.onSurfaceVariant, fontWeight: v == i ? FontWeight.w700 : FontWeight.w500)),
                  ),
                ),
              )),
            IconButton(icon: Icon(Icons.add_circle_outline, color: color), onPressed: _registerOa),
          ]),
        ),
        Divider(height: 1, color: cs.outlineVariant),
        Expanded(
          child: _loading
              ? const Center(child: CircularProgressIndicator())
              : _error != null
                  ? Center(child: Text(_error!, style: TextStyle(color: cs.error)))
                  : _cur.isEmpty
                      ? Center(child: Text(_tab.value == 0 ? '还没有公众号' : (_tab.value == 1 ? '还没有订阅' : '还没有在看'), style: TextStyle(color: cs.onSurfaceVariant)))
                      : ListView.separated(
                          padding: const EdgeInsets.all(16),
                          itemCount: _cur.length,
                          separatorBuilder: (_, i) => const SizedBox(height: 10),
                          itemBuilder: (_, i) {
                            final m = _cur[i];
                            final isArticle = _tab.value != 0;
                            return Container(
                              padding: const EdgeInsets.all(14),
                              decoration: BoxDecoration(color: cs.surface, borderRadius: BorderRadius.circular(14), border: Border.all(color: cs.outlineVariant.withValues(alpha: 0.5))),
                              child: isArticle
                                  ? InkWell(onTap: () => _openArticle(m), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                      Text((m['title'] ?? '').toString(), style: TextStyle(color: cs.onSurface, fontSize: 15, fontWeight: FontWeight.w600)),
                                      const SizedBox(height: 4),
                                      Text('${_svc.str(m['accountName'])} · ${_fmt(m['createdAt'])} · 阅读 ${_svc.toInt(m['readCount'])} · 在看 ${_svc.toInt(m['presentCount'])}', style: TextStyle(color: cs.onSurfaceVariant, fontSize: 12)),
                                    ]))
                                  : InkWell(onTap: () => _openAccount(m), child: Row(children: [
                                      CircleAvatar(radius: 18, backgroundColor: color.withValues(alpha: 0.15), child: Text(_svc.str(m['name']).isNotEmpty ? _svc.str(m['name'])[0] : '?', style: TextStyle(color: color))),
                                      const SizedBox(width: 10),
                                      Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                        Text(_svc.str(m['name']), style: TextStyle(color: cs.onSurface, fontWeight: FontWeight.w600)),
                                        Text(_svc.str(m['intro']) + (m['following'] == true ? ' · 已关注' : ''), style: TextStyle(color: cs.onSurfaceVariant, fontSize: 12)),
                                      ])),
                                      TextButton(
                                        onPressed: () async {
                                          try {
                                            await _svc.followOa(_svc.toInt(m['id']), on: m['following'] != true);
                                            _load();
                                          } catch (e) {
                                            if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
                                          }
                                        },
                                        child: Text(m['following'] == true ? '已关注' : '＋关注', style: TextStyle(color: color)),
                                      ),
                                    ])),
                            );
                          },
                        ),
        ),
      ]),
    );
  }
}

class _AccountDetail extends StatefulWidget {
  const _AccountDetail({required this.svc, required this.account});
  final MediaService svc;
  final Map<String, dynamic> account;
  @override
  State<_AccountDetail> createState() => _AccountDetailState();
}

class _AccountDetailState extends State<_AccountDetail> {
  late final MediaService svc = widget.svc;
  List<Map<String, dynamic>> _articles = [];
  bool _loading = true;
  String? _error;
  Map<String, dynamic> _account = {};

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() { _loading = true; _error = null; });
    try {
      final acc = await svc.account(widget.account['id'] as int);
      _account = acc;
      _articles = await svc.accountArticles(widget.account['id'] as int);
    } catch (e) {
      _error = e.toString().replaceFirst('Bad state: ', '');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _publish() async {
    final t = TextEditingController();
    final c = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('发布图文文章'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: t, decoration: const InputDecoration(hintText: '标题')),
          const SizedBox(height: 8),
          TextField(controller: c, maxLines: 5, decoration: const InputDecoration(hintText: '正文')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('发布')),
        ],
      ),
    );
    if (ok != true || t.text.trim().isEmpty || c.text.trim().isEmpty) return;
    try {
      await svc.publishArticle(widget.account['id'] as int, t.text.trim(), c.text.trim());
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('发布成功')));
      _load();
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('发布失败：$e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final color = Theme.of(context).colorScheme.primary;
    final owned = _account['ownedByMe'] == true;
    return Scaffold(
      backgroundColor: cs.surface,
      appBar: AppBar(
        backgroundColor: cs.surface,
        elevation: 0,
        title: Text(svc.str(_account['name'] ?? svc.str(widget.account['name'])), style: TextStyle(color: cs.onSurface, fontWeight: FontWeight.w700)),
        leading: IconButton(icon: Icon(Icons.arrow_back, color: cs.onSurface), onPressed: () => Navigator.of(context).maybePop()),
        actions: [
          if (owned) IconButton(icon: Icon(Icons.edit_note, color: color), onPressed: _publish),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(child: Text(_error!, style: TextStyle(color: cs.error)))
              : ListView.separated(
                  padding: const EdgeInsets.all(16),
                  itemCount: _articles.length,
                  separatorBuilder: (_, i) => const SizedBox(height: 10),
                  itemBuilder: (_, i) {
                    final a = _articles[i];
                    return InkWell(
                      onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => _ArticleDetail(svc: svc, article: a))),
                      child: Container(
                        padding: const EdgeInsets.all(14),
                        decoration: BoxDecoration(color: cs.surface, borderRadius: BorderRadius.circular(14), border: Border.all(color: cs.outlineVariant.withValues(alpha: 0.5))),
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Text(svc.str(a['title']), style: TextStyle(color: cs.onSurface, fontWeight: FontWeight.w600, fontSize: 15)),
                          const SizedBox(height: 4),
                          Text('阅读 ${svc.toInt(a['readCount'])} · 在看 ${svc.toInt(a['presentCount'])} · ${_fmt(a['createdAt'])}', style: TextStyle(color: cs.onSurfaceVariant, fontSize: 12)),
                        ]),
                      ),
                    );
                  },
                ),
    );
  }

  String _fmt(dynamic v) {
    final ms = v is int ? v : int.tryParse('$v') ?? 0;
    if (ms == 0) return '';
    final dt = DateTime.fromMillisecondsSinceEpoch(ms);
    String two(int x) => x.toString().padLeft(2, '0');
    return '${dt.month}/${dt.day} ${two(dt.hour)}:${two(dt.minute)}';
  }
}

class _ArticleDetail extends StatefulWidget {
  const _ArticleDetail({required this.svc, required this.article});
  final MediaService svc;
  final Map<String, dynamic> article;
  @override
  State<_ArticleDetail> createState() => _ArticleDetailState();
}

class _ArticleDetailState extends State<_ArticleDetail> {
  late final MediaService svc = widget.svc;
  final _commentCtl = TextEditingController();
  Map<String, dynamic> _a = {};
  List<Map<String, dynamic>> _comments = [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() { _loading = true; _error = null; });
    try {
      final a = await svc.article(widget.article['id'] as int);
      _a = a;
      _comments = (a['comments'] as List?)?.cast<Map<String, dynamic>>() ?? [];
    } catch (e) {
      _error = e.toString().replaceFirst('Bad state: ', '');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _comment() async {
    final t = _commentCtl.text.trim();
    if (t.isEmpty) return;
    _commentCtl.clear();
    try {
      await svc.commentArticle(svc.toInt(_a['id']), t);
      _load();
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('留言失败：$e')));
    }
  }

  @override
  void dispose() {
    _commentCtl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final color = cs.primary;
    final onAir = _a['presented'] == true;
    return Scaffold(
      backgroundColor: cs.surface,
      appBar: AppBar(
        backgroundColor: cs.surface,
        elevation: 0,
        title: Text('文章', style: TextStyle(color: cs.onSurface, fontWeight: FontWeight.w700)),
        leading: IconButton(icon: Icon(Icons.arrow_back, color: cs.onSurface), onPressed: () => Navigator.of(context).maybePop()),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(child: Text(_error!, style: TextStyle(color: cs.error)))
              : Column(children: [
                  Expanded(child: SingleChildScrollView(padding: const EdgeInsets.all(20), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(svc.str(_a['title']), style: TextStyle(color: cs.onSurface, fontSize: 22, fontWeight: FontWeight.w800)),
                    const SizedBox(height: 6),
                    Text('来自 ${svc.str(_a['accountName'])}', style: TextStyle(color: cs.onSurfaceVariant, fontSize: 12)),
                    const SizedBox(height: 14),
                    const Divider(height: 1),
                    const SizedBox(height: 14),
                    Text(svc.str(_a['content']), style: TextStyle(color: cs.onSurface, fontSize: 15, height: 1.6)),
                    const SizedBox(height: 16),
                    Row(children: [
                      InkWell(onTap: () async {
                        try {
                          await svc.wow(svc.toInt(_a['id']), on: _a['presented'] != true);
                          if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(_a['presented'] == true ? '已取消在看' : '在看 +1')));
                          _load();
                        } catch (e) {
                          // 在看失败静默
                        }
                      }, child: Row(children: [
                        Icon(Icons.filter_vintage, size: 18, color: onAir ? color : cs.onSurfaceVariant),
                        const SizedBox(width: 4),
                        Text('在看 ${svc.toInt(_a['presentCount'])}', style: TextStyle(color: onAir ? color : cs.onSurfaceVariant, fontSize: 12)),
                      ])),
                      const SizedBox(width: 20),
                      Text('阅读 ${svc.toInt(_a['readCount'])}', style: TextStyle(color: cs.onSurfaceVariant, fontSize: 12)),
                    ]),
                    const SizedBox(height: 16),
                    Text('留言', style: TextStyle(color: cs.onSurface, fontWeight: FontWeight.w700)),
                    const SizedBox(height: 8),
                    // 评论区：可精选/回复
                    ..._comments.map((c) => Container(
                          margin: const EdgeInsets.only(bottom: 8),
                          padding: const EdgeInsets.all(10),
                          decoration: BoxDecoration(color: cs.surface, borderRadius: BorderRadius.circular(10), border: Border.all(color: cs.outlineVariant.withValues(alpha: c['featured'] == true ? 1 : 0.4))),
                          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                            Row(children: [
                              Expanded(child: Text(svc.str(c['nickname'] ?? ('用户${c['userId']}')), style: TextStyle(fontWeight: FontWeight.w600, fontSize: 12, color: c['featured'] == true ? color : cs.onSurface))),
                              if (c['featured'] == true) Text(' 精选', style: TextStyle(color: color, fontSize: 11)),
                            ]),
                            Text(svc.str(c['content']), style: TextStyle(color: cs.onSurface, fontSize: 13)),
                          ]),
                        )),
                    if (_comments.isEmpty) Text('还没有留言', style: TextStyle(color: cs.onSurfaceVariant)),
                  ]))),
                  Container(
                    padding: const EdgeInsets.fromLTRB(16, 10, 16, 16),
                    decoration: BoxDecoration(color: cs.surface, border: Border(top: BorderSide(color: cs.outlineVariant))),
                    child: Row(children: [
                      Expanded(child: TextField(controller: _commentCtl, decoration: const InputDecoration(hintText: '写下你的留言…', isDense: true))),
                      const SizedBox(width: 8),
                      FilledButton(onPressed: _comment, child: const Text('发送')),
                    ]),
                  ),
                ]),
    );
  }
}