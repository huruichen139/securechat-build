import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

enum CallStatus { idle, calling, ringing, connecting, connected, ended }

const _iceServers = [
  {'urls': 'stun:stun.l.google.com:19302'},
  {'urls': 'stun:stun1.l.google.com:19302'},
];

class CallService extends ChangeNotifier {
  CallService({required this.socket});

  final WebSocketChannel socket;

  CallStatus status = CallStatus.idle;
  bool video = false;
  int? peerId;
  String? endReason;

  MediaStream? localStream;
  MediaStream? remoteStream;
  final RTCVideoRenderer localRenderer = RTCVideoRenderer();
  final RTCVideoRenderer remoteRenderer = RTCVideoRenderer();
  RTCPeerConnection? peer;

  bool muted = false;
  bool cameraOn = true;

  Timer? _ringTimer;
  Timer? _disconnectTimer;
  bool _remoteDescSet = false;
  final List<RTCIceCandidate> _pendingCandidates = [];
  DateTime? _connectedAt;

  DateTime? get connectedAt => _connectedAt;

  bool get busy => status != CallStatus.idle;

  bool _disposed = false;

  void _send(String sub, [Object? data]) {
    final to = peerId;
    if (to == null) return;
    socket.sink.add(jsonEncode({'type': 'signal', 'payload': {'to': to, 'sub': sub, 'data': data}}));
  }

  void onSignal(int? from, String? sub, dynamic data) {
    if (sub == 'peer_offline') {
      if (status == CallStatus.calling || status == CallStatus.connecting) _end('对方不在线');
      return;
    }
    // 除来电(call)外，其余信号必须来自当前通话对端，否则拒绝（防第三方伪造 hangup/answer 等）
    if (sub != 'call' && peerId != null && from != peerId) return;
    final payload = (data is Map) ? data.cast<String, dynamic>() : <String, dynamic>{};
    switch (sub) {
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
        if (status == CallStatus.calling || status == CallStatus.connecting) {
          _end('对方已取消');
        } else if (status == CallStatus.connected) {
          _end('通话已结束');
        } else {
          _end('对方已拒绝');
        }
    }
  }

  void _onIncoming(int? from, Map<String, dynamic> payload) {
    if (busy) {
      _send('call_ack', {'accepted': false});
      return;
    }
    peerId = from;
    video = payload['video'] == true;
    status = CallStatus.ringing;
    _ringTimer = Timer(const Duration(seconds: 30), () {
      if (status == CallStatus.ringing) {
        _send('call_ack', {'accepted': false});
        _end('未接听');
      }
    });
    notifyListeners();
  }

  void _onCallAck(Map<String, dynamic> payload) {
    _ringTimer?.cancel();
    if (status != CallStatus.calling) return;
    if (payload['accepted'] != true) {
      _end('对方已拒绝');
      return;
    }
    status = CallStatus.connecting;
    notifyListeners();
    _setupPeer().then((_) => _createAndSendOffer());
  }

  Future<void> _createAndSendOffer() async {
    try {
      final p = peer;
      if (p == null) return;
      final offer = await p.createOffer();
      await p.setLocalDescription(offer);
      _send('offer', offer.toMap());
    } catch (_) {}
  }

  Future<void> _setupPeer() async {
    try {
      peer = await createPeerConnection({'iceServers': _iceServers});
      peer!.onIceCandidate = (c) => _send('ice', {'candidate': c.toMap(), 'sdpMid': c.sdpMid, 'sdpMLineIndex': c.sdpMLineIndex});
      peer!.onIceConnectionState = (state) {
        if (state == RTCIceConnectionState.RTCIceConnectionStateConnected) {
          _ringTimer?.cancel();
          _connectedAt = DateTime.now();
          status = CallStatus.connected;
          notifyListeners();
        } else if (state == RTCIceConnectionState.RTCIceConnectionStateFailed ||
            state == RTCIceConnectionState.RTCIceConnectionStateClosed) {
          if (status != CallStatus.idle && status != CallStatus.ended) _end('通话已断开');
        } else if (state == RTCIceConnectionState.RTCIceConnectionStateDisconnected) {
          // 网络抖动会导致短暂 Disconnected，先给宽限期，避免误挂断
          _disconnectTimer?.cancel();
          _disconnectTimer = Timer(const Duration(seconds: 8), () {
            if (status != CallStatus.idle && status != CallStatus.ended && status == CallStatus.connected) {
              _end('通话已断开');
            }
          });
        } else if (state == RTCIceConnectionState.RTCIceConnectionStateConnected) {
          _disconnectTimer?.cancel();
        }
      };
      peer!.onTrack = (event) {
        remoteStream = event.streams.isNotEmpty ? event.streams.first : null;
        if (remoteStream != null) {
          remoteRenderer.srcObject = remoteStream;
        }
        notifyListeners();
      };
      localStream = await navigator.mediaDevices.getUserMedia({'audio': true, 'video': video});
      if (video) {
        await localRenderer.initialize();
        localRenderer.srcObject = localStream;
      }
      peer!.addStream(localStream!);
      notifyListeners();
    } catch (e) {
      _end('无法访问麦克风/摄像头：$e');
    }
  }

  Future<void> startCall(int to, {required bool withVideo}) async {
    if (busy) return;
    peerId = to;
    video = withVideo;
    status = CallStatus.calling;
    _ringTimer = Timer(const Duration(seconds: 30), () {
      if (status == CallStatus.calling) {
        _send('hangup', null);
        _end('对方未接听');
      }
    });
    _send('call', {'video': withVideo});
    notifyListeners();
  }

  Future<void> accept() async {
    if (status != CallStatus.ringing) return;
    _ringTimer?.cancel();
    status = CallStatus.connecting;
    _send('call_ack', {'accepted': true});
    notifyListeners();
    await _setupPeer();
  }

  Future<void> decline() async {
    if (status != CallStatus.ringing) return;
    _send('call_ack', {'accepted': false});
    _end('已拒绝');
  }

  void hangup() {
    if (status == CallStatus.idle || status == CallStatus.ended) return;
    _send('hangup', null);
    _end(status == CallStatus.connected ? '通话已结束' : null);
  }

  Future<void> _onOffer(Map<String, dynamic> payload) async {
    try {
      if (peer == null) await _setupPeer();
      if (peer == null) return;
      await peer!.setRemoteDescription(RTCSessionDescription(payload['sdp'] as String, payload['type'] as String));
      _remoteDescSet = true;
      await _flushCandidates();
      final answer = await peer!.createAnswer();
      await peer!.setLocalDescription(answer);
      _send('answer', answer.toMap());
    } catch (_) {}
  }

  Future<void> _onAnswer(Map<String, dynamic> payload) async {
    try {
      await peer!.setRemoteDescription(RTCSessionDescription(payload['sdp'] as String, payload['type'] as String));
      _remoteDescSet = true;
      await _flushCandidates();
    } catch (_) {}
  }

  Future<void> _onIce(Map<String, dynamic> payload) async {
    final candidate = RTCIceCandidate(payload['candidate'] as String, payload['sdpMid'] as String?, payload['sdpMLineIndex'] as int?);
    if (_remoteDescSet) {
      try {
        await peer?.addCandidate(candidate);
      } catch (_) {}
    } else {
      _pendingCandidates.add(candidate);
    }
  }

  Future<void> _flushCandidates() async {
    final peer = this.peer;
    if (peer == null) return;
    for (final c in List.of(_pendingCandidates)) {
      try {
        await peer.addCandidate(c);
      } catch (_) {}
    }
    _pendingCandidates.clear();
  }

  void toggleMute() {
    muted = !muted;
    for (final track in localStream?.getAudioTracks() ?? <MediaStreamTrack>[]) {
      track.enabled = !muted;
    }
    notifyListeners();
  }

  Future<void> toggleCamera() async {
    cameraOn = !cameraOn;
    for (final track in localStream?.getVideoTracks() ?? <MediaStreamTrack>[]) {
      track.enabled = cameraOn;
    }
    notifyListeners();
  }

  void _end(String? reason) {
    _ringTimer?.cancel();
    _disconnectTimer?.cancel();
    endReason = reason;
    status = CallStatus.ended;
    peerId = null;
    try {
      for (final track in localStream?.getTracks() ?? <MediaStreamTrack>[]) {
        try { track.stop(); } catch (_) {}
      }
      try { localStream?.dispose(); } catch (_) {}
      localStream = null;
      try { remoteStream?.dispose(); } catch (_) {}
      remoteStream = null;
      try { localRenderer.srcObject = null; } catch (_) {}
      try { remoteRenderer.srcObject = null; } catch (_) {}
      if (!_disposed) {
        try { localRenderer.dispose(); } catch (_) {}
        try { remoteRenderer.dispose(); } catch (_) {}
      }
      try { peer?.close(); } catch (_) {}
      peer = null;
      _pendingCandidates.clear();
      _remoteDescSet = false;
      _connectedAt = null;
      muted = false;
      cameraOn = true;
    } catch (_) {}
    if (!_disposed) {
      status = CallStatus.idle;
      notifyListeners();
    }
  }

  @override
  void dispose() {
    _ringTimer?.cancel();
    try { localRenderer.dispose(); } catch (_) {}
    try { remoteRenderer.dispose(); } catch (_) {}
    _disposed = true;
    _end(null);
    super.dispose();
  }
}
