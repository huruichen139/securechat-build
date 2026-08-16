import 'package:flutter/material.dart';

import 'services/app_config.dart';
import 'services/securechat_api.dart';
import 'widgets/ux.dart';

class VideosPage extends StatefulWidget {
  const VideosPage({super.key, required this.api, required this.config});
  final SecureChatApi api;
  final dynamic config;
  @override
  State<VideosPage> createState() => _VideosPageState();
}

class _VideosPageState extends State<VideosPage> {
  final _videos = <Map<String, dynamic>>[];
  bool _loading = true;
  String? _error;
  final _titleCtrl = TextEditingController();
  final _contentCtrl = TextEditingController();

  AppConfig get _cfg => widget.config as AppConfig;
  AppTheme get _t => _cfg.theme;

  @override
  void initState() {
    super.initState();
    _reload();
  }

  Future<void> _reload() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      _videos
        ..clear()
        ..addAll(await widget.api.videos());
    } catch (e) {
      _error = e.toString().replaceFirst('Bad state: ', '');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _post() async {
    final title = _titleCtrl.text.trim();
    if (title.isEmpty) return;
    setState(() {
      _titleCtrl.clear();
      _contentCtrl.clear();
    });
    try {
      await widget.api.postVideo(title, content: _contentCtrl.text.trim());
      await _reload();
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('发布成功')));
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('发布失败：$e')));
    }
  }

  Future<void> _toggleLike(Map<String, dynamic> v) async {
    final id = v['id'] as int;
    final liked = v['likedByMe'] == true;
    setState(() {
      v['likedByMe'] = !liked;
      v['likeCount'] = ((v['likeCount'] as int?) ?? 0) + (liked ? -1 : 1);
    });
    try {
      await widget.api.likeVideo(id, on: !liked);
    } catch (_) {
      setState(() {
        v['likedByMe'] = liked;
        v['likeCount'] = ((v['likeCount'] as int?) ?? 0) + (liked ? 1 : -1);
      });
    }
  }

  Future<void> _comment(Map<String, dynamic> v) async {
    final c = TextEditingController();
    final text = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('评论'),
        content: TextField(controller: c, autofocus: true, decoration: const InputDecoration(hintText: '说点什么...')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, c.text.trim()), child: const Text('发表')),
        ],
      ),
    );
    if (text == null || text.isEmpty) return;
    try {
      await widget.api.commentVideo(v['id'] as int, text);
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('评论成功')));
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('评论失败：$e')));
    }
  }

  String _fmt(dynamic v) {
    final ms = v is int ? v : int.tryParse('$v') ?? 0;
    if (ms == 0) return '';
    final dt = DateTime.fromMillisecondsSinceEpoch(ms);
    String two(int x) => x.toString().padLeft(2, '0');
    return '${dt.month}/${dt.day} ${two(dt.hour)}:${two(dt.minute)}';
  }

  @override
  void dispose() {
    _titleCtrl.dispose();
    _contentCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = _t;
    return Scaffold(
      backgroundColor: t.bg,
      body: Column(children: [
        PageHeader(
          title: '视频号',
          config: _cfg,
          trailing: IconButton(
            onPressed: _reload,
            icon: Icon(Icons.refresh, color: t.text, size: 20),
          ),
        ),
        Container(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
          decoration: BoxDecoration(color: t.bg, border: Border(bottom: BorderSide(color: t.div.withValues(alpha: 0.6)))),
          child: Column(children: [
            Row(children: [
              Expanded(
                child: TextField(
                  controller: _titleCtrl,
                  style: TextStyle(color: t.text),
                  decoration: InputDecoration(hintText: '视频标题', hintStyle: TextStyle(color: t.subText)),
                ),
              ),
              const SizedBox(width: 10),
              FilledButton(
                onPressed: _post,
                style: FilledButton.styleFrom(backgroundColor: Ux.green, foregroundColor: Colors.white),
                child: const Text('发布'),
              ),
            ]),
            const SizedBox(height: 8),
            TextField(
              controller: _contentCtrl,
              style: TextStyle(color: t.text),
              decoration: InputDecoration(hintText: '描述（可选）', hintStyle: TextStyle(color: t.subText)),
            ),
          ]),
        ),
        Expanded(
          child: _loading
              ? Center(child: CircularProgressIndicator(color: t.subText))
              : _error != null
                  ? Center(child: Text(_error!, style: TextStyle(color: t.subText)))
                  : _videos.isEmpty
                      ? Center(child: Text('还没有视频', style: TextStyle(color: t.subText)))
                      : ListView.builder(
                          padding: const EdgeInsets.symmetric(vertical: 12),
                          itemCount: _videos.length,
                          itemBuilder: (_, i) {
                            final v = _videos[i];
                            final nick = (v['nickname'] ?? '').toString();
                            final liked = v['likedByMe'] == true;
                            return Container(
                              margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                              padding: const EdgeInsets.all(14),
                              decoration: BoxDecoration(
                                color: t.card.withValues(alpha: 0.85),
                                borderRadius: BorderRadius.circular(Ux.cardRadius),
                                border: Border.all(color: t.div.withValues(alpha: 0.6)),
                              ),
                              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                Row(children: [
                                  CircleAvatar(radius: 16, backgroundColor: Ux.cellIconBg(t), child: Text(nick.isNotEmpty ? nick[0] : '?', style: TextStyle(color: t.text, fontSize: 12))),
                                  const SizedBox(width: 8),
                                  Expanded(
                                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                      Text(nick, style: TextStyle(color: t.text, fontWeight: FontWeight.w600, fontSize: 13)),
                                      Text(_fmt(v['createdAt']), style: TextStyle(color: t.subText, fontSize: 11)),
                                    ]),
                                  ),
                                ]),
                                const SizedBox(height: 10),
                                Text(v['title'] ?? '', style: TextStyle(color: t.text, fontSize: 15, fontWeight: FontWeight.w600)),
                                if ((v['content'] ?? '').toString().isNotEmpty) ...[
                                  const SizedBox(height: 4),
                                  Text(v['content'], style: TextStyle(color: t.subText, fontSize: 13)),
                                ],
                                const SizedBox(height: 10),
                                Row(children: [
                                  InkWell(onTap: () => _toggleLike(v), child: Row(children: [
                                    Icon(Icons.favorite, size: 16, color: liked ? Ux.green : t.subText),
                                    const SizedBox(width: 4),
                                    Text('${v['likeCount'] ?? 0}', style: TextStyle(color: liked ? Ux.green : t.subText, fontSize: 12)),
                                  ])),
                                  const SizedBox(width: 18),
                                  InkWell(onTap: () => _comment(v), child: Row(children: [
                                    Icon(Icons.comment, size: 15, color: t.subText),
                                    const SizedBox(width: 4),
                                    Text('评论', style: TextStyle(color: t.subText, fontSize: 12)),
                                  ])),
                                ]),
                              ]),
                            );
                          },
                        ),
        ),
      ]),
    );
  }
}
