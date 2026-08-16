// module: oa_page (worker batch4) —— Flutter 公众号页：关注/文章/留言/在看
import 'package:flutter/material.dart';

import 'services/app_config.dart';
import 'services/media_api.dart';
import 'services/securechat_api.dart';
import 'widgets/ux.dart';

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

  AppConfig get _cfg => widget.config as AppConfig;
  AppTheme get _t => _cfg.theme;

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
    setState(() {
      _loading = true;
      _error = null;
    });
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
    Navigator.of(context).push(MaterialPageRoute(builder: (_) => _AccountDetail(svc: _svc, account: a, config: _cfg)));
  }

  void _openArticle(Map<String, dynamic> a) {
    Navigator.of(context).push(MaterialPageRoute(builder: (_) => _ArticleDetail(svc: _svc, article: a, config: _cfg)));
  }

  Widget _tabItem(int index, String label) {
    return Expanded(
      child: ValueListenableBuilder<int>(
        valueListenable: _tab,
        builder: (_, v, __) => InkWell(
          onTap: () => _tab.value = index,
          child: Container(
            padding: const EdgeInsets.symmetric(vertical: 12),
            alignment: Alignment.center,
            decoration: BoxDecoration(border: Border(bottom: BorderSide(color: v == index ? Ux.green : Colors.transparent, width: 2))),
            child: Text(label, style: TextStyle(color: v == index ? Ux.green : _t.subText, fontWeight: v == index ? FontWeight.w700 : FontWeight.w500)),
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
            onPressed: _registerOa,
            icon: Icon(Icons.add_circle_outline, color: t.text, size: 20),
          ),
        ),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          decoration: BoxDecoration(color: t.bg, border: Border(bottom: BorderSide(color: t.div.withValues(alpha: 0.6)))),
          child: Row(children: [
            _tabItem(0, '公众号'),
            _tabItem(1, '订阅'),
            _tabItem(2, '在看'),
          ]),
        ),
        Expanded(
          child: _loading
              ? Center(child: CircularProgressIndicator(color: t.subText))
              : _error != null
                  ? Center(child: Text(_error!, style: TextStyle(color: t.subText)))
                  : _cur.isEmpty
                      ? Center(child: Text(_tab.value == 0 ? '还没有公众号' : (_tab.value == 1 ? '还没有订阅' : '还没有在看'), style: TextStyle(color: t.subText)))
                      : ListView.builder(
                          padding: const EdgeInsets.symmetric(vertical: 12),
                          itemCount: _cur.length,
                          itemBuilder: (_, i) {
                            final m = _cur[i];
                            final isArticle = _tab.value != 0;
                            return Container(
                              margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
                              padding: const EdgeInsets.all(14),
                              decoration: BoxDecoration(
                                color: t.card.withValues(alpha: 0.85),
                                borderRadius: BorderRadius.circular(Ux.cardRadius),
                                border: Border.all(color: t.div.withValues(alpha: 0.6)),
                              ),
                              child: isArticle
                                  ? InkWell(
                                      onTap: () => _openArticle(m),
                                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                        Text((m['title'] ?? '').toString(), style: TextStyle(color: t.text, fontSize: 15, fontWeight: FontWeight.w600)),
                                        const SizedBox(height: 4),
                                        Text('${_svc.str(m['accountName'])} · ${_fmt(m['createdAt'])} · 阅读 ${_svc.toInt(m['readCount'])} · 在看 ${_svc.toInt(m['presentCount'])}', style: TextStyle(color: t.subText, fontSize: 12)),
                                      ]),
                                    )
                                  : InkWell(
                                      onTap: () => _openAccount(m),
                                      child: Row(children: [
                                        CircleAvatar(radius: 18, backgroundColor: Ux.cellIconBg(t), child: Text(_svc.str(m['name']).isNotEmpty ? _svc.str(m['name'])[0] : '?', style: TextStyle(color: t.text))),
                                        const SizedBox(width: 10),
                                        Expanded(
                                          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                            Text(_svc.str(m['name']), style: TextStyle(color: t.text, fontWeight: FontWeight.w600)),
                                            Text(_svc.str(m['intro']) + (m['following'] == true ? ' · 已关注' : ''), style: TextStyle(color: t.subText, fontSize: 12)),
                                          ]),
                                        ),
                                        TextButton(
                                          onPressed: () async {
                                            try {
                                              await _svc.followOa(_svc.toInt(m['id']), on: m['following'] != true);
                                              _load();
                                            } catch (e) {
                                              if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
                                            }
                                          },
                                          child: Text(m['following'] == true ? '已关注' : '＋关注', style: TextStyle(color: Ux.green)),
                                        ),
                                      ]),
                                    ),
                            );
                          },
                        ),
        ),
      ]),
    );
  }
}

class _AccountDetail extends StatefulWidget {
  const _AccountDetail({required this.svc, required this.account, required this.config});
  final MediaService svc;
  final Map<String, dynamic> account;
  final AppConfig config;
  @override
  State<_AccountDetail> createState() => _AccountDetailState();
}

class _AccountDetailState extends State<_AccountDetail> {
  late final MediaService svc = widget.svc;
  List<Map<String, dynamic>> _articles = [];
  bool _loading = true;
  String? _error;
  Map<String, dynamic> _account = {};

  AppTheme get _t => widget.config.theme;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
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
    final t = _t;
    final owned = _account['ownedByMe'] == true;
    return Scaffold(
      backgroundColor: t.bg,
      body: Column(children: [
        PageHeader(
          title: svc.str(_account['name'] ?? svc.str(widget.account['name'])),
          config: widget.config,
          trailing: owned
              ? IconButton(
                  onPressed: _publish,
                  icon: Icon(Icons.edit_note, color: t.text, size: 20),
                )
              : null,
        ),
        Expanded(
          child: _loading
              ? Center(child: CircularProgressIndicator(color: t.subText))
              : _error != null
                  ? Center(child: Text(_error!, style: TextStyle(color: t.subText)))
                  : ListView.builder(
                      padding: const EdgeInsets.symmetric(vertical: 12),
                      itemCount: _articles.length,
                      itemBuilder: (_, i) {
                        final a = _articles[i];
                        return InkWell(
                          onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => _ArticleDetail(svc: svc, article: a, config: widget.config))),
                          child: Container(
                            margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
                            padding: const EdgeInsets.all(14),
                            decoration: BoxDecoration(
                              color: t.card.withValues(alpha: 0.85),
                              borderRadius: BorderRadius.circular(Ux.cardRadius),
                              border: Border.all(color: t.div.withValues(alpha: 0.6)),
                            ),
                            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                              Text(svc.str(a['title']), style: TextStyle(color: t.text, fontWeight: FontWeight.w600, fontSize: 15)),
                              const SizedBox(height: 4),
                              Text('阅读 ${svc.toInt(a['readCount'])} · 在看 ${svc.toInt(a['presentCount'])} · ${_fmt(a['createdAt'])}', style: TextStyle(color: t.subText, fontSize: 12)),
                            ]),
                          ),
                        );
                      },
                    ),
        ),
      ]),
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
  const _ArticleDetail({required this.svc, required this.article, required this.config});
  final MediaService svc;
  final Map<String, dynamic> article;
  final AppConfig config;
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

  AppTheme get _t => widget.config.theme;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
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
    final t = _t;
    final onAir = _a['presented'] == true;
    return Scaffold(
      backgroundColor: t.bg,
      body: Column(children: [
        PageHeader(title: '文章', config: widget.config),
        Expanded(
          child: _loading
              ? Center(child: CircularProgressIndicator(color: t.subText))
              : _error != null
                  ? Center(child: Text(_error!, style: TextStyle(color: t.subText)))
                  : Column(children: [
                      Expanded(
                        child: SingleChildScrollView(
                          padding: const EdgeInsets.all(20),
                          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                            Text(svc.str(_a['title']), style: TextStyle(color: t.text, fontSize: 22, fontWeight: FontWeight.w800)),
                            const SizedBox(height: 6),
                            Text('来自 ${svc.str(_a['accountName'])}', style: TextStyle(color: t.subText, fontSize: 12)),
                            const SizedBox(height: 14),
                            Divider(height: 1, color: t.div.withValues(alpha: 0.6)),
                            const SizedBox(height: 14),
                            Text(svc.str(_a['content']), style: TextStyle(color: t.text, fontSize: 15, height: 1.6)),
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
                                Icon(Icons.filter_vintage, size: 18, color: onAir ? Ux.green : t.subText),
                                const SizedBox(width: 4),
                                Text('在看 ${svc.toInt(_a['presentCount'])}', style: TextStyle(color: onAir ? Ux.green : t.subText, fontSize: 12)),
                              ])),
                              const SizedBox(width: 20),
                              Text('阅读 ${svc.toInt(_a['readCount'])}', style: TextStyle(color: t.subText, fontSize: 12)),
                            ]),
                            const SizedBox(height: 16),
                            Text('留言', style: TextStyle(color: t.text, fontWeight: FontWeight.w700)),
                            const SizedBox(height: 8),
                            // 评论区：可精选/回复
                            ..._comments.map((c) => Container(
                                  margin: const EdgeInsets.only(bottom: 8),
                                  padding: const EdgeInsets.all(10),
                                  decoration: BoxDecoration(
                                    color: t.card.withValues(alpha: 0.6),
                                    borderRadius: BorderRadius.circular(Ux.radius),
                                    border: Border.all(color: c['featured'] == true ? Ux.green.withValues(alpha: 0.5) : t.div.withValues(alpha: 0.4)),
                                  ),
                                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                    Row(children: [
                                      Expanded(child: Text(svc.str(c['nickname'] ?? ('用户${c['userId']}')), style: TextStyle(fontWeight: FontWeight.w600, fontSize: 12, color: c['featured'] == true ? Ux.green : t.text))),
                                      if (c['featured'] == true) Text(' 精选', style: TextStyle(color: Ux.green, fontSize: 11)),
                                    ]),
                                    Text(svc.str(c['content']), style: TextStyle(color: t.text, fontSize: 13)),
                                  ]),
                                )),
                            if (_comments.isEmpty) Text('还没有留言', style: TextStyle(color: t.subText)),
                          ]),
                        ),
                      ),
                      Container(
                        padding: const EdgeInsets.fromLTRB(16, 10, 16, 16),
                        decoration: BoxDecoration(color: t.bg, border: Border(top: BorderSide(color: t.div.withValues(alpha: 0.6)))),
                        child: Row(children: [
                          Expanded(child: TextField(controller: _commentCtl, style: TextStyle(color: t.text), decoration: InputDecoration(hintText: '写下你的留言…', hintStyle: TextStyle(color: t.subText), isDense: true))),
                          const SizedBox(width: 8),
                          FilledButton(onPressed: _comment, style: FilledButton.styleFrom(backgroundColor: Ux.green, foregroundColor: Colors.white), child: const Text('发送')),
                        ]),
                      ),
                    ]),
        ),
      ]),
    );
  }
}
