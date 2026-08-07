import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:file_picker/file_picker.dart';

import 'services/app_config.dart';
import 'services/securechat_api.dart';

class FileRepositoryPage extends StatefulWidget {
  const FileRepositoryPage({super.key, required this.api, required this.config});

  final SecureChatApi api;
  final AppConfig config;

  @override
  State<FileRepositoryPage> createState() => _FileRepositoryPageState();
}

class _FileRepositoryPageState extends State<FileRepositoryPage> {
  List<Map<String, dynamic>> files = [];
  bool loading = true;
  String? error;
  String? downloadMsg;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      loading = true;
      error = null;
    });
    try {
      final list = await widget.api.myFiles();
      if (!mounted) return;
      setState(() {
        files = list;
        loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        error = e.toString().replaceFirst('Bad state: ', '');
        loading = false;
      });
    }
  }

  String _fmtSize(int? size) {
    if (size == null) return '未知大小';
    if (size < 1024) return '$size B';
    if (size < 1024 * 1024) return '${(size / 1024).toStringAsFixed(1)} KB';
    if (size < 1024 * 1024 * 1024) return '${(size / (1024 * 1024)).toStringAsFixed(1)} MB';
    return '${(size / (1024 * 1024 * 1024)).toStringAsFixed(2)} GB';
  }

  String _fmtTime(int? t) {
    if (t == null || t <= 0) return '';
    final d = DateTime.fromMillisecondsSinceEpoch(t);
    return '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')} ${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
  }

  IconData _iconFor(String name) {
    final lower = name.toLowerCase();
    if (name.endsWith('.zip') || name.endsWith('.tar') || name.endsWith('.gz') || name.endsWith('.rar') || name.endsWith('.7z')) {
      return Icons.folder_zip_outlined;
    }
    if (lower.contains('pdf')) return Icons.picture_as_pdf_outlined;
    if (name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.gif') || name.endsWith('.webp')) {
      return Icons.image_outlined;
    }
    if (name.endsWith('.doc') || name.endsWith('.docx')) return Icons.description_outlined;
    if (name.endsWith('.xls') || name.endsWith('.xlsx')) return Icons.table_chart_outlined;
    if (name.endsWith('.mp4') || name.endsWith('.mov')) return Icons.movie_outlined;
    if (name.endsWith('.mp3') || name.endsWith('.m4a') || name.endsWith('.wav')) return Icons.music_note_outlined;
    return Icons.insert_drive_file_outlined;
  }

  Future<void> _downloadPick(Map<String, dynamic> f) async {
    final id = f['id'] as String;
    final name = (f['name'] ?? 'file').toString();
    setState(() => downloadMsg = '正在下载 $name …');
    try {
      final bytes = await widget.api.fetchFile(id);
      final savePath = (await FilePicker.platform.saveFile(
        dialogTitle: '保存到本地（zip 无需解压即可保存）',
        fileName: name,
        bytes: Uint8List.fromList(bytes),
      ));
      if (savePath == null) {
        if (mounted) setState(() => downloadMsg = '已取消');
        return;
      }
      await File(savePath).writeAsBytes(bytes, flush: true);
      if (!mounted) return;
      setState(() => downloadMsg = '已保存到：$savePath');
    } catch (e) {
      if (!mounted) return;
      setState(() => downloadMsg = '下载失败：${e.toString().replaceFirst('Bad state: ', '')}');
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = widget.config.theme;
    final primary = widget.config.primary;
    return AnimatedBuilder(
      animation: widget.config,
      builder: (context, _) => Scaffold(
        backgroundColor: Colors.transparent,
        appBar: AppBar(
          backgroundColor: Colors.transparent,
          title: const Text('文件仓库'),
          leading: const CloseButton(),
          actions: [IconButton(tooltip: '刷新', onPressed: loading ? null : _load, icon: const Icon(Icons.refresh))],
        ),
        body: loading
            ? const Center(child: CircularProgressIndicator())
            : error != null
                ? Center(child: Text(error!, style: const TextStyle(color: Color(0xffc0392b))))
                : Column(children: [
                    Container(
                      color: primary.withValues(alpha: 0.12),
                      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                      child: Row(children: [
                        Icon(Icons.cloud_done_outlined, color: primary, size: 18),
                        const SizedBox(width: 8),
                        Expanded(child: Text('云端存储：收到的文件在线保存，压缩包直接下载保存、无需解压。', style: TextStyle(color: t.text, fontSize: 12))),
                        Text('${files.length} 个文件', style: TextStyle(color: t.text, fontSize: 12)),
                      ]),
                    ),
                    Expanded(
                      child: files.isEmpty
                          ? Center(child: Text('还没有云端文件', style: TextStyle(color: t.subText)))
                          : ListView.separated(
                              padding: const EdgeInsets.all(12),
                              itemCount: files.length,
                              separatorBuilder: (_, i) => const SizedBox(height: 8),
                              itemBuilder: (_, i) {
                                final f = files[i];
                                return Container(
                                  padding: const EdgeInsets.all(12),
                                  decoration: BoxDecoration(color: t.card.withValues(alpha: 0.82), borderRadius: BorderRadius.circular(14), border: Border.all(color: t.div.withValues(alpha: 0.5))),
                                  child: Row(children: [
                                    Icon(_iconFor((f['name'] ?? '').toString()), color: primary, size: 34),
                                    const SizedBox(width: 12),
                                    Expanded(
                                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                        Text((f['name'] ?? '').toString(), style: TextStyle(color: t.text, fontWeight: FontWeight.w600), maxLines: 1, overflow: TextOverflow.ellipsis),
                                        const SizedBox(height: 4),
                                        Text('${f['kind'] == 'sent' ? '我发送' : '发给 ${f['peer']}'} · ${_fmtSize(f['size'])} · ${_fmtTime(f['time'])}', style: TextStyle(color: t.subText, fontSize: 12)),
                                      ]),
                                    ),
                                    IconButton(
                                      tooltip: '下载',
                                      onPressed: () => _downloadPick(f),
                                      icon: Icon(Icons.download_outlined, color: primary),
                                    ),
                                  ]),
                                );
                              },
                            ),
                    ),
                    if (downloadMsg != null)
                      Container(
                        width: double.infinity,
                        color: t.card,
                        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                        child: Text(downloadMsg!, style: TextStyle(color: t.text, fontSize: 12), maxLines: 2, overflow: TextOverflow.ellipsis),
                      ),
                  ]),
      ),
    );
  }
}
