// module: lifestyle_api (worker batch5) —— 小程序开放平台 / 附近的人 / 摇一摇 / 扫一扫 的轻量服务
// 复用现有 SecureChatApi 的 baseUrl/token；端点见 server/routes/lifestyle.js。
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'securechat_api.dart';

class LifestyleService {
  LifestyleService(this.api);
  final SecureChatApi api;

  String get _base => api.baseUrl.replaceAll(RegExp(r'/$'), '');
  String get _token => api.token ?? '';

  Map<String, String> _headers() => {
        'Authorization': 'Bearer $_token',
        'Content-Type': 'application/json',
      };

  Uri _uri(String path, [Map<String, String>? query]) {
    final u = Uri.parse('$_base$path');
    return u.replace(queryParameters: query);
  }

  Map<String, dynamic> _decode(http.Response r) {
    Map<String, dynamic> data;
    try {
      data = jsonDecode(r.body) as Map<String, dynamic>;
    } catch (_) {
      data = {'error': r.body};
    }
    if (r.statusCode < 200 || r.statusCode >= 300) {
      throw StateError(data['error']?.toString() ?? '请求失败 (${r.statusCode})');
    }
    return data;
  }

  Future<Map<String, dynamic>> _get(String path, [Map<String, String>? q]) =>
      http.get(_uri(path, q), headers: _headers()).then(_decode);

  Future<Map<String, dynamic>> _post(String path, [Map<String, dynamic>? body]) =>
      http.post(_uri(path), headers: _headers(), body: jsonEncode(body ?? const {})).then(_decode);

  // ---------- 小程序 ----------
  Future<Map<String, dynamic>> publishMiniApp(String name, String url, {String icon = '', String description = ''}) async {
    final d = await _post('/api/mini-program/publish', {'name': name, 'url': url, 'icon': icon, 'description': description});
    return (d['program'] as Map?)?.cast<String, dynamic>() ?? {};
  }

  Future<List<Map<String, dynamic>>> miniPrograms() async {
    final d = await _get('/api/mini-program/list');
    return ((d['programs'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  Future<List<Map<String, dynamic>>> searchMiniPrograms(String q) async {
    final d = await _get('/api/mini-program/search', {'q': q});
    return ((d['programs'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  Future<List<Map<String, dynamic>>> recentMiniPrograms() async {
    final d = await _get('/api/mini-program/me/recent');
    return ((d['programs'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  Future<List<Map<String, dynamic>>> favoriteMiniPrograms() async {
    final d = await _get('/api/mini-program/me/favorites');
    return ((d['programs'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  Future<void> favoriteMiniProgram(int id, {bool on = true}) async {
    await _post('/api/mini-program/$id/favorite', {'on': on});
  }

  Future<Map<String, dynamic>> openMiniProgram(int id) async {
    final d = await _get('/api/mini-program/$id');
    return ((d['program'] as Map?)?.cast<String, dynamic>() ?? {});
  }

  // ---------- 附近的人 ----------
  Future<Map<String, dynamic>> setNearby({String city = '', String region = ''}) async {
    return _post('/api/nearby/set', {'city': city, 'region': region});
  }

  Future<Map<String, dynamic>> nearbyData() async {
    return _get('/api/nearby/list');
  }

  Future<List<Map<String, dynamic>>> nearbyPeople() async {
    final d = await _get('/api/nearby/list');
    final list = ((d['people'] as List?) ?? const []).cast<Map<String, dynamic>>();
    return list;
  }

  Future<Map<String, dynamic>> nearbyHello(int userId) async {
    return _post('/api/nearby/$userId/hello', const {});
  }

  // ---------- 摇一摇 ----------
  Future<Map<String, dynamic>> shakeStart() async {
    return _post('/api/shake/start', const {});
  }

  Future<List<Map<String, dynamic>>> shakeMatches() async {
    final d = await _get('/api/shake/matches');
    return ((d['matches'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  Future<void> shakeStop() async {
    await _post('/api/shake/stop', const {});
  }

  Future<Map<String, dynamic>> shakeHello(int userId) async {
    return _post('/api/shake/$userId/hello', const {});
  }

  int toInt(dynamic v) => v is int ? v : int.tryParse('$v') ?? 0;
  String str(dynamic v) => (v ?? '').toString();
}
