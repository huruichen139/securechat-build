import 'package:flutter/material.dart';

import 'services/securechat_api.dart';
import 'settings_page.dart';

class MePage extends StatefulWidget {
  const MePage({super.key, this.api, this.config});
  final SecureChatApi? api;
  final dynamic config;
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
    final api = SecureChatApi();
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
    final t = Theme.of(context);
    return Container(
      color: const Color(0xffededed),
      child: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(child: Text(_error!, style: TextStyle(color: t.colorScheme.error)))
              : CustomScrollView(
                  slivers: [
                    _header(),
                    _group('服务', [
                      _serviceItem(Icons.payments_outlined, '支付'),
                      _serviceItem(Icons.favorite_border, '收藏'),
                      _serviceItem(Icons.photo_library_outlined, '相册'),
                      _serviceItem(Icons.wallet_giftcard_outlined, '卡包'),
                      _serviceItem(Icons.emoji_emotions_outlined, '表情'),
                      _serviceItem(Icons.settings_outlined, '设置'),
                    ]),
                    const SliverToBoxAdapter(child: SizedBox(height: 32)),
                  ],
                ),
    );
  }

  Widget _header() {
    final card = _card ?? {};
    final name = (card['name'] ?? card['nickname'] ?? card['username'] ?? '用户').toString();
    final uid = (card['uid'] ?? '').toString();
    return SliverToBoxAdapter(
      child: Container(
        margin: const EdgeInsets.only(top: 24),
        decoration: const BoxDecoration(color: Colors.white),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 20),
          child: Row(children: [
            CircleAvatar(
              radius: 34,
              backgroundColor: const Color(0xff07c160),
              child: Text(name.isNotEmpty ? name[0].toUpperCase() : 'S',
                  style: const TextStyle(color: Colors.white, fontSize: 28, fontWeight: FontWeight.bold)),
            ),
            const SizedBox(width: 16),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(name.isNotEmpty ? name : 'SecureChat 用户',
                    style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700, color: Color(0xff1a1a1a))),
                const SizedBox(height: 4),
                Text('微信号：${uid.isNotEmpty ? uid : '暂未设置'}',
                    style: const TextStyle(fontSize: 13, color: Color(0xff888888))),
              ]),
            ),
            const Icon(Icons.chevron_right, color: Color(0xffc8c8c8), size: 20),
          ]),
        ),
      ),
    );
  }

  Widget _group(String title, List<Widget> items) {
    return SliverToBoxAdapter(
      child: Container(
        margin: const EdgeInsets.only(top: 10),
        decoration: const BoxDecoration(color: Colors.white),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.only(left: 16, top: 10, bottom: 2),
              child: Text(title, style: const TextStyle(color: Color(0xff999999), fontSize: 13, fontWeight: FontWeight.w500)),
            ),
            ...items,
          ],
        ),
      ),
    );
  }

  Widget _serviceItem(IconData icon, String label) {
    return Material(
      color: Colors.white,
      child: InkWell(
        onTap: () {
          if (label == '设置') {
            Navigator.push(context, MaterialPageRoute(builder: (_) => SettingsPage(config: widget.config, api: SecureChatApi())));
          }
        },
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
          child: Row(children: [
            Icon(icon, color: const Color(0xff333333), size: 22),
            const SizedBox(width: 12),
            Expanded(child: Text(label, style: const TextStyle(fontSize: 15, color: Color(0xff1a1a1a)))),
            const Icon(Icons.chevron_right, color: Color(0xffc8c8c8), size: 18),
          ]),
        ),
      ),
    );
  }
}
