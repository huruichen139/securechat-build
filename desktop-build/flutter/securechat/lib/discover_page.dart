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
import 'embedded_web_page.dart';
import 'epay_settings_page.dart';

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
            ListCell(config: cfg, icon: Icons.visibility_outlined, title: '看一看', onTap: () => _open(context, ReadPage(config: cfg, api: api ?? SecureChatApi()))),
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
          _group(cfg, [
            ListCell(config: cfg, icon: Icons.cloud_outlined, title: 'AI 中转站', subtitle: 'ai.32768.top', onTap: () => _openWeb(context, 'AI 中转站', 'https://ai.32768.top')),
            ListCell(config: cfg, icon: Icons.folder_open_outlined, title: '云网盘', subtitle: 'mc.32768.top:5216', onTap: () => _openWeb(context, '云网盘', 'https://mc.32768.top:5216')),
            ListCell(config: cfg, icon: Icons.dns_outlined, title: '服务器管理', subtitle: 'mc.32768.top:4567', onTap: () => _openWeb(context, '服务器管理', 'https://mc.32768.top:4567')),
            ListCell(config: cfg, icon: Icons.payments_outlined, title: 'EPay 网关设置', subtitle: '查看/修改商户密钥', onTap: () => _open(context, EpaySettingsPage(api: api ?? SecureChatApi(), config: cfg))),
          ]),
          const SliverToBoxAdapter(child: SizedBox(height: 24)),
        ],
      ),
    );
  }

  void _open(BuildContext context, Widget page) {
    Navigator.push(context, MaterialPageRoute(builder: (_) => page));
  }

  void _openWeb(BuildContext context, String title, String url) {
    Navigator.push(context, MaterialPageRoute(builder: (_) => EmbeddedWebPage(title: title, url: url, config: config)));
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
