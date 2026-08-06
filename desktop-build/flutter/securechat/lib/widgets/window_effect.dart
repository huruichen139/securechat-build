import 'dart:math' as math;
import 'package:flutter/material.dart';

import '../services/app_config.dart';

/// 可选的材料贴图层：跨平台生效，叠加在背景图上。
class MaterialOverlay extends StatelessWidget {
  const MaterialOverlay({super.key, required this.effect, this.color = const Color(0x99ffffff), this.child});
  final WindowEffectKind effect;
  final Color color;
  final Widget? child;

  @override
  Widget build(BuildContext context) {
    Widget? base;
    final tint = color;

    switch (effect) {
      case WindowEffectKind.acrylic:
        base = _NoiseWidget(color: tint);
      case WindowEffectKind.blur:
        base = const _BlurTint();
      case WindowEffectKind.smoke:
        base = const _SmokeWidget();
      case WindowEffectKind.metallic:
        base = const _MetallicWidget();
      case WindowEffectKind.frosted:
        base = _FrostedWidget(tint: tint);
      case WindowEffectKind.etched:
        base = const _EtchedWidget();
      case WindowEffectKind.shadow:
        base = const _ShadowWidget();
      case WindowEffectKind.mica:
        base = _NoiseWidget(color: tint.withValues(alpha: 0.75));
      case WindowEffectKind.none:
        base = null;
    }

    if (base == null) return child ?? const SizedBox.shrink();
    return Stack(fit: StackFit.expand, children: [base, ?child]);
  }
}

class _NoiseWidget extends StatelessWidget {
  const _NoiseWidget({required this.color});
  final Color color;
  @override
  Widget build(BuildContext context) => CustomPaint(painter: _NoisePainter(color), size: Size.infinite);
}

class _NoisePainter extends CustomPainter {
  _NoisePainter(this.color);
  final Color color;
  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(Offset.zero & size, Paint()..color = color);
    final rnd = math.Random(7);
    var p = Paint()..color = Colors.white.withValues(alpha: 0.05);
    for (var i = 0; i < 700; i++) {
      canvas.drawRect(Rect.fromLTWH(rnd.nextDouble() * size.width, rnd.nextDouble() * size.height, 1.4, 1.4), p);
    }
    p = Paint()..color = Colors.white.withValues(alpha: 0.03);
    for (var i = 0; i < 360; i++) {
      canvas.drawRect(Rect.fromLTWH(rnd.nextDouble() * size.width, rnd.nextDouble() * size.height, 3, 3), p);
    }
  }

  @override
  bool shouldRepaint(_NoisePainter old) => old.color != color;
}

class _BlurTint extends StatelessWidget {
  const _BlurTint();
  @override
  Widget build(BuildContext context) => CustomPaint(painter: const _TintPainter(), size: Size.infinite);
}

class _TintPainter extends CustomPainter {
  const _TintPainter();
  @override
  void paint(Canvas canvas, Size size) => canvas.drawRect(Offset.zero & size, Paint()..color = const Color(0xcaffffff));
  @override
  bool shouldRepaint(_TintPainter old) => false;
}

class _FrostedWidget extends StatelessWidget {
  const _FrostedWidget({required this.tint});
  final Color tint;
  @override
  Widget build(BuildContext context) => CustomPaint(painter: _TintPainterFrost(tint), size: Size.infinite);
}

class _TintPainterFrost extends CustomPainter {
  const _TintPainterFrost(this.color);
  final Color color;
  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(Offset.zero & size, Paint()..color = color.withValues(alpha: 0.8));
  }

  @override
  bool shouldRepaint(_TintPainterFrost old) => old.color != color;
}

class _SmokeWidget extends StatelessWidget {
  const _SmokeWidget();
  @override
  Widget build(BuildContext context) => CustomPaint(painter: const _SmokePainter(), size: Size.infinite);
}

class _SmokePainter extends CustomPainter {
  const _SmokePainter();
  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(Offset.zero & size, Paint()..color = const Color(0xa8ffffff));
    final rnd = math.Random(3);
    final p = Paint();
    for (var i = 0; i < 18; i++) {
      final cx = 0.5 + (rnd.nextDouble() - 0.5) * 1.6;
      final cy = 0.5 + (rnd.nextDouble() - 0.5) * 1.6;
      p.shader = RadialGradient(colors: [Colors.white.withValues(alpha: 0.06), Colors.white.withValues(alpha: 0.0)])
          .createShader(Rect.fromCenter(center: Offset(cx * size.width, cy * size.height), width: size.width, height: size.height));
      canvas.drawRect(Offset.zero & size, p);
    }
  }

  @override
  bool shouldRepaint(_SmokePainter old) => false;
}

class _MetallicWidget extends StatelessWidget {
  const _MetallicWidget();
  @override
  Widget build(BuildContext context) => CustomPaint(painter: const _MetallicPainter(), size: Size.infinite);
}

class _MetallicPainter extends CustomPainter {
  const _MetallicPainter();
  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(Offset.zero & size, Paint()..color = const Color(0xaaffffff));
    final p = Paint()
      ..shader = const LinearGradient(
        colors: [Color(0x33aaaaaa), Color(0x66ffffff), Color(0x22888888), Color(0x55ffffff)],
        stops: [0.0, 0.3, 0.6, 1.0],
      ).createShader(Offset.zero & size);
    canvas.drawRect(Offset.zero & size, p);
    final line = Paint()..color = Colors.white.withValues(alpha: 0.12);
    for (var y = -size.height; y < size.height * 2; y += 22) {
      canvas.drawLine(Offset(0, y), Offset(size.width, y + 34), line);
    }
  }

  @override
  bool shouldRepaint(_MetallicPainter old) => false;
}

class _EtchedWidget extends StatelessWidget {
  const _EtchedWidget();
  @override
  Widget build(BuildContext context) => CustomPaint(painter: const _EtchedPainter(), size: Size.infinite);
}

class _EtchedPainter extends CustomPainter {
  const _EtchedPainter();
  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(Offset.zero & size, Paint()..color = const Color(0xaaffffff));
    final rnd = math.Random(11);
    final p = Paint()..strokeWidth = 1.2;
    for (var i = 0; i < 120; i++) {
      final x = rnd.nextDouble() * size.width;
      final y = rnd.nextDouble() * size.height;
      final len = 20 + rnd.nextDouble() * 70;
      p.color = Colors.white.withValues(alpha: 0.12 + rnd.nextDouble() * 0.15);
      canvas.drawLine(Offset(x, y), Offset(x + len, y + len * 0.18), p);
    }
  }

  @override
  bool shouldRepaint(_EtchedPainter old) => false;
}

class _ShadowWidget extends StatelessWidget {
  const _ShadowWidget();
  @override
  Widget build(BuildContext context) => CustomPaint(painter: const _ShadowPainter(), size: Size.infinite);
}

class _ShadowPainter extends CustomPainter {
  const _ShadowPainter();
  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(Offset.zero & size, Paint()..color = const Color(0x99ffffff));
    final light = Paint()
      ..shader = RadialGradient(colors: [Colors.white.withValues(alpha: 0.6), Colors.white.withValues(alpha: 0.0)]).createShader(Offset.zero & size);
    canvas.drawRect(Offset.zero & size, light);
  }

  @override
  bool shouldRepaint(_ShadowPainter old) => false;
}

/// 背景层：根据配置绘制纯色/渐变。
class BgLayer extends StatelessWidget {
  const BgLayer({super.key, required this.theme, required this.config});
  final AppTheme theme;
  final AppConfig config;

  @override
  Widget build(BuildContext context) {
    final base = theme.bg;
    if (config.bgKind == 1) {
      return DecoratedBox(
        decoration: BoxDecoration(
          gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [config.bgColor, config.bgColor.withValues(alpha: 0.7), theme.primary.withValues(alpha: 0.4)]),
        ),
      );
    }
    return DecoratedBox(decoration: BoxDecoration(color: config.bgKind == 2 ? config.bgColor : base));
  }
}
