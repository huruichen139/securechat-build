// module: videos_social_page (worker batch4) —— Flutter 视频号页（增强版）：上传/信息流/点赞/评论/收藏/转发
// 说明：batch2 已有一份 videos_page.dart；本文件为 batch4 独立交付，文件名不同以免覆盖，由合并 worker 二选一挂载。
import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import 'services/media_api.dart';
import 'services/securechat_api.dart';

class VideosSocialPage extends StatefulWidget {
  const VideosSocialPage({super.key, required this.api, required this.config});
  final SecureChatApi api;
  final dynamic config;
  @override
  State<VideosSocialPage> createState() => _VideosSocialPageState();
}

class _VideosSocialPageState extends State<VideosSocialPage> {
  late final MediaService _svc = MediaService(widget.api);
  final _tab = ValueNotifier(0); // 0=推荐 1=关注 2=收藏
  List<Map<String, dynamic>> _videos = [];
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
        _videos = await _svc.videoFeed();
      } else if (_tab.value == 1) {
        _videos = await _svc.followingVideos();
      } else {
        _videos = await _svc.myFavoriteVideos();
      }
    } catch (e) {
      _error = e.toString().replaceFirst('Bad state: ', '');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _publish() async {
    final result = await FilePicker.platform.pickFiles(type: FileType.video);
    if (result == null || result.files.isEmpty || result.files.first.path == null) return;
    final path = result.files.first.path!;
    final name = result.files.first.name;
    try {
      final bytes = await File(path).readAsBytes();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('上传中，请稍候…')));
      final up = await _svc.upload(bytes, name, mime: 'video/mp4');
      if (!mounted) return;
      final title = TextEditingController();
      final content = TextEditingController();
      final ok = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('发布视频'),
          content: Column(mainAxisSize: MainAxisSize.min, children: [
            TextField(controller: title, decoration: const InputDecoration(hintText: '标题')),
            const SizedBox(height: 8),
            TextField(controller: content, decoration: const InputDecoration(hintText: '描述（可选）')),
          ]),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
            FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('发布')),
          ],
        ),
      );
      if (ok != true || title.text.trim().isEmpty) return;
      await _svc.publishVideo(title.text.trim(), _svc.str(up['url']), content: content.text.trim());
      if (mounted) { ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('发布成功'))); _load(); }
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('失败：$e')));
    }
  }

  Future<void> _toggleLike(Map<String, dynamic> v) async {
    final liked = v['likedByMe'] == true;
    setState(() {
      v['likedByMe'] = !liked;
      v['likeCount'] = (_svc.toInt(v['likeCount'])) + (liked ? -1 : 1);
    });
    try {
      await _svc.likeVideo(_svc.toInt(v['id']), on: !liked);
    } catch (_) {
      setState(() {
        v['likedByMe'] = liked;
        v['likeCount'] = (_svc.toInt(v['likeCount'])) + (liked ? 1 : -1);
      });
    }
  }

  Future<void> _toggleFav(Map<String, dynamic> v) async {
    final fav = v['favoritedByMe'] == true;
    setState(() {
      v['favoritedByMe'] = !fav;
      v['favoriteCount'] = (_svc.toInt(v['favoriteCount'])) + (fav ? -1 : 1);
    });
    try {
      await _svc.favoriteVideo(_svc.toInt(v['id']), on: !fav);
      if (_tab.value == 2 && fav) _load();
    } catch (_) {
      setState(() {
        v['favoritedByMe'] = fav;
        v['favoriteCount'] = (_svc.toInt(v['favoriteCount'])) + (fav ? 1 : -1);
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
      await _svc.commentVideo(_svc.toInt(v['id']), text);
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('评论成功')));
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('评论失败：$e')));
    }
  }

  Future<void> _share(Map<String, dynamic> v) async {
    try {
      await _svc.shareVideo(_svc.toInt(v['id']));
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已转发')));
    } catch (e) {
      // 转发计数失败不影响页面
    }
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
        actions: [IconButton(icon: Icon(Icons.refresh, color: color), onPressed: _load), IconButton(icon: Icon(Icons.add, color: color), onPressed: _publish)],
      ),
      body: Column(children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: Row(children: [
            for (final (i, label) in const [(0, '推荐'), (1, '关注'), (2, '收藏')])
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
                            final nick = _svc.str(v['nickname']);
                            final liked = v['likedByMe'] == true;
                            final fav = v['favoritedByMe'] == true;
                            final src = _svc.absolute(_svc.str(v['url']));
                            return Container(
                              padding: const EdgeInsets.all(14),
                              decoration: BoxDecoration(color: cs.surface, borderRadius: BorderRadius.circular(14), border: Border.all(color: cs.outlineVariant.withValues(alpha: 0.5))),
                              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                Row(children: [
                                  CircleAvatar(radius: 16, backgroundColor: color.withValues(alpha: 0.15), child: Text(nick.isNotEmpty ? nick[0] : '?', style: TextStyle(color: color, fontSize: 12))),
                                  const SizedBox(width: 8),
                                  Expanded(child: Text(nick, style: TextStyle(color: cs.onSurface, fontWeight: FontWeight.w600, fontSize: 13))),
                                ]),
                                const SizedBox(height: 10),
                                // 无内置播放器：展示一个“视频卡片”，点按查看地址
                                GestureDetector(
                                  onTap: () => ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(src.isEmpty ? '视频地址未配置' : '视频地址：$src'))),
                                  child: Container(
                                    height: 120,
                                    decoration: BoxDecoration(color: cs.primaryContainer.withValues(alpha: 0.3), borderRadius: BorderRadius.circular(10)),
                                    child: Center(child: Column(mainAxisSize: MainAxisSize.min, children: [
                                      Icon(Icons.play_circle_outline, size: 34, color: color),
                                      const SizedBox(height: 4),
                                      Text('点击查看视频地址', style: TextStyle(color: cs.onSurfaceVariant, fontSize: 11)),
                                    ])),
                                  ),
                                ),
                                const SizedBox(height: 8),
                                Text(_svc.str(v['title']), style: TextStyle(color: cs.onSurface, fontSize: 15, fontWeight: FontWeight.w600)),
                                if (_svc.str(v['content']).isNotEmpty) ...[
                                  const SizedBox(height: 4),
                                  Text(_svc.str(v['content']), style: TextStyle(color: cs.onSurfaceVariant, fontSize: 13)),
                                ],
                                const SizedBox(height: 10),
                                Row(children: [
                                  InkWell(onTap: () => _toggleLike(v), child: Row(children: [
                                    Icon(Icons.favorite, size: 16, color: liked ? Colors.redAccent : cs.onSurfaceVariant),
                                    const SizedBox(width: 4),
                                    Text('${_svc.toInt(v['likeCount'])}', style: TextStyle(color: liked ? Colors.redAccent : cs.onSurfaceVariant, fontSize: 12)),
                                  ])),
                                  const SizedBox(width: 18),
                                  InkWell(onTap: () => _comment(v), child: Row(children: [
                                    Icon(Icons.comment, size: 15, color: cs.onSurfaceVariant),
                                    const SizedBox(width: 4),
                                    Text('${_svc.toInt(v['commentCount'])}', style: TextStyle(color: cs.onSurfaceVariant, fontSize: 12)),
                                  ])),
                                  const SizedBox(width: 18),
                                  InkWell(onTap: () => _toggleFav(v), child: Row(children: [
                                    Icon(fav ? Icons.star : Icons.star_border, size: 16, color: fav ? Colors.amber : cs.onSurfaceVariant),
                                    const SizedBox(width: 4),
                                    Text('${_svc.toInt(v['favoriteCount'])}', style: TextStyle(color: cs.onSurfaceVariant, fontSize: 12)),
                                  ])),
                                  const SizedBox(width: 18),
                                  InkWell(onTap: () => _share(v), child: Row(children: [
                                    Icon(Icons.share, size: 16, color: cs.onSurfaceVariant),
                                    const SizedBox(width: 4),
                                    Text('${_svc.toInt(v['shareCount'])}', style: TextStyle(color: cs.onSurfaceVariant, fontSize: 12)),
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