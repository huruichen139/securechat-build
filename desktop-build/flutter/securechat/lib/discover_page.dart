import 'package:flutter/material.dart';

import 'services/securechat_api.dart';
import 'services/app_config.dart';
import 'widgets/ux.dart';
import 'moments_page.dart';
import 'videos_page.dart';
import 'live_page.dart';
import 'nearby_page.dart';
import 'miniapp_page.dart';
import 'community_tools_page.dart';
import 'ai_page.dart';
import 'search_page.dart';
import 'read_page.dart';

class DiscoverPage extends StatelessWidget {
  const DiscoverPage({super.key, this.api, required this.config, this.onOpenChat});
  final SecureChatApi? api;
  final AppConfig config;
  final void Function(int id, bool isGroup, String name)? onOpenChat;

  @override
  Widget build(BuildContext context) {
    final cfg = config;
    final t = cfg.theme;
    return Container(
      color: t.bg,
      child: CustomScrollView(
        slivers: [
          _group(cfg, [
            ListCell(config: cfg, icon: Icons.photo_library_outlined, title: '朋友圈', onTap: () => _open(context, MomentsPage(api: api ?? SecureChatApi(), config: cfg))),
          ]),
          _group(cfg, [
            ListCell(config: cfg, icon: Icons.video_library_outlined, title: '视频号', onTap: () => _open(context, VideosPage(api: api ?? SecureChatApi(), config: cfg))),
            ListCell(config: cfg, icon: Icons.live_tv_outlined, title: '直播', onTap: () => _open(context, LivePage(api: api ?? SecureChatApi(), config: cfg))),
          ]),
          _group(cfg, [
            ListCell(config: cfg, icon: Icons.search_outlined, title: '搜一搜', onTap: () => _open(context, SearchPage(api: api ?? SecureChatApi(), config: cfg, onOpenChat: onOpenChat))),
            ListCell(config: cfg, icon: Icons.visibility_outlined, title: '看一看', onTap: () => _open(context, ReadPage(config: cfg))),
          ]),
          _group(cfg, [
            ListCell(config: cfg, icon: Icons.location_on_outlined, title: '附近的人', onTap: () => _open(context, NearbyPage(api: api ?? SecureChatApi(), config: cfg))),
          ]),
          _group(cfg, [
            ListCell(config: cfg, icon: Icons.shopping_bag_outlined, title: '购物', onTap: () => _open(context, CommunityToolsPage(api: api ?? SecureChatApi(), config: cfg))),
          ]),
          _group(cfg, [
            ListCell(config: cfg, icon: Icons.apps_outlined, title: '小程序', onTap: () => _open(context, MiniAppStorePage(api: api ?? SecureChatApi(), config: cfg))),
            ListCell(config: cfg, icon: Icons.smart_toy_outlined, title: 'AI 助手', onTap: () => _open(context, AiPage(api: api ?? SecureChatApi(), config: cfg))),
          ]),
          const SliverToBoxAdapter(child: SizedBox(height: 24)),
        ],
      ),
    );
  }

  void _open(BuildContext context, Widget page) {
    Navigator.push(context, MaterialPageRoute(builder: (_) => page));
  }

  Widget _group(AppConfig cfg, List<Widget> items) {
    return SliverToBoxAdapter(
      child: Padding(
        padding: const EdgeInsets.only(top: 12),
        child: SectionCard(
          config: cfg,
          margin: const EdgeInsets.symmetric(horizontal: 12),
          children: [
            for (var i = 0; i < items.length; i++) ...[
              if (i > 0) CellDivider(config: cfg),
              items[i],
            ],
          ],
        ),
      ),
    );
  }
}
