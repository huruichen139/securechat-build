import 'package:flutter/material.dart';

class DiscoverPage extends StatelessWidget {
  const DiscoverPage({super.key});

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Container(
      color: const Color(0xffededed),
      child: CustomScrollView(
        slivers: [
          SliverToBoxAdapter(
            child: Container(
              margin: const EdgeInsets.only(top: 12),
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
              decoration: const BoxDecoration(color: Colors.white),
              child: Row(children: [
                Icon(Icons.qr_code_scanner, color: t.colorScheme.onSurfaceVariant, size: 20),
                const SizedBox(width: 8),
                const Expanded(child: Text('扫一扫', style: TextStyle(fontSize: 15, color: Colors.black87))),
                const Icon(Icons.chevron_right, color: Color(0xffbdbdbd), size: 20),
              ]),
            ),
          ),
          _divider(),
          _group('朋友', [
            _item(Icons.photo_library_outlined, '朋友圈'),
            _item(Icons.video_library_outlined, '视频号'),
            _item(Icons.visibility_outlined, '看一看'),
            _item(Icons.search_outlined, '搜一搜'),
            _item(Icons.live_tv_outlined, '直播'),
          ]),
          _group('附近', [
            _item(Icons.location_on_outlined, '附近的人'),
            _item(Icons.storefront_outlined, '附近门店'),
          ]),
          _group('购物', [
            _item(Icons.shopping_bag_outlined, '购物'),
            _item(Icons.games_outlined, '游戏'),
          ]),
          _group('小程序', [
            _item(Icons.apps_outlined, '小程序精选'),
            _item(Icons.history_outlined, '最近使用'),
          ]),
          const SliverToBoxAdapter(child: SizedBox(height: 24)),
        ],
      ),
    );
  }

  Widget _group(String title, List<Widget> items) {
    return SliverToBoxAdapter(
      child: Column(
        children: [
          _divider(),
          Padding(
            padding: const EdgeInsets.only(left: 16, top: 10, bottom: 2),
            child: Text(title, style: const TextStyle(color: Color(0xff999999), fontSize: 13, fontWeight: FontWeight.w500)),
          ),
          ...items,
        ],
      ),
    );
  }

  Widget _item(IconData icon, String label) {
    return Material(
      color: Colors.white,
      child: InkWell(
        onTap: () {},
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
