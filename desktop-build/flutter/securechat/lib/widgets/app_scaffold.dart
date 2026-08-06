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
            Positioned.fill(
              child: MaterialOverlay(effect: config.effect, color: materialColor),
            ),
            if (overlay != null) Positioned.fill(child: overlay!),
            Positioned.fill(child: _BodySurface(config: config, theme: theme, child: body)),
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
    if (config.blurPanel) {
      return ClipRect(
        child: BackdropFilter(
          filter: ImageFilter.blur(sigmaX: 18, sigmaY: 18),
          child: ColoredBox(
            color: theme.isDark
                ? const Color(0x6628303a)
                : const Color(0x66ffffff),
            child: child,
          ),
        ),
      );
    }
    return ColoredBox(
      color: (theme.panel)
          .withValues(alpha: theme.isDark ? 0.85 : 0.88),
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
