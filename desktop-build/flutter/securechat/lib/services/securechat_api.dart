import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

/// token 失效专用异常：_json 遇 401 抛出，ChatShell 捕获后回登录页
class AuthExpiredException implements Exception {
  const AuthExpiredException([this.message = '登录已失效，请重新登录']);
  final String message;
  @override
  String toString() => message;
}

class SecureChatApi {
  SecureChatApi({this.baseUrl = 'https://mc.32768.top:8888'}) {
    // 全局 token 机制：任何新实例自动继承已登录的全局会话，
    // 不再需要每个页面单独 restoreSession，杜绝"未授权"。
    if (globalToken != null) {
      token = globalToken;
      myId = globalMyId;
    }
  }

  /// 全局共享会话（静态），登录/恢复/退出时同步更新。
  static String? globalToken;
  static int? globalMyId;

  String baseUrl;
  String? token;
  int? myId;

  static const _kToken = 'sc_api_token';
  static const _kMyId = 'sc_api_myid';

  Future<void> persistSession() async {
    final sp = await SharedPreferences.getInstance();
    if (token != null) await sp.setString(_kToken, token!);
    if (myId != null) await sp.setInt(_kMyId, myId!);
    _syncGlobal();
  }

  Future<void> restoreSession() async {
    final sp = await SharedPreferences.getInstance();
    token = sp.getString(_kToken);
    final id = sp.getInt(_kMyId);
    if (id != null) myId = id;
    _syncGlobal();
  }

  Future<void> clearSession() async {
    token = null;
    myId = null;
    globalToken = null;
    globalMyId = null;
    final sp = await SharedPreferences.getInstance();
    await sp.remove(_kToken);
    await sp.remove(_kMyId);
  }

  void _syncGlobal() {
    if (token != null && token!.isNotEmpty) {
      globalToken = token;
      globalMyId = myId;
    }
  }

  void _setSession(Map<String, dynamic> data) {
    token = data['token'] as String?;
    final user = data['user'];
    if (user is Map && user['id'] != null) {
      myId = int.tryParse('${user['id']}');
    }
    _syncGlobal();
  }

  bool get isLoggedIn => token != null && token!.isNotEmpty;

  Uri _uri(String path, [Map<String, String>? query]) {
    final root = Uri.parse(baseUrl.endsWith('/') ? baseUrl : '$baseUrl/');
    return root.replace(path: '${root.path.replaceAll(RegExp(r'/$'), '')}$path', queryParameters: query);
  }

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        if (token != null) 'Authorization': 'Bearer $token',
      };

  Future<Map<String, dynamic>> _json(String method, String path, {Object? body, bool auth = true, Map<String, String>? query}) async {
    final headers = auth ? _headers : {'Content-Type': 'application/json'};
    final uri = _uri(path, query);
    const timeout = Duration(seconds: 15);
    final response = switch (method) {
      'GET' => await http.get(uri, headers: headers).timeout(timeout),
      'POST' => await http.post(uri, headers: headers, body: jsonEncode(body ?? const {})).timeout(timeout),
      'DELETE' => await http.delete(uri, headers: headers).timeout(timeout),
      _ => await http.get(uri, headers: headers).timeout(timeout),
    };
    Map<String, dynamic> data;
    try {
      data = jsonDecode(response.body) as Map<String, dynamic>;
    } catch (_) {
      data = {'error': response.body};
    }
    if (response.statusCode == 401) {
      // 温和处理：不清会话、不强制回登录，仅提示，避免用户"点啥都重新登录"
      throw const AuthExpiredException();
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw StateError(data['error']?.toString() ?? '请求失败 (${response.statusCode})');
    }
    return data;
  }

  Future<Map<String, dynamic>> grabRedPacket(int id) => _json('POST', '/api/redpacket/$id/grab');
  Future<Map<String, dynamic>> redPacketDetail(int id) => _json('GET', '/api/redpacket/$id');

  Future<List<Map<String, dynamic>>> feedsNews() async {
    final r = await _json('GET', '/api/feeds/news');
    return (r['list'] as List? ?? []).map((e) => (e as Map).cast<String, dynamic>()).toList();
  }

  Future<List<Map<String, dynamic>>> feedsVideos() async {
    final r = await _json('GET', '/api/feeds/videos');
    return (r['list'] as List? ?? []).map((e) => (e as Map).cast<String, dynamic>()).toList();
  }

  Future<Map<String, dynamic>> gatewayOrder(String orderNo) => _json('GET', '/api/pay/gateway/order/${Uri.encodeComponent(orderNo)}');

  Future<Map<String, dynamic>> gatewayAuthorizations() => _json('GET', '/api/pay/gateway/authorization');

  Future<Map<String, dynamic>> gatewayCreateAuthorization(int merchantId, double maxAmount, String mode) =>
      _json('POST', '/api/pay/gateway/authorization', body: {'merchantId': merchantId, 'maxAmount': maxAmount, 'mode': mode, 'confirm': true});

  Future<Map<String, dynamic>> gatewayConfirm(String orderNo, double amount) =>
      _json('POST', '/api/pay/gateway/order/${Uri.encodeComponent(orderNo)}/confirm', body: {'confirm': true, 'amount': amount});

  Future<Map<String, dynamic>> login(String account, String password) async {
    final data = await _json('POST', '/api/login', body: {'account': account, 'password': password}, auth: false);
    _setSession(data);
    await persistSession();
    return data;
  }

  Future<void> sendEmailCode(String email) async {
    await _json('POST', '/api/email/code', body: {'email': email, 'purpose': 'login'}, auth: false);
  }

  Future<Map<String, dynamic>> loginByCode(String email, String code) async {
    final data = await _json('POST', '/api/login/code', body: {'email': email, 'code': code}, auth: false);
    _setSession(data);
    await persistSession();
    return data;
  }

  Future<void> sendResetCode(String email) async {
    await _json('POST', '/api/email/code', body: {'email': email, 'purpose': 'reset'}, auth: false);
  }

  Future<void> resetPassword(String email, String code, String newPassword) async {
    await _json('POST', '/api/password/reset', body: {'email': email, 'code': code, 'newPassword': newPassword}, auth: false);
  }

  Future<String> aiChat({required String baseUrl, required String apiKey, required String model, required List<Map<String, dynamic>> messages}) async {
    final data = await _json('POST', '/api/ai/chat', body: {'baseUrl': baseUrl, 'apiKey': apiKey, 'model': model, 'messages': messages});
    final choices = data['choices'];
    if (choices is List && choices.isNotEmpty) {
      final content = choices.first?['message']?['content'];
      if (content is String && content.isNotEmpty) return content;
    }
    final err = data['error'];
    if (err is String && err.isNotEmpty) throw StateError(err);
    throw StateError('AI 无返回');
  }

  Future<Map<String, dynamic>> createQrLogin() => _json('POST', '/api/login/qr/create', auth: false);

  Future<Map<String, dynamic>> qrStatus(String qrToken) => _json('GET', '/api/login/qr/status', auth: false, query: {'token': qrToken});

  Future<Map<String, dynamic>> consumeQrLogin(String qrToken) async {
    final data = await _json('POST', '/api/login/qr/consume', body: {'token': qrToken}, auth: false);
    _setSession(data);
    await persistSession();
    return data;
  }

  Future<void> confirmQrLogin(String qrToken) async {
    await _json('POST', '/api/login/qr/confirm', body: {'token': qrToken});
  }

  Future<Map<String, dynamic>> myCard() async {
    final data = await _json('GET', '/api/qrcode/mycard');
    final card = data['card'];
    if (card is Map<String, dynamic>) return card;
    if (card is Map) return card.cast<String, dynamic>();
    return data;
  }

  Future<Map<String, dynamic>> addFriend(String friendUid) async {
    return _json('POST', '/api/friend/add', body: {'friendUid': friendUid});
  }

  Future<Map<String, dynamic>> uploadVoice(int to, List<int> bytes, String name) async {
    final uri = _uri('/api/files', {'to': '$to', 'name': name, 'mime': 'audio/m4a'});
    final response = await http.post(uri, headers: {'Content-Type': 'application/octet-stream', if (token != null) 'Authorization': 'Bearer $token'}, body: bytes);
    final data = jsonDecode(response.body) as Map<String, dynamic>;
    if (response.statusCode < 200 || response.statusCode >= 300) throw StateError(data['error']?.toString() ?? '语音上传失败');
    return data;
  }

  Future<Uint8List> fetchFile(String id) async {
    final uri = _uri('/api/files/$id');
    final response = await http.get(uri, headers: {if (token != null) 'Authorization': 'Bearer $token'});
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw StateError('文件获取失败 (${response.statusCode})');
    }
    return response.bodyBytes;
  }

  Future<Map<String, dynamic>> uploadAttachment(int to, List<int> bytes, String name, String mime) async {
    final uri = _uri('/api/files', {'to': '$to', 'name': name, 'mime': mime});
    final response = await http.post(uri, headers: {'Content-Type': 'application/octet-stream', if (token != null) 'Authorization': 'Bearer $token'}, body: bytes);
    final data = jsonDecode(response.body) as Map<String, dynamic>;
    if (response.statusCode < 200 || response.statusCode >= 300) throw StateError(data['error']?.toString() ?? '文件上传失败');
    return data;
  }

  Future<Map<String, dynamic>> uploadGroupFile(int groupId, List<int> bytes, String name, String mime) async {
    final uri = _uri('/api/groups/$groupId/files', {'name': name, 'mime': mime});
    final response = await http.post(uri, headers: {'Content-Type': 'application/octet-stream', if (token != null) 'Authorization': 'Bearer $token'}, body: bytes);
    final data = jsonDecode(response.body) as Map<String, dynamic>;
    if (response.statusCode < 200 || response.statusCode >= 300) throw StateError(data['error']?.toString() ?? '群文件上传失败');
    return data;
  }

  Future<Uint8List> fetchGroupFile(String fileId) async {
    final uri = _uri('/api/group-files/$fileId');
    final response = await http.get(uri, headers: {if (token != null) 'Authorization': 'Bearer $token'});
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw StateError('文件获取失败 (${response.statusCode})');
    }
    return response.bodyBytes;
  }

  Future<List<Map<String, dynamic>>> myFiles() async {
    final data = await _json('GET', '/api/files');
    return ((data['files'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  Future<List<Map<String, dynamic>>> favorites() async {
    final data = await _json('GET', '/api/favorites');
    return ((data['messages'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  Future<void> setFavorite(int messageId, {bool favorite = true}) async {
    await _json('POST', '/api/messages/$messageId/favorite', body: {'favorite': favorite});
  }

  Future<String> exportChat(int peerId, {String format = 'json'}) async {
    final uri = _uri('/api/export/messages', {'peerId': '$peerId', 'format': format});
    final resp = await http.get(uri, headers: {if (token != null) 'Authorization': 'Bearer $token'}).timeout(const Duration(seconds: 30));
    if (resp.statusCode == 200) return resp.body;
    throw Exception('导出失败: ${resp.statusCode}');
  }

  Future<void> pinMessage(int messageId, bool pinned) async {
    await _json('POST', '/api/messages/$messageId/pin', body: {'pinned': pinned});
  }

  Future<Map<String, dynamic>> checkVersion() async {
    return _json('GET', '/api/version', auth: false);
  }

  Uri downloadUri(String relativePath) => _uri(relativePath.startsWith('/') ? relativePath : '/$relativePath');

  Future<String> transcribe(String id) async {
    final data = await _json('POST', '/api/stt', body: {'id': id});
    return (data['text'] ?? '').toString().trim();
  }

  Future<List<Map<String, dynamic>>> friends() async {
    final data = await _json('GET', '/api/friends');
    return ((data['friends'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  Future<List<Map<String, dynamic>>> groups() async {
    final data = await _json('GET', '/api/groups');
    return ((data['groups'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  Future<List<Map<String, dynamic>>> history(int peerId) async {
    final data = await _json('GET', '/api/history/$peerId');
    return ((data['messages'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  Future<void> deleteHistory(int peerId) async {
    await _json('DELETE', '/api/history/$peerId');
  }

  Future<Map<String, dynamic>> sendMessage(int to, String content, {String? clientMsgId, int? replyTo, int? forwardedFrom}) async {
    return _json('POST', '/api/messages', body: {
      'to': to, 'content': content,
      'clientMsgId': ?clientMsgId,
      'replyTo': ?replyTo,
      'forwardedFrom': ?forwardedFrom,
    });
  }

  Future<void> setChatSettings(int peerId, {bool? muted, bool? pinned}) async {
    await _json('POST', '/api/chats/$peerId/settings', body: {
      'muted': ?muted,
      'pinned': ?pinned,
    });
  }

  Future<List<Map<String, dynamic>>> chatSettings() async {
    final data = await _json('GET', '/api/chats/settings');
    return ((data['settings'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  Future<List<Map<String, dynamic>>> groupMembers(int groupId) async {
    final data = await _json('GET', '/api/groups/$groupId/members');
    return ((data['members'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  Future<List<Map<String, dynamic>>> groupHistory(int groupId) async {
    final data = await _json('GET', '/api/groups/$groupId/messages');
    return ((data['messages'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  WebSocketChannel connect() {
    final root = Uri.parse(baseUrl);
    final scheme = root.scheme == 'https' ? 'wss' : 'ws';
    final uri = Uri(scheme: scheme, host: root.host, port: root.hasPort ? root.port : null, path: '/ws');
    final channel = WebSocketChannel.connect(uri);
    channel.sink.add(jsonEncode({'type': 'auth', 'payload': {'token': token}}));
    return channel;
  }

  // ============ 朋友圈 ============
  Future<Map<String, dynamic>> postMoment(String content, List<String> images) =>
      _json('POST', '/api/moments', body: {'content': content, 'images': images});
  Future<List<Map<String, dynamic>>> moments({int offset = 0, int limit = 20}) async {
    final data = await _json('GET', '/api/moments', query: {'offset': '$offset', 'limit': '$limit'});
    return ((data['moments'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }
  Future<void> likeMoment(int id, {bool on = true}) =>
      _json('POST', '/api/moments/$id/like', body: {'on': on});
  Future<void> commentMoment(int id, String content, {int? replyToId}) =>
      _json('POST', '/api/moments/$id/comment', body: {'content': content, 'replyToId': replyToId});

  // ============ 钱包 ============
  Future<Map<String, dynamic>> wallet() => _json('GET', '/api/wallet');
  Future<Map<String, dynamic>> redeem(String code) =>
      _json('POST', '/api/wallet/redeem', body: {'code': code});
  Future<Map<String, dynamic>> transfer(String toUid, double amount, {String remark = ''}) =>
      _json('POST', '/api/wallet/transfer', body: {'toUid': toUid, 'amount': amount, 'remark': remark});
  Future<List<Map<String, dynamic>>> walletTxn() async {
    final data = await _json('GET', '/api/wallet/txn');
    return ((data['txn'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  // ============ 状态 ============
  Future<Map<String, dynamic>?> myStatus() async {
    final data = await _json('GET', '/api/status');
    return data['status'] as Map<String, dynamic>?;
  }
  Future<void> setStatus(String text, {String icon = '', String emoji = ''}) =>
      _json('POST', '/api/status', body: {'text': text, 'icon': icon, 'emoji': emoji});

  // ============ 视频号 ============
  Future<void> postVideo(String title, {String cover = '', String content = ''}) =>
      _json('POST', '/api/videos', body: {'title': title, 'cover': cover, 'content': content});
  Future<List<Map<String, dynamic>>> videos() async {
    final data = await _json('GET', '/api/videos');
    return ((data['videos'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }
  Future<void> likeVideo(int id, {bool on = true}) => _json('POST', '/api/videos/$id/like', body: {'on': on});
  Future<void> commentVideo(int id, String content) => _json('POST', '/api/videos/$id/comment', body: {'content': content});

  // ============ 公众号 ============
  Future<List<Map<String, dynamic>>> accounts() async {
    final data = await _json('GET', '/api/accounts');
    return ((data['accounts'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }
  Future<void> followAccount(int id, {bool on = true}) => _json('POST', '/api/accounts/$id/follow', body: {'on': on});
  Future<List<Map<String, dynamic>>> accountPosts(int id) async {
    final data = await _json('GET', '/api/accounts/$id/posts');
    return ((data['posts'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  // ============ 小程序 ============
  Future<List<Map<String, dynamic>>> miniApps() async {
    final data = await _json('GET', '/api/mini-apps');
    return ((data['apps'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  // ============ 拍一拍 ============
  Future<void> poke(int to) => _json('POST', '/api/poke', body: {'to': to});

  // ============ X3DH 预钥 ============
  /// 上传我方身份公钥 (identity pubkey)，覆盖服务器 users.pubkey
  Future<Map<String, dynamic>> updatePubkey(String pubKey) =>
      _json('POST', '/api/keys', body: {'pubkey': pubKey});

  /// 上传签名预钥 (signed prekey)
  Future<Map<String, dynamic>> uploadSignedPreKey(String keyId, String pubKey, String signature) =>
      _json('POST', '/api/keys/signed-prekey', body: {'keyId': keyId, 'pubKey': pubKey, 'signature': signature});

  /// 批量上传一次性预钥 (one-time prekeys)
  Future<Map<String, dynamic>> uploadOneTimePreKeys(List<Map<String, String>> prekeys) =>
      _json('POST', '/api/keys/prekeys', body: {'prekeys': prekeys});

  /// 取对方完整 X3DH bundle（身分公钥 + signedPreKey + 一条 oneTimePreKey）
  /// userId 对方用户 id
  /// 返回 { identityKey, signedPreKey: { keyId, pubKey, signature } | null, oneTimePreKey: { keyId, pubKey } | null, registrationId }
  Future<Map<String, dynamic>> fetchKeyBundle(int userId) =>
      _json('GET', '/api/keys/bundle/$userId');

  // ============ 收藏笔记 ============
  Future<void> addNote(String content) => _json('POST', '/api/notes', body: {'content': content});
  Future<List<Map<String, dynamic>>> notes() async {
    final data = await _json('GET', '/api/notes');
    return ((data['notes'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }
  Future<void> deleteNote(int id) => _json('DELETE', '/api/notes/$id');

  // ============ 用户目录 / 好友请求 ============
  /// 全部可加好友的用户（服务端已排除自己）
  Future<List<Map<String, dynamic>>> allUsers() async {
    final data = await _json('GET', '/api/users');
    return ((data['users'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  /// 待处理的好友请求（别人加我）
  Future<List<Map<String, dynamic>>> friendRequests() async {
    final data = await _json('GET', '/api/friend/requests');
    return ((data['requests'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  Future<void> acceptFriend(int friendId) => _json('POST', '/api/friend/accept', body: {'friendId': friendId});
  Future<void> rejectFriend(int friendId) => _json('POST', '/api/friend/reject', body: {'friendId': friendId});

  // ============ 个人资料 ============
  /// 更新资料：昵称 / 地区 / 自定义扩展字段（签名、性别等扁平键值）
  Future<Map<String, dynamic>> updateProfile({
    String? nickname,
    String? country,
    String? province,
    String? city,
    Map<String, String>? extra,
  }) =>
      _json('POST', '/api/profile', body: {
        if (nickname != null) 'nickname': nickname,
        if (country != null) 'country': country,
        if (province != null) 'province': province,
        if (city != null) 'city': city,
        if (extra != null) 'extra': extra,
      });

  /// 设置头像，需传 data URI（data:image/png;base64,...），服务端限制 256KB
  Future<Map<String, dynamic>> setAvatar(String dataUri) => _json('POST', '/api/avatar', body: {'avatar': dataUri});

  // ============ 全局消息搜索 ============
  /// 跨会话搜索我的消息，返回 [{id, content, createdAt, peerId, peerName}]
  Future<List<Map<String, dynamic>>> searchMessages(String query) async {
    final data = await _json('GET', '/api/search/messages', query: {'q': query});
    return ((data['messages'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  // ============ 公告 ============
  Future<List<Map<String, dynamic>>> announcements() async {
    final data = await _json('GET', '/api/announcements');
    return ((data['announcements'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  // ============ 意见反馈 ============
  /// kind 取值：bug / suggestion / complaint / other；content 至少 10 字
  Future<void> sendFeedback(String kind, String content) =>
      _json('POST', '/api/feedback', body: {'kind': kind, 'content': content});

  Future<List<Map<String, dynamic>>> myFeedbacks() async {
    final data = await _json('GET', '/api/feedback');
    return ((data['feedbacks'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  // ============ 管理员（仅 admin_emails 白名单账号可访问） ============
  Future<Map<String, dynamic>> adminOverview() => _json('GET', '/api/admin/overview');

  Future<List<Map<String, dynamic>>> adminUsers() async {
    final data = await _json('GET', '/api/admin/users');
    return ((data['users'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  Future<void> adminBan(int id, {required bool banned, String reason = ''}) =>
      _json('POST', '/api/admin/ban', body: {'id': id, 'banned': banned, if (reason.isNotEmpty) 'reason': reason});

  Future<void> adminKick(int id, {String reason = ''}) =>
      _json('POST', '/api/admin/kick', body: {'id': id, if (reason.isNotEmpty) 'reason': reason});

  Future<void> adminUpdateUser(int id, {String? nickname, String? role}) =>
      _json('POST', '/api/admin/user/update', body: {
        'id': id,
        if (nickname != null) 'nickname': nickname,
        if (role != null) 'role': role,
      });

  /// 重置指定用户密码（服务端要求至少 6 位，重置后该用户被强制下线）
  Future<Map<String, dynamic>> adminResetPassword(int id, String password) =>
      _json('POST', '/api/admin/user/reset-password', body: {'id': id, 'password': password});

  Future<List<Map<String, dynamic>>> adminAnnouncements() async {
    final data = await _json('GET', '/api/admin/announcements');
    return ((data['announcements'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  Future<Map<String, dynamic>> adminCreateAnnouncement(String title, String content, {String level = 'info', bool top = false}) =>
      _json('POST', '/api/admin/announcements', body: {'title': title, 'content': content, 'level': level, 'top': top});

  Future<void> adminDeleteAnnouncement(int id) =>
      _json('DELETE', '/api/admin/announcements', query: {'id': '$id'});

  Future<List<Map<String, dynamic>>> adminAudit({int limit = 200}) async {
    final data = await _json('GET', '/api/admin/audit', query: {'limit': '$limit'});
    return ((data['logs'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  Future<Map<String, dynamic>> adminIssueRedeem(double value, int count) =>
      _json('POST', '/api/admin/redeem/issue', body: {'value': value, 'count': count});

  Future<List<Map<String, dynamic>>> adminRedeem({int? claimed}) async {
    final data = await _json('GET', '/api/admin/redeem', query: {if (claimed != null) 'claimed': '$claimed'});
    return ((data['codes'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  Future<List<Map<String, dynamic>>> adminGroups({String q = ''}) async {
    final data = await _json('GET', '/api/admin/groups', query: {if (q.isNotEmpty) 'q': q});
    return ((data['groups'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  Future<Map<String, dynamic>> adminGroupDetail(int id) => _json('GET', '/api/admin/group/$id');

  Future<void> adminDissolveGroup(int id) => _json('POST', '/api/admin/group/dissolve', body: {'id': id});

  Future<void> adminRemoveGroupMember(int groupId, int userId) =>
      _json('POST', '/api/admin/group/remove-member', body: {'groupId': groupId, 'userId': userId});

  Future<void> adminFeedbackStatus(int id, String status) =>
      _json('POST', '/api/admin/feedback/status', body: {'id': id, 'status': status});

  Future<List<Map<String, dynamic>>> adminBannedIps() async {
    final data = await _json('GET', '/api/admin/banned-ips');
    return ((data['ips'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  Future<void> adminBanIp(String ip, {String reason = ''}) =>
      _json('POST', '/api/admin/ban-ip', body: {'ip': ip, if (reason.isNotEmpty) 'reason': reason});

  Future<void> adminUnbanIp(String ip) => _json('DELETE', '/api/admin/banned-ips', query: {'ip': ip});

  Future<List<Map<String, dynamic>>> adminSensitiveWords() async {
    final data = await _json('GET', '/api/admin/sensitive-words');
    return ((data['words'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  Future<void> adminAddSensitiveWord(String word) =>
      _json('POST', '/api/admin/sensitive-words', body: {'word': word});

  Future<void> adminDeleteSensitiveWord(String word) =>
      _json('DELETE', '/api/admin/sensitive-words', query: {'word': word});

  Future<Map<String, dynamic>> adminUpdateStatus() => _json('GET', '/api/admin/update-status');

  Future<Map<String, dynamic>> adminSetVersion(String latest, {String releaseNotes = ''}) =>
      _json('POST', '/api/admin/version', body: {'latest': latest, if (releaseNotes.isNotEmpty) 'releaseNotes': releaseNotes});

  /// 上传安装包到 server/downloads（按当前 latest 版本命名）。
  /// platform: windows / windowsPortable / macos / android / harmony / ios
  Future<Map<String, dynamic>> adminUploadPackage(String platform, Uint8List bytes) async {
    final uri = _uri('/api/admin/upload/$platform');
    final response = await http.post(
      uri,
      headers: {
        'Content-Type': 'application/octet-stream',
        if (token != null) 'Authorization': 'Bearer $token',
      },
      body: bytes,
    );
    Map<String, dynamic> data;
    try {
      data = jsonDecode(response.body) as Map<String, dynamic>;
    } catch (_) {
      data = {'error': response.body};
    }
    if (response.statusCode == 401) throw const AuthExpiredException();
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw StateError(data['error']?.toString() ?? '上传失败 (${response.statusCode})');
    }
    return data;
  }

  Future<void> adminDeletePackage(String platform) => _json('DELETE', '/api/admin/upload/$platform');

  // ============ QQ 互联 ============
  Future<Map<String, dynamic>> qqStatus() => _json('GET', '/api/oauth/qq/status', auth: false);

  Future<String> qqLoginUrl(String state) async {
    final data = await _json('GET', '/api/oauth/qq/url', query: {'state': state}, auth: false);
    final url = (data['url'] ?? '').toString();
    if (url.isEmpty) throw StateError(data['error'] ?? 'QQ 登录未启用');
    return url;
  }

  Future<Map<String, dynamic>> qqPoll(String state) =>
      _json('GET', '/api/oauth/qq/poll', query: {'state': state}, auth: false);

  /// 用 QQ 回调产生的登录结果完成登录（token+user 注入会话）
  Future<void> applyLoginData(Map<String, dynamic> data) async {
    final t = (data['token'] ?? '').toString();
    if (t.isEmpty) throw StateError('登录结果无效');
    token = t;
    final user = data['user'];
    if (user is Map && user['id'] != null) {
      myId = int.tryParse('${user['id']}');
    }
    await persistSession();
  }

  Future<Map<String, dynamic>> adminQqConfig() => _json('GET', '/api/admin/qq/config');

  Future<Map<String, dynamic>> adminSaveQqConfig({
    required String appid,
    required String secret,
    required String redirect,
    required bool enabled,
  }) =>
      _json('POST', '/api/admin/qq/config', body: {
        'appid': appid,
        'secret': secret,
        'redirect': redirect,
        'enabled': enabled,
      });

  // ============ GitHub OAuth ============
  Future<Map<String, dynamic>> githubStatus() => _json('GET', '/api/oauth/github/status', auth: false);

  Future<String> githubLoginUrl(String state) async {
    final data = await _json('GET', '/api/oauth/github/url', query: {'state': state}, auth: false);
    final url = (data['url'] ?? '').toString();
    if (url.isEmpty) throw StateError(data['error'] ?? 'GitHub 登录未启用');
    return url;
  }

  Future<Map<String, dynamic>> githubPoll(String state) =>
      _json('GET', '/api/oauth/github/poll', query: {'state': state}, auth: false);

  Future<Map<String, dynamic>> adminGithubConfig() => _json('GET', '/api/admin/github/config');

  Future<Map<String, dynamic>> adminSaveGithubConfig({
    required String clientId,
    required String clientSecret,
    required String redirect,
    required bool enabled,
  }) =>
      _json('POST', '/api/admin/github/config', body: {
        'clientId': clientId,
        'clientSecret': clientSecret,
        'redirect': redirect,
        'enabled': enabled,
      });

  // ============ Passkey 本地设备凭据 ============
  Future<Map<String, dynamic>> passkeyRegister(String deviceName) =>
      _json('POST', '/api/passkey/register', body: {'deviceName': deviceName});

  Future<List<Map<String, dynamic>>> passkeyList() async {
    final data = await _json('GET', '/api/passkey/list');
    return ((data['credentials'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  Future<void> passkeyDelete(String credentialId) =>
      _json('DELETE', '/api/passkey/delete', query: {'credentialId': credentialId});

  Future<Map<String, dynamic>> passkeyStart(String credentialId) =>
      _json('POST', '/api/passkey/start', body: {'credentialId': credentialId}, auth: false);

  Future<Map<String, dynamic>> passkeyFinish(String credentialId, String signature) =>
      _json('POST', '/api/passkey/finish', body: {'credentialId': credentialId, 'signature': signature}, auth: false);

  Future<List<Map<String, dynamic>>> adminPasskeys() async {
    final data = await _json('GET', '/api/admin/passkey/list');
    return ((data['credentials'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  Future<void> adminDeletePasskey(String credentialId) =>
      _json('DELETE', '/api/admin/passkey/delete', query: {'credentialId': credentialId});

  Future<Map<String, dynamic>> adminEpayConfig() => _json('GET', '/api/admin/pay/epay/config');

  Future<Map<String, dynamic>> adminSaveEpayConfig(Map<String, dynamic> config) =>
      _json('POST', '/api/admin/pay/epay/config', body: config);

  Future<void> joinGroup(int groupId) =>
      _json('POST', '/api/group/join', body: {'groupId': groupId});

  Future<void> blockUser(int targetId) =>
      _json('POST', '/api/block', body: {'targetId': targetId});

  Future<void> unblockUser(int targetId) =>
      _json('POST', '/api/unblock', body: {'targetId': targetId});

  Future<List<Map<String, dynamic>>> blockList() async {
    final data = await _json('GET', '/api/blocklist');
    return ((data['blocked'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  Future<List<Map<String, dynamic>>> fetchAnnouncements() async {
    final data = await _json('GET', '/api/announcements');
    return ((data['announcements'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }
}
