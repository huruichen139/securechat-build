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
    final response = method == 'GET'
        ? await http.get(uri, headers: headers)
        : await http.post(uri, headers: headers, body: jsonEncode(body ?? const {}));
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

  WebSocketChannel connect() {
    final root = Uri.parse(baseUrl);
    final scheme = root.scheme == 'https' ? 'wss' : 'ws';
    final uri = Uri(scheme: scheme, host: root.host, port: root.hasPort ? root.port : null, path: '/ws');
    final channel = WebSocketChannel.connect(uri);
    channel.sink.add(jsonEncode({'type': 'auth', 'payload': {'token': token}}));
    return channel;
  }
}
