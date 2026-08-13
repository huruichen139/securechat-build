// module: moment-ext / status / favorites 服务 (worker batch7)
// Flutter 端统一服务：状态、朋友圈增强、收藏。自建 service，复用现有
// SecureChatApi 的 baseUrl / token 做带鉴权请求（与 media_api.dart 同风格）。
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'securechat_api.dart';

class MomentCollarService {
  MomentCollarService(this._api);

  final SecureChatApi _api;
  String get _base => _api.baseUrl.replaceAll(RegExp(r'/$'), '');

  Map<String, String> get _headers => {
        'Authorization': 'Bearer ${_api.token ?? ''}',
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
      http.get(_uri(path, q), headers: _headers).then(_decode);

  Future<Map<String, dynamic>> _post(String path, Map<String, dynamic> body) =>
      http.post(_uri(path), headers: _headers, body: jsonEncode(body)).then(_decode);

  Future<Map<String, dynamic>> _patch(String path, Map<String, dynamic> body) =>
      http.patch(_uri(path), headers: _headers, body: jsonEncode(body)).then(_decode);

  Future<Map<String, dynamic>> _delete(String path, [Map<String, String>? q]) =>
      http.delete(_uri(path, q), headers: _headers).then(_decode);

  // -------------------- 状态 --------------------
  Future<Map<String, dynamic>> statusFeed() => _get('/api/status/feed');

  Future<void> setStatus(String text, {String icon = '', String bgUrl = ''}) =>
      _post('/api/status', {'text': text, 'icon': icon, 'bgUrl': bgUrl});

  Future<void> clearStatus() => _delete('/api/status');

  Future<List<Map<String, dynamic>>> statusMessages(int userId) async {
    final d = await _get('/api/status/$userId/messages');
    return ((d['messages'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  Future<void> postStatusMessage(int userId, String content) =>
      _post('/api/status/$userId/message', {'content': content});

  // -------------------- 朋友圈增强 --------------------
  Future<Map<String, dynamic>> momentDetail(int id) => _get('/api/moments/ext/detail/$id');

  Future<void> replyMoment(int id, String content, {int? replyToId}) =>
      _post('/api/moments/ext/$id/reply', {'content': content, 'replyToId': replyToId});

  Future<int> momentRedDot() async {
    final d = await _get('/api/moments/ext/reddot');
    return (d['count'] as int?) ?? 0;
  }

  Future<void> markRedDotRead() => _post('/api/moments/ext/reddot/read', const {});

  Future<List<Map<String, dynamic>>> momentFilters() async {
    final d = await _get('/api/moments/filters');
    return ((d['filters'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  Future<void> setMomentFilter(int targetId, String mode) =>
      _post('/api/moments/filters/$targetId', {'mode': mode});

  Future<void> removeMomentFilter(int targetId) => _delete('/api/moments/filters/$targetId');

  Future<void> setMomentSource(int id, String source) =>
      _post('/api/moments/ext/$id/source', {'source': source});

  // -------------------- 好友（转发入聊目标） --------------------
  Future<List<Map<String, dynamic>>> friends() async {
    final d = await _get('/api/friends');
    return ((d['friends'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  // -------------------- 收藏 --------------------
  Future<List<Map<String, dynamic>>> classifiers() async {
    final d = await _get('/api/favorites/classifiers');
    return ((d['classifiers'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  Future<Map<String, dynamic>> createClassifier(String name, {String icon = '📁'}) =>
      _post('/api/favorites/classifiers', {'name': name, 'icon': icon});

  Future<void> renameClassifier(int id, String name) => _patch('/api/favorites/classifiers/$id', {'name': name});

  Future<void> deleteClassifier(int id) => _delete('/api/favorites/classifiers/$id');

  Future<List<String>> favoriteTags() async {
    final d = await _get('/api/favorites/tags');
    return ((d['tags'] as List?) ?? const []).map((t) => t.toString()).toList();
  }

  Future<Map<String, dynamic>> addFavoriteItem(
    String kind,
    Map<String, dynamic> data, {
    int? classifierId,
    List<String> tags = const [],
  }) =>
      _post('/api/favorites/items', {
        'kind': kind,
        'data': data,
        'classifierId': classifierId,
        'tags': tags,
      });

  Future<List<Map<String, dynamic>>> favoriteItems({
    int? classifierId,
    String tag = '',
    String q = '',
    int limit = 100,
  }) async {
    final query = <String, String>{
      'limit': '$limit',
      if (classifierId != null) 'classifierId': '$classifierId',
      if (tag.isNotEmpty) 'tag': tag,
      if (q.isNotEmpty) 'q': q,
    };
    final d = await _get('/api/favorites/items', query);
    return ((d['items'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  Future<void> organizeFavoriteItem(int id, {int? classifierId, List<String>? tags}) =>
      _patch('/api/favorites/items/$id', {
        if (classifierId != null) 'classifierId': classifierId,
        if (tags != null) 'tags': tags,
      });

  Future<void> deleteFavoriteItem(int id) => _delete('/api/favorites/items/$id');

  Future<Map<String, dynamic>> forwardFavoriteItem(int id, int to, {String? content}) =>
      _post('/api/favorites/items/$id/forward', {'to': to, if (content != null) 'content': content});
}