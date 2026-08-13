import 'dart:io' show Platform;
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:window_manager/window_manager.dart';

enum ThemeModeEx { light, dark, glass }

enum WindowEffectKind {
  none('无效果'),
  mica('云母 Mica'),
  acrylic('亚克力 Acrylic'),
  blur('模糊 Blur'),
  smoke('烟雾 Smoke'),
  metallic('金属拉丝'),
  frosted('磨砂 Frosted'),
  etched('压花玻璃'),
  shadow('深度阴影');

  const WindowEffectKind(this.label);
  final String label;
}

enum BubbleStyle { round, soft, sharp }

class AppTheme {
  AppTheme({required this.isDark, required this.primary, required this.fontScale});
  final bool isDark;
  final Color primary;
  final double fontScale;

  Color get bg => isDark ? const Color(0xff14181e) : const Color(0xfff4f6f8);
  Color get panel => isDark ? const Color(0x99263038) : const Color(0x99ffffff);
  Color get sidebar => isDark ? const Color(0xa61f2a33) : const Color(0x9cffffff);
  Color get card => isDark ? const Color(0xcc232c36) : const Color(0xd9ffffff);
  Color get text => isDark ? const Color(0xffe6eaef) : const Color(0xff17212b);
  Color get subText => isDark ? const Color(0xff8b96a1) : const Color(0xff77818a);
  Color get div => isDark ? const Color(0xff2d3742) : const Color(0xffe3e8eb);
  Color get inputBg => isDark ? const Color(0xff232c36) : const Color(0xfff1f4f6);
  Color get bubbleMine => primary.withValues(alpha: 0.32);
  Color get bubbleOther => isDark ? const Color(0xff232c36) : Colors.white;
  Color get onAccent => const Color(0xff0e2018);

  ThemeData theme() {
    final scheme = ColorScheme.fromSeed(seedColor: primary, brightness: isDark ? Brightness.dark : Brightness.light);
    final base = isDark ? ThemeData.dark(useMaterial3: true) : ThemeData.light(useMaterial3: true);
    final scale = fontScale == 1.0 ? 1.0 : fontScale.clamp(0.3, 1.5);
    // 将字号缩放应用于整个 textTheme，确保所有主题化文字都会随"设置-字号"变化
    TextTheme scaleText(TextTheme tt) => tt.apply(fontSizeFactor: scale, displayColor: null, bodyColor: null);
    return base.copyWith(
      colorScheme: scheme,
      scaffoldBackgroundColor: Colors.transparent,
      visualDensity: VisualDensity.adaptivePlatformDensity,
      textTheme: scaleText(base.textTheme),
      primaryTextTheme: scaleText(base.primaryTextTheme),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: inputBg,
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide.none),
        contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
      ),
      snackBarTheme: SnackBarThemeData(behavior: SnackBarBehavior.floating, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12))),
    );
  }
}

class AppConfig extends ChangeNotifier {
  AppConfig({required this.sp});
  final SharedPreferences sp;

  static const _kTheme = 'cfg_theme';
  static const _kEffect = 'cfg_effect';
  static const _kPrimary = 'cfg_primary';
  static const _kFont = 'cfg_font_scale';
  static const _kBgKind = 'cfg_bg_kind';
  static const _kBgColor = 'cfg_bg_color';
  static const _kDense = 'cfg_dense';
  static const _kEnterSend = 'cfg_enter_send';
  static const _kTimestamp = 'cfg_timestamp';
  static const _kAccentText = 'cfg_accent_text';
  static const _kShowStatusbar = 'cfg_statusbar';
  static const _kEnterHaptick = 'cfg_haptic';
  static const _kBubble = 'cfg_bubble';
  static const _kBlurPanel = 'cfg_blur_panel';

  ThemeModeEx mode = ThemeModeEx.light;
  WindowEffectKind effect = WindowEffectKind.acrylic;
  Color primary = const Color(0xff07c160);
  double fontScale = 1.0;
  int bgKind = 0; // 0 纯色 1 渐变 2 图片
  Color bgColor = const Color(0xff2c3e50);
  bool dense = false;
  bool enterSend = false;
  bool showTimestamp = true;
  bool accentText = true;
  bool showStatusbar = true;
  bool haptic = false;
  bool blurPanel = false;
  BubbleStyle bubbleStyle = BubbleStyle.round;

  late AppTheme dark = _build(true);
  late AppTheme light = _build(false);

  AppTheme get theme => mode == ThemeModeEx.dark ? dark : light;
  String get effectTitle => effect.label;

  static Future<AppConfig> init() async {
    final sp = await SharedPreferences.getInstance();
    return load(sp);
  }

  static AppConfig load(SharedPreferences sp) {
    final c = AppConfig(sp: sp)
      ..mode = ThemeModeEx.values[int.tryParse(sp.getString(_kTheme) ?? '') ?? 0]
      ..effect = WindowEffectKind.values[int.tryParse(sp.getString(_kEffect) ?? '') ?? 1]
      ..primary = Color(int.tryParse(sp.getString(_kPrimary) ?? '') ?? const Color(0xff07c160).toARGB32())
      ..fontScale = double.tryParse(sp.getString(_kFont) ?? '') ?? 1.0
      ..bgKind = int.tryParse(sp.getString(_kBgKind) ?? '') ?? 0
      ..bgColor = Color(int.tryParse(sp.getString(_kBgColor) ?? '') ?? const Color(0xff2c3e50).toARGB32())
      ..dense = sp.getBool(_kDense) ?? false
      ..enterSend = sp.getBool(_kEnterSend) ?? false
      ..showTimestamp = sp.getBool(_kTimestamp) ?? true
      ..accentText = sp.getBool(_kAccentText) ?? true
      ..showStatusbar = sp.getBool(_kShowStatusbar) ?? true
      ..haptic = sp.getBool(_kEnterHaptick) ?? false
      ..blurPanel = sp.getBool(_kBlurPanel) ?? false
      ..bubbleStyle = BubbleStyle.values[int.tryParse(sp.getString(_kBubble) ?? '') ?? 0];
    return c;
  }

  AppTheme _build(bool isDark) => AppTheme(isDark: isDark, primary: primary, fontScale: fontScale);

  void setMode(ThemeModeEx v) {
    mode = v;
    sp.setString(_kTheme, v.index.toString());
    notifyListeners();
  }

  void setEffect(WindowEffectKind v) {
    effect = v;
    sp.setString(_kEffect, v.index.toString());
    notifyListeners();
    // Windows 11: 切至「无效果」时把窗口背景设回不透明（盖住 Mica），
    // 其余效果（Mica/Acrylic/Blur…）都把窗口背景设透明让系统级亚克力透出。
    // C++ 端 runner/win32_window.cpp 已全局启用 DWMSBT_MAINWINDOW（Mica）。
    if (Platform.isWindows) {
      try {
        windowManager.setBackgroundColor(
          v == WindowEffectKind.none ? const Color(0xFFF7F7F7) : Colors.transparent,
        );
      } catch (_) {}
    }
  }

  void setPrimary(Color v) {
    primary = v;
    sp.setString(_kPrimary, v.toARGB32().toString());
    dark = _build(true);
    light = _build(false);
    notifyListeners();
  }

  void setFontScale(double v) {
    fontScale = v;
    sp.setString(_kFont, v.toString());
    dark = _build(true);
    light = _build(false);
    notifyListeners();
  }

  void setBgKind(int v) {
    bgKind = v;
    sp.setString(_kBgKind, v.toString());
    notifyListeners();
  }

  void setBgColor(Color v) {
    bgColor = v;
    sp.setString(_kBgColor, v.toARGB32().toString());
    notifyListeners();
  }

  void setDense(bool v) {
    dense = v;
    sp.setBool(_kDense, v);
    notifyListeners();
  }

  void setEnterSend(bool v) {
    enterSend = v;
    sp.setBool(_kEnterSend, v);
    notifyListeners();
  }

  void setShowTimestamp(bool v) {
    showTimestamp = v;
    sp.setBool(_kTimestamp, v);
    notifyListeners();
  }

  void setAccentText(bool v) {
    accentText = v;
    sp.setBool(_kAccentText, v);
    notifyListeners();
  }

  void setShowStatusbar(bool v) {
    showStatusbar = v;
    sp.setBool(_kShowStatusbar, v);
    notifyListeners();
  }

  void setHaptic(bool v) {
    haptic = v;
    sp.setBool(_kEnterHaptick, v);
    notifyListeners();
  }

  void setBlurPanel(bool v) {
    blurPanel = v;
    sp.setBool(_kBlurPanel, v);
    notifyListeners();
  }

  void setBubbleStyle(BubbleStyle v) {
    bubbleStyle = v;
    sp.setString(_kBubble, v.index.toString());
    notifyListeners();
  }

  static const List<Color> presetColors = [
    Color(0xff07c160),
    Color(0xff3b82f6),
    Color(0xff8b5cf6),
    Color(0xfff59e0b),
    Color(0xffef4444),
    Color(0xff14b8a6),
    Color(0xff64748b),
  ];
}
