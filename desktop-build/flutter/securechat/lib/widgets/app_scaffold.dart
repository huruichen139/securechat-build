import 'dart:ui' show ImageFilter;
import 'package:flutter/material.dart';

import '../services/app_config.dart';
import 'window_effect.dart';

class AppScaffold extends StatelessWidget {
  const AppScaffold({super.key, required this.config, required this.body, this.overlay});

  final AppConfig config;
  final Widget body;
  final Widget? overlay;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: config,
      builder: (context, _) {
        final theme = config.theme;
        final materialColor = theme.isDark
            ? const Color(0x992a323c)
            : const Color(0x99ffffff);
        return Stack(
          fit: StackFit.expand,
          children: [
            Positioned.fill(child: BgLayer(theme: theme, config: config)),
            // 材质切换时淡入淡出，让变化清晰可感知
            AnimatedSwitcher(
              duration: const Duration(milliseconds: 420),
              child: MaterialOverlay(
                key: ValueKey('overlay-${config.effect}'),
                effect: config.effect,
                color: materialColor,
              ),
            ),
            Positioned.fill(
              child: _BodySurface(config: config, theme: theme, child: body),
            ),
            if (overlay != null) Positioned.fill(child: overlay!),
          ],
        );
      },
    );
  }
}

class _BodySurface extends StatelessWidget {
  const _BodySurface({required this.config, required this.theme, required this.child});

  final AppConfig config;
  final AppTheme theme;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final eff = config.effect;
    // 每材质独立的模糊强度 + 面板透明度 → 切换时视觉差异明显
    double sigma;
    double panelAlpha;
    switch (eff) {
      case WindowEffectKind.none:
        sigma = 0;
        panelAlpha = 0.96;
      case WindowEffectKind.mica:
        sigma = 22;
        panelAlpha = 0.84;
      case WindowEffectKind.acrylic:
        sigma = 18;
        panelAlpha = 0.78;
      case WindowEffectKind.blur:
        sigma = 28;
        panelAlpha = 0.82;
      case WindowEffectKind.smoke:
        sigma = 16;
        panelAlpha = 0.74;
      case WindowEffectKind.metallic:
        sigma = 6;
        panelAlpha = 0.70;
      case WindowEffectKind.frosted:
        sigma = 34;
        panelAlpha = 0.88;
      case WindowEffectKind.etched:
        sigma = 12;
        panelAlpha = 0.80;
      case WindowEffectKind.shadow:
        sigma = 40;
        panelAlpha = 0.90;
    }
    if (config.blurPanel) sigma = 24;
    final dark = theme.isDark;

    if (sigma > 0) {
      return ClipRect(
        child: BackdropFilter(
          filter: ImageFilter.blur(sigmaX: sigma, sigmaY: sigma),
          child: ColoredBox(
            // 更轻的罩膜：让下方分材质的主色调能透出来，切换材质肉眼可辨
            color: dark
                ? const Color(0x2428303a)
                : const Color(0x1fffffff),
            child: child,
          ),
        ),
      );
    }
    return ColoredBox(
      color: (theme.panel).withValues(alpha: panelAlpha),
      child: child,
    );
  }
}

class PanelCard extends StatelessWidget {
  const PanelCard({super.key, required this.config, this.child, this.padding, this.radius = 14});

  final AppConfig config;
  final Widget? child;
  final EdgeInsetsGeometry? padding;
  final double radius;

  @override
  Widget build(BuildContext context) {
    final color = config.theme.card.withValues(alpha: 0.82);
    return Container(
      decoration: BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(radius),
        border: Border.all(color: config.theme.div.withValues(alpha: 0.5)),
      ),
      padding: padding,
      child: child,
    );
  }
}

class AppIconButton extends StatelessWidget {
  const AppIconButton({super.key, required this.config, required this.icon, this.onPressed, this.tooltip});

  final AppConfig config;
  final IconData icon;
  final VoidCallback? onPressed;
  final String? tooltip;

  @override
  Widget build(BuildContext context) {
    final iconButton = IconButton(
      icon: Icon(icon, color: config.theme.text),
      onPressed: onPressed,
      iconSize: 18,
      style: IconButton.styleFrom(
        backgroundColor: config.theme.inputBg.withValues(alpha: 0.7),
        foregroundColor: config.theme.text,
      ),
    );
    if (tooltip == null) return iconButton;
    return Tooltip(message: tooltip!, child: iconButton);
  }
}
