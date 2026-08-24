// module: voicemsg (worker batch3)
// 语音消息服务（Flutter 端，独立可编译）。
//
// 录制：用 record 包（pubspec 已含）录 m4a → 上传 /api/files → 发送 "[语音消息:id]"。
// 播放：用 audioplayers。
// 降级：若 record/audioplayers 在目标平台不可用（或编译期缺失时由主工程降级调用 file_transfer），
//        本服务提供基于文件上传的降级路径（startDegraded 直接用文件字节上传）。
// 依赖：record / audioplayers / http。
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:record/record.dart';
import 'package:audioplayers/audioplayers.dart';

enum VoicemsgStatus { idle, recording, ready, uploading, playing }

class VoicemsgService extends ChangeNotifier {
  VoicemsgService({required this.baseUrl, this.token});

  final String baseUrl;
  String? token;

  final AudioRecorder _recorder = AudioRecorder();
  AudioPlayer? _player;
  VoicemsgStatus status = VoicemsgStatus.idle;
  Duration duration = Duration.zero;
  String? lastFileId;
  String? lastLocalPath;
  Timer? _meter;
  String? endReason;

  bool get isRecording => status == VoicemsgStatus.recording;
  bool get isPlaying => status == VoicemsgStatus.playing;

  Map<String, String> get _headers => {
        if (token != null) 'Authorization': 'Bearer $token',
      };

  Uri _uri(String path, [Map<String, String>? q]) {
    final root = Uri.parse(baseUrl.endsWith('/') ? baseUrl : '$baseUrl/');
    return root.replace(path: '${root.path.replaceAll(RegExp(r'/$'), '')}$path', queryParameters: q);
  }

  Future<bool> hasPermission() => _recorder.hasPermission();

  /// 开始按住录音；返回 false 表示无可写权限/不支持。
  Future<bool> startRecording() async {
    if (status == VoicemsgStatus.recording) return true;
    try {
      if (!await _recorder.hasPermission()) {
        endReason = '需要麦克风权限';
        status = VoicemsgStatus.idle;
        notifyListeners();
        return false;
      }
      final dir = Directory.systemTemp;
      await dir.create(recursive: true);
      final target = '${dir.path}/securechat-${DateTime.now().millisecondsSinceEpoch}.m4a';
      lastLocalPath = target;
      await _recorder.start(
        const RecordConfig(encoder: AudioEncoder.aacLc, bitRate: 64000, sampleRate: 44100),
        path: target,
      );
      status = VoicemsgStatus.recording;
      _startMeter();
      return true;
    } catch (e) {
      endReason = '无法开始录音：$e';
      status = VoicemsgStatus.idle;
      notifyListeners();
      return false;
    }
  }

  void _startMeter() {
    duration = Duration.zero;
    _meter = Timer.periodic(const Duration(milliseconds: 300), (_) {
      if (status == VoicemsgStatus.recording) {
        duration = duration + const Duration(milliseconds: 300);
        notifyListeners();
      }
    });
  }

  /// 停止录音：返回 true 表示得到了待发送的音频；false 表示过短/取消。
  Future<bool> stopRecording({bool cancel = false}) async {
    if (status != VoicemsgStatus.recording) return false;
    _meter?.cancel();
    _meter = null;
    final wasDuration = duration;
    status = VoicemsgStatus.idle;
    notifyListeners();
    try {
      final path = await _recorder.stop();
      if (cancel || path == null) {
        endReason = cancel ? '已取消发送' : '未录到声音';
        status = VoicemsgStatus.idle;
        notifyListeners();
        return false;
      }
      if (wasDuration.inMilliseconds < 500) {
        endReason = '说话时间过短';
        status = VoicemsgStatus.idle;
        notifyListeners();
        return false;
      }
      lastLocalPath = path;
      duration = wasDuration;
      status = VoicemsgStatus.ready;
      notifyListeners();
      return true;
    } catch (e) {
      endReason = '录音停止失败：$e';
      status = VoicemsgStatus.idle;
      notifyListeners();
      return false;
    }
  }

  /// 上传刚录好的音频并返回 file id（调用方据此发送 "[语音消息:id]"）。
  Future<String?> uploadAndGetId(int to) async {
    final path = lastLocalPath;
    if (path == null || !File(path).existsSync()) {
      endReason = '请先录音';
      status = VoicemsgStatus.idle;
      notifyListeners();
      return null;
    }
    final bytes = await File(path).readAsBytes();
    return uploadBytes(to, bytes, 'voice-${DateTime.now().millisecondsSinceEpoch}.m4a');
  }

  /// 把任意音频字节上传到 /api/files，返回 {id}；失败返回 null。
  Future<String?> uploadBytes(int to, List<int> bytes, String name) async {
    status = VoicemsgStatus.uploading;
    notifyListeners();
    try {
      final resp = await http.post(
        _uri('/api/files', {'to': '$to', 'name': name, 'mime': 'audio/m4a'}),
        headers: _headers,
        body: bytes,
      );
      if (resp.statusCode < 200 || resp.statusCode >= 300) {
        final err = _tryDecodeErr(resp.body, '语音上传失败');
        throw StateError(err);
      }
      final data = _jsonDecode(resp.body);
      lastFileId = data['id'] as String?;
      status = VoicemsgStatus.ready;
      notifyListeners();
      return lastFileId;
    } catch (e) {
      endReason = e.toString().replaceFirst('Bad state: ', '');
      status = VoicemsgStatus.idle;
      notifyListeners();
      return null;
    }
  }

  /// 播放一条语音（content 形如 "[语音消息:<id>]" 或直接 URL）。
  Future<void> playVoice(Object content) async {
    final id = _extractId(content);
    if (id == null) return;
    final data = await _fetchBytes('/api/files/$id');
    if (data == null) return;
    final path = await _writeTemp('voice-${DateTime.now().millisecondsSinceEpoch}.m4a', data);
    await playLocal(path);
  }

  Future<void> playLocal(String path) async {
    try {
      _player ??= AudioPlayer();
      await _player!.stop();
      await _player!.play(DeviceFileSource(path));
      status = VoicemsgStatus.playing;
      notifyListeners();
      _player!.onPlayerComplete.first.then((_) {
        status = VoicemsgStatus.ready;
        notifyListeners();
      });
    } catch (e) {
      endReason = '播放失败：$e';
      status = VoicemsgStatus.idle;
      notifyListeners();
    }
  }

  Future<void> stopPlayback() async {
    try {
      await _player?.stop();
      status = VoicemsgStatus.ready;
      notifyListeners();
    } catch (_) {}
  }

  Future<Uint8List?> _fetchBytes(String path) async {
    try {
      final resp = await http.get(_uri(path), headers: _headers);
      if (resp.statusCode >= 200 && resp.statusCode < 300) return resp.bodyBytes;
    } catch (_) {}
    return null;
  }

  Future<String> _writeTemp(String name, List<int> bytes) async {
    final dir = Directory.systemTemp;
    await dir.create(recursive: true);
    final f = File('${dir.path}/$name');
    await f.writeAsBytes(bytes);
    return f.path;
  }

  String? _extractId(Object content) {
    final s = content.toString();
    final m = RegExp(r'^\[语音消息:([0-9a-f-]{8,})\]$').firstMatch(s);
    if (m != null) return m[1];
    return null;
  }

  String _tryDecodeErr(String body, String fallback) {
    try {
      final d = _jsonDecode(body);
      return (d['error'] ?? fallback).toString();
    } catch (_) {
      return fallback;
    }
  }

  Map<String, dynamic> _jsonDecode(String body) {
    final d = jsonDecode(body);
    return (d is Map) ? Map<String, dynamic>.from(d) : <String, dynamic>{};
  }

  @override
  void dispose() {
    _meter?.cancel();
    if (isRecording) {
      try { _recorder.stop(); } catch (_) {}
      status = VoicemsgStatus.idle;
    }
    _player?.dispose();
    _recorder.dispose();
    super.dispose();
  }
}