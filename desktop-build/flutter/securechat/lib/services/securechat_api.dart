import 'dart:async';
import 'dart:convert';

import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

class SecureChatApi {
  SecureChatApi({this.baseUrl = 'https://mc.32768.top:8888'});

  String baseUrl;
  String? token;
  int? myId;

  static const _kToken = 'sc_api_token';
  static const _kMyId = 'sc_api_myid';

  Future<void> persistSession() async {
    final sp = await SharedPreferences.getInstance();
    if (token != null) await sp.setString(_kToken, token!);
    if (myId != null) await sp.setInt(_kMyId, myId!);
  }

  Future<void> restoreSession() async {
    final sp = await SharedPreferences.getInstance();
    token = sp.getString(_kToken);
    final id = sp.getInt(_kMyId);
    if (id != null) myId = id;
  }

  Future<void> clearSession() async {
    token = null;
    myId = null;
    final sp = await SharedPreferences.getInstance();
    await sp.remove(_kToken);
    await sp.remove(_kMyId);
  }

  void _setSession(Map<String, dynamic> data) {
    token = data['token'] as String?;
    final user = data['user'];
    if (user is Map && user['id'] != null) {
      myId = int.tryParse('${user['id']}');
    }
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
    final response = switch (method) {
      'GET' => await http.get(uri, headers: headers),
      'POST' => await http.post(uri, headers: headers, body: jsonEncode(body ?? const {})),
      'DELETE' => await http.delete(uri, headers: headers),
      _ => await http.get(uri, headers: headers),
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

  Future<List<int>> fetchFile(String id) async {
    final uri = _uri('/api/files/$id');
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
    final data = await _json('GET', '/api/group/$groupId/members');
    return ((data['members'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  Future<List<Map<String, dynamic>>> groupHistory(int groupId) async {
    final data = await _json('GET', '/api/group/$groupId/messages');
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
}
