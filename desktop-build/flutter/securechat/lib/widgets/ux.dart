import 'dart:io';

import 'package:flutter/material.dart';
import 'package:window_manager/window_manager.dart';

import '../services/app_config.dart';

/// SecureChat 2026 设计系统
///
/// 原则（来自 2026 真实产品调研，反 AI-slop）：
/// - 扁平、克制的表面：不要紫色渐变、不要过度毛玻璃、不要悬浮发光
/// - 单一强调色：微信绿只用于激活/主操作/关键状态
/// - 真正的层级：每屏一个焦点，其余安静
/// - 安静动效：150-200ms，只做背景/透明度变化，不做位移弹跳
/// - 全页面主题感知：明暗统一走 AppTheme，杜绝硬编码浅色

class Ux {
  static const double radius = 10;
  static const double cardRadius = 12;
  static const double cellHeight = 52;
  static const Duration fast = Duration(milliseconds: 150);

  static const Color green = Color(0xff07c160);

  static Color hover(AppTheme t) => t.isDark ? const Color(0xff23262b) : const Color(0xfff5f6f7);
  static Color cellIconBg(AppTheme t) => t.isDark ? const Color(0xff2a2e35) : const Color(0xffeef1f3);
}

/// 页面顶栏：原生、简洁、仅标题 + 返回
///
/// 桌面端（Windows/macOS/Linux）在最顶部额外渲染一条 32px 迷你标题栏：
/// 左侧可拖动区域 + 应用名小字，右侧最小化/最大化/关闭按钮，
/// 保证全屏推入的二级页面也能拖动窗口与关闭应用。
class PageHeader extends StatefulWidget {
  const PageHeader({super.key, required this.title, this.config, this.trailing, this.onBack});

  final String title;
  final AppConfig? config;
  final Widget? trailing;
  final VoidCallback? onBack;

  @override
  State<PageHeader> createState() => _PageHeaderState();
}

class _PageHeaderState extends State<PageHeader> {
  static bool get _isDesktop => Platform.isWindows || Platform.isMacOS || Platform.isLinux;
  bool _maximized = false;

  @override
  void initState() {
    super.initState();
    if (_isDesktop) {
      windowManager.isMaximized().then((v) {
        if (mounted) setState(() => _maximized = v);
      });
    }
  }

  Future<void> _toggleMaximize() async {
    try {
      if (await windowManager.isMaximized()) {
        await windowManager.unmaximize();
        if (mounted) setState(() => _maximized = false);
      } else {
        await windowManager.maximize();
        if (mounted) setState(() => _maximized = true);
      }
    } catch (_) {}
  }

  Widget _winButton(IconData icon, Color color, VoidCallback onTap, {Color? hover}) {
    return SizedBox(
      width: 44,
      height: 32,
      child: InkWell(
        onTap: onTap,
        hoverColor: hover,
        child: Icon(icon, size: 15, color: color),
      ),
    );
  }

  Widget _buildMiniTitleBar(BuildContext context, AppTheme? t) {
    final surface = t?.panel ?? Theme.of(context).colorScheme.surface;
    final nameColor = t?.text ?? Theme.of(context).colorScheme.onSurface;
    final btnColor = t?.subText ?? Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.6);
    return Container(
      height: 32,
      decoration: BoxDecoration(
        color: surface.withValues(alpha: 0.85),
        border: Border(bottom: BorderSide(color: t?.div.withValues(alpha: 0.5) ?? Theme.of(context).dividerColor)),
      ),
      child: Row(children: [
        Expanded(
          child: DragToMoveArea(
            child: Padding(
              padding: const EdgeInsets.only(left: 10),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text('SecureChat', style: TextStyle(fontSize: 11, fontWeight: FontWeight.w500, color: nameColor.withValues(alpha: 0.7))),
              ),
            ),
          ),
        ),
        _winButton(Icons.remove_rounded, btnColor, () { try { windowManager.minimize(); } catch (_) {} }),
        _winButton(
          _maximized ? Icons.filter_none_rounded : Icons.crop_square_rounded,
          btnColor,
          () { _toggleMaximize(); },
        ),
        _winButton(
          Icons.close_rounded,
          const Color(0xffe74c3c),
          () { try { windowManager.close(); } catch (_) {} },
          hover: const Color(0x29e74c3c),
        ),
      ]),
    );
  }

  @override
  Widget build(BuildContext context) {
    final t = widget.config?.theme;
    final text = t?.text ?? Theme.of(context).colorScheme.onSurface;
    final header = Container(
      height: 56,
      padding: const EdgeInsets.symmetric(horizontal: 8),
      decoration: BoxDecoration(
        color: t?.panel.withValues(alpha: 0.5) ?? Theme.of(context).colorScheme.surface,
        border: Border(bottom: BorderSide(color: t?.div ?? Theme.of(context).dividerColor)),
      ),
      child: Row(children: [
        IconButton(
          onPressed: widget.onBack ?? () => Navigator.maybePop(context),
          icon: const Icon(Icons.arrow_back_ios_new_rounded, size: 18),
          color: text,
        ),
        const SizedBox(width: 4),
        Expanded(child: Text(widget.title, style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: text))),
        ?widget.trailing,
      ]),
    );
    if (!_isDesktop) return header;
    return Column(mainAxisSize: MainAxisSize.min, children: [
      _buildMiniTitleBar(context, t),
      header,
    ]);
  }
}

/// 分组卡片（扁平白底 + 细边框），一组列表单元格的容器
class SectionCard extends StatelessWidget {
  const SectionCard({super.key, required this.config, this.children, this.padding = EdgeInsets.zero, this.margin});

  final AppConfig config;
  final List<Widget>? children;
  final EdgeInsetsGeometry padding;
  final EdgeInsetsGeometry? margin;

  @override
  Widget build(BuildContext context) {
    final t = config.theme;
    return Container(
      margin: margin ?? const EdgeInsets.symmetric(horizontal: 12),
      decoration: BoxDecoration(
        color: t.card.withValues(alpha: 0.85),
        borderRadius: BorderRadius.circular(Ux.cardRadius),
        border: Border.all(color: t.div.withValues(alpha: 0.6)),
      ),
      clipBehavior: Clip.antiAlias,
      child: Padding(padding: padding, child: children == null ? null : Column(children: children!)),
    );
  }
}

/// 扁平列表单元格：图标 + 标题 + 可选副标题 + 右箭头/尾部件
class ListCell extends StatelessWidget {
  const ListCell({
    super.key,
    required this.config,
    required this.icon,
    required this.title,
    this.subtitle,
    this.onTap,
    this.trailing,
    this.iconColor,
    this.showArrow = true,
  });

  final AppConfig config;
  final IconData icon;
  final String title;
  final String? subtitle;
  final VoidCallback? onTap;
  final Widget? trailing;
  final Color? iconColor;
  final bool showArrow;

  @override
  Widget build(BuildContext context) {
    final t = config.theme;
    final base = Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        child: Container(
          constraints: const BoxConstraints(minHeight: Ux.cellHeight),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
          child: Row(children: [
            Container(
              width: 34,
              height: 34,
              decoration: BoxDecoration(color: Ux.cellIconBg(t), borderRadius: BorderRadius.circular(8)),
              child: Icon(icon, size: 20, color: iconColor ?? t.text),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                Text(title, style: TextStyle(fontSize: 15, color: t.text, fontWeight: FontWeight.w500)),
                if (subtitle != null) ...[
                  const SizedBox(height: 2),
                  Text(subtitle!, style: TextStyle(fontSize: 12, color: t.subText)),
                ],
              ]),
            ),
            ?trailing,
            if (trailing == null && showArrow)
              Icon(Icons.chevron_right_rounded, color: t.subText.withValues(alpha: 0.7), size: 20),
          ]),
        ),
      ),
    );
    return base;
  }
}

/// 分组标题（小字、灰、大写字距）
class SectionTitle extends StatelessWidget {
  const SectionTitle({super.key, required this.config, required this.title});
  final AppConfig config;
  final String title;

  @override
  Widget build(BuildContext context) {
    final t = config.theme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 20, 20, 8),
      child: Text(title, style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: t.subText)),
    );
  }
}

/// 内容分隔线（卡片内）
class CellDivider extends StatelessWidget {
  const CellDivider({super.key, required this.config, this.indent = 60});
  final AppConfig config;
  final double indent;

  @override
  Widget build(BuildContext context) {
    return Divider(height: 1, thickness: 0.5, indent: indent, endIndent: 0, color: config.theme.div.withValues(alpha: 0.7));
  }
}
