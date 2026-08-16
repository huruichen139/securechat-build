// module: videos_social_page (worker batch4) —— Flutter 视频号页（增强版）：上传/信息流/点赞/评论/收藏/转发
import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import 'services/app_config.dart';
import 'services/media_api.dart';
import 'services/securechat_api.dart';
import 'widgets/ux.dart';

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
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('发布成功')));
        _load();
      }
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
          title: '视频号',
          config: _cfg,
          trailing: Row(mainAxisSize: MainAxisSize.min, children: [
            IconButton(onPressed: _load, icon: Icon(Icons.refresh, color: t.text, size: 20)),
            IconButton(onPressed: _publish, icon: Icon(Icons.add, color: t.text, size: 20)),
          ]),
        ),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          decoration: BoxDecoration(color: t.bg, border: Border(bottom: BorderSide(color: t.div.withValues(alpha: 0.6)))),
          child: Row(children: [
            _tabItem(0, '推荐'),
            _tabItem(1, '关注'),
            _tabItem(2, '收藏'),
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
                            final nick = _svc.str(v['nickname']);
                            final liked = v['likedByMe'] == true;
                            final fav = v['favoritedByMe'] == true;
                            final src = _svc.absolute(_svc.str(v['url']));
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
                                  Expanded(child: Text(nick, style: TextStyle(color: t.text, fontWeight: FontWeight.w600, fontSize: 13))),
                                ]),
                                const SizedBox(height: 10),
                                // 无内置播放器：展示一个“视频卡片”，点按查看地址
                                GestureDetector(
                                  onTap: () => ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(src.isEmpty ? '视频地址未配置' : '视频地址：$src'))),
                                  child: Container(
                                    height: 120,
                                    decoration: BoxDecoration(color: Ux.cellIconBg(t), borderRadius: BorderRadius.circular(Ux.radius)),
                                    child: Center(
                                      child: Column(mainAxisSize: MainAxisSize.min, children: [
                                        Icon(Icons.play_circle_outline, size: 34, color: Ux.green),
                                        const SizedBox(height: 4),
                                        Text('点击查看视频地址', style: TextStyle(color: t.subText, fontSize: 11)),
                                      ]),
                                    ),
                                  ),
                                ),
                                const SizedBox(height: 8),
                                Text(_svc.str(v['title']), style: TextStyle(color: t.text, fontSize: 15, fontWeight: FontWeight.w600)),
                                if (_svc.str(v['content']).isNotEmpty) ...[
                                  const SizedBox(height: 4),
                                  Text(_svc.str(v['content']), style: TextStyle(color: t.subText, fontSize: 13)),
                                ],
                                const SizedBox(height: 10),
                                Row(children: [
                                  InkWell(onTap: () => _toggleLike(v), child: Row(children: [
                                    Icon(Icons.favorite, size: 16, color: liked ? Ux.green : t.subText),
                                    const SizedBox(width: 4),
                                    Text('${_svc.toInt(v['likeCount'])}', style: TextStyle(color: liked ? Ux.green : t.subText, fontSize: 12)),
                                  ])),
                                  const SizedBox(width: 18),
                                  InkWell(onTap: () => _comment(v), child: Row(children: [
                                    Icon(Icons.comment, size: 15, color: t.subText),
                                    const SizedBox(width: 4),
                                    Text('${_svc.toInt(v['commentCount'])}', style: TextStyle(color: t.subText, fontSize: 12)),
                                  ])),
                                  const SizedBox(width: 18),
                                  InkWell(onTap: () => _toggleFav(v), child: Row(children: [
                                    Icon(fav ? Icons.star : Icons.star_border, size: 16, color: fav ? Ux.green : t.subText),
                                    const SizedBox(width: 4),
                                    Text('${_svc.toInt(v['favoriteCount'])}', style: TextStyle(color: t.subText, fontSize: 12)),
                                  ])),
                                  const SizedBox(width: 18),
                                  InkWell(onTap: () => _share(v), child: Row(children: [
                                    Icon(Icons.share, size: 16, color: t.subText),
                                    const SizedBox(width: 4),
                                    Text('${_svc.toInt(v['shareCount'])}', style: TextStyle(color: t.subText, fontSize: 12)),
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
