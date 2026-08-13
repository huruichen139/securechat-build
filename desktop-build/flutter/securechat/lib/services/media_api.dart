// module: media_api (worker batch4) —— 公众号 / 视频号 / 直播 / 媒体上传 的轻量服务
// 复用现有 SecureChatApi 的 baseUrl/token；上传走 /api/media。
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'securechat_api.dart';

class MediaService {
  MediaService(this.api);
  final SecureChatApi api;

  String get _base => api.baseUrl.replaceAll(RegExp(r'/$'), '');
  String get _token => api.token ?? '';

  Map<String, String> _headers({bool json = true}) => {
        'Authorization': 'Bearer $_token',
        if (json) 'Content-Type': 'application/json',
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

  Future<Map<String, dynamic>> _post(String path, Map<String, dynamic> body) =>
      http.post(_uri(path), headers: _headers(), body: jsonEncode(body)).then(_decode);

  // ---------- 媒体上传 ----------
  /// 上传任意文件(bytes)，返回 { url, id, mime, size }；url 为相对路径 /api/media/:id
  Future<Map<String, dynamic>> upload(List<int> bytes, String name, {String mime = 'application/octet-stream'}) async {
    final uri = _uri('/api/media', {'name': name, 'mime': mime});
    final r = await http.post(uri, headers: {'Authorization': 'Bearer $_token', 'Content-Type': 'application/octet-stream'}, body: bytes);
    return _decode(r);
  }

  // ---------- 公众号 ----------
  Future<List<Map<String, dynamic>>> accounts() async {
    final d = await _get('/api/oa');
    return ((d['accounts'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  Future<Map<String, dynamic>> account(int id) async {
    final d = await _get('/api/oa/$id');
    return (d['account'] as Map?)?.cast<String, dynamic>() ?? {};
  }

  Future<Map<String, dynamic>> registerOa(String name, String intro) =>
      _post('/api/oa/register', {'name': name, 'intro': intro});

  Future<void> followOa(int id, {bool on = true}) async {
    await _post('/api/oa/$id/follow', {'on': on});
  }

  Future<List<Map<String, dynamic>>> accountArticles(int id) async {
    final d = await _get('/api/oa/$id/articles');
    return ((d['articles'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  Future<Map<String, dynamic>> publishArticle(int id, String title, String content, {String cover = ''}) async {
    final d = await _post('/api/oa/$id/article', {'title': title, 'content': content, 'cover': cover});
    return (d['article'] as Map?)?.cast<String, dynamic>() ?? {};
  }

  Future<Map<String, dynamic>> article(int id) async {
    final d = await _get('/api/articles/$id');
    return (d['article'] as Map?)?.cast<String, dynamic>() ?? {};
  }

  Future<void> commentArticle(int id, String content, {int? replyTo}) async {
    await _post('/api/articles/$id/comment', {'content': content, if (replyTo != null) 'replyTo': replyTo});
  }

  Future<void> featureComment(int articleId, int commentId, {bool on = true}) async {
    await _post('/api/articles/$articleId/comment/$commentId/feature', {'on': on});
  }

  Future<void> replyComment(int articleId, int commentId, String content) async {
    await _post('/api/articles/$articleId/reply', {'commentId': commentId, 'content': content});
  }

  Future<void> wow(int articleId, {bool on = true}) async {
    await _post('/api/articles/$articleId/wow', {'on': on});
  }

  Future<List<Map<String, dynamic>>> oaFeed() async {
    final d = await _get('/api/oa/feed');
    return ((d['articles'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  Future<List<Map<String, dynamic>>> myPresent() async {
    final d = await _get('/api/oa/me/present');
    return ((d['articles'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  // ---------- 视频号 ----------
  Future<Map<String, dynamic>> publishVideo(String title, String url, {String content = '', String cover = ''}) async {
    final d = await _post('/api/videos/publish', {'title': title, 'url': url, 'content': content, 'cover': cover});
    return (d['video'] as Map?)?.cast<String, dynamic>() ?? {};
  }

  Future<List<Map<String, dynamic>>> videoFeed() async {
    final d = await _get('/api/videos/feed');
    return ((d['videos'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  Future<List<Map<String, dynamic>>> followingVideos() async {
    final d = await _get('/api/videos/following');
    return ((d['videos'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  Future<List<Map<String, dynamic>>> myFavoriteVideos() async {
    final d = await _get('/api/videos/me/favorites');
    return ((d['videos'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  Future<Map<String, dynamic>> video(int id) async {
    final d = await _get('/api/videos/$id');
    return (d['video'] as Map?)?.cast<String, dynamic>() ?? {};
  }

  Future<void> likeVideo(int id, {bool on = true}) async {
    await _post('/api/videos/$id/like', {'on': on});
  }

  Future<void> favoriteVideo(int id, {bool on = true}) async {
    await _post('/api/videos/$id/favorite', {'on': on});
  }

  Future<void> commentVideo(int id, String content, {int? replyTo}) async {
    await _post('/api/videos/$id/comment', {'content': content, if (replyTo != null) 'replyTo': replyTo});
  }

  Future<void> shareVideo(int id) async {
    await _post('/api/videos/$id/share', {});
  }

  // ---------- 直播 ----------
  Future<Map<String, dynamic>> startLive(String title, {String streamUrl = '', String cover = ''}) async {
    final d = await _post('/api/live/start', {'title': title, 'streamUrl': streamUrl, 'cover': cover});
    return (d['room'] as Map?)?.cast<String, dynamic>() ?? {};
  }

  Future<Map<String, dynamic>> endLive(int roomId, {String replayUrl = ''}) async {
    final d = await _post('/api/live/end', {'roomId': roomId, 'replayUrl': replayUrl});
    return (d['room'] as Map?)?.cast<String, dynamic>() ?? {};
  }

  Future<List<Map<String, dynamic>>> liveRooms() async {
    final d = await _get('/api/live');
    return ((d['rooms'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  Future<List<Map<String, dynamic>>> myFavoriteRooms() async {
    final d = await _get('/api/live/me/favorites');
    return ((d['rooms'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  Future<Map<String, dynamic>> liveRoom(int id) async {
    final d = await _get('/api/live/room/$id');
    return (d['room'] as Map?)?.cast<String, dynamic>() ?? {};
  }

  Future<List<Map<String, dynamic>>> liveChat(int roomId, {int since = 0}) async {
    final d = await _get('/api/live/room/$roomId/chat', {'since': '$since'});
    return ((d['chats'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  Future<void> sendChat(int roomId, String content) async {
    await _post('/api/live/room/$roomId/chat', {'content': content});
  }

  Future<void> likeRoom(int roomId, {bool on = true}) async {
    await _post('/api/live/room/$roomId/like', {'on': on});
  }

  Future<void> favoriteRoom(int roomId, {bool on = true}) async {
    await _post('/api/live/room/$roomId/favorite', {'on': on});
  }

  /// 把相对媒体路径转成绝对地址（供 Image.network / 视频地址打开）
  String absolute(String? url) {
    if (url == null || url.isEmpty) return '';
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    return '$_base$url';
  }

  int toInt(dynamic v) => v is int ? v : int.tryParse('$v') ?? 0;
  String str(dynamic v) => (v ?? '').toString();
}
