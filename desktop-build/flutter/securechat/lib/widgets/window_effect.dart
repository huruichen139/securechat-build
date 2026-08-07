import 'dart:math' as math;
import 'package:flutter/material.dart';

import '../services/app_config.dart';

/// 背景层：默认渲染一张丰富、明暗适配、值得模糊的自然渐变底图，
/// 这样 8 种材质（mica/acrylic/blur/…）模糊后效果才清晰可见、切换可感知。
class BgLayer extends StatelessWidget {
  const BgLayer({super.key, required this.theme, required this.config});
  final AppTheme theme;
  final AppConfig config;

  @override
  Widget build(BuildContext context) {
    final dark = theme.isDark;
    final base = config.bgKind == 2 ? config.bgColor : theme.bg;
    final primary = config.primary;

    List<Color> stops;
    if (config.bgKind == 1) {
      stops = [config.bgColor, config.bgColor.withValues(alpha: 0.72), primary.withValues(alpha: 0.45)];
    } else {
      // 让纯色背景也带一点点氛围光，导出各材质差异
      final accentA = primary.withValues(alpha: dark ? 0.34 : 0.22);
      final accentB = dark ? const Color(0x335b8cff) : const Color(0x22ff8fb1);
      final accentC = dark ? const Color(0x28a86ae0) : const Color(0x1f62c8ff);
      stops = [base, accentA, accentB, base, accentC, base];
    }

    return Stack(fit: StackFit.expand, children: [
      DecoratedBox(
        decoration: BoxDecoration(
          color: base,
          // 始终用温和渐变，让模糊有意义
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: config.bgKind == 1 ? stops : [stops[0], stops[1], stops[2]],
            stops: config.bgKind == 1 ? [0.0, 0.55, 1.0] : null,
          ),
        ),
      ),
      // 氛围光斑（可被模糊，产生真实毛玻璃感）
      Positioned(left: -120, top: -80, child: _Glow(size: 340, color: primary.withValues(alpha: dark ? 0.20 : 0.16))),
      Positioned(right: -100, top: 120, child: _Glow(size: 300, color: const Color(0xff4facfe).withValues(alpha: dark ? 0.16 : 0.14))),
      Positioned(left: 60, bottom: -120, child: _Glow(size: 360, color: const Color(0xfff093fb).withValues(alpha: dark ? 0.14 : 0.12))),
      if (config.bgKind == 1)
        DecoratedBox(
          decoration: BoxDecoration(gradient: LinearGradient(colors: [Colors.transparent, Colors.black.withValues(alpha: dark ? 0.35 : 0.10)])),
        ),
    ]);
  }
}

class _Glow extends StatelessWidget {
  const _Glow({required this.size, required this.color});
  final double size;
  final Color color;
  @override
  Widget build(BuildContext context) => Container(
        width: size,
        height: size,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          gradient: RadialGradient(colors: [color, color.withValues(alpha: 0.0)]),
        ),
      );
}

/// 可选的材料贴图层：跨平台生效，叠加在背景图上。
/// 8 种材质各有明显不同的绘制，明暗自适配。
class MaterialOverlay extends StatelessWidget {
  const MaterialOverlay({super.key, required this.effect, this.color = const Color(0x99ffffff), this.child});
  final WindowEffectKind effect;
  final Color color;
  final Widget? child;

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    final tint = color;
    final lightBase = const Color(0xb8ffffff).withValues(alpha: dark ? 0.9 : 0.25);
    final darkBase = const Color(0x9928303a);

    Widget? base;
    switch (effect) {
      case WindowEffectKind.none:
        base = null;
      case WindowEffectKind.mica:
        base = _NoiseWidget(baseDark: const Color(0x662a323c), baseLight: tint);
      case WindowEffectKind.acrylic:
        base = _NoiseWidget(baseDark: const Color(0x8a222a33), baseLight: tint);
      case WindowEffectKind.blur:
        base = _TintWidget(baseDark: darkBase, baseLight: lightBase, seed: 1);
      case WindowEffectKind.smoke:
        base = _SmokeWidget(baseDark: darkBase, baseLight: lightBase);
      case WindowEffectKind.metallic:
        base = _MetallicWidget(baseDark: darkBase, baseLight: lightBase);
      case WindowEffectKind.frosted:
        base = _FrostedWidget(baseDark: darkBase, baseLight: lightBase);
      case WindowEffectKind.etched:
        base = _EtchedWidget(baseDark: darkBase, baseLight: lightBase);
      case WindowEffectKind.shadow:
        base = _ShadowWidget(baseDark: darkBase, baseLight: lightBase);
    }

    if (base == null) return child ?? const SizedBox.shrink();
    return Stack(fit: StackFit.expand, children: [base, ?child]);
  }
}

class _NoiseWidget extends StatelessWidget {
  const _NoiseWidget({required this.baseDark, required this.baseLight});
  final Color baseDark;
  final Color baseLight;
  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    return CustomPaint(painter: _NoisePainter(baseColor: dark ? baseDark : baseLight), size: Size.infinite);
  }
}

class _NoisePainter extends CustomPainter {
  _NoisePainter({required this.baseColor});
  final Color baseColor;
  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(Offset.zero & size, Paint()..color = baseColor);
    final rnd = math.Random(7);
    var p = Paint()..color = Colors.white.withValues(alpha: 0.06);
    for (var i = 0; i < 700; i++) {
      canvas.drawRect(Rect.fromLTWH(rnd.nextDouble() * size.width, rnd.nextDouble() * size.height, 1.4, 1.4), p);
    }
    p = Paint()..color = Colors.white.withValues(alpha: 0.04);
    for (var i = 0; i < 360; i++) {
      canvas.drawRect(Rect.fromLTWH(rnd.nextDouble() * size.width, rnd.nextDouble() * size.height, 3, 3), p);
    }
  }

  @override
  bool shouldRepaint(_NoisePainter old) => old.baseColor != baseColor;
}

class _TintWidget extends StatelessWidget {
  const _TintWidget({required this.baseDark, required this.baseLight, required this.seed});
  final Color baseDark;
  final Color baseLight;
  final int seed;
  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    return CustomPaint(painter: _TintPainter(baseColor: dark ? baseDark : baseLight, seed: seed), size: Size.infinite);
  }
}

class _TintPainter extends CustomPainter {
  _TintPainter({required this.baseColor, required this.seed});
  final Color baseColor;
  final int seed;
  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(Offset.zero & size, Paint()..color = baseColor);
  }

  @override
  bool shouldRepaint(_TintPainter old) => old.baseColor != baseColor || old.seed != seed;
}

class _SmokeWidget extends StatelessWidget {
  const _SmokeWidget({required this.baseDark, required this.baseLight});
  final Color baseDark;
  final Color baseLight;
  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    return CustomPaint(painter: _SmokePainter(baseColor: dark ? baseDark : baseLight), size: Size.infinite);
  }
}

class _SmokePainter extends CustomPainter {
  _SmokePainter({required this.baseColor});
  final Color baseColor;
  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(Offset.zero & size, Paint()..color = baseColor);
    final rnd = math.Random(3);
    final p = Paint();
    // 白色烟团
    for (var i = 0; i < 26; i++) {
      final cx = 0.5 + (rnd.nextDouble() - 0.5) * 1.8;
      final cy = 0.5 + (rnd.nextDouble() - 0.5) * 1.8;
      p.shader = RadialGradient(colors: [Colors.white.withValues(alpha: 0.09), Colors.white.withValues(alpha: 0.0)])
          .createShader(Rect.fromCenter(center: Offset(cx * size.width, cy * size.height), width: size.width, height: size.height));
      canvas.drawRect(Offset.zero & size, p);
    }
  }

  @override
  bool shouldRepaint(_SmokePainter old) => old.baseColor != baseColor;
}

class _MetallicWidget extends StatelessWidget {
  const _MetallicWidget({required this.baseDark, required this.baseLight});
  final Color baseDark;
  final Color baseLight;
  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    return CustomPaint(painter: _MetallicPainter(baseColor: dark ? baseDark : baseLight), size: Size.infinite);
  }
}

class _MetallicPainter extends CustomPainter {
  _MetallicPainter({required this.baseColor});
  final Color baseColor;
  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(Offset.zero & size, Paint()..color = baseColor);
    // 金属渐变：白亮带
    final p = Paint()
      ..shader = LinearGradient(
        begin: Alignment.topLeft,
        end: Alignment.bottomRight,
        colors: const [Color(0x22ffffff), Color(0x00ffffff), Color(0x44ffffff), Color(0x00ffffff)],
        stops: const [0.0, 0.45, 0.5, 0.55],
      ).createShader(Offset.zero & size);
    canvas.drawRect(Offset.zero & size, p);
    final line = Paint()..color = Colors.white.withValues(alpha: 0.14);
    for (var y = -size.height; y < size.height * 2; y += 26) {
      canvas.drawLine(Offset(0, y), Offset(size.width, y + 40), line);
    }
  }

  @override
  bool shouldRepaint(_MetallicPainter old) => old.baseColor != baseColor;
}

class _FrostedWidget extends StatelessWidget {
  const _FrostedWidget({required this.baseDark, required this.baseLight});
  final Color baseDark;
  final Color baseLight;
  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    return CustomPaint(painter: _FrostedPainter(baseColor: dark ? baseDark : baseLight), size: Size.infinite);
  }
}

class _FrostedPainter extends CustomPainter {
  _FrostedPainter({required this.baseColor});
  final Color baseColor;
  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(Offset.zero & size, Paint()..color = baseColor);
    final rnd = math.Random(5);
    final p = Paint()..color = Colors.white.withValues(alpha: 0.10);
    for (var i = 0; i < 400; i++) {
      canvas.drawCircle(
        Offset(rnd.nextDouble() * size.width, rnd.nextDouble() * size.height),
        6 + rnd.nextDouble() * 18,
        p,
      );
    }
  }

  @override
  bool shouldRepaint(_FrostedPainter old) => old.baseColor != baseColor;
}

class _EtchedWidget extends StatelessWidget {
  const _EtchedWidget({required this.baseDark, required this.baseLight});
  final Color baseDark;
  final Color baseLight;
  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    return CustomPaint(painter: _EtchedPainter(baseColor: dark ? baseDark : baseLight), size: Size.infinite);
  }
}

class _EtchedPainter extends CustomPainter {
  _EtchedPainter({required this.baseColor});
  final Color baseColor;
  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(Offset.zero & size, Paint()..color = baseColor);
    final rnd = math.Random(11);
    final p = Paint()..strokeWidth = 1.4;
    for (var i = 0; i < 130; i++) {
      final x = rnd.nextDouble() * size.width;
      final y = rnd.nextDouble() * size.height;
      final len = 20 + rnd.nextDouble() * 80;
      final a = rnd.nextDouble() * math.pi;
      p.color = Colors.white.withValues(alpha: 0.12 + rnd.nextDouble() * 0.18);
      canvas.drawLine(Offset(x, y), Offset(x + math.cos(a) * len, y + math.sin(a) * len), p);
    }
  }

  @override
  bool shouldRepaint(_EtchedPainter old) => old.baseColor != baseColor;
}

class _ShadowWidget extends StatelessWidget {
  const _ShadowWidget({required this.baseDark, required this.baseLight});
  final Color baseDark;
  final Color baseLight;
  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    return CustomPaint(painter: _ShadowPainter(baseColor: dark ? baseDark : baseLight), size: Size.infinite);
  }
}

class _ShadowPainter extends CustomPainter {
  _ShadowPainter({required this.baseColor});
  final Color baseColor;
  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(Offset.zero & size, Paint()..color = baseColor);
    final light = Paint()
      ..shader = RadialGradient(colors: [Colors.white.withValues(alpha: 0.35), Colors.transparent]).createShader(
        Rect.fromCenter(center: Offset(size.width * 0.72, size.height * 0.18), width: size.width * 1.4, height: size.height),
      );
    canvas.drawRect(Offset.zero & size, light);
  }

  @override
  bool shouldRepaint(_ShadowPainter old) => old.baseColor != baseColor;
}
