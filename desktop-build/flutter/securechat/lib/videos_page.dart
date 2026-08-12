import 'package:flutter/material.dart';

import 'services/securechat_api.dart';

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

  @override
  void initState() {
    super.initState();
    _reload();
  }

  Future<void> _reload() async {
    setState(() { _loading = true; _error = null; });
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
    setState(() { _titleCtrl.clear(); _contentCtrl.clear(); });
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
    final cs = Theme.of(context).colorScheme;
    final color = widget.config.theme.primary;
    return Scaffold(
      backgroundColor: cs.surface,
      appBar: AppBar(
        backgroundColor: cs.surface,
        elevation: 0,
        title: Text('视频号', style: TextStyle(color: cs.onSurface, fontWeight: FontWeight.w700)),
        leading: IconButton(icon: Icon(Icons.arrow_back, color: cs.onSurface), onPressed: () => Navigator.of(context).maybePop()),
        actions: [IconButton(icon: Icon(Icons.refresh, color: color), onPressed: _reload)],
      ),
      body: Column(children: [
        Container(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
          child: Column(children: [
            Row(children: [
              Expanded(child: TextField(controller: _titleCtrl, decoration: const InputDecoration(hintText: '视频标题'))),
              const SizedBox(width: 10),
              FilledButton(onPressed: _post, child: const Text('发布')),
            ]),
            const SizedBox(height: 8),
            TextField(controller: _contentCtrl, decoration: const InputDecoration(hintText: '描述（可选）')),
          ]),
        ),
        Divider(height: 1, color: cs.outlineVariant),
        Expanded(
          child: _loading
              ? const Center(child: CircularProgressIndicator())
              : _error != null
                  ? Center(child: Text(_error!, style: TextStyle(color: cs.error)))
                  : _videos.isEmpty
                      ? Center(child: Text('还没有视频', style: TextStyle(color: cs.onSurfaceVariant)))
                      : ListView.separated(
                          padding: const EdgeInsets.all(16),
                          itemCount: _videos.length,
                          separatorBuilder: (_, i) => const SizedBox(height: 12),
                          itemBuilder: (_, i) {
                            final v = _videos[i];
                            final nick = (v['nickname'] ?? '').toString();
                            final liked = v['likedByMe'] == true;
                            return Container(
                              padding: const EdgeInsets.all(14),
                              decoration: BoxDecoration(
                                color: cs.surface,
                                borderRadius: BorderRadius.circular(14),
                                border: Border.all(color: cs.outlineVariant.withValues(alpha: 0.5)),
                              ),
                              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                Row(children: [
                                  CircleAvatar(radius: 16, backgroundColor: color.withValues(alpha: 0.15), child: Text(nick.isNotEmpty ? nick[0] : '?', style: TextStyle(color: color, fontSize: 12))),
                                  const SizedBox(width: 8),
                                  Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                    Text(nick, style: TextStyle(color: cs.onSurface, fontWeight: FontWeight.w600, fontSize: 13)),
                                    Text(_fmt(v['createdAt']), style: TextStyle(color: cs.onSurfaceVariant, fontSize: 11)),
                                  ])),
                                ]),
                                const SizedBox(height: 10),
                                Text(v['title'] ?? '', style: TextStyle(color: cs.onSurface, fontSize: 15, fontWeight: FontWeight.w600)),
                                if ((v['content'] ?? '').toString().isNotEmpty) ...[
                                  const SizedBox(height: 4),
                                  Text(v['content'], style: TextStyle(color: cs.onSurfaceVariant, fontSize: 13)),
                                ],
                                const SizedBox(height: 10),
                                Row(children: [
                                  InkWell(onTap: () => _toggleLike(v), child: Row(children: [
                                    Icon(Icons.favorite, size: 16, color: liked ? Colors.redAccent : cs.onSurfaceVariant),
                                    const SizedBox(width: 4),
                                    Text('${v['likeCount'] ?? 0}', style: TextStyle(color: liked ? Colors.redAccent : cs.onSurfaceVariant, fontSize: 12)),
                                  ])),
                                  const SizedBox(width: 18),
                                  InkWell(onTap: () => _comment(v), child: Row(children: [
                                    Icon(Icons.comment, size: 15, color: cs.onSurfaceVariant),
                                    const SizedBox(width: 4),
                                    Text('评论', style: TextStyle(color: cs.onSurfaceVariant, fontSize: 12)),
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