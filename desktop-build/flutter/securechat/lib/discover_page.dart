import 'package:flutter/material.dart';
import 'services/securechat_api.dart';
import 'scan_page.dart';
import 'moments_page.dart';
import 'videos_page.dart';
import 'live_page.dart';
import 'nearby_page.dart';
import 'miniapp_page.dart';
import 'community_tools_page.dart';

class DiscoverPage extends StatelessWidget {
  const DiscoverPage({super.key, this.api, this.config});
  final SecureChatApi? api;
  final dynamic config;

  @override
  Widget build(BuildContext context) {
    return Container(
      color: const Color(0xffededed),
      child: CustomScrollView(
        slivers: [
          SliverToBoxAdapter(
            child: Container(
              margin: const EdgeInsets.only(top: 12),
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
              decoration: const BoxDecoration(color: Colors.white),
              child: InkWell(
                onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => ScanPage(api: api ?? SecureChatApi(), config: config))),
                child: Row(children: [
                  Icon(Icons.qr_code_scanner, color: const Color(0xff333333), size: 20),
                  const SizedBox(width: 8),
                  const Expanded(child: Text('扫一扫', style: TextStyle(fontSize: 15, color: Color(0xff333333)))),
                  const Icon(Icons.chevron_right, color: Color(0xffbdbdbd), size: 20),
                ]),
              ),
            ),
          ),
          _divider(),
          _group('朋友', [
            _item(Icons.photo_library_outlined, '朋友圈', () => Navigator.push(context, MaterialPageRoute(builder: (_) => MomentsPage(api: api ?? SecureChatApi(), config: config)))),
            _item(Icons.video_library_outlined, '视频号', () => Navigator.push(context, MaterialPageRoute(builder: (_) => VideosPage(api: api ?? SecureChatApi(), config: config)))),
            _item(Icons.visibility_outlined, '看一看', () => _notImplemented(context)),
            _item(Icons.search_outlined, '搜一搜', () => _notImplemented(context)),
            _item(Icons.live_tv_outlined, '直播', () => Navigator.push(context, MaterialPageRoute(builder: (_) => LivePage(api: api ?? SecureChatApi(), config: config)))),
          ]),
          _group('附近', [
            _item(Icons.location_on_outlined, '附近的人', () => Navigator.push(context, MaterialPageRoute(builder: (_) => NearbyPage(api: api ?? SecureChatApi(), config: config)))),
            _item(Icons.storefront_outlined, '附近门店', () => _notImplemented(context)),
          ]),
          _group('购物', [
            _item(Icons.shopping_bag_outlined, '购物', () => Navigator.push(context, MaterialPageRoute(builder: (_) => CommunityToolsPage(api: api ?? SecureChatApi(), config: config)))),
            _item(Icons.games_outlined, '游戏', () => _notImplemented(context)),
          ]),
          _group('小程序', [
            _item(Icons.apps_outlined, '小程序精选', () => Navigator.push(context, MaterialPageRoute(builder: (_) => MiniAppStorePage(api: api ?? SecureChatApi(), config: config)))),
            _item(Icons.history_outlined, '最近使用', () => Navigator.push(context, MaterialPageRoute(builder: (_) => MiniAppStorePage(api: api ?? SecureChatApi(), config: config)))),
          ]),
          const SliverToBoxAdapter(child: SizedBox(height: 24)),
        ],
      ),
    );
  }

  void _notImplemented(BuildContext context) {
    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('功能开发中'), duration: Duration(seconds: 1)));
  }

  Widget _group(String title, List<Widget> items) {
    return SliverToBoxAdapter(
      child: Column(
        children: [
          _divider(),
          Padding(
            padding: const EdgeInsets.only(left: 16, top: 10, bottom: 2),
            child: Row(children: [
              Text(title, style: const TextStyle(color: Color(0xff999999), fontSize: 13, fontWeight: FontWeight.w500)),
            ]),
          ),
          Container(color: Colors.white, child: Column(children: items)),
        ],
      ),
    );
  }

  Widget _item(IconData icon, String label, VoidCallback onTap) {
    return Material(
      color: Colors.white,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 13),
          child: Row(children: [
            Icon(icon, color: const Color(0xff333333), size: 22),
            const SizedBox(width: 12),
            Expanded(child: Text(label, style: const TextStyle(fontSize: 15, color: Color(0xff333333)))),
            const Icon(Icons.chevron_right, color: Color(0xffc8c8c8), size: 18),
          ]),
        ),
      ),
    );
  }

  Widget _divider() => const Divider(height: 1, thickness: 0.5, color: Color(0xffe5e5e5));
}