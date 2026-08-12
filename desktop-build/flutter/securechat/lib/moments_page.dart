import 'package:flutter/material.dart';

import 'services/securechat_api.dart';

class MomentsPage extends StatefulWidget {
  const MomentsPage({super.key, required this.api, required this.config});
  final SecureChatApi api;
  final dynamic config;
  @override
  State<MomentsPage> createState() => _MomentsPageState();
}

class _MomentsPageState extends State<MomentsPage> {
  final _moments = <Map<String, dynamic>>[];
  bool _loading = true;
  String? _error;
  final _input = TextEditingController();

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
      final data = await widget.api.moments();
      _moments
        ..clear()
        ..addAll(data);
    } catch (e) {
      _error = e.toString().replaceFirst('Bad state: ', '');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _post() async {
    final text = _input.text.trim();
    if (text.isEmpty) return;
    setState(() => _input.clear());
    try {
      await widget.api.postMoment(text, []);
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('发布成功')));
      await _reload();
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('发布失败：$e')));
    }
  }

  Future<void> _toggleLike(Map<String, dynamic> m) async {
    final id = m['id'] as int;
    final liked = m['likedByMe'] == true;
    setState(() {
      m['likedByMe'] = !liked;
      m['likeCount'] = (m['likeCount'] as int? ?? 0) + (liked ? -1 : 1);
    });
    try {
      await widget.api.likeMoment(id, on: !liked);
    } catch (e) {
      // revert
      setState(() {
        m['likedByMe'] = liked;
        m['likeCount'] = (m['likeCount'] as int? ?? 0) + (liked ? 1 : -1);
      });
    }
  }

  Future<void> _comment(Map<String, dynamic> m) async {
    final controller = TextEditingController();
    final text = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('发表评论'),
        content: TextField(controller: controller, autofocus: true, decoration: const InputDecoration(hintText: '评论内容')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, controller.text.trim()), child: const Text('发表')),
        ],
      ),
    );
    if (text == null || text.isEmpty) return;
    try {
      await widget.api.commentMoment(m['id'] as int, text);
      await _reload();
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('评论失败：$e')));
    }
  }

  String _fmtTime(dynamic v) {
    final ms = v is int ? v : int.tryParse('$v') ?? 0;
    if (ms == 0) return '';
    final dt = DateTime.fromMillisecondsSinceEpoch(ms);
    String two(int x) => x.toString().padLeft(2, '0');
    return '${dt.month}/${dt.day} ${two(dt.hour)}:${two(dt.minute)}';
  }

  @override
  void dispose() {
    _input.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Scaffold(
      backgroundColor: cs.surface,
      appBar: AppBar(
        backgroundColor: cs.surface,
        elevation: 0,
        title: Text('朋友圈', style: TextStyle(color: cs.onSurface, fontWeight: FontWeight.w700)),
        leading: IconButton(icon: Icon(Icons.arrow_back, color: cs.onSurface), onPressed: () => Navigator.of(context).maybePop()),
        actions: [
          IconButton(icon: Icon(Icons.refresh, color: cs.primary), tooltip: '刷新', onPressed: _reload),
        ],
      ),
      body: Column(children: [
        // 发布框
        Container(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
          color: cs.surface,
          child: Row(children: [
            Expanded(
              child: TextField(
                controller: _input,
                decoration: const InputDecoration(hintText: '分享新鲜事...', alignLabelWithHint: true),
              ),
            ),
            const SizedBox(width: 10),
            FilledButton.icon(onPressed: _post, icon: const Icon(Icons.send, size: 16), label: const Text('发表')),
          ]),
        ),
        Divider(height: 1, color: cs.outlineVariant),
        Expanded(
          child: _loading
              ? const Center(child: CircularProgressIndicator())
              : _error != null
                  ? Center(child: Text(_error!, style: TextStyle(color: cs.error)))
                  : _moments.isEmpty
                      ? Center(child: Text('还没有朋友圈动态', style: TextStyle(color: cs.onSurfaceVariant)))
                      : ListView.separated(
                          padding: const EdgeInsets.all(16),
                          itemCount: _moments.length,
                          separatorBuilder: (_, i) => const SizedBox(height: 12),
                          itemBuilder: (_, i) {
                            final m = _moments[i];
                            final nick = (m['nickname'] ?? (m['userId'] ?? '')).toString();
                            final content = (m['content'] ?? '').toString();
                            final images = (m['images'] as List?) ?? const [];
                            final comments = (m['comments'] as List?) ?? const [];
                            final liked = m['likedByMe'] == true;
                            final likeCount = m['likeCount'] as int? ?? 0;
                            final color = widget.config.theme.primary;
                            return Container(
                              padding: const EdgeInsets.all(14),
                              decoration: BoxDecoration(
                                color: cs.surface,
                                borderRadius: BorderRadius.circular(14),
                                border: Border.all(color: cs.outlineVariant.withValues(alpha: 0.5)),
                              ),
                              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                  CircleAvatar(radius: 18, backgroundColor: color.withValues(alpha: 0.15), child: Text(nick.isNotEmpty ? nick[0] : '?', style: TextStyle(color: color))),
                                  const SizedBox(width: 10),
                                  Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                    Text(nick, style: TextStyle(color: cs.onSurface, fontWeight: FontWeight.w600)),
                                    const SizedBox(height: 2),
                                    Text(_fmtTime(m['createdAt']), style: TextStyle(color: cs.onSurfaceVariant, fontSize: 11)),
                                  ])),
                                ]),
                                if (content.isNotEmpty) ...[
                                  const SizedBox(height: 10),
                                  Text(content, style: TextStyle(color: cs.onSurface, fontSize: 15)),
                                ],
                                if (images.isNotEmpty) ...[
                                  const SizedBox(height: 10),
                                  Wrap(spacing: 8, runSpacing: 8, children: [
                                    for (final img in images)
                                      ClipRRect(
                                        borderRadius: BorderRadius.circular(8),
                                        child: Image.network(img, width: 100, height: 100, fit: BoxFit.cover, errorBuilder: (_, e, s) => Container(width: 100, height: 100, color: cs.surfaceContainerHighest, child: Icon(Icons.broken_image, color: cs.onSurfaceVariant))),
                                      ),
                                  ]),
                                ],
                                const SizedBox(height: 10),
                                Row(children: [
                                  InkWell(
                                    onTap: () => _toggleLike(m),
                                    child: Row(children: [
                                      Icon(Icons.thumb_up, size: 16, color: liked ? color : cs.onSurfaceVariant),
                                      const SizedBox(width: 4),
                                      Text(likeCount > 0 ? '$likeCount' : '赞', style: TextStyle(color: liked ? color : cs.onSurfaceVariant, fontSize: 12)),
                                    ]),
                                  ),
                                  const SizedBox(width: 18),
                                  InkWell(
                                    onTap: () => _comment(m),
                                    child: Row(children: [
                                      Icon(Icons.comment, size: 15, color: cs.onSurfaceVariant),
                                      const SizedBox(width: 4),
                                      Text(comments.isEmpty ? '评论' : '${comments.length}', style: TextStyle(color: cs.onSurfaceVariant, fontSize: 12)),
                                    ]),
                                  ),
                                ]),
                                if (comments.isNotEmpty) ...[
                                  const SizedBox(height: 8),
                                  Container(
                                    width: double.infinity,
                                    padding: const EdgeInsets.all(10),
                                    decoration: BoxDecoration(color: cs.surfaceContainerHighest.withValues(alpha: 0.5), borderRadius: BorderRadius.circular(8)),
                                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                      for (final c in comments)
                                        Padding(
                                          padding: const EdgeInsets.only(bottom: 3),
                                          child: RichText(
                                            text: TextSpan(style: TextStyle(color: cs.onSurface, fontSize: 13), children: [
                                              TextSpan(text: (c['nickname'] ?? '?').toString(), style: TextStyle(color: color, fontWeight: FontWeight.w600)),
                                              TextSpan(text: ': '),
                                              TextSpan(text: (c['content'] ?? '').toString()),
                                            ]),
                                          ),
                                        ),
                                    ]),
                                  ),
                                ],
                              ]),
                            );
                          },
                        ),
        ),
      ]),
    );
  }
}