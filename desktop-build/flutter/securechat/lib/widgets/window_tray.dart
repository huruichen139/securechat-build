import 'dart:io';

import 'package:flutter/widgets.dart';
import 'package:tray_manager/tray_manager.dart';
import 'package:window_manager/window_manager.dart';

// 托盘图标：复用 windows/runner/resources/app_icon.ico，
// 已在 pubspec.yaml 的 flutter.assets 中注册为同名资产键。
const String _kTrayIconAsset = 'windows/runner/resources/app_icon.ico';

class _WindowTrayHost with TrayListener, WindowListener {
  _WindowTrayHost._();

  static final _WindowTrayHost instance = _WindowTrayHost._();

  VoidCallback? _onShowMainWindow;
  bool _active = false;
  bool _manualQuit = false;

  Future<void> init({VoidCallback? onShowMainWindow}) async {
    if (_active) return;
    if (!(Platform.isWindows || Platform.isMacOS || Platform.isLinux)) return;
    _active = true;
    _onShowMainWindow = onShowMainWindow;
    _manualQuit = false;
    try {
      await trayManager.setIcon(_kTrayIconAsset);
      await trayManager.setToolTip('SecureChat');
      await trayManager.setContextMenu(Menu(items: [
        MenuItem(key: 'tray_show', label: '显示主界面'),
        MenuItem.separator(),
        MenuItem(key: 'tray_quit', label: '退出程序'),
      ]));
      await windowManager.setPreventClose(true);
      trayManager.addListener(this);
      windowManager.addListener(this);
    } catch (_) {
      // 图标加载或托盘初始化失败：静默降级为普通窗口行为，不阻塞启动
      await dispose();
    }
  }

  Future<void> dispose() async {
    if (!_active) return;
    _active = false;
    try {
      trayManager.removeListener(this);
      windowManager.removeListener(this);
    } catch (_) {}
  }

  Future<void> _showMainWindow() async {
    try {
      await windowManager.show();
      await windowManager.focus();
    } catch (_) {}
    _onShowMainWindow?.call();
  }

  Future<void> _quit() async {
    _manualQuit = true;
    try {
      await dispose();
      await windowManager.setPreventClose(false);
      await windowManager.close();
    } catch (_) {
      exit(0);
    }
  }

  @override
  void onTrayIconMouseDown() {
    // tray_manager 0.2.x 无单独的双击回调；双击会连续触发本回调，
    // 效果等同显示并聚焦主窗口
    _showMainWindow();
  }

  @override
  void onTrayIconRightMouseDown() {
    // Windows 下右键不会自动弹出菜单，需手动调用 popUpContextMenu
    try {
      _popUpMenu();
    } catch (_) {}
  }

  Future<void> _popUpMenu() async {
    await trayManager.popUpContextMenu();
  }

  @override
  void onTrayMenuItemClick(MenuItem menuItem) {
    switch (menuItem.key) {
      case 'tray_show':
        _showMainWindow();
        break;
      case 'tray_quit':
        _quit();
        break;
    }
  }

  @override
  void onWindowClose() {
    if (_manualQuit) return;
    // 拦截关闭按钮：隐藏到托盘（微信式），进程继续运行
    windowManager.hide();
  }
}

Future<void> initTray({VoidCallback? onShowMainWindow}) {
  return _WindowTrayHost.instance.init(onShowMainWindow: onShowMainWindow);
}

Future<void> disposeTray() {
  return _WindowTrayHost.instance.dispose();
}
