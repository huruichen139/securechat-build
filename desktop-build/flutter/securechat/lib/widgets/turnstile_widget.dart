import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';

/// Cloudflare Turnstile 验证组件（基于 WebView 加载官方 widget）
/// 通过 JavaScriptChannel 桥接 token 到 Flutter。
class TurnstileWidget extends StatefulWidget {
  const TurnstileWidget({
    super.key,
    required this.siteKey,
    required this.onToken,
    this.onError,
  });

  /// Cloudflare Turnstile 站点密钥（公钥）
  final String siteKey;

  /// 验证成功回调（参数为 turnstile token）
  final ValueChanged<String> onToken;

  /// 验证失败回调
  final VoidCallback? onError;

  @override
  State<TurnstileWidget> createState() => _TurnstileWidgetState();
}

class _TurnstileWidgetState extends State<TurnstileWidget> {
  WebViewController? _controller;

  String _buildHtml() {
    return '''
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileLoaded" async defer></script>
<style>
  html,body{margin:0;padding:0;display:flex;justify-content:center;align-items:center;height:100%;background:transparent}
</style>
</head>
<body>
<div id="ts"></div>
<script>
  function post(msg) {
    if (window.TurnstileBridge) window.TurnstileBridge.postMessage(msg);
  }
  window.onTurnstileLoaded = function() {
    try {
      turnstile.render(document.getElementById('ts'), {
        sitekey: '${widget.siteKey}',
        callback: function(token){ post(token); },
        'error-callback': function(){ post('__error__'); },
        'expired-callback': function(){ post('__expired__'); }
      });
    } catch(e) { post('__error__'); }
  };
</script>
</body>
</html>
''';
  }

  @override
  void initState() {
    super.initState();
    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(Colors.transparent)
      ..addJavaScriptChannel('TurnstileBridge', onMessageReceived: (msg) {
        _handleBridge(msg.message);
      })
      ..setNavigationDelegate(NavigationDelegate(
        onPageFinished: (_) {},
        onWebResourceError: (_) => widget.onError?.call(),
      ));
    _controller!.loadHtmlString(_buildHtml());
  }

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 70,
      child: WebViewWidget(controller: _controller!),
    );
  }

  void _handleBridge(String message) {
    if (message == '__error__' || message == '__expired__') {
      widget.onError?.call();
      return;
    }
    if (message.isNotEmpty && message != 'null' && message != 'undefined') {
      widget.onToken(message);
    }
  }
}
