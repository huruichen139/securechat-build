// module: groups (worker batch1)
// 群聊体系 Flutter 服务层（独立文件，不修改 securechat_api.dart）。
// 复用 SecureChatApi 的公共字段 baseUrl / token / myId 发起 HTTP，自带鉴权头。
// 群相关 REST 走 /api/groups/*（新管理端点），历史消息走 /api/groups/:id/messages。
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'securechat_api.dart';

class GroupService {
  GroupService(this._api);
  final SecureChatApi _api;

  String get _baseUrl => _api.baseUrl.endsWith('/') ? _api.baseUrl.substring(0, _api.baseUrl.length - 1) : _api.baseUrl;
  String? get _token => _api.token;

  Uri _uri(String path, [Map<String, String>? query]) {
    final root = Uri.parse(_baseUrl.endsWith('/') ? _baseUrl : '$_baseUrl/');
    return root.replace(
      path: '${root.path.replaceAll(RegExp(r'/$'), '')}$path',
      queryParameters: query,
    );
  }

  Map<String, String> get _jsonHeaders => {
        'Content-Type': 'application/json',
        if (_token != null) 'Authorization': 'Bearer $_token',
      };

  Map<String, String> get _octetHeaders => {
        if (_token != null) 'Authorization': 'Bearer $_token',
      };

  // 丢弃键值为 null 的项（后续请求体 compact）
  Map<String, dynamic> _compact(Map<String, dynamic> body) {
    final out = <String, dynamic>{};
    body.forEach((k, v) { if (v != null) out[k] = v; });
    return out;
  }

  Future<Map<String, dynamic>> _json(String method, String path, {Object? body, Map<String, String>? query}) async {
    final headers = _jsonHeaders;
    final uri = _uri(path, query);
    http.Response resp;
    switch (method) {
      case 'POST':
        resp = await http.post(uri, headers: headers, body: jsonEncode(body ?? const {}));
        break;
      case 'DELETE':
        resp = await http.delete(uri, headers: headers);
        break;
      default:
        resp = await http.get(uri, headers: headers);
    }
    Map<String, dynamic> data;
    try {
      data = jsonDecode(resp.body) as Map<String, dynamic>;
    } catch (_) {
      data = {'error': resp.body};
    }
    if (resp.statusCode < 200 || resp.statusCode >= 300) {
      throw StateError(data['error']?.toString() ?? '请求失败 (${resp.statusCode})');
    }
    return data;
  }

  // ---------- 群管理 ----------
  Future<List<Map<String, dynamic>>> listGroups() async {
    final d = await _json('GET', '/api/groups/enhanced');
    return ((d['groups'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  Future<Map<String, dynamic>> groupDetail(int groupId) async {
    return _json('GET', '/api/groups/$groupId');
  }

  Future<Map<String, dynamic>> createGroup(String name, List<String> friendUids) async {
    return _json('POST', '/api/groups', body: {'name': name, 'uids': friendUids});
  }

  Future<Map<String, dynamic>> invite(int groupId, List<String> uids) async {
    return _json('POST', '/api/groups/$groupId/invite', body: {'uids': uids});
  }

  Future<void> removeMember(int groupId, int userId) async {
    await _json('POST', '/api/groups/$groupId/remove', body: {'userId': userId});
  }

  Future<void> leave(int groupId) async {
    await _json('POST', '/api/groups/$groupId/leave', body: const {});
  }

  Future<void> dissolve(int groupId) async {
    await _json('POST', '/api/groups/$groupId/dissolve', body: const {});
  }

  Future<Map<String, dynamic>> setAnnouncement(int groupId, String content) async {
    return _json('POST', '/api/groups/$groupId/announcement', body: {'content': content});
  }

  Future<void> pinAnnouncement(int groupId, {bool on = true}) async {
    await _json('POST', '/api/groups/$groupId/announcement/pin', body: {'on': on});
  }

  Future<Map<String, dynamic>> setSettings(int groupId, {bool? muted, String? note, String? nickname}) async {
    return _json('POST', '/api/groups/$groupId/settings', body: _compact({
      'muted': muted,
      'note': note,
      'nickname': nickname,
    }));
  }

  Future<void> setNickname(int groupId, String nickname) async {
    await _json('POST', '/api/groups/$groupId/nickname', body: {'nickname': nickname});
  }

  Future<List<Map<String, dynamic>>> members(int groupId) async {
    final d = await _json('GET', '/api/groups/$groupId/members');
    return ((d['members'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  // ---------- 群消息 ----------
  Future<List<Map<String, dynamic>>> history(int groupId) async {
    final d = await _json('GET', '/api/groups/$groupId/messages');
    return ((d['messages'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  Future<Map<String, dynamic>> sendMessage(int groupId, String content, {String? clientMsgId}) async {
    return _json('POST', '/api/groups/$groupId/messages', body: _compact({
      'content': content,
      'clientMsgId': clientMsgId,
    }));
  }

  // ---------- 群文件 ----------
  Future<List<Map<String, dynamic>>> fileList(int groupId) async {
    final d = await _json('GET', '/api/groups/$groupId/files');
    return ((d['files'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  Uri fileUri(String fileId) => _uri('/api/group-files/$fileId');

  Future<Map<String, dynamic>> uploadFile(int groupId, List<int> bytes, String name, {String mime = 'application/octet-stream', String? path}) async {
    final uri = _uri('/api/groups/$groupId/files', {
      'name': path != null ? (path.split('/').isNotEmpty ? path.split('/').last : name) : name,
      'mime': mime,
    });
    final resp = await http.post(uri, headers: _octetHeaders, body: bytes);
    Map<String, dynamic> data;
    try { data = jsonDecode(resp.body) as Map<String, dynamic>; } catch (_) { data = {'error': resp.body}; }
    if (resp.statusCode < 200 || resp.statusCode >= 300) {
      throw StateError(data['error']?.toString() ?? '上传失败 (${resp.statusCode})');
    }
    return data;
  }

  Future<List<int>> fetchFile(String fileId) async {
    final uri = _uri('/api/group-files/$fileId');
    final resp = await http.get(uri, headers: _octetHeaders);
    if (resp.statusCode < 200 || resp.statusCode >= 300) {
      throw StateError('文件获取失败 (${resp.statusCode})');
    }
    return resp.bodyBytes;
  }

  Future<void> deleteFile(int groupId, String fileId) async {
    await _json('DELETE', '/api/groups/$groupId/files/$fileId');
  }

  // ---------- 群消息置顶 ----------
  Future<void> pinMessage(int groupId, int messageId, {bool pinned = true}) async {
    await _json('POST', '/api/groups/$groupId/messages/$messageId/pin', body: {'pinned': pinned});
  }

  // ---------- 群消息引用回复 ----------
  Future<void> replyMessage(int groupId, int messageId, {int? replyTo}) async {
    await _json('POST', '/api/groups/$groupId/messages/$messageId/reply', body: {'replyTo': replyTo});
  }

  // ---------- 好友可邀请列表（用于建群选人）----------
  Future<List<Map<String, dynamic>>> friendPool() async {
    final uri = _uri('/api/friends');
    final resp = await http.get(uri, headers: _jsonHeaders);
    Map<String, dynamic> data;
    try { data = jsonDecode(resp.body) as Map<String, dynamic>; } catch (_) { data = {'error': resp.body}; }
    if (resp.statusCode < 200 || resp.statusCode >= 300) {
      throw StateError(data['error']?.toString() ?? '好友加载失败 (${resp.statusCode})');
    }
    return ((data['friends'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }
}