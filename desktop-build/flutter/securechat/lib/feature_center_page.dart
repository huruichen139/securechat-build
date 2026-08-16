// 功能中心：恢复此前被裁剪掉的"更多功能"入口。
// 微信化样式：分组卡片 + 网格图标，全部功能聚合在此页。
import 'dart:io';

import 'package:flutter/material.dart';

import 'accounts_page.dart';
import 'chat_ext_page.dart';
import 'community_tools_page.dart';
import 'favorites_page.dart' as fav;
import 'features_center.dart';
import 'file_repository_page.dart';
import 'filehelper_page.dart';
import 'group_page.dart';
import 'miniapp_page.dart';
import 'mini_apps_page.dart';
import 'moments_page.dart';
import 'nearby_page.dart';
import 'notebook_page.dart';
import 'scan_page.dart';
import 'services/app_config.dart';
import 'services/securechat_api.dart';
import 'shake_page.dart';
import 'status_page.dart';
import 'videos_page.dart';
import 'wallet_extra_page.dart';
import 'wallet_page.dart';
import 'widgets/ux.dart';

class FeatureCenterPage extends StatelessWidget {
  const FeatureCenterPage({super.key, this.api, required this.config});
  final SecureChatApi? api;
  final AppConfig config;

  @override
  Widget build(BuildContext context) {
    final t = config.theme;
    final a = api ?? SecureChatApi();
    final pages = <(String, IconData, Widget)>[
      ('朋友圈', Icons.dynamic_feed_outlined, MomentsPage(api: a, config: config)),
      ('视频号', Icons.video_library_outlined, VideosPage(api: a, config: config)),
      ('公众号', Icons.article_outlined, AccountsPage(api: a, config: config)),
      ('钱包', Icons.account_balance_wallet_outlined, WalletPage(api: a, config: config)),
      ('小程序', Icons.apps_rounded, MiniAppsPage(api: a, config: config)),
      ('我的笔记', Icons.sticky_note_2_outlined, NotebookPage(api: a, config: config)),
      ('安全便签', Icons.sticky_note_2_outlined, const NotesPage()),
      ('待办清单', Icons.checklist_rounded, const TodoPage()),
      ('快捷回复', Icons.bolt_outlined, const QuickRepliesPage()),
      ('文件仓库', Icons.folder_outlined, FileRepositoryPage(api: a, config: config)),
      ('我的收藏', Icons.favorite_outline, fav.FavoritesPage(api: a, config: config)),
      ('定时提醒', Icons.alarm_outlined, const ReminderPage()),
      ('在线状态', Icons.mood_outlined, const MoodStatusPage()),
      ('群聊', Icons.group_outlined, GroupPage(api: a, config: config)),
      ('聊天增强', Icons.auto_fix_high, ChatExtPage(api: a, config: config)),
      ('文件助手', Icons.folder_shared_outlined, FilehelperPage(baseUrl: a.baseUrl, token: a.token, config: config)),
      ('社区工具', Icons.handyman_outlined, CommunityToolsPage(api: a, config: config)),
      ('我的状态', Icons.face_outlined, StatusPage(api: a, config: config)),
      ('支付生活', Icons.payments_outlined, WalletExtraPage(api: a, config: config)),
      ('小程序商店', Icons.storefront_outlined, MiniAppStorePage(api: a, config: config)),
      ('附近的人', Icons.near_me_outlined, NearbyPage(api: a, config: config)),
      ('摇一摇', Icons.vibration_outlined, ShakePage(api: a, config: config)),
      ('扫一扫', Icons.qr_code_scanner_outlined, ScanPage(api: a, config: config)),
      ('我的文件', Icons.insert_drive_file_outlined, FileCenterPage(api: a, config: config)),
    ];
    final webServices = <(String, IconData, String)>[
      ('网盘', Icons.cloud_outlined, 'http://mc.32768.top:5213'),
      ('邮箱', Icons.mail_outline, 'https://mail.32768.top'),
      ('AI 网页', Icons.smart_toy_outlined, 'https://ai.32768.top'),
    ];
    return Scaffold(
      backgroundColor: t.bg,
      appBar: AppBar(
        backgroundColor: t.bg,
        elevation: 0,
        leading: IconButton(icon: const Icon(Icons.arrow_back_ios_new_rounded), color: t.text, onPressed: () => Navigator.of(context).maybePop()),
        title: Text('功能中心', style: TextStyle(color: t.text, fontWeight: FontWeight.w700)),
      ),
      body: ListView(
        padding: const EdgeInsets.only(bottom: 32),
        children: [
          SectionCard(
            config: config,
            margin: const EdgeInsets.symmetric(horizontal: 12),
            padding: const EdgeInsets.all(14),
            children: [
              _grid(context, pages),
            ],
          ),
          const SizedBox(height: 10),
          SectionCard(
            config: config,
            margin: const EdgeInsets.symmetric(horizontal: 12),
            padding: const EdgeInsets.all(14),
            children: [
              Text('我的服务', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700, color: t.text)),
              const SizedBox(height: 12),
              _grid(context, webServices.map((s) => (s.$1, s.$2, s.$3 as Object)).toList()),
            ],
          ),
        ],
      ),
    );
  }

  Widget _grid(BuildContext context, List<(String, IconData, Object)> entries) {
    final t = config.theme;
    return Wrap(
      spacing: 12,
      runSpacing: 12,
      children: [
        for (final (label, icon, target) in entries)
          InkWell(
            onTap: () {
              if (target is Widget) {
                Navigator.of(context).push(MaterialPageRoute(builder: (_) => target));
              } else {
                final url = target as String;
                try { Process.start('cmd', ['/c', 'start', '', url]); } catch (_) {}
              }
            },
            borderRadius: BorderRadius.circular(14),
            child: Container(
              width: 78,
              padding: const EdgeInsets.symmetric(vertical: 10),
              decoration: BoxDecoration(
                color: t.card,
                borderRadius: BorderRadius.circular(14),
                border: Border.all(color: t.div.withValues(alpha: 0.6)),
              ),
              child: Column(children: [
                Icon(icon, color: config.theme.primary, size: 24),
                const SizedBox(height: 6),
                Text(label, style: TextStyle(fontSize: 11, color: t.text), maxLines: 1, overflow: TextOverflow.ellipsis),
              ]),
            ),
          ),
      ],
    );
  }
}
