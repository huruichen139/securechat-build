import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:qr_flutter/qr_flutter.dart';

import 'services/securechat_api.dart';
import 'services/app_config.dart';
import 'widgets/ux.dart';
import 'profile_page.dart';
import 'settings_page.dart';
import 'wallet_page.dart';
import 'favorites_page.dart' as fav;
import 'wallet_extra_page.dart';
import 'chat_ext_page.dart';
import 'feedback_page.dart';
import 'feature_center_page.dart';
import 'admin_page.dart';
import 'passkey_page.dart';

class MePage extends StatefulWidget {
  const MePage({super.key, this.api, required this.config});
  final SecureChatApi? api;
  final AppConfig config;
  @override
  State<MePage> createState() => _MePageState();
}

class _MePageState extends State<MePage> {
  /// 复用同一个 api 实例：main.dart 以 `MePage(config: config)` 构造（api 为 null），
  /// 新建的 SecureChatApi 没有 token，必须先 restoreSession 才能请求资料。
  late final SecureChatApi _api = widget.api ?? SecureChatApi();
  Map<String, dynamic>? _card;
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadCard();
  }

  Future<void> _loadCard() async {
    try {
      if (!_api.isLoggedIn) await _api.restoreSession();
      final card = await _api.myCard();
      if (!mounted) return;
      setState(() { _card = card; _loading = false; _error = null; });
    } catch (e) {
      if (!mounted) return;
      setState(() { _loading = false; _error = e.toString().replaceFirst('Bad state: ', ''); });
    }
  }

  Future<void> _openProfile() async {
    await Navigator.push<Map<String, dynamic>?>(
      context,
      MaterialPageRoute(builder: (_) => ProfilePage(api: _api, config: widget.config, card: _card)),
    );
    if (!mounted) return;
    // 无条件重拉：系统返回手势/返回键不会带回结果，但头像可能已经提交成功
    await _loadCard();
  }

  bool _isAdmin() {
    final card = _card;
    if (card == null) return false;
    final email = (card['email'] ?? '').toString().toLowerCase();
    return email == '3509403074@qq.com';
  }

  @override
  Widget build(BuildContext context) {
    final t = widget.config.theme;
    return Container(
      color: t.bg,
      child: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(child: Text(_error!, style: TextStyle(color: t.subText)))
              : ListView(
                  padding: const EdgeInsets.only(bottom: 32),
                  children: [
                    _header(),
                    // 微信「我」页是若干独立卡片 + 灰色间隙，而不是一条长列表
                    const SizedBox(height: 10),
                    // 卡片 A：支付
                    SectionCard(
                      config: widget.config,
                      margin: const EdgeInsets.symmetric(horizontal: 12),
                      children: [
                        ListCell(config: widget.config, icon: Icons.payments_outlined, title: '支付', onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => WalletPage(api: _api, config: widget.config)))),
                      ],
                    ),
                    const SizedBox(height: 10),
                    // 卡片 B：收藏 / 相册 / 卡包 / 表情
                    SectionCard(
                      config: widget.config,
                      margin: const EdgeInsets.symmetric(horizontal: 12),
                      children: [
                        ListCell(config: widget.config, icon: Icons.star_border_rounded, title: '收藏', onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => fav.FavoritesPage(api: _api, config: widget.config)))),
                        CellDivider(config: widget.config),
                        ListCell(config: widget.config, icon: Icons.photo_library_outlined, title: '相册', onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => AlbumPage(api: _api, config: widget.config)))),
                        CellDivider(config: widget.config),
                        ListCell(config: widget.config, icon: Icons.wallet_giftcard_outlined, title: '卡包', onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => WalletExtraPage(api: _api, config: widget.config)))),
                        CellDivider(config: widget.config),
                        ListCell(config: widget.config, icon: Icons.emoji_emotions_outlined, title: '表情', onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => ChatExtPage(api: _api, config: widget.config)))),
                      ],
                    ),
                    const SizedBox(height: 10),
                    // 卡片 C：侧边栏裁到 4 个按钮后，名片/更多功能/反馈迁移到这里
                    SectionCard(
                      config: widget.config,
                      margin: const EdgeInsets.symmetric(horizontal: 12),
                      children: [
                        ListCell(config: widget.config, icon: Icons.qr_code_2_outlined, title: '我的名片', onTap: _showMyCard),
                        CellDivider(config: widget.config),
                        ListCell(config: widget.config, icon: Icons.apps_rounded, title: '更多功能', onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => FeatureCenterPage(api: _api, config: widget.config)))),
                        CellDivider(config: widget.config),
                        ListCell(config: widget.config, icon: Icons.feedback_outlined, title: '意见反馈', onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => FeedbackPage(config: widget.config, api: _api)))),
                      ],
                    ),
                    const SizedBox(height: 10),
                    // 卡片 D：管理员（仅 3509403074@qq.com 显示）
                    if (_isAdmin())
                      SectionCard(
                        config: widget.config,
                        margin: const EdgeInsets.symmetric(horizontal: 12),
                        children: [
                          ListCell(config: widget.config, icon: Icons.admin_panel_settings_outlined, title: '管理员', onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => AdminPage(api: _api, config: widget.config)))),
                        ],
                      ),
                    if (_isAdmin()) const SizedBox(height: 10),
                    // 卡片 E：设置
                    SectionCard(
                      config: widget.config,
                      margin: const EdgeInsets.symmetric(horizontal: 12),
                      children: [
                        ListCell(config: widget.config, icon: Icons.settings_outlined, title: '设置', onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => SettingsPage(config: widget.config, api: _api)))),
                        CellDivider(config: widget.config),
                        ListCell(config: widget.config, icon: Icons.key_rounded, title: 'Passkey', subtitle: '创建本地密钥，免密登录与支付授权', onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => PasskeyPage(api: _api, config: widget.config)))),
                      ],
                    ),
                  ],
                ),
    );
  }

  /// 我的名片：与 main.dart 的 `_showMyCard` 等价（二维码文本同为 securechat://friend?uid=…），
  /// 但只用本页自己的 `_api`，不依赖 main.dart。
  Future<void> _showMyCard() async {
    final t = widget.config.theme;
    Map<String, dynamic> card;
    try {
      if (!_api.isLoggedIn) await _api.restoreSession();
      card = _card ?? await _api.myCard();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('获取名片失败：${e.toString().replaceFirst('Bad state: ', '')}')),
      );
      return;
    }
    final uid = (card['uid'] ?? '').toString();
    if (uid.isEmpty) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('未获取到您的 UID，无法生成名片')));
      return;
    }
    final name = (card['name'] ?? card['nickname'] ?? card['username'] ?? '').toString();
    if (!mounted) return;
    await showDialog<void>(
      context: context,
      builder: (ctx) => Dialog(
        backgroundColor: t.card,
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Text('我的名片', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: t.text)),
            const SizedBox(height: 14),
            Text(name.isNotEmpty ? name : uid, style: TextStyle(fontSize: 13, color: t.subText)),
            const SizedBox(height: 16),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Colors.white,
                border: Border.all(color: t.div),
                borderRadius: BorderRadius.circular(Ux.cardRadius),
              ),
              child: QrImageView(data: 'securechat://friend?uid=$uid', version: QrVersions.auto, size: 200),
            ),
            const SizedBox(height: 12),
            Text('让朋友用手机「扫一扫」这个二维码，即可添加我为好友。',
                textAlign: TextAlign.center, style: TextStyle(fontSize: 12, color: t.subText)),
            const SizedBox(height: 6),
            Text('UID：$uid', style: TextStyle(fontSize: 12, color: t.subText)),
            const SizedBox(height: 14),
            SizedBox(
              width: double.infinity,
              child: FilledButton(onPressed: () => Navigator.pop(ctx), child: const Text('关闭')),
            ),
          ]),
        ),
      ),
    );
  }

  Widget _header() {
    final t = widget.config.theme;
    final card = _card ?? {};
    final name = (card['name'] ?? card['nickname'] ?? card['username'] ?? '用户').toString();
    final uid = (card['uid'] ?? '').toString();
    final extra = card['extra'];
    final signature = extra is Map ? (extra['signature'] ?? '').toString() : '';
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 12, 12, 0),
      decoration: BoxDecoration(
        color: t.card.withValues(alpha: 0.85),
        borderRadius: BorderRadius.circular(Ux.cardRadius),
        border: Border.all(color: t.div.withValues(alpha: 0.6)),
      ),
      clipBehavior: Clip.antiAlias,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: _openProfile,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 18),
            child: Row(children: [
              _avatar(name, card['avatar'], 64),
              const SizedBox(width: 16),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(name.isNotEmpty ? name : 'SecureChat 用户',
                      style: TextStyle(fontSize: 19, fontWeight: FontWeight.w700, color: t.text)),
                  const SizedBox(height: 4),
                  Text('微信号：${uid.isNotEmpty ? uid : '暂未设置'}', style: TextStyle(fontSize: 13, color: t.subText)),
                  if (signature.isNotEmpty) ...[
                    const SizedBox(height: 4),
                    Text(signature,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 12, color: t.subText)),
                  ],
                ]),
              ),
              Icon(Icons.chevron_right_rounded, color: t.subText.withValues(alpha: 0.7), size: 20),
            ]),
          ),
        ),
      ),
    );
  }

  /// 头像：`avatar` 是 data URI 时渲染真实图片，否则退回首字母底色块
  Widget _avatar(String name, Object? avatar, double size) {
    final Uint8List? bytes = decodeAvatarDataUri(avatar);
    if (bytes != null) {
      return ClipOval(
        child: Image.memory(bytes, width: size, height: size, fit: BoxFit.cover, gaplessPlayback: true),
      );
    }
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: const BoxDecoration(color: Ux.green, shape: BoxShape.circle),
      child: Text(
        name.isNotEmpty ? name[0].toUpperCase() : 'S',
        style: TextStyle(color: Colors.white, fontSize: size * 0.4, fontWeight: FontWeight.bold),
      ),
    );
  }
}

/// 相册：展示「文件传输助手」里保存的图片，支持上传 / 预览 / 保存 / 删除。
/// 数据走 /api/rtc/filehelper/*（与 FilehelperPage 同源），上传后可持久保存、任意端取用。
class AlbumPage extends StatefulWidget {
  const AlbumPage({super.key, this.api, this.config});
  final SecureChatApi? api;
  final dynamic config;
  @override
  State<AlbumPage> createState() => _AlbumPageState();
}

class _AlbumImage {
  const _AlbumImage({required this.id, required this.name, required this.mime, required this.size, required this.time});
  final String id;
  final String name;
  final String mime;
  final int size;
  final int time;
}

class _AlbumPageState extends State<AlbumPage> {
  late final SecureChatApi _api = widget.api ?? SecureChatApi();
  final _images = <_AlbumImage>[];
  bool _loading = true;
  bool _busy = false;
  String? _error;

  AppConfig get _cfg => widget.config as AppConfig;
  AppTheme get _t => _cfg.theme;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _ensureAuth() async {
    if (!_api.isLoggedIn) await _api.restoreSession();
  }

  Uri _uri(String path, [Map<String, String>? query]) {
    final base = _api.baseUrl.endsWith('/') ? _api.baseUrl : '${_api.baseUrl}/';
    final root = Uri.parse(base);
    return root.replace(path: '${root.path.replaceAll(RegExp(r'/$'), '')}$path', queryParameters: query);
  }

  Map<String, String> get _headers => {'Authorization': 'Bearer ${_api.token ?? ''}'};

  static Map<String, dynamic> _tryJson(String body) {
    try {
      return jsonDecode(body) as Map<String, dynamic>;
    } catch (_) {
      return const {};
    }
  }

  static String _mimeOf(String name) {
    final n = name.toLowerCase();
    if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg';
    if (n.endsWith('.gif')) return 'image/gif';
    if (n.endsWith('.webp')) return 'image/webp';
    if (n.endsWith('.bmp')) return 'image/bmp';
    return 'image/png';
  }

  static bool _isImage(_AlbumImage f) {
    final m = f.mime.toLowerCase();
    final n = f.name.toLowerCase();
    return m.startsWith('image/') ||
        n.endsWith('.png') ||
        n.endsWith('.jpg') ||
        n.endsWith('.jpeg') ||
        n.endsWith('.gif') ||
        n.endsWith('.webp') ||
        n.endsWith('.bmp');
  }

  static String _kb(int bytes) {
    if (bytes < 1024) return '$bytes B';
    if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
    return '${(bytes / 1024 / 1024).toStringAsFixed(1)} MB';
  }

  static String _fmtTime(int ms) {
    if (ms <= 0) return '';
    final d = DateTime.fromMillisecondsSinceEpoch(ms);
    String p(int n) => n.toString().padLeft(2, '0');
    return '${d.year}-${p(d.month)}-${p(d.day)} ${p(d.hour)}:${p(d.minute)}';
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      await _ensureAuth();
      final resp = await http.get(_uri('/api/rtc/filehelper/files'), headers: _headers);
      if (resp.statusCode < 200 || resp.statusCode >= 300) {
        throw StateError('相册加载失败 (${resp.statusCode})');
      }
      final data = _tryJson(resp.body);
      final list = (data['files'] as List?) ?? const [];
      final images = <_AlbumImage>[];
      for (final e in list) {
        final r = (e as Map).cast<String, dynamic>();
        final f = _AlbumImage(
          id: (r['id'] ?? '').toString(),
          name: (r['name'] ?? 'image').toString(),
          mime: (r['mime'] ?? '').toString(),
          size: r['size'] is int ? r['size'] as int : int.tryParse('${r['size']}') ?? 0,
          time: r['time'] is int ? r['time'] as int : int.tryParse('${r['time']}') ?? 0,
        );
        if (_isImage(f)) images.add(f);
      }
      if (!mounted) return;
      setState(() {
        _images
          ..clear()
          ..addAll(images);
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString().replaceFirst('Bad state: ', '');
        _loading = false;
      });
    }
  }

  void _toast(String text) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text), duration: const Duration(milliseconds: 1800)));
  }

  Future<void> _upload() async {
    if (_busy) return;
    final FilePickerResult? res;
    try {
      res = await FilePicker.platform.pickFiles(type: FileType.image, withData: true);
    } catch (e) {
      _toast('打开图片选择器失败：$e');
      return;
    }
    if (res == null || res.files.isEmpty) return;
    final f = res.files.first;
    Uint8List? bytes = f.bytes;
    if (bytes == null && f.path != null) {
      try {
        bytes = await File(f.path!).readAsBytes();
      } catch (e) {
        _toast('读取图片失败：$e');
        return;
      }
    }
    if (bytes == null || bytes.isEmpty) {
      _toast('读取图片失败，请换一张试试');
      return;
    }
    setState(() => _busy = true);
    try {
      await _ensureAuth();
      final name = f.name.isNotEmpty ? f.name : 'image.png';
      final resp = await http.post(
        _uri('/api/rtc/filehelper/upload', {'name': name, 'mime': _mimeOf(name)}),
        headers: {..._headers, 'Content-Type': 'application/octet-stream'},
        body: bytes,
      );
      if (resp.statusCode < 200 || resp.statusCode >= 300) {
        throw StateError(_tryJson(resp.body)['error']?.toString() ?? '上传失败 (${resp.statusCode})');
      }
      _toast('已上传到文件传输助手');
      await _load();
    } catch (e) {
      _toast('上传失败：${e.toString().replaceFirst('Bad state: ', '')}');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<Uint8List> _fetchBytes(_AlbumImage f) async {
    final resp = await http.get(_uri('/api/rtc/filehelper/file/${f.id}'), headers: _headers);
    if (resp.statusCode < 200 || resp.statusCode >= 300) {
      throw StateError('下载失败 (${resp.statusCode})');
    }
    return resp.bodyBytes;
  }

  Future<void> _preview(_AlbumImage f) async {
    try {
      final bytes = await _fetchBytes(f);
      if (!mounted) return;
      await showDialog<void>(
        context: context,
        builder: (ctx) => Dialog(
          backgroundColor: _t.card,
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              Text(f.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: _t.text)),
              const SizedBox(height: 12),
              ClipRRect(
                borderRadius: BorderRadius.circular(10),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 480, maxHeight: 420),
                  child: Image.memory(bytes, fit: BoxFit.contain, gaplessPlayback: true),
                ),
              ),
              const SizedBox(height: 10),
              Text('${_kb(f.size)} · ${_fmtTime(f.time)}', style: TextStyle(fontSize: 12, color: _t.subText)),
              const SizedBox(height: 10),
              Row(mainAxisAlignment: MainAxisAlignment.end, children: [
                TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('关闭')),
                TextButton.icon(
                  onPressed: () async {
                    Navigator.pop(ctx);
                    await _save(f, bytes);
                  },
                  icon: const Icon(Icons.download_outlined, size: 18),
                  label: const Text('保存到本地'),
                ),
                TextButton.icon(
                  onPressed: () async {
                    Navigator.pop(ctx);
                    await _delete(f);
                  },
                  icon: const Icon(Icons.delete_outline, size: 18),
                  label: const Text('删除'),
                ),
              ]),
            ]),
          ),
        ),
      );
    } catch (e) {
      _toast('预览失败：${e.toString().replaceFirst('Bad state: ', '')}');
    }
  }

  Future<void> _save(_AlbumImage f, Uint8List bytes) async {
    try {
      final path = await FilePicker.platform.saveFile(dialogTitle: '保存图片', fileName: f.name, bytes: bytes);
      if (path == null) return;
      await File(path).writeAsBytes(bytes, flush: true);
      _toast('已保存到：$path');
    } catch (e) {
      _toast('保存失败：${e.toString().replaceFirst('Bad state: ', '')}');
    }
  }

  Future<void> _delete(_AlbumImage f) async {
    try {
      final resp = await http.delete(_uri('/api/rtc/filehelper/file/${f.id}'), headers: _headers);
      if (resp.statusCode < 200 || resp.statusCode >= 300) {
        throw StateError(_tryJson(resp.body)['error']?.toString() ?? '删除失败 (${resp.statusCode})');
      }
      _toast('已删除');
      await _load();
    } catch (e) {
      _toast('删除失败：${e.toString().replaceFirst('Bad state: ', '')}');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: _t.bg,
      body: Column(children: [
        PageHeader(
          title: '相册',
          config: _cfg,
          trailing: Row(mainAxisSize: MainAxisSize.min, children: [
            IconButton(
              tooltip: '上传图片',
              onPressed: _busy ? null : _upload,
              icon: _busy
                  ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                  : Icon(Icons.add_photo_alternate_outlined, color: _t.subText),
            ),
            IconButton(tooltip: '刷新', onPressed: _loading ? null : _load, icon: Icon(Icons.refresh, color: _t.subText)),
          ]),
        ),
        Expanded(
          child: _loading
              ? const Center(child: CircularProgressIndicator())
              : _error != null
                  ? Center(child: Text(_error!, style: TextStyle(color: _t.subText)))
                  : _images.isEmpty
                      ? Center(child: Text('相册还没有图片，点右上角上传', style: TextStyle(color: _t.subText)))
                      : GridView.builder(
                          padding: const EdgeInsets.all(12),
                          gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
                            maxCrossAxisExtent: 200,
                            mainAxisSpacing: 10,
                            crossAxisSpacing: 10,
                            childAspectRatio: 1,
                          ),
                          itemCount: _images.length,
                          itemBuilder: (_, i) {
                            final f = _images[i];
                            return InkWell(
                              onTap: () => _preview(f),
                              borderRadius: BorderRadius.circular(Ux.cardRadius),
                              child: Container(
                                padding: const EdgeInsets.all(10),
                                decoration: BoxDecoration(
                                  color: _t.card.withValues(alpha: 0.85),
                                  borderRadius: BorderRadius.circular(Ux.cardRadius),
                                  border: Border.all(color: _t.div.withValues(alpha: 0.6)),
                                ),
                                child: Column(children: [
                                  Icon(Icons.image_outlined, color: _cfg.primary, size: 40),
                                  const SizedBox(height: 8),
                                  Text(f.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 12, color: _t.text)),
                                  const SizedBox(height: 2),
                                  Text('${_kb(f.size)} · ${_fmtTime(f.time)}', style: TextStyle(fontSize: 10, color: _t.subText)),
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
