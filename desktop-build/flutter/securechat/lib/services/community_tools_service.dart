// module: community-tools (worker batch8)
// 聊天民生工具 Flutter 服务层（独立文件，不修改 securechat_api.dart）。
// 复用 SecureChatApi 的 baseUrl / token 发起带鉴权 HTTP。
// 提供：群投票 / 群接龙 / 群待办 / 定时提醒 / 翻译 / 群语音 的 API 封装。
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'securechat_api.dart';

class CommunityToolsService {
  CommunityToolsService(this._api);
  final SecureChatApi _api;

  String get _baseUrl => _api.baseUrl.endsWith('/')
      ? _api.baseUrl.substring(0, _api.baseUrl.length - 1)
      : _api.baseUrl;
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

  Future<Map<String, dynamic>> _json(
    String method,
    String path, {
    Object? body,
    Map<String, String>? query,
  }) async {
    final uri = _uri(path, query);
    final headers = _jsonHeaders;
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

  // ---------- 群投票 ----------
  Future<List<Map<String, dynamic>>> pollsOfGroup(int groupId) async {
    final d = await _json('GET', '/api/polls/group/$groupId');
    return ((d['polls'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  Future<Map<String, dynamic>> createPoll(
    int groupId, {
    required String title,
    required List<String> options,
    bool multi = false,
    bool anonymous = false,
    int? deadline,
    bool onlyMembers = true,
  }) {
    return _json('POST', '/api/polls', body: {
      'groupId': groupId,
      'title': title,
      'options': options,
      'multi': multi,
      'anonymous': anonymous,
      'deadline': deadline,
      'onlyMembers': onlyMembers,
    });
  }

  Future<Map<String, dynamic>> votePoll(int pollId, List<int> optionIds) {
    return _json('POST', '/api/polls/$pollId/vote', body: {'optionIds': optionIds});
  }

  Future<Map<String, dynamic>> closePoll(int pollId) {
    return _json('POST', '/api/polls/$pollId/close', body: const {});
  }

  // ---------- 群接龙 ----------
  Future<List<Map<String, dynamic>>> solangsOfGroup(int groupId) async {
    final d = await _json('GET', '/api/solang/group/$groupId');
    return ((d['solangs'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  Future<Map<String, dynamic>> createSolang(int groupId, String title) {
    return _json('POST', '/api/solang', body: {'groupId': groupId, 'title': title});
  }

  Future<Map<String, dynamic>> joinSolang(int solangId, String note) {
    return _json('POST', '/api/solang/$solangId/join', body: {'note': note});
  }

  Future<Map<String, dynamic>> closeSolang(int solangId) {
    return _json('POST', '/api/solang/$solangId/close', body: const {});
  }

  // ---------- 群待办 ----------
  Future<List<Map<String, dynamic>>> todosOfGroup(int groupId) async {
    final d = await _json('GET', '/api/todos/group/$groupId');
    return ((d['todos'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  Future<Map<String, dynamic>> createTodo(
    int groupId, {
    String title = '今日待办',
    required List<String> items,
  }) {
    return _json('POST', '/api/todos', body: {
      'groupId': groupId,
      'title': title,
      'items': items,
    });
  }

  Future<Map<String, dynamic>> checkTodoItem(int todoId, int itemId, bool done) {
    return _json('POST', '/api/todos/$todoId/items/$itemId/check', body: {'done': done});
  }

  // ---------- 定时提醒 ----------
  Future<List<Map<String, dynamic>>> myReminders() async {
    final d = await _json('GET', '/api/reminders');
    return ((d['reminders'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  Future<Map<String, dynamic>> createReminder({
    required String targetType,
    required int targetId,
    required int at,
    String content = '定时提醒',
  }) {
    return _json('POST', '/api/reminders', body: {
      'targetType': targetType,
      'targetId': targetId,
      'at': at,
      'content': content,
    });
  }

  Future<void> deleteReminder(int id) async {
    await _json('DELETE', '/api/reminders/$id');
  }

  // ---------- 翻译 ----------
  Future<Map<String, dynamic>> translate(String text, {String target = 'zh'}) {
    return _json('POST', '/api/translate', body: {'text': text, 'target': target});
  }

  // ---------- 群语音 ----------
  Future<Map<String, dynamic>> sendGroupVoice(int groupId, String fileId) {
    return _json('POST', '/api/solang/voice', query: {
      'groupId': '$groupId',
      'fileId': fileId,
    });
  }
}