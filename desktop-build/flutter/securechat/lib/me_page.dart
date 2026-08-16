import 'package:flutter/material.dart';

import 'services/securechat_api.dart';
import 'services/app_config.dart';
import 'widgets/ux.dart';
import 'settings_page.dart';
import 'wallet_page.dart';
import 'favorites_page.dart' as fav;
import 'notebook_page.dart';
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
  Map<String, dynamic>? _card;
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadCard();
  }

  Future<void> _loadCard() async {
    final api = widget.api ?? SecureChatApi();
    try {
      final card = await api.myCard();
      if (!mounted) return;
      setState(() { _card = card; _loading = false; });
    } catch (e) {
      if (!mounted) return;
      setState(() { _loading = false; _error = e.toString().replaceFirst('Bad state: ', ''); });
    }
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
                        ListCell(config: widget.config, icon: Icons.payments_outlined, title: '支付', onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => WalletPage(api: widget.api ?? SecureChatApi(), config: widget.config)))),
                        CellDivider(config: widget.config),
                        ListCell(config: widget.config, icon: Icons.favorite_border_rounded, title: '收藏', onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => fav.FavoritesPage(api: widget.api ?? SecureChatApi(), config: widget.config)))),
                        CellDivider(config: widget.config),
                        ListCell(config: widget.config, icon: Icons.photo_library_outlined, title: '相册', onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => AlbumPage(api: widget.api ?? SecureChatApi(), config: widget.config)))),
                        CellDivider(config: widget.config),
                        ListCell(config: widget.config, icon: Icons.wallet_giftcard_outlined, title: '卡包', onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => WalletExtraPage(api: widget.api ?? SecureChatApi(), config: widget.config)))),
                        CellDivider(config: widget.config),
                        ListCell(config: widget.config, icon: Icons.emoji_emotions_outlined, title: '表情', onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => ChatExtPage(api: widget.api ?? SecureChatApi(), config: widget.config)))),
                        CellDivider(config: widget.config),
                        ListCell(config: widget.config, icon: Icons.settings_outlined, title: '设置', onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => SettingsPage(config: widget.config, api: widget.api ?? SecureChatApi())))),
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
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 12, 12, 0),
      decoration: BoxDecoration(
        color: t.card.withValues(alpha: 0.85),
        borderRadius: BorderRadius.circular(Ux.cardRadius),
        border: Border.all(color: t.div.withValues(alpha: 0.6)),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 18),
        child: Row(children: [
          CircleAvatar(
            radius: 32,
            backgroundColor: Ux.green,
            child: Text(name.isNotEmpty ? name[0].toUpperCase() : 'S',
                style: const TextStyle(color: Colors.white, fontSize: 26, fontWeight: FontWeight.bold)),
          ),
          const SizedBox(width: 16),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(name.isNotEmpty ? name : 'SecureChat 用户',
                  style: TextStyle(fontSize: 19, fontWeight: FontWeight.w700, color: t.text)),
              const SizedBox(height: 4),
              Text('微信号：${uid.isNotEmpty ? uid : '暂未设置'}', style: TextStyle(fontSize: 13, color: t.subText)),
            ]),
          ),
          Icon(Icons.chevron_right_rounded, color: t.subText.withValues(alpha: 0.7), size: 20),
        ]),
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
