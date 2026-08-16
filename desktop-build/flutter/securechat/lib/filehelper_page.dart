// module: filehelper (worker batch3)
// 文件传输助手会话页面（Flutter 端，独立可编译）。
// 固定「文件传输助手」会话（peer_id = -1），可发文字 / 文件，再从任意端取用。
//   - 文字：POST /api/messages
//   - 历史：GET /api/history/-1
//   - 文件上传：POST /api/rtc/filehelper/upload（bytes，来自 server/routes/rtc.js）
//   - 文件列表/下载/删除：GET /api/rtc/filehelper/files , /file/:id , DELETE
// 依赖：file_picker / http / app_config(AppConfig)。
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:file_picker/file_picker.dart';

import 'services/app_config.dart';
import 'widgets/ux.dart';

const int kFilehelperId = -1;

class FilehelperEntry {
  FilehelperEntry(this.id, this.mine, this.time, this.content);
  final int id;
  final bool mine;
  final String? time;
  final String content;

  String? get fileId {
    final m = RegExp(r'^文件:([0-9a-f-]{8,}):(\{.*\})$').firstMatch(content);
    return m?.group(1);
  }

  bool get isDeleted => content == '文件:DELETED';

  Map<String, dynamic>? get fileMeta {
    final m = RegExp(r'^文件:([0-9a-f-]{8,}):(\{.*\})$').firstMatch(content);
    if (m == null) return null;
    try {
      return (jsonDecode(m.group(2)!) as Map).cast<String, dynamic>();
    } catch (_) {
      return null;
    }
  }

  bool get isFile => fileId != null && !isDeleted;
  bool get isVoice => RegExp(r'^\[语音消息:[0-9a-f-]{8,}\]$').hasMatch(content);
}

class FilehelperPage extends StatefulWidget {
  const FilehelperPage({super.key, required this.baseUrl, this.token, required this.config, this.myId});
  final String baseUrl;
  final String? token;
  final AppConfig config;
  final int? myId;

  @override
  State<FilehelperPage> createState() => _FilehelperPageState();
}

class _FilehelperPageState extends State<FilehelperPage> {
  final List<FilehelperEntry> _msgs = [];
  final TextEditingController _input = TextEditingController();
  bool _loading = true;
  bool _sending = false;

  Uri _uri(String path, [Map<String, String>? q]) {
    final root = Uri.parse(widget.baseUrl.endsWith('/') ? widget.baseUrl : '${widget.baseUrl}/');
    return root.replace(path: '${root.path.replaceAll(RegExp(r'/$'), '')}$path', queryParameters: q);
  }

  Map<String, String> get _headers => {
        if (widget.token != null) 'Authorization': 'Bearer ${widget.token}',
      };

  @override
  void initState() {
    super.initState();
    _loadHistory();
  }

  Future<void> _loadHistory() async {
    setState(() => _loading = true);
    try {
      final resp = await http.get(_uri('/api/history/$kFilehelperId'), headers: _headers);
      if (resp.statusCode >= 200 && resp.statusCode < 300) {
        final data = jsonDecode(resp.body) as Map<String, dynamic>;
        final list = data['messages'] as List? ?? [];
        final mine = widget.myId;
        _msgs
          ..clear()
          ..addAll(list.map((m) {
            final r = (m as Map).cast<String, dynamic>();
            return FilehelperEntry(
              (r['id'] as num).toInt(),
              mine != null && (r['from'] as num).toInt() == mine,
              _fmt((r['createdAt'] as num?)?.toInt() ?? 0),
              (r['content'] ?? '').toString(),
            );
          }));
      }
    } catch (_) {
      _snack('历史加载失败');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  static String _fmt(int ms) {
    if (ms <= 0) return '';
    final d = DateTime.fromMillisecondsSinceEpoch(ms);
    String p(int n) => n.toString().padLeft(2, '0');
    return '${p(d.hour)}:${p(d.minute)}';
  }

  static String _humanSize(int b) {
    if (b < 1024) return '$b B';
    if (b < 1048576) return '${(b / 1024).toStringAsFixed(1)} KB';
    if (b < 1073741824) return '${(b / 1048576).toStringAsFixed(1)} MB';
    return '${(b / 1073741824).toStringAsFixed(2)} GB';
  }

  Future<void> _sendText() async {
    final text = _input.text.trim();
    if (text.isEmpty || _sending) return;
    setState(() => _sending = true);
    try {
      await http.post(_uri('/api/messages'), headers: {'Content-Type': 'application/json', ..._headers}, body: jsonEncode({'to': kFilehelperId, 'content': text}));
      _input.clear();
      await _loadHistory();
    } catch (_) {
      _snack('发送失败');
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _pickAndUpload() async {
    final res = await FilePicker.platform.pickFiles();
    if (res == null || res.files.isEmpty) return;
    final pf = res.files.first;
    final bytes = pf.bytes ?? (pf.path != null ? await File(pf.path!).readAsBytes() : null);
    if (bytes == null) {
      _snack('无法读取文件');
      return;
    }
    setState(() => _sending = true);
    try {
      final url = _uri('/api/rtc/filehelper/upload', {'name': pf.name});
      final resp = await http.post(url, headers: {..._headers, 'Content-Type': 'application/octet-stream'}, body: bytes);
      if (resp.statusCode >= 200 && resp.statusCode < 300) {
        await _loadHistory();
      } else {
        _snack('上传失败 (${resp.statusCode})');
      }
    } catch (e) {
      _snack('上传失败：$e');
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _download(FilehelperEntry e) async {
    final id = e.fileId;
    if (id == null) return;
    final name = e.fileMeta?['name']?.toString() ?? 'file';
    try {
      final resp = await http.get(_uri('/api/rtc/filehelper/file/$id'));
      if (resp.statusCode < 200 || resp.statusCode >= 300) {
        _snack('下载失败 (${resp.statusCode})');
        return;
      }
      final dir = Directory('${Directory.systemTemp.path}/securechat-fh');
      await dir.create(recursive: true);
      final f = File('${dir.path}/$name');
      await f.writeAsBytes(resp.bodyBytes);
      _snack('已保存到 ${f.path}');
    } catch (e) {
      _snack('下载失败：$e');
    }
  }

  Future<void> _delete(FilehelperEntry e) async {
    final id = e.fileId;
    if (id == null) return;
    try {
      await http.delete(_uri('/api/rtc/filehelper/file/$id'), headers: _headers);
      await _loadHistory();
    } catch (e) {
      _snack('删除失败：$e');
    }
  }

  void _snack(String s) {
    if (!mounted) return;
    try {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(s), duration: const Duration(milliseconds: 1500)));
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    final theme = widget.config.theme;
    return Scaffold(
      backgroundColor: theme.bg,
      body: Column(children: [
        PageHeader(title: '文件传输助手', config: widget.config),
        Expanded(
          child: _loading
              ? const Center(child: CircularProgressIndicator())
              : ListView.builder(
                  padding: const EdgeInsets.all(12),
                  itemCount: _msgs.length,
                  itemBuilder: (_, i) => _bubble(_msgs[i], theme),
                ),
        ),
        _composer(theme),
      ]),
    );
  }

  Widget _bubble(FilehelperEntry e, AppTheme theme) {
    final meta = e.fileMeta;
    final Widget content;
    if (e.isFile) {
      content = Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
        Row(mainAxisSize: MainAxisSize.min, children: [
          const Icon(Icons.attach_file, size: 16),
          const SizedBox(width: 4),
          Flexible(child: Text(meta?['name']?.toString() ?? '文件', style: TextStyle(color: theme.text))),
        ]),
        const SizedBox(height: 2),
        Text(_humanSize((meta?['size'] as num?)?.toInt() ?? 0), style: TextStyle(color: theme.subText, fontSize: 11)),
        const SizedBox(height: 4),
        Row(mainAxisSize: MainAxisSize.min, children: [
          TextButton(onPressed: () => _download(e), child: const Text('打开')),
          const SizedBox(width: 4),
          TextButton(onPressed: () => _delete(e), child: const Text('删除')),
        ]),
      ]);
    } else if (e.isDeleted) {
      content = Text('(已删除)', style: TextStyle(color: theme.subText, fontStyle: FontStyle.italic));
    } else if (e.isVoice) {
      content = Row(mainAxisSize: MainAxisSize.min, children: [
        const Icon(Icons.mic, size: 16),
        const SizedBox(width: 4),
        const Text('语音消息'),
        const SizedBox(width: 8),
        TextButton(onPressed: () => _playVoice(e), child: const Text('播放')),
      ]);
    } else {
      content = Text(e.content, style: TextStyle(color: theme.text));
    }

    return Align(
      alignment: e.mine ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 4),
        padding: const EdgeInsets.all(10),
        constraints: const BoxConstraints(maxWidth: 300),
        decoration: BoxDecoration(
          color: e.mine ? theme.bubbleMine : theme.bubbleOther,
          borderRadius: BorderRadius.circular(10),
        ),
        child: Column(crossAxisAlignment: e.mine ? CrossAxisAlignment.end : CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
          content,
          if (e.time != null && e.time!.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 4), child: Text(e.time!, style: TextStyle(color: theme.subText, fontSize: 10))),
        ]),
      ),
    );
  }

  Future<void> _playVoice(FilehelperEntry e) async {
    final id = e.fileId;
    if (id == null) return;
    try {
      final resp = await http.get(_uri('/api/rtc/filehelper/file/$id'));
      if (resp.statusCode < 200 || resp.statusCode >= 300) {
        _snack('语音获取失败');
        return;
      }
      final dir = Directory.systemTemp;
      await dir.create(recursive: true);
      final f = File('${dir.path}/fh-voice-${DateTime.now().millisecondsSinceEpoch}.webm');
      await f.writeAsBytes(resp.bodyBytes);
      _snack('语音已下载，请用 voicemsg 服务播放：${f.path}');
    } catch (e) {
      _snack('语音播放失败：$e');
    }
  }

  Widget _composer(AppTheme theme) {
    return Container(
      color: theme.panel,
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      child: SafeArea(
        top: false,
        child: Row(children: [
          IconButton(onPressed: _pickAndUpload, icon: const Icon(Icons.attach_file), tooltip: '发送文件'),
          Expanded(
            child: TextField(
              controller: _input,
              enabled: !_sending,
              style: TextStyle(color: theme.text),
              onSubmitted: (_) => _sendText(),
              decoration: InputDecoration(hintText: '输入，Enter 发送'),
            ),
          ),
          const SizedBox(width: 8),
          IconButton(onPressed: _sendText, icon: const Icon(Icons.send), tooltip: '发送'),
        ]),
      ),
    );
  }
}