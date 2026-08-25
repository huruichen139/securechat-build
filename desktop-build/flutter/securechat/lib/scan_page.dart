// module: scan (worker batch5) —— 扫一扫：MobileScanner 摄像头解码，
// 识别安全码/好友码/小程序 URL/网页链接。桌面无摄像头时降级为手动输入文本。
// 依赖：services/securechat_api.dart、services/lifestyle_api.dart、package:mobile_scanner/mobile_scanner。
// 注：摄像头扫码分支在桌面（无摄像头）会友好提示，并始终提供"手动输入二维码文本"降级入口。
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import 'services/app_config.dart';
import 'services/lifestyle_api.dart';
import 'services/securechat_api.dart';
import 'widgets/ux.dart';
import 'gateway_pay_page.dart';

class ScanPage extends StatefulWidget {
  const ScanPage({super.key, required this.api, required this.config});
  final SecureChatApi api;
  final AppConfig config;
  @override
  State<ScanPage> createState() => _ScanPageState();
}

class _ScanPageState extends State<ScanPage> {
  late final LifestyleService _svc;
  bool _busy = false;
  String? _status;
  bool _manual = false;
  final _manualCtrl = TextEditingController();
  MobileScannerController? _scannerCtrl;

  @override
  void initState() {
    super.initState();
    _svc = LifestyleService(widget.api);
    final hasCam = !Platform.isWindows && !Platform.isLinux;
    if (hasCam) {
      _scannerCtrl = MobileScannerController(formats: const [BarcodeFormat.qrCode], facing: CameraFacing.back);
      _scannerCtrl!.start().catchError((_) {});
    }
  }

  String? _lastCode;
  DateTime? _lastCodeAt;

  bool _isDuplicateScan(String code) {
    final now = DateTime.now();
    if (_lastCode == code && _lastCodeAt != null && now.difference(_lastCodeAt!).inSeconds < 3) return true;
    _lastCode = code;
    _lastCodeAt = now;
    return false;
  }

  @override
  void dispose() {
    _manualCtrl.dispose();
    _scannerCtrl?.dispose();
    super.dispose();
  }

  Future<void> _handle(String raw) async {
    if (_busy) return;
    final text = raw.trim();
    if (text.isEmpty) return;

    // securechat://friend?uid=xxx → 加好友
    if (text.startsWith('securechat://friend')) {
      final uid = _queryParam(text, 'uid');
      if (uid == null || uid.isEmpty) { _status = '无效的好友二维码'; return; }
      setState(() { _busy = true; _status = '发送好友请求…'; });
      try {
        final r = await widget.api.addFriend(uid);
        _status = '${(r['friend']?['nickname'] ?? r['friend']?['username'] ?? '').toString()} 已发送好友请求';
      } catch (e) {
        _status = e.toString().replaceFirst('Bad state: ', '');
      } finally {
        if (mounted) setState(() => _busy = false);
      }
      return;
    }

    // securechat://login?token=xxx → 确认登录
    if (text.startsWith('securechat://login')) {
      final token = _queryParam(text, 'token');
      if (token == null) { _status = '登录二维码无效'; return; }
      setState(() => _busy = true);
      try {
        await widget.api.confirmQrLogin(token);
        _status = '已确认登录';
      } catch (e) {
        _status = e.toString().replaceFirst('Bad state: ', '');
      } finally {
        if (mounted) setState(() => _busy = false);
      }
      return;
    }

    // securechat://gateway/pay?order=xxx → 网关支付确认
    if (text.startsWith('securechat://gateway')) {
      final order = _queryParam(text, 'order');
      if (order == null || order.isEmpty) { _status = '网关支付二维码无效'; return; }
      setState(() { _busy = true; _status = '打开网关支付确认…'; });
      if (!mounted) return;
      Navigator.of(context).push(MaterialPageRoute(
        builder: (_) => GatewayPayPage(api: widget.api, config: widget.config, orderNo: order),
      )).then((_) { if (mounted) setState(() { _busy = false; _status = null; }); });
      return;
    }

    // securechat://mini?app=… → 打开小程序（搜索名称/ID）
    if (text.startsWith('securechat://mini')) {
      final key = _queryParam(text, 'app') ?? _queryParam(text, 'id');
      if (key == null || key.isEmpty) { _status = '小程序码无效'; return; }
      try {
        final list = await _svc.searchMiniPrograms(key);
        if (list.isEmpty) { _status = '未找到小程序：$key'; return; }
        final target = list.firstWhere((a) => _svc.toInt(a['id']).toString() == key, orElse: () => list.first);
        final url = (target['url'] ?? '').toString();
        _status = '正在打开小程序：${target['name']}';
        if (url.isNotEmpty) {
          if (Platform.isWindows) {
            Process.start('cmd', ['/c', 'start', '', url]);
          } else if (Platform.isMacOS) {
            Process.start('open', [url]);
          } else {
            Process.start('xdg-open', [url]);
          }
        }
      } catch (e) {
        _status = '打开小程序失败：${e.toString().replaceFirst('Bad state: ', '')}';
      }
      return;
    }

    // 任意其他内容：直接显示扫描结果（不做限制）
    if (!mounted) return;
    _showRawResult(text);
  }

  void _showRawResult(String text) {
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('扫码结果'),
        content: SingleChildScrollView(child: SelectableText(text)),
        actions: [
          TextButton(
            onPressed: () async {
              await Clipboard.setData(ClipboardData(text: text));
              if (ctx.mounted) Navigator.of(ctx).pop();
            },
            child: const Text('复制'),
          ),
          TextButton(onPressed: () => Navigator.of(ctx).pop(), child: const Text('关闭')),
        ],
      ),
    );
  }

  String? _queryParam(String raw, String key) {
    final uri = Uri.tryParse(raw);
    if (uri != null && uri.queryParameters[key] != null) return uri.queryParameters[key];
    final marker = '?$key=';
    if (raw.contains(marker)) {
      return Uri.decodeComponent(raw.split('$key=').last.split('&').first);
    }
    return null;
  }

  void _manualSubmit() {
    final t = _manualCtrl.text.trim();
    if (t.isEmpty) { _status = '请输入二维码内容'; return; }
    _handle(t);
  }

  @override
  Widget build(BuildContext context) {
    final t = widget.config.theme;
    final hasCam = _scannerCtrl != null;
    return Scaffold(
      backgroundColor: t.bg,
      body: Column(children: [
        PageHeader(
          title: '扫一扫',
          config: widget.config,
          trailing: TextButton(
            onPressed: () => setState(() { _manual = !_manual; _status = null; }),
            child: Text(_manual ? '摄像头' : '手动输入', style: TextStyle(color: widget.config.primary)),
          ),
        ),
        Expanded(child: _manual ? _manualView(t) : _cameraView(t, hasCam)),
      ]),
    );
  }

  Widget _manualView(AppTheme t) {
    return Padding(
      padding: const EdgeInsets.all(20),
      child: Column(children: [
        const SizedBox(height: 8),
        TextField(controller: _manualCtrl, maxLines: 3, decoration: const InputDecoration(hintText: '粘贴二维码内容（如 securechat://friend?uid=xxx）')),
        if (_status != null) ...[
          const SizedBox(height: 12),
          Text(_status!, style: TextStyle(color: t.subText)),
        ],
        const SizedBox(height: 16),
        FilledButton.icon(onPressed: _manualSubmit, icon: const Icon(Icons.arrow_forward), label: const Text('识别')),
      ]),
    );
  }

  Widget _cameraView(AppTheme t, bool hasCam) {
    if (!hasCam) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Icon(Icons.no_photography_outlined, size: 56, color: t.subText),
            const SizedBox(height: 12),
            Text('当前设备没有摄像头或不受支持', style: TextStyle(color: t.text)),
            const SizedBox(height: 8),
            Text('请切换到「手动输入」粘贴二维码内容', style: TextStyle(color: t.subText)),
          ]),
        ),
      );
    }
    return Stack(children: [
      MobileScanner(
        controller: _scannerCtrl,
        onDetect: (capture) {
          final v = capture.barcodes.isEmpty ? null : capture.barcodes.first.rawValue;
          if (v != null && !_isDuplicateScan(v)) _handle(v);
        },
      ),
      Align(
        alignment: Alignment.bottomCenter,
        child: Container(
          width: double.infinity,
          padding: const EdgeInsets.all(16),
          color: Colors.black54,
          child: Text(_status ?? '将二维码放入框内（支持好友码 / 登录码 / 小程序 / 网页）', textAlign: TextAlign.center, style: const TextStyle(color: Colors.white, fontSize: 13)),
        ),
      ),
    ]);
  }
}
