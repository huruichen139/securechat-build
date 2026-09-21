import 'dart:io';

import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:open_filex/open_filex.dart';
import 'package:path_provider/path_provider.dart';

import 'services/securechat_api.dart';

const kAppVersion = '1.80.7';

/// Android 鍘熺敓瀹夎鍣ㄩ€氶亾锛歁ainActivity.installApk 閫氳繃 FileProvider 鎷夎捣瀹夎鐣岄潰
const _kInstallerChannel = MethodChannel('securechat/installer');

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

  /// 浠?releaseNotes 鎻愬彇銆屾湰娆℃洿鏂般€嶇殑璇存槑鏂囨湰銆?
  /// releaseNotes 鏀寔涓ょ褰㈡€侊細
  ///   - 鏁扮粍 [{version, date, notes:[...]}, ...]锛氬彇鏈€鏂扮増鏈紙绗竴涓級鐨?notes
  ///   - 鏃х増瀛楃涓诧細鐩存帴杩斿洖
  /// 瀹㈡埛绔彧灞曠ず鏈鏇存柊鐨勫唴瀹癸紝閬垮厤鎶婂巻鍙茬増鏈叏閮ㄥ爢鍦ㄦ洿鏂板脊绐楅噷銆?
  String _currentReleaseNotes(dynamic releaseNotes) {
    if (releaseNotes is List) {
      final head = releaseNotes.isNotEmpty ? releaseNotes.first : null;
      if (head is Map) {
        final notes = head['notes'];
        if (notes is List) {
          return notes.map((n) => n.toString()).where((s) => s.isNotEmpty).join('\n');
        }
        if (notes is String) return notes;
        // 鍏煎鏃ф牸寮忥細{version, date, notes: "鏂囨湰"}
      }
      // 鏁扮粍浣嗛椤逛笉鏄鏈熺粨鏋勶細閫愪釜鐗堟湰鎷兼帴銆寁X: 璇存槑銆?
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

  /// 杩斿洖闇€瑕佹洿鏂扮殑淇℃伅锛涙棤鏇存柊鎴栨棤娉曡幏鍙栬繑鍥?null銆?
  Future<Map<String, dynamic>?> check() async {
    try {
      final data = await api.checkVersion();
      final latest = (data['latest'] ?? data['current'] ?? '').toString();
      if (latest.isEmpty || !isNewer(latest, kAppVersion)) return null;
      final downloads = (data['downloads'] as Map?)?.cast<String, dynamic>() ?? const {};
      // 鎸夊綋鍓嶅钩鍙伴€夋嫨瀹夎鍖咃細鎵嬫満鎷縜pk銆乵ac鎷縟mg銆佸叾浣欐嬁windows
      String dlKey = 'windows';
      if (Platform.isAndroid) dlKey = 'android';
      if (Platform.isIOS) dlKey = 'ios';
      if (Platform.isMacOS) dlKey = 'macos';
      return {
        'latest': latest,
        'download': downloads[dlKey],
        'releaseNotes': _currentReleaseNotes(data['releaseNotes']),
      };
    } catch (_) {
      return null;
    }
  }

  /// 涓嬭浇瀹夎鍖?渚挎惡鍖咃紝杩斿洖淇濆瓨璺緞锛?04 杩斿洖 null銆?
  /// Android 涓嬭浇鍒板閮ㄧ紦瀛樼洰褰曪紙open_filex 鐨?FileProvider 瑕嗙洊璇ヨ矾寰勶紝鍙洿鎺ユ媺璧峰畨瑁呭櫒锛夈€?
  Future<String?> download(String relativePath, {void Function(int, int)? onProgress}) async {
    final uri = api.downloadUri(relativePath);
    final client = http.Client();
    try {
      final name = relativePath.split('/').last;
      String baseDir = Directory.systemTemp.path;
      if (Platform.isAndroid) {
        try {
          // 搴旂敤绉佹湁缂撳瓨鐩綍锛歰pen_filex 鐨?FileProvider 涓€瀹氳鐩?files/cache锛?
          // 澶栭儴缂撳瓨鐩綍(external-cache)鍙兘涓嶅湪鍏?file_paths 鍐呭鑷?content:// 鏃犳硶瑙ｆ瀽銆?
          // 瀹夎鍣ㄩ潤榛樺け璐ャ€傛敼鐢?getApplicationCacheDirectory 纭繚鑳芥媺璧峰畨瑁呯晫闈€?
          final cache = await getApplicationCacheDirectory();
          baseDir = cache.path;
        } catch (_) {
          try {
            final ext = await getExternalCacheDirectories();
            baseDir = (ext != null && ext.isNotEmpty) ? ext.first.path : (await getApplicationCacheDirectory()).path;
          } catch (_) {
            final cache = await getApplicationCacheDirectory();
            baseDir = cache.path;
          }
        }
      }
      if (!Directory(baseDir).existsSync()) Directory(baseDir).createSync(recursive: true);
      final savePath = '$baseDir${Platform.isWindows ? '\\' : '/'}$name';
      final out = File(savePath);
      final resp = await client.send(http.Request('GET', uri));
      // 闈?00涓€寰嬫斁寮冿紙閬垮厤鎶婇敊璇疕TML/鏂囨湰瀛樻垚.exe/.apk鍐嶈鎷夎捣瀹夎锛?
      if (resp.statusCode != 200) { await resp.stream.drain<void>(); return null; }
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

  /// 鎵撳紑/鍚姩涓嬭浇鍒扮殑瀹夎鍖呫€?
  /// Windows锛氱敤 Inno Setup 闈欓粯妯″紡鍚姩瀹夎鍣紝鐒跺悗鑷姩閫€鍑哄綋鍓嶅簲鐢紝
  /// 璁╁畨瑁呭櫒瑕嗙洊瀹夎锛堟棤闇€鐢ㄦ埛鎵嬪姩鍏崇▼搴忥級銆?
  Future<bool> launchInstaller(String path) async {
    try {
      if (Platform.isWindows) {
        // /SILENT = 闈欓粯瀹夎锛堟湁杩涘害鏉℃棤 UI锛?
        // 鍏堝惎鍔ㄥ畨瑁呭櫒锛屽啀閫€鍑哄綋鍓嶈繘绋嬶紝璁╁畨瑁呭櫒瀹屾垚瑕嗙洊
        await Process.run('cmd', ['/c', 'start', '', path, '/SILENT']);
        Future.delayed(const Duration(milliseconds: 500), () => exit(0));
        return true;
      } else if (Platform.isMacOS) {
        final result = await Process.run('open', [path]);
        return result.exitCode == 0;
      } else if (Platform.isAndroid) {
        // 浼樺厛璧板師鐢?installApk锛團ileProvider + 鏈煡鏉ユ簮鏉冮檺寮曞 + ACTION_VIEW锛夋渶鍙潬锛?
        // 澶辫触鍐嶅洖閫€ open_filex
        if (await _nativeInstall(path)) return true;
        final r = await OpenFilex.open(path, type: 'application/vnd.android.package-archive');
        return r.type == ResultType.done;
      } else {
        return false;
      }
    } catch (_) {
      return false;
    }
  }

  Future<bool> _nativeInstall(String path) async {
    try {
      final ok = await _kInstallerChannel.invokeMethod<bool>('installApk', {'path': path});
      return ok == true;
    } catch (_) {
      return false;
    }
  }
}
