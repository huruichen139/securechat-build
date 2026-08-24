// module: chat-ext (worker batch2)
// 聊天增强：表情/引用/转发/合并转发/撤回 的 API 服务封装 + 聊天背景本地存储。
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import 'securechat_api.dart';

/// 聊天增强服务。复用 [SecureChatApi] 的 baseUrl/token 做带鉴权请求；
/// 聊天背景按「每个会话」存到 SharedPreferences（本地存储）。
class ChatExtService {
  ChatExtService(this._api);

  final SecureChatApi _api;
  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        if (_api.token != null) 'Authorization': 'Bearer ${_api.token}',
      };

  Uri _uri(String path) {
    final root = Uri.parse(_api.baseUrl.endsWith('/') ? _api.baseUrl : '${_api.baseUrl}/');
    return root.replace(path: '${root.path.replaceAll(RegExp(r'/$'), '')}$path');
  }

  Future<Map<String, dynamic>> _json(String method, String path, {Object? body}) async {
    final uri = _uri(path);
    final response = switch (method) {
      'POST' => await http.post(uri, headers: _headers, body: jsonEncode(body ?? const {})),
      'GET' => await http.get(uri, headers: _headers),
      _ => await http.get(uri, headers: _headers),
    };
    Map<String, dynamic> data;
    try {
      data = jsonDecode(response.body) as Map<String, dynamic>;
    } catch (_) {
      data = {'error': response.body};
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw StateError(data['error']?.toString() ?? '请求失败 (${response.statusCode})');
    }
    return data;
  }

  // ---------- 发送增强内容（好友走 REST /api/messages） ----------
  Future<Map<String, dynamic>> sendEnhanced(int to, String content, {String? clientMsgId, int? replyTo, int? forwardedFrom}) {
    return _json('POST', '/api/messages', body: {
      'to': to,
      'content': content,
      'clientMsgId': clientMsgId,
      'replyTo': replyTo,
      'forwardedFrom': forwardedFrom,
    });
  }

  // ---------- 表情 ----------
  Future<Map<String, dynamic>> sendEmoji(int to, String emoji) {
    return sendEnhanced(to, '[emoji:$emoji]');
  }

  // ---------- 引用回复 ----------
  Future<Map<String, dynamic>> sendReply(int to, String content, int replyTo) {
    return sendEnhanced(to, content, replyTo: replyTo);
  }

  // ---------- 撤回（限 2 分钟内，本人所发） ----------
  Future<Map<String, dynamic>> recall(int messageId) {
    return _json('POST', '/api/messages/$messageId/recall');
  }

  // ---------- 消息置顶（单聊） ----------
  Future<Map<String, dynamic>> pinMessage(int messageId, bool pinned) {
    return _json('POST', '/api/messages/$messageId/pin', body: {'pinned': pinned});
  }

  // ---------- 聊天设置（免打扰 / 置顶会话） ----------
  Future<Map<String, dynamic>> setChatSettings(int peerId, {bool? muted, bool? pinned}) {
    return _json('POST', '/api/chats/$peerId/settings', body: {
      if (muted != null) 'muted': muted,
      if (pinned != null) 'pinned': pinned,
    });
  }

  Future<List<Map<String, dynamic>>> getChatSettings() async {
    final d = await _json('GET', '/api/chats/settings');
    return ((d['settings'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  // ---------- 拍一拍 -> 系统消息 ----------
  Future<Map<String, dynamic>> poke(int messageId, int to) {
    return _json('POST', '/api/messages/$messageId/poke', body: {'to': to});
  }

  // ---------- 单条转发 ----------
  Future<Map<String, dynamic>> forwardOne(int messageId, List<Map<String, dynamic>> targets) {
    return _json('POST', '/api/messages/$messageId/forward', body: {'targets': targets});
  }

  // ---------- 批量 / 合并转发 ----------
  Future<Map<String, dynamic>> forwardMany(List<int> messageIds, List<Map<String, dynamic>> targets, {bool merge = false}) {
    return _json('POST', '/api/messages/forward', body: {
      'messageIds': messageIds,
      'targets': targets,
      'merge': merge,
    });
  }

  // ---------- 合并转发卡片解析 ----------
  static List<Map<String, dynamic>> parseMerged(String content) {
    if (!content.startsWith('[合并转发]')) return const [];
    try {
      final data = jsonDecode(content.substring('[合并转发]'.length));
      if (data is Map && data['items'] is List) {
        return [for (final e in data['items'] as List) if (e is Map) Map<String, dynamic>.from(e)];
      }
    } catch (_) {}
    return const [];
  }

  // =====================================================================
  // 聊天背景（本地存储：SharedPreferences，key = sc_bg_<userId>_<peerId|groupId>）
  // =====================================================================
  String _bgKey(int convId) {
    final uid = _api.myId?.toString() ?? 'guest';
    return 'sc_bg_${uid}_$convId';
  }

  Future<Map<String, dynamic>?> getBackground(int convId) async {
    final sp = await SharedPreferences.getInstance();
    final raw = sp.getString(_bgKey(convId));
    if (raw == null) return null;
    try {
      final v = jsonDecode(raw);
      if (v is Map) return v.cast<String, dynamic>();
    } catch (_) {}
    return null;
  }

  Future<void> setBackground(int? convId, Map<String, dynamic>? bg) async {
    if (convId == null) return;
    final sp = await SharedPreferences.getInstance();
    if (bg == null || bg['kind'] == null) {
      await sp.remove(_bgKey(convId));
      return;
    }
    final clone = <String, dynamic>{
      'kind': bg['kind'],
      'value': (bg['value'] ?? '').toString(),
      if (bg['opacity'] != null) 'opacity': (bg['opacity'] as num).toDouble(),
    };
    await sp.setString(_bgKey(convId), jsonEncode(clone));
  }

  Future<void> clearBackground(int convId) async {
    final sp = await SharedPreferences.getInstance();
    await sp.remove(_bgKey(convId));
  }
}