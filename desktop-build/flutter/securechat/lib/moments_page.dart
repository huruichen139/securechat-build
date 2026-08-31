import 'dart:io';
import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import 'services/media_api.dart';
import 'services/securechat_api.dart';
import 'services/app_config.dart';
import 'widgets/ux.dart';

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
  final List<Map<String, dynamic>> _pickedImages = []; // {url, name, bytes}

  @override
  void initState() {
    super.initState();
    _reload();
  }

  String _absUrl(String path) {
    if (path.startsWith('http')) return path;
    // 中转相对路径为完整 URL（沿用客户端 baseUrl）
    return widget.api.baseUrl.replaceAll(RegExp(r'/$'), '') + path;
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

  Future<void> _pickImages() async {
    try {
      final res = await FilePicker.platform.pickFiles(allowMultiple: true, type: FileType.image, withData: true);
      if (res == null || res.files.isEmpty) return;
      final media = MediaService(widget.api);
      final items = <Map<String, dynamic>>[];
      for (final f in res.files) {
        final bytes = f.bytes ?? await File(f.path!).readAsBytes();
        final up = await media.upload(bytes, f.name, mime: 'image/jpeg');
        items.add({'url': up['url'], 'name': f.name});
      }
      if (mounted) setState(() => _pickedImages.addAll(items));
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('上传图片失败：$e')));
    }
  }

  Future<void> _post() async {
    final text = _input.text.trim();
    if (text.isEmpty && _pickedImages.isEmpty) return;
    setState(() {});
    try {
      final urls = _pickedImages.map((e) => e['url'].toString()).toList();
      await widget.api.postMoment(text, urls);
      setState(() {
        _input.clear();
        _pickedImages.clear();
      });
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
      setState(() {
        m['likedByMe'] = liked;
        m['likeCount'] = (m['likeCount'] as int? ?? 0) + (liked ? 1 : -1);
      });
    }
  }

  /// 点击图片查看大图（微信式，可左右滑动切换）
  void _previewImage(String current, List<dynamic> all) {
    final initial = all.indexOf(current);
    final t = (widget.config as AppConfig).theme;
    showDialog(
      context: context,
      barrierColor: Colors.black,
      builder: (ctx) {
        var idx = initial < 0 ? 0 : initial;
        return StatefulBuilder(
          builder: (ctx2, setState2) {
            final img = all[idx].toString();
            return Stack(children: [
              Positioned.fill(
                child: GestureDetector(
                  onTap: () => Navigator.pop(ctx),
                  child: Image.network(
                    _absUrl(img),
                    fit: BoxFit.contain,
                    loadingBuilder: (_, child, p) => p == null ? child : const Center(child: CircularProgressIndicator(color: Colors.white)),
                    errorBuilder: (_, e, s) => const Center(child: Icon(Icons.broken_image, color: Colors.white54, size: 60)),
                  ),
                ),
              ),
              Positioned(
                top: 40,
                right: 20,
                child: GestureDetector(
                  onTap: () => Navigator.pop(ctx),
                  child: const Icon(Icons.close, color: Colors.white, size: 30),
                ),
              ),
              if (all.length > 1) ...[
                Positioned(
                  left: 0,
                  top: 0,
                  bottom: 0,
                  child: Center(
                    child: IconButton(
                      icon: const Icon(Icons.chevron_left, color: Colors.white, size: 40),
                      onPressed: idx > 0 ? () => setState2(() => idx--) : null,
                    ),
                  ),
                ),
                Positioned(
                  right: 0,
                  top: 0,
                  bottom: 0,
                  child: Center(
                    child: IconButton(
                      icon: const Icon(Icons.chevron_right, color: Colors.white, size: 40),
                      onPressed: idx < all.length - 1 ? () => setState2(() => idx++) : null,
                    ),
                  ),
                ),
              ],
            ]);
          },
        );
      },
    );
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
    final cfg = widget.config as AppConfig;
    final t = cfg.theme;
    return Scaffold(
      backgroundColor: t.bg,
      body: Column(children: [
        PageHeader(
          title: '朋友圈',
          config: cfg,
          trailing: IconButton(
            onPressed: _reload,
            icon: Icon(Icons.refresh, color: t.subText, size: 20),
            tooltip: '刷新',
          ),
        ),
        _composer(cfg),
        Expanded(
          child: _loading
              ? const Center(child: CircularProgressIndicator())
              : _error != null
                  ? Center(child: Text(_error!, style: TextStyle(color: t.subText)))
                  : _moments.isEmpty
                      ? Center(child: Text('还没有朋友圈动态', style: TextStyle(color: t.subText)))
                      : ListView.separated(
                          padding: const EdgeInsets.all(12),
                          itemCount: _moments.length,
                          separatorBuilder: (_, i) => const SizedBox(height: 12),
                          itemBuilder: (_, i) => _momentCard(cfg, _moments[i]),
                        ),
        ),
      ]),
    );
  }

  Widget _composer(AppConfig cfg) {
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(
            child: TextField(
              controller: _input,
              decoration: const InputDecoration(hintText: '分享新鲜事...', alignLabelWithHint: true),
            ),
          ),
          IconButton(
            onPressed: _pickImages,
            icon: Icon(Icons.photo_outlined, color: Ux.green, size: 22),
            tooltip: '添加图片',
          ),
          FilledButton.icon(onPressed: _post, icon: const Icon(Icons.send, size: 16), label: const Text('发表')),
        ]),
        if (_pickedImages.isNotEmpty) ...[
          const SizedBox(height: 8),
          Wrap(spacing: 8, runSpacing: 8, children: [
            for (int i = 0; i < _pickedImages.length; i++)
              Stack(children: [
                ClipRRect(
                  borderRadius: BorderRadius.circular(8),
                  child: Image.network(
                    _absUrl(_pickedImages[i]['url'].toString()),
                    width: 90,
                    height: 90,
                    fit: BoxFit.cover,
                    errorBuilder: (_, e, s) => Container(width: 90, height: 90, color: Ux.cellIconBg(cfg.theme), child: const Icon(Icons.image, color: Colors.grey)),
                  ),
                ),
                Positioned(
                  top: 2,
                  right: 2,
                  child: InkWell(
                    onTap: () => setState(() => _pickedImages.removeAt(i)),
                    child: Container(
                      width: 20,
                      height: 20,
                      decoration: const BoxDecoration(color: Colors.black54, shape: BoxShape.circle),
                      child: const Icon(Icons.close, color: Colors.white, size: 14),
                    ),
                  ),
                ),
              ]),
          ]),
        ],
      ]),
    );
  }

  Widget _momentCard(AppConfig cfg, Map<String, dynamic> m) {
    final t = cfg.theme;
    final nick = (m['nickname'] ?? (m['userId'] ?? '')).toString();
    final content = (m['content'] ?? '').toString();
    final images = (m['images'] as List?) ?? const [];
    final comments = (m['comments'] as List?) ?? const [];
    final liked = m['likedByMe'] == true;
    final likeCount = m['likeCount'] as int? ?? 0;
    final likers = (m['likers'] as List?)?.map((e) => e.toString()).toList() ?? const [];
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: t.card.withValues(alpha: 0.85),
        borderRadius: BorderRadius.circular(Ux.cardRadius),
        border: Border.all(color: t.div.withValues(alpha: 0.6)),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          CircleAvatar(radius: 18, backgroundColor: Ux.cellIconBg(t), child: Text(nick.isNotEmpty ? nick[0] : '?', style: TextStyle(color: Ux.green))),
          const SizedBox(width: 10),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(nick, style: TextStyle(color: t.text, fontWeight: FontWeight.w600)),
              const SizedBox(height: 2),
              Text(_fmtTime(m['createdAt']), style: TextStyle(color: t.subText, fontSize: 11)),
            ]),
          ),
        ]),
        if (content.isNotEmpty) ...[
          const SizedBox(height: 10),
          Text(content, style: TextStyle(color: t.text, fontSize: 15)),
        ],
        if (images.isNotEmpty) ...[
          const SizedBox(height: 10),
          Wrap(spacing: 8, runSpacing: 8, children: [
            for (final img in images)
              GestureDetector(
                onTap: () => _previewImage(img, images),
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(8),
                  child: Image.network(
                    _absUrl(img),
                    width: 100,
                    height: 100,
                    fit: BoxFit.cover,
                    errorBuilder: (_, e, s) => Container(width: 100, height: 100, color: Ux.cellIconBg(t), child: Icon(Icons.broken_image, color: t.subText)),
                  ),
                ),
              ),
          ]),
        ],
        const SizedBox(height: 10),
        Row(children: [
          InkWell(
            onTap: () => _toggleLike(m),
            child: Row(children: [
              Icon(Icons.thumb_up, size: 16, color: liked ? Ux.green : t.subText),
              const SizedBox(width: 4),
              Text(likeCount > 0 ? '$likeCount' : '赞', style: TextStyle(color: liked ? Ux.green : t.subText, fontSize: 12)),
            ]),
          ),
          const SizedBox(width: 18),
          InkWell(
            onTap: () => _comment(m),
            child: Row(children: [
              Icon(Icons.comment, size: 15, color: t.subText),
              const SizedBox(width: 4),
              Text(comments.isEmpty ? '评论' : '${comments.length}', style: TextStyle(color: t.subText, fontSize: 12)),
            ]),
          ),
        ]),
        if (likers.isNotEmpty) ...[
          const SizedBox(height: 8),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(color: Ux.cellIconBg(t), borderRadius: BorderRadius.circular(8)),
            child: Row(children: [
              Icon(Icons.favorite, size: 14, color: Ux.green),
              const SizedBox(width: 6),
              Expanded(
                child: Text(likers.join('，'), style: TextStyle(color: Ux.green, fontSize: 13)),
              ),
            ]),
          ),
        ],
        if (comments.isNotEmpty) ...[
          const SizedBox(height: 8),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(color: Ux.cellIconBg(t), borderRadius: BorderRadius.circular(8)),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              for (final c in comments)
                Padding(
                  padding: const EdgeInsets.only(bottom: 3),
                  child: RichText(
                    text: TextSpan(style: TextStyle(color: t.text, fontSize: 13), children: [
                      TextSpan(text: (c['nickname'] ?? '?').toString(), style: TextStyle(color: Ux.green, fontWeight: FontWeight.w600)),
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
  }
}
