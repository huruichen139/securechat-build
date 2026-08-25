import 'dart:io';

import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:open_filex/open_filex.dart';
import 'package:path_provider/path_provider.dart';

import 'services/securechat_api.dart';

const kAppVersion = '1.71.9';

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

  /// 从 releaseNotes 提取「本次更新」的说明文本。
  /// releaseNotes 支持两种形态：
  ///   - 数组 [{version, date, notes:[...]}, ...]：取最新版本（第一个）的 notes
  ///   - 旧版字符串：直接返回
  /// 客户端只展示本次更新的内容，避免把历史版本全部堆在更新弹窗里。
  String _currentReleaseNotes(dynamic releaseNotes) {
    if (releaseNotes is List) {
      final head = releaseNotes.isNotEmpty ? releaseNotes.first : null;
      if (head is Map) {
        final notes = head['notes'];
        if (notes is List) {
          return notes.map((n) => n.toString()).where((s) => s.isNotEmpty).join('\n');
        }
        if (notes is String) return notes;
        // 兼容旧格式：{version, date, notes: "文本"}
      }
      // 数组但首项不是预期结构：逐个版本拼接「vX: 说明」
      final lines = <String>[];
      for (final e in releaseNotes) {
        if (e is! Map) continue;
        final v = e['version'];
        final notes = e['notes'];
        if (notes is List) {
          lines.add(v == null ? notes.join('\n') : 'v$v\n${notes.join('\n')}');
        } else if (notes is String) {
          lines.add(v == null ? notes : 'v$v\n$notes');
        }
      }
      return lines.join('\n\n');
    }
    return (releaseNotes ?? '').toString();
  }

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
        'releaseNotes': _currentReleaseNotes(data['releaseNotes']),
      };
    } catch (_) {
      return null;
    }
  }

  /// 下载安装包/便携包，返回保存路径；404 返回 null。
  /// Android 下载到外部缓存目录（open_filex 的 FileProvider 覆盖该路径，可直接拉起安装器）。
  Future<String?> download(String relativePath, {void Function(int, int)? onProgress}) async {
    final uri = api.downloadUri(relativePath);
    final client = http.Client();
    try {
      final name = relativePath.split('/').last;
      String baseDir = Directory.systemTemp.path;
      if (Platform.isAndroid) {
        try {
          final ext = await getExternalCacheDirectories();
          baseDir = (ext != null && ext.isNotEmpty) ? ext.first.path : (await getApplicationCacheDirectory()).path;
        } catch (_) {
          final cache = await getApplicationCacheDirectory();
          baseDir = cache.path;
        }
      }
      if (!Directory(baseDir).existsSync()) Directory(baseDir).createSync(recursive: true);
      final savePath = '$baseDir${Platform.isWindows ? '\\' : '/'}$name';
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

  static const _installerChannel = MethodChannel('securechat/installer');

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
        // open_filex：内部处理 FileProvider(content://)、未知来源权限引导与 MIME 注册
        try {
          final r = await OpenFilex.open(path, type: 'application/vnd.android.package-archive');
          return r.type == ResultType.done;
        } catch (_) {
          // 兜底（老系统）
          await Process.run('am', ['start', '-a', 'android.intent.action.VIEW', '-d', 'file://$path', '-t', '*/*']);
          return true;
        }
      } else {
        return false;
      }
    } catch (_) {
      return false;
    }
  }
}
