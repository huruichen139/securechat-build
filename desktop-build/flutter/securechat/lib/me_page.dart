import 'dart:typed_data';

import 'package:flutter/material.dart';

import 'services/securechat_api.dart';
import 'services/app_config.dart';
import 'widgets/ux.dart';
import 'profile_page.dart';
import 'settings_page.dart';
import 'wallet_page.dart';
import 'favorites_page.dart' as fav;
import 'wallet_extra_page.dart';
import 'chat_ext_page.dart';

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
                    const SizedBox(height: 10),
                    SectionCard(
                      config: widget.config,
                      margin: const EdgeInsets.symmetric(horizontal: 12),
                      children: [
                        ListCell(config: widget.config, icon: Icons.payments_outlined, title: '支付', onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => WalletPage(api: _api, config: widget.config)))),
                        CellDivider(config: widget.config),
                        ListCell(config: widget.config, icon: Icons.favorite_border_rounded, title: '收藏', onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => fav.FavoritesPage(api: _api, config: widget.config)))),
                        CellDivider(config: widget.config),
                        ListCell(config: widget.config, icon: Icons.photo_library_outlined, title: '相册', onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => AlbumPage(api: _api, config: widget.config)))),
                        CellDivider(config: widget.config),
                        ListCell(config: widget.config, icon: Icons.wallet_giftcard_outlined, title: '卡包', onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => WalletExtraPage(api: _api, config: widget.config)))),
                        CellDivider(config: widget.config),
                        ListCell(config: widget.config, icon: Icons.emoji_emotions_outlined, title: '表情', onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => ChatExtPage(api: _api, config: widget.config)))),
                        CellDivider(config: widget.config),
                        ListCell(config: widget.config, icon: Icons.settings_outlined, title: '设置', onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => SettingsPage(config: widget.config, api: _api)))),
                      ],
                    ),
                  ],
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

class AlbumPage extends StatelessWidget {
  const AlbumPage({super.key, this.api, this.config});
  final SecureChatApi? api;
  final dynamic config;
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('相册'), backgroundColor: const Color(0xfff7f7f7)),
      body: const Center(child: Text('相册功能开发中', style: TextStyle(color: Color(0xff888888)))),
    );
  }
}
