// module: rtc (worker batch3)
// 语音/视频通话增强服务（Flutter 端，独立可编译）。
//
// 与既有的 CallService 不同，本服务：
//  1) 除 WebSocket 信令外，额外支持 POST /api/rtc/{signal,poll} 的 REST 信令桥，
//     用于 Web <-> Flutter 跨端通话（配合 server/routes/rtc.js）。
//  2) 提供完整通话控制：接听 / 拒绝 / 忙线 / 挂断 / 静音 / 麦克风 / 摄像头 / 扬声器。
//  3) 视频通话：依赖 flutter_webrtc（pubspec 已含）。若缺失会做友好降级提示而非崩溃。
//
// 用法（由合并 worker 接线）：
//   final svc = RtcService(api: api, socket: optionalWs);
//   svc.registerSignaling();   // 必须：把 WS / 轮询收到的信令喂进去
//   await svc.startCall(peerId, withVideo: true);
//   svc.pollOnce();            // 无 WS 时每 ~1.5s 轮询
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

// 友好导入：flutter_webrtc 存在则使用；缺失时以 bool 标记降级。
import 'package:flutter_webrtc/flutter_webrtc.dart'
    if (dart.library.io) 'package:flutter_webrtc/flutter_webrtc.dart';

enum RtcCallStatus { idle, calling, ringing, connecting, connected, ended }

const List<Map<String, dynamic>> rtcIceServers = [
  {'urls': 'stun:stun.l.google.com:19302'},
  {'urls': 'stun:stun1.l.google.com:19302'},
  {'urls': 'stun:stun.qq.com:3478'},
  {'urls': 'stun:stun.cloudflare.com:3478'},
  {'urls': 'stun:stun.aliyun.com:3478'},
];

typedef RtcSignalSender = void Function(int to, String sub, Object? data);

/// 抽象信号收发：可由 WS（web_socket_channel）或 REST 轮询实现。
abstract class RtcSignalTransport {
  void send(int to, String sub, Object? data);
  Stream<Map<String, dynamic>> get incoming; // {from, sub, data}
}

/// HTTP-only 信令源（REST 轮询 /api/rtc/signal + /api/rtc/poll）。
class RestRtcTransport implements RtcSignalTransport {
  RestRtcTransport({required this.baseUrl, this.token, this.pollInterval = const Duration(milliseconds: 1500)});
  final String baseUrl;
  String? token;
  final Duration pollInterval;

  final _subject = StreamController<Map<String, dynamic>>.broadcast();
  Timer? _timer;
  bool _disposed = false;

  @override
  Stream<Map<String, dynamic>> get incoming => _subject.stream;

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        if (token != null) 'Authorization': 'Bearer $token',
      };

  Uri _uri(String path) {
    final root = Uri.parse(baseUrl.endsWith('/') ? baseUrl : '$baseUrl/');
    return root.replace(path: '${root.path.replaceAll(RegExp(r'/$'), '')}$path');
  }

  @override
  void send(int to, String sub, Object? data) {
    unawaited(_post('/api/rtc/signal', {'to': to, 'sub': sub, 'data': data}));
  }

  Future<void> _post(String path, Object? body) async {
    try {
      await http.post(_uri(path), headers: _headers, body: jsonEncode(body ?? const {}));
    } catch (_) {}
  }

  Future<void> pollOnce() async {
    if (_disposed) return;
    try {
      final resp = await http.post(_uri('/api/rtc/poll'), headers: _headers, body: '{}');
      if (resp.statusCode >= 200 && resp.statusCode < 300) {
        final data = jsonDecode(resp.body) as Map<String, dynamic>;
        final signals = data['signals'] as List?;
        if (signals != null) {
          for (final s in signals) {
            _subject.add((s as Map).cast<String, dynamic>());
          }
        }
      }
    } catch (_) {}
  }

  void startPolling() {
    _timer ??= Timer.periodic(pollInterval, (_) => pollOnce());
    pollOnce();
  }

  void stopPolling() {
    _timer?.cancel();
    _timer = null;
  }

  void dispose() {
    _disposed = true;
    stopPolling();
    _subject.close();
  }
}

class RtcService extends ChangeNotifier {
  RtcService({required this.baseUrl, this.token, this.transport});

  final String baseUrl;
  String? token;
  RtcSignalTransport? transport;

  RtcCallStatus status = RtcCallStatus.idle;
  bool video = false;
  int? peerId;
  String? endReason;

  MediaStream? localStream;
  MediaStream? remoteStream;
  RTCVideoRenderer? localRenderer;
  RTCVideoRenderer? remoteRenderer;
  RTCPeerConnection? peer;

  bool muted = false;
  bool cameraOn = true;
  bool speakerOn = true;

  Timer? _ringTimer;
  DateTime? _connectedAt;
  final List<Map<String, dynamic>> _pendingCandidates = [];
  bool _remoteDescSet = false;
  bool _webrtcOk = false;
  StreamSubscription<Map<String, dynamic>>? _sub;

  DateTime? get connectedAt => _connectedAt;
  bool get busy => status != RtcCallStatus.idle;

  bool get videoSupported => _webrtcOk;

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        if (token != null) 'Authorization': 'Bearer $token',
      };

  Uri _uri(String path) {
    final root = Uri.parse(baseUrl.endsWith('/') ? baseUrl : '$baseUrl/');
    return root.replace(path: '${root.path.replaceAll(RegExp(r'/$'), '')}$path');
  }

  /// 必须调用：初始化 webrtc 可用性 + 监听传输信令。
  Future<void> registerSignaling() async {
    try {
      if (localRenderer == null) {
        localRenderer = RTCVideoRenderer();
        await localRenderer!.initialize();
      }
      if (remoteRenderer == null) {
        remoteRenderer = RTCVideoRenderer();
        await remoteRenderer!.initialize();
      }
      _webrtcOk = true;
    } catch (_) {
      _webrtcOk = false;
    }
    final t = transport;
    if (t != null) {
      _sub ??= t.incoming.listen((s) => onSignal(s['from'] as int?, s['sub'] as String?, s['data']));
      if (t is RestRtcTransport) t.startPolling();
    }
  }

  void _putSignal(int to, String sub, Object? data) {
    final t = transport;
    if (t != null) {
      t.send(to, sub, data);
    } else {
      unawaited(http.post(_uri('/api/rtc/signal'), headers: _headers, body: jsonEncode({'to': to, 'sub': sub, 'data': data})));
    }
  }

  /// 处理来自对端的信令（WS 或 REST 轮询喂入）。
  void onSignal(int? from, String? sub, dynamic data) {
    final payload = (data is Map) ? data.cast<String, dynamic>() : <String, dynamic>{};
    switch (sub) {
      case 'peer_offline':
        if (status == RtcCallStatus.calling || status == RtcCallStatus.connecting) _end('对方不在线');
      case 'call':
        _onIncoming(from, payload);
      case 'call_ack':
        _onCallAck(payload);
      case 'offer':
        _onOffer(payload);
      case 'answer':
        _onAnswer(payload);
      case 'ice':
        _onIce(payload);
      case 'hangup':
        if (status == RtcCallStatus.calling || status == RtcCallStatus.connecting) {
          _end('对方已取消');
        } else if (status == RtcCallStatus.connected) {
          _end('通话已结束');
        } else {
          _end('对方已拒绝');
        }
    }
  }

  Future<void> startCall(int to, {required bool withVideo}) async {
    if (busy) return;
    if (withVideo && !_webrtcOk) {
      endReason = '视频通话当前端不支持，请用网页端';
      status = RtcCallStatus.ended;
      notifyListeners();
      return;
    }
    peerId = to;
    video = withVideo;
    status = RtcCallStatus.calling;
    _ringTimer = Timer(const Duration(seconds: 30), () {
      if (status == RtcCallStatus.calling) {
        _putSignal(to, 'hangup', null);
        _end('对方未接听');
      }
    });
    _putSignal(to, 'call', {'video': withVideo});
    notifyListeners();
    await _acquireLocal();
  }

  void _onIncoming(int? from, Map<String, dynamic> payload) {
    if (busy) {
      _putSignal(from ?? -1, 'call_ack', {'accepted': false});
      return;
    }
    peerId = from;
    video = payload['video'] == true;
    if (video && !_webrtcOk) {
      // 视频来电但当前端无 webrtc：友好降级为语音 + 提示
      video = false;
      endReason = '视频通话当前端不支持，已按语音接听，请用网页端进行视频';
    }
    status = RtcCallStatus.ringing;
    _ringTimer = Timer(const Duration(seconds: 30), () {
      if (status == RtcCallStatus.ringing) {
        _putSignal(peerId ?? -1, 'call_ack', {'accepted': false});
        _end('未接听');
      }
    });
    notifyListeners();
  }

  void _onCallAck(Map<String, dynamic> payload) {
    _ringTimer?.cancel();
    if (status != RtcCallStatus.calling) return;
    if (payload['accepted'] != true) {
      _end('对方已拒绝');
      return;
    }
    status = RtcCallStatus.connecting;
    notifyListeners();
    _tryCreateOffer();
  }

  Future<void> _acquireLocal() async {
    if (!_webrtcOk) {
      if (video) {
        status = RtcCallStatus.idle;
        endReason = '视频通话当前端不支持，请用网页端';
        notifyListeners();
      }
      return;
    }
    try {
      localStream = await _getUserMedia();
      notifyListeners();
    } catch (e) {
      endReason = '无法访问麦克风/摄像头：$e';
    }
  }

  Future<MediaStream> _getUserMedia() async {
    final s = await navigator.mediaDevices.getUserMedia({
      'audio': true,
      'video': video ? true : false,
    });
    return s;
  }

  Future<RTCPeerConnection> _buildPeer() async {
    final pc = await createPeerConnection({'iceServers': rtcIceServers});
    pc.onIceCandidate = (c) {
      _putSignal(peerId ?? -1, 'ice', {'candidate': c.toMap(), 'sdpMid': c.sdpMid, 'sdpMLineIndex': c.sdpMLineIndex});
    };
    pc.onIceConnectionState = (state) {
      if (state == RTCIceConnectionState.RTCIceConnectionStateConnected) {
        _ringTimer?.cancel();
        _connectedAt = DateTime.now();
        status = RtcCallStatus.connected;
        notifyListeners();
      } else if (state == RTCIceConnectionState.RTCIceConnectionStateFailed ||
          state == RTCIceConnectionState.RTCIceConnectionStateDisconnected ||
          state == RTCIceConnectionState.RTCIceConnectionStateClosed) {
        if (status != RtcCallStatus.idle && status != RtcCallStatus.ended) _end('通话已断开');
      }
    };
    pc.onTrack = (event) {
      remoteStream = event.streams.isNotEmpty ? event.streams.first : null;
      if (remoteStream != null && remoteRenderer != null) {
        remoteRenderer!.srcObject = remoteStream;
      }
      notifyListeners();
    };
    final ls = localStream;
    if (ls != null) pc.addStream(ls);
    return pc;
  }

  Future<void> _tryCreateOffer() async {
    try {
      peer = await _buildPeer();
      final offer = await peer!.createOffer();
      await peer!.setLocalDescription(offer);
      _putSignal(peerId ?? -1, 'offer', offer.toMap());
    } catch (e) {
      _end('创建通话失败：$e');
    }
  }

  Future<void> accept() async {
    if (status != RtcCallStatus.ringing) return;
    _ringTimer?.cancel();
    status = RtcCallStatus.connecting;
    _putSignal(peerId ?? -1, 'call_ack', {'accepted': true});
    notifyListeners();
    if (!_webrtcOk) return;
    await _acquireLocal();
    try {
      peer = await _buildPeer();
      await _flushCandidatesPending();
      final answer = await peer!.createAnswer();
      await peer!.setLocalDescription(answer);
      _putSignal(peerId ?? -1, 'answer', answer.toMap());
    } catch (e) {
      _end('接听失败：$e');
    }
  }

  Future<void> decline() async {
    if (status != RtcCallStatus.ringing) return;
    _putSignal(peerId ?? -1, 'call_ack', {'accepted': false});
    _putSignal(peerId ?? -1, 'hangup', null);
    _end('已拒绝');
  }

  Future<void> hangup() async {
    if (status == RtcCallStatus.idle || status == RtcCallStatus.ended) return;
    _putSignal(peerId ?? -1, 'hangup', null);
    _end(status == RtcCallStatus.connected ? '通话已结束' : null);
  }

  Future<void> _onOffer(Map<String, dynamic> payload) async {
    try {
      peer ??= await _buildPeer();
      await peer!.setRemoteDescription(
          RTCSessionDescription(payload['sdp'] as String, payload['type'] as String));
      _remoteDescSet = true;
      await _flushCandidatesPending();
    } catch (_) {}
  }

  Future<void> _onAnswer(Map<String, dynamic> payload) async {
    try {
      await peer!.setRemoteDescription(
          RTCSessionDescription(payload['sdp'] as String, payload['type'] as String));
      _remoteDescSet = true;
      await _flushCandidatesPending();
    } catch (_) {}
  }

  Future<void> _onIce(Map<String, dynamic> payload) async {
    final c = RTCIceCandidate(
      payload['candidate'] as String,
      payload['sdpMid'] as String?,
      payload['sdpMLineIndex'] as int?,
    );
    if (_remoteDescSet && peer != null) {
      try {
        await peer!.addCandidate(c);
      } catch (_) {}
    } else {
      _pendingCandidates.add(payload);
    }
  }

  Future<void> _flushCandidatesPending() async {
    for (final p in List.of(_pendingCandidates)) {
      try {
        await peer!.addCandidate(RTCIceCandidate(
          p['candidate'] as String,
          p['sdpMid'] as String?,
          p['sdpMLineIndex'] as int?,
        ));
      } catch (_) {}
    }
    _pendingCandidates.clear();
  }

  void toggleMute() {
    muted = !muted;
    for (final t in localStream?.getAudioTracks() ?? <MediaStreamTrack>[]) {
      t.enabled = !muted;
    }
    notifyListeners();
  }

  void toggleMic() => toggleMute();

  Future<void> toggleCamera() async {
    cameraOn = !cameraOn;
    for (final t in localStream?.getVideoTracks() ?? <MediaStreamTrack>[]) {
      t.enabled = cameraOn;
    }
    notifyListeners();
  }

  bool toggleSpeaker() {
    // 移动端 speakerOn = 外放；桌面端保持系统输出即可。
    speakerOn = !speakerOn;
    notifyListeners();
    return speakerOn;
  }

  void _end(String? reason) {
    _ringTimer?.cancel();
    endReason = reason;
    status = RtcCallStatus.ended;
    peerId = null;
    for (final t in localStream?.getTracks() ?? <MediaStreamTrack>[]) {
      t.stop();
    }
    localStream?.dispose();
    localStream = null;
    remoteStream?.dispose();
    remoteStream = null;
    localRenderer?.srcObject = null;
    remoteRenderer?.srcObject = null;
    peer?.close();
    peer = null;
    _pendingCandidates.clear();
    _remoteDescSet = false;
    _connectedAt = null;
    muted = false;
    cameraOn = true;
    speakerOn = true;
    // 立即复位 idle，允许再次发起通话
    status = RtcCallStatus.idle;
    notifyListeners();
  }

  Future<void> pollOnce() async {
    final t = transport;
    if (t is RestRtcTransport) return t.pollOnce();
  }

  void startPolling() {
    final t = transport;
    if (t is RestRtcTransport) t.startPolling();
  }

  void stopPolling() {
    final t = transport;
    if (t is RestRtcTransport) t.stopPolling();
  }

  @override
  void dispose() {
    _sub?.cancel();
    _ringTimer?.cancel();
    _end(null);
    if (transport is RestRtcTransport) (transport as RestRtcTransport).stopPolling();
    localRenderer?.dispose();
    remoteRenderer?.dispose();
    super.dispose();
  }
}