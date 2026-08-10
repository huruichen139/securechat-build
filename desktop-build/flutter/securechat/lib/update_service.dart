import 'dart:io';

import 'package:http/http.dart' as http;

import 'services/securechat_api.dart';

const kAppVersion = '1.47.0';

class UpdateService {
  UpdateService({required this.api});
  final SecureChatApi api;

  static int _cmpVersion(String a, String b) {
    final r = RegExp(r'\d+');
    final pa = r.allMatches(a).map((m) => int.parse(m.group(0)!)).toList();
    final pb = r.allMatches(b).map((m) => int.parse(m.group(0)!)).toList();
    final n = pa.length > pb.length ? pa.length : pb.length;
    for (var i = 0; i < n; i++) {
      final x = i < pa.length ? pa[i] : 0;
      final y = i < pb.length ? pb[i] : 0;
      if (x != y) return x < y ? -1 : 1;
    }
    return 0;
  }

  bool isNewer(String latest, String current) => _cmpVersion(latest, current) > 0;

  /// 返回需要更新的信息；无更新或无法获取返回 null。
  Future<Map<String, dynamic>?> check() async {
    try {
      final data = await api.checkVersion();
      final latest = (data['latest'] ?? data['current'] ?? '').toString();
      if (latest.isEmpty || !isNewer(latest, kAppVersion)) return null;
      final downloads = (data['downloads'] as Map?)?.cast<String, dynamic>() ?? const {};
      return {
        'latest': latest,
        'download': downloads['windows'],
        'releaseNotes': (data['releaseNotes'] ?? '').toString(),
      };
    } catch (_) {
      return null;
    }
  }

  /// 下载安装包/便携包，返回保存路径；404 返回 null。
  Future<String?> download(String relativePath, {void Function(int, int)? onProgress}) async {
    final uri = api.downloadUri(relativePath);
    final client = http.Client();
    try {
      final name = relativePath.split('/').last;
      final savePath = '${Directory.systemTemp.path}${Platform.isWindows ? '\\' : '/'}$name';
      final out = File(savePath);
      final resp = await client.send(http.Request('GET', uri));
      if (resp.statusCode == 404) return null;
      final total = resp.contentLength;
      final sink = out.openWrite();
      var loaded = 0;
      await for (final chunk in resp.stream) {
        sink.add(chunk);
        loaded += chunk.length;
        if (total != null && total > 0) onProgress?.call(loaded, total);
      }
      await sink.close();
      return out.path;
    } catch (_) {
      return null;
    } finally {
      client.close();
    }
  }

  /// 打开/启动下载到的安装包。
  Future<bool> launchInstaller(String path) async {
    try {
      if (Platform.isWindows) {
        final result = await Process.run('cmd', ['/c', 'start', '', path]);
        return result.exitCode == 0;
      } else if (Platform.isMacOS) {
        final result = await Process.run('open', [path]);
        return result.exitCode == 0;
      } else if (Platform.isAndroid) {
        await Process.run('am', ['start', '-a', 'android.intent.action.VIEW', '-d', 'file://$path', '-t', '*/*']);
        return true;
      } else {
        return false;
      }
    } catch (_) {
      return false;
    }
  }
}
