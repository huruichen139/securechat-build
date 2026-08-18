import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';

import 'services/app_config.dart';
import 'services/call_service.dart';

class CallPage extends StatefulWidget {
  const CallPage({super.key, required this.service, required this.peerName, required this.config});

  final CallService service;
  final String peerName;
  final AppConfig config;

  @override
  State<CallPage> createState() => _CallPageState();
}

class _CallPageState extends State<CallPage> {
  Timer? _ticker;
  Duration _elapsed = Duration.zero;
  final _focusNode = FocusNode();

  @override
  void initState() {
    super.initState();
    widget.service.addListener(_onChange);
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      final at = widget.service.connectedAt;
      if (at != null) {
        setState(() => _elapsed = DateTime.now().difference(at));
      }
    });
  }

  void _onChange() {
    if (mounted) {
      setState(() {});
      final s = widget.service.status;
      if ((s == CallStatus.idle || s == CallStatus.ended) && Navigator.of(context).canPop()) {
        final reason = widget.service.endReason;
        Navigator.of(context).pop();
        if (reason != null && reason.isNotEmpty) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(reason), duration: const Duration(seconds: 2)));
        }
      }
    }
  }

  @override
  void dispose() {
    widget.service.removeListener(_onChange);
    _ticker?.cancel();
    _focusNode.dispose();
    super.dispose();
  }

  KeyEventResult _onKey(KeyEvent event) {
    if (event is! KeyDownEvent) return KeyEventResult.ignored;
    final key = event.logicalKey;
    final service = widget.service;
    if (service.status == CallStatus.ringing) {
      if (key == LogicalKeyboardKey.enter || key == LogicalKeyboardKey.numpadEnter) {
        service.accept();
        return KeyEventResult.handled;
      }
      if (key == LogicalKeyboardKey.escape) {
        service.decline();
        return KeyEventResult.handled;
      }
    } else {
      // M = 静音（toggleMute），ESC = 挂断（hangup），V = 摄像头开关
      if (key == LogicalKeyboardKey.keyM) {
        service.toggleMute();
        return KeyEventResult.handled;
      }
      if (key == LogicalKeyboardKey.escape) {
        service.hangup();
        return KeyEventResult.handled;
      }
      if (service.video && key == LogicalKeyboardKey.keyV) {
        service.toggleCamera();
        return KeyEventResult.handled;
      }
    }
    return KeyEventResult.ignored;
  }

  String _statusText() {
    switch (widget.service.status) {
      case CallStatus.calling:
        return '正在呼叫…';
      case CallStatus.ringing:
        return '邀请你视频/语音通话…';
      case CallStatus.connecting:
        return '连接中…';
      case CallStatus.connected:
        return _fmt(_elapsed);
      default:
        return '';
    }
  }

  static String _fmt(Duration d) {
    final m = d.inMinutes.toString().padLeft(2, '0');
    final s = (d.inSeconds % 60).toString().padLeft(2, '0');
    return '$m:$s';
  }

  @override
  Widget build(BuildContext context) {
    final service = widget.service;
    final videoOn = service.video && service.remoteStream != null;
    final primary = widget.config.primary;
    return KeyboardListener(
      focusNode: _focusNode,
      autofocus: true,
      onKeyEvent: _onKey,
      child: Scaffold(
      backgroundColor: const Color(0xff0f1b24),
      body: SafeArea(
        child: Stack(children: [
          Positioned.fill(
            child: videoOn
                ? RTCVideoView(service.remoteRenderer, objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitContain)
                : Container(color: const Color(0xff0f1b24), child: Center(child: CircleAvatar(radius: 54, backgroundColor: const Color(0xffd9eee4), child: Icon(service.video ? Icons.videocam_rounded : Icons.call_rounded, size: 40, color: const Color(0xff168457))))),
          ),
          if (service.video && service.localStream != null)
            Positioned(
              right: 16,
              top: 16,
              child: Container(width: 120, height: 170, clipBehavior: Clip.antiAlias, decoration: BoxDecoration(color: Colors.black, borderRadius: BorderRadius.circular(12), border: Border.all(color: Colors.white24)), child: RTCVideoView(service.localRenderer, mirror: true, objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitCover)),
            ),
          Positioned(
            left: 0,
            right: 0,
            top: 24,
            child: Column(children: [
              Text(widget.peerName, style: const TextStyle(color: Colors.white, fontSize: 22, fontWeight: FontWeight.w700)),
              const SizedBox(height: 6),
              Text(_statusText(), style: const TextStyle(color: Colors.white70, fontSize: 13)),
            ]),
          ),
          Positioned(
            left: 0,
            right: 0,
            bottom: 34,
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                if (service.status == CallStatus.ringing) ...[
                  _button(Icons.call_rounded, primary, '接听', () => service.accept()),
                  const SizedBox(width: 26),
                  _button(Icons.call_end_rounded, const Color(0xffe74c3c), '拒绝', () => service.decline()),
                ] else ...[
                  _button(service.muted ? Icons.mic_off_rounded : Icons.mic_rounded, const Color(0xff2b3b47), service.muted ? '已静音' : '静音', () => service.toggleMute()),
                  const SizedBox(width: 26),
                  _button(Icons.call_end_rounded, const Color(0xffe74c3c), '挂断', () => service.hangup()),
                  if (service.video) ...[
                    const SizedBox(width: 26),
                    _button(service.cameraOn ? Icons.videocam_off_rounded : Icons.videocam_rounded, const Color(0xff2b3b47), service.cameraOn ? '关闭摄像头' : '开启摄像头', () => service.toggleCamera()),
                  ],
                ],
              ]),
              const SizedBox(height: 10),
              Text(
                service.status == CallStatus.ringing ? 'Enter 接听 · ESC 拒绝'
                  : (service.video ? 'M 静音 · ESC 挂断 · V 摄像头' : 'M 静音 · ESC 挂断'),
                style: const TextStyle(color: Colors.white38, fontSize: 11),
              ),
            ]),
          ),
        ]),
      ),
      ),
    );
  }

  Widget _button(IconData icon, Color color, String label, VoidCallback onTap) {
    return Column(mainAxisSize: MainAxisSize.min, children: [
      Material(
        color: color,
        shape: const CircleBorder(),
        child: InkWell(customBorder: const CircleBorder(), onTap: onTap, child: SizedBox(width: 58, height: 58, child: Icon(icon, color: Colors.white, size: 26))),
      ),
      const SizedBox(height: 8),
      Text(label, style: const TextStyle(color: Colors.white70, fontSize: 12)),
    ]);
  }
}
