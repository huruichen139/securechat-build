import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_windows/webview_flutter_windows.dart'
    as windows;

class TurnstileWidget extends StatefulWidget {
  const TurnstileWidget({
    super.key,
    required this.siteKey,
    required this.onToken,
    this.onError,
    this.baseUrl,
  });

  final String siteKey;
  final ValueChanged<String> onToken;
  final VoidCallback? onError;
  final String? baseUrl;

  @override
  State<TurnstileWidget> createState() => _TurnstileWidgetState();
}

class _TurnstileWidgetState extends State<TurnstileWidget> {
  WebViewController? _controller;
  windows.WebviewController? _windowsController;
  final List<StreamSubscription<dynamic>> _subscriptions = [];
  Timer? _loadTimer;
  int _generation = 0;
  bool _loading = true;
  bool _failed = false;

  bool _isCurrent(int generation) => mounted && generation == _generation;

  String _buildHtml(String? baseUrl) {
    final siteKey = jsonEncode(widget.siteKey).replaceAll('<', r'\u003c');
    final base = baseUrl == null
        ? ''
        : '<base href="${const HtmlEscape().convert(baseUrl)}">';
    return '''
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
$base
<style>
html,body{margin:0;padding:0;width:100%;height:100%;background:transparent}
body{display:flex;align-items:center;justify-content:center;overflow:auto}
#ts{flex-shrink:0}
@media(max-width:149px){body{justify-content:flex-start}}
</style>
</head>
<body>
<div id="ts"></div>
<script>
(function() {
  var widgetId = null;
  var compact = window.matchMedia('(max-width:299px)');
  var size = compact.matches ? 'compact' : 'normal';
  function post(type, token) {
    var message = JSON.stringify({type:type, token:token});
    if (window.chrome && window.chrome.webview) {
      window.chrome.webview.postMessage(message);
    } else if (window.TurnstileBridge) {
      window.TurnstileBridge.postMessage(message);
    }
  }
  function render() {
    try {
      widgetId = window.turnstile.render(document.getElementById('ts'), {
        sitekey: $siteKey,
        size: size,
        callback: function(token) { post('token', token); },
        'error-callback': function() { post('error'); },
        'expired-callback': function() { post('expired'); },
        'timeout-callback': function() { post('error'); },
        'unsupported-callback': function() { post('error'); }
      });
      post('ready');
    } catch (error) {
      post('error');
    }
  }
  window.onTurnstileLoaded = render;
  window.onTurnstileLoadError = function() { post('error'); };
  window.addEventListener('resize', function() {
    var nextSize = compact.matches ? 'compact' : 'normal';
    if (size === nextSize) return;
    size = nextSize;
    if (widgetId !== null && window.turnstile) {
      post('invalidated');
      window.turnstile.remove(widgetId);
      widgetId = null;
      render();
    }
  });
})();
</script>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileLoaded&render=explicit" async defer onerror="onTurnstileLoadError()"></script>
</body>
</html>
''';
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) unawaited(_initialize());
    });
  }

  @override
  void didUpdateWidget(covariant TurnstileWidget oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.siteKey != widget.siteKey ||
        oldWidget.baseUrl != widget.baseUrl) {
      _generation++;
      _loadTimer?.cancel();
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        widget.onError?.call();
        unawaited(_initialize());
      });
    }
  }

  Future<void> _ignoreFailure(Future<void> Function() action) async {
    try {
      await action();
    } catch (_) {}
  }

  void _release() {
    _loadTimer?.cancel();
    _loadTimer = null;
    for (final subscription in _subscriptions) {
      unawaited(_ignoreFailure(subscription.cancel));
    }
    _subscriptions.clear();
    final windowsController = _windowsController;
    _windowsController = null;
    if (windowsController != null) {
      unawaited(_ignoreFailure(windowsController.dispose));
    }
    final controller = _controller;
    _controller = null;
    if (controller != null) {
      unawaited(_cleanMobile(controller));
    }
  }

  Future<void> _cleanMobile(WebViewController controller) async {
    await _ignoreFailure(
      () => controller.runJavaScript(
        'if (window.turnstile) window.turnstile.remove(); window.stop();',
      ),
    );
    await _ignoreFailure(
      () => controller.removeJavaScriptChannel('TurnstileBridge'),
    );
  }

  Future<void> _initialize() async {
    if (!mounted) return;
    final generation = ++_generation;
    _release();
    setState(() {
      _loading = true;
      _failed = false;
    });
    _loadTimer = Timer(const Duration(seconds: 30), () => _fail(generation));
    WebViewController? mobileController;
    try {
      if (widget.siteKey.trim().isEmpty) {
        throw ArgumentError('Missing Turnstile site key');
      }
      final baseUrl = widget.baseUrl;
      if (baseUrl != null) {
        final uri = Uri.tryParse(baseUrl);
        if (uri == null ||
            !uri.hasAuthority ||
            uri.host.isEmpty ||
            (uri.scheme != 'https' && uri.scheme != 'http') ||
            uri.userInfo.isNotEmpty) {
          throw ArgumentError('Invalid Turnstile base URL');
        }
      }
      final html = _buildHtml(baseUrl);
      if (!kIsWeb && defaultTargetPlatform == TargetPlatform.windows) {
        final controller = windows.WebviewController();
        _windowsController = controller;
        await controller.initialize();
        if (!_isCurrent(generation) || _failed) return;
        _subscriptions.addAll([
          controller.webMessage.listen(
            (message) => _handleBridge(message, generation),
            onError: (Object error) => _fail(generation),
          ),
          controller.onLoadError.listen(
            (_) => _fail(generation),
            onError: (Object error) => _fail(generation),
          ),
        ]);
        await controller.setBackgroundColor(Colors.transparent);
        if (!_isCurrent(generation) || _failed) return;
        await controller.loadStringContent(html);
      } else if (!kIsWeb &&
          (defaultTargetPlatform == TargetPlatform.android ||
              defaultTargetPlatform == TargetPlatform.iOS)) {
        final controller = WebViewController();
        mobileController = controller;
        _controller = controller;
        await controller.setJavaScriptMode(JavaScriptMode.unrestricted);
        if (!_isCurrent(generation) || _failed) return;
        await controller.setBackgroundColor(Colors.transparent);
        if (!_isCurrent(generation) || _failed) return;
        await controller.addJavaScriptChannel(
          'TurnstileBridge',
          onMessageReceived: (message) =>
              _handleBridge(message.message, generation),
        );
        if (!_isCurrent(generation) || _failed) return;
        await controller.setNavigationDelegate(
          NavigationDelegate(
            onWebResourceError: (error) {
              if (error.isForMainFrame == true) _fail(generation);
            },
          ),
        );
        if (!_isCurrent(generation) || _failed) return;
        await controller.loadHtmlString(html, baseUrl: baseUrl);
      } else {
        throw UnsupportedError('Unsupported Turnstile platform');
      }
      if (_isCurrent(generation) && !_failed) setState(() {});
    } catch (_) {
      _fail(generation);
    } finally {
      if (mobileController != null && (!_isCurrent(generation) || _failed)) {
        await _cleanMobile(mobileController);
      }
    }
  }

  void _fail(int generation) {
    if (!_isCurrent(generation) || _failed) return;
    _generation++;
    _release();
    setState(() {
      _failed = true;
      _loading = false;
    });
    widget.onError?.call();
  }

  void _handleBridge(dynamic message, int generation) {
    if (!_isCurrent(generation) || _failed || message is! String) return;
    dynamic payload;
    try {
      payload = jsonDecode(message);
    } on FormatException {
      return;
    }
    if (payload is! Map<String, dynamic>) return;
    switch (payload['type']) {
      case 'ready':
        _loadTimer?.cancel();
        setState(() => _loading = false);
        break;
      case 'token':
        final token = payload['token'];
        if (token is String &&
            token.trim().isNotEmpty &&
            token != 'null' &&
            token != 'undefined' &&
            token.length <= 2048) {
          _loadTimer?.cancel();
          setState(() => _loading = false);
          widget.onToken(token);
        }
        break;
      case 'invalidated':
        widget.onError?.call();
        break;
      case 'error':
      case 'expired':
        _fail(generation);
        break;
    }
  }

  @override
  void dispose() {
    _generation++;
    _release();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final width = constraints.hasBoundedWidth
            ? constraints.maxWidth
            : 300.0;
        return SizedBox(
          width: width,
          height: width < 300 ? 150 : 70,
          child: _failed
              ? Center(
                  child: SingleChildScrollView(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Text('验证加载失败或已过期', textAlign: TextAlign.center),
                        TextButton(
                          onPressed: () => unawaited(_initialize()),
                          child: const Text('重试'),
                        ),
                      ],
                    ),
                  ),
                )
              : Stack(
                  fit: StackFit.expand,
                  children: [
                    if (_windowsController?.value.isInitialized == true)
                      windows.Webview(
                        _windowsController!,
                        key: ValueKey(_windowsController),
                      )
                    else if (_controller != null)
                      WebViewWidget(
                        controller: _controller!,
                        key: ValueKey(_controller),
                      ),
                    if (_loading)
                      const IgnorePointer(
                        child: Center(
                          child: SizedBox.square(
                            dimension: 24,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          ),
                        ),
                      ),
                  ],
                ),
        );
      },
    );
  }
}
