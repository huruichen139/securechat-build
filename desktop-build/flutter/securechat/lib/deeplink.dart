// module: deeplink —— securechat:// 深链统一入口（Windows）：
// 1) 冷启动：main() 读取 Platform.executableArguments 中的深链参数；
// 2) 热启动：第二实例经 C++ 壳 WM_COPYDATA → MethodChannel "securechat/deeplink"
//    转发过来的深链。
// 目前支持 securechat://gateway/pay?order=<order_no> → GatewayPayPage 授权扣款确认页。
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'gateway_pay_page.dart';
import 'services/app_config.dart';
import 'services/securechat_api.dart';

/// 全局导航 Key：深链可能在任何页面栈状态下到达，统一经根导航器压入确认页。
final GlobalKey<NavigatorState> appNavigatorKey = GlobalKey<NavigatorState>();

class DeepLink {
  static const MethodChannel _channel = MethodChannel('securechat/deeplink');
  static SecureChatApi? _api;
  static AppConfig? _config;
  static String? _pending;
  static int _pendingTries = 0;

  /// 必须在 runApp 前调用：注册原生转发通道并缓存 api/config。
  static void init({required SecureChatApi api, required AppConfig config}) {
    _api = api;
    _config = config;
    _channel.setMethodCallHandler((call) async {
      if (call.method == 'open') {
        handle(call.arguments?.toString() ?? '');
      }
    });
  }

  /// 处理一条深链文本（启动参数或转发来的 URL）。
  static void handle(String text) {
    final order = _parseGatewayOrder(text);
    if (order == null) return;
    final navigator = appNavigatorKey.currentState;
    if (navigator == null) {
      // 首帧尚未渲染（转发可能早于 runApp 完成）：暂存并在帧回调里重试。
      _pending = order;
      _pendingTries = 0;
      _retryPending();
      return;
    }
    _pending = null;
    final api = _api;
    final config = _config;
    if (api == null || config == null) return;
    if (!api.isLoggedIn) {
      ScaffoldMessenger.of(navigator.context).showSnackBar(
        const SnackBar(content: Text('请先登录 SecureChat 后再发起授权扣款')),
      );
      return;
    }
    navigator.push(MaterialPageRoute(
      builder: (_) => GatewayPayPage(api: api, config: config, orderNo: order),
    ));
  }

  static void _retryPending() {
    if (_pending == null) return;
    if (++_pendingTries > 30) {
      _pending = null;
      return;
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final p = _pending;
      if (p != null) handle('securechat://gateway/pay?order=$p');
    });
  }

  /// 解析 `securechat://gateway/pay?order=<order_no>`，返回 order_no；非法返回 null。
  static String? _parseGatewayOrder(String text) {
    final t = text.trim();
    if (!t.startsWith('securechat://gateway')) return null;
    try {
      final order = Uri.parse(t).queryParameters['order'];
      return (order == null || order.isEmpty) ? null : order;
    } catch (_) {
      return null;
    }
  }
}