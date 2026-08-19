/// 新增功能实现库 - 消息翻译、快捷回复、定时发送等
library chat_features;

import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:http/http.dart' as http;
import 'services/securechat_api.dart';

/// 1. 消息翻译 - 弹窗显示
Future<void> showTranslateDialog(BuildContext ctx, SecureChatApi api, String text) async {
  if (text.isEmpty) return;
  final result = await showDialog<String>(
    context: ctx,
    builder: (_) => AlertDialog(
      title: const Text('翻译消息'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text('原文: $text', style: const TextStyle(fontSize: 13)),
          const SizedBox(height: 12),
          TextField(
            decoration: const InputDecoration(
              labelText: '目标语言',
              hintText: '如: en, yue, ja, ko',
              prefixIcon: Icon(Icons.language),
            ),
            onChanged: (v) {},
          ),
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
        TextButton(
          onPressed: () async {
            final uri = Uri.parse('${api.baseUrl}/api/message/translate');
            final resp = await http.post(
              uri,
              headers: {'Content-Type': 'application/json'},
              body: json.encode({'text': text, 'targetLang': 'zh'}),
            );
            if (resp.statusCode == 200) {
              final data = json.decode(resp.body);
              Navigator.pop(ctx, data['translated'] ?? '');
            } else {
              if (ctx.mounted) {
                ScaffoldMessenger.of(ctx).showSnackBar(const SnackBar(content: Text('翻译失败')));
              }
            }
          },
          child: const Text('翻译'),
        ),
      ],
    ),
  );
  if (result != null && ctx.mounted) {
    ScaffoldMessenger.of(ctx).showSnackBar(SnackBar(content: Text('译文: $result')));
  }
}

/// 2. 快捷回复管理器
class QuickReplyManager {
  static final QuickReplyManager _instance = QuickReplyManager._internal();
  QuickReplyManager._internal();
  
  static QuickReplyManager get instance => _instance;
  
  List<Map<String, dynamic>> _replies = [];
  
  Future<void> loadReplies() async {
    final sp = await SharedPreferences.getInstance();
    final list = sp.getStringList('quick_replies') ?? [];
    _replies = list.map((e) => json.decode(e) as Map<String, dynamic>).toList();
  }
  
  Future<List<Map<String, dynamic>>> getReplies() async {
    if (_replies.isEmpty) await loadReplies();
    return _replies;
  }
  
  Future<void> addReply(String title, String content) async {
    final sp = await SharedPreferences.getInstance();
    _replies.add({'title': title, 'content': content});
    await sp.setStringList('quick_replies', _replies.map((e) => json.encode(e)).toList());
  }
  
  Future<void> removeReply(int index) async {
    final sp = await SharedPreferences.getInstance();
    _replies.removeAt(index);
    await sp.setStringList('quick_replies', _replies.map((e) => json.encode(e)).toList());
  }
}

/// 3. 快捷回复面板
Future<void> showQuickRepliesSheet(BuildContext ctx, SecureChatApi api) async {
  await QuickReplyManager.instance.loadReplies();
  final replies = await QuickReplyManager.instance.getReplies();
  if (!ctx.mounted) return;
  
  showModalBottomSheet(
    context: ctx,
    builder: (_) => SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const ListTile(title: Text('快捷回复'), leading: Icon(Icons.short_text)),
          ...replies.map((r) => ListTile(
            title: Text(r['title']),
            subtitle: Text((r['content'] ?? '').toString().substring(0, [50, (r['content'] ?? '').length].reduce((a, b) => a < b ? a : b))),
            onTap: () => Navigator.pop(ctx, r['content']),
          )),
          const SizedBox(height: 8),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: FilledButton(
              onPressed: () async {
                final title = await showDialog<String>(context: ctx, builder: (_) => AlertDialog(
                  title: const Text('添加快捷回复'),
                  content: TextField(decoration: const InputDecoration(hintText: '标题')),
                  actions: [
                    TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
                    TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('确定')),
                  ],
                ));
                // 简化实现，实际可完善
              },
              child: const Text('添加快捷回复'),
            ),
          ),
          const SizedBox(height: 16),
        ],
      ),
    ),
  );
}

/// 4. 定时发送对话框
Future<void> showScheduleDialog(BuildContext ctx, SecureChatApi api, int peerId, bool isGroup) async {
  final contentCtrl = TextEditingController();
  final dateCtrl = TextEditingController();
  final timeCtrl = TextEditingController();
  
  final pickedDate = await showDatePicker(
    context: ctx,
    initialDate: DateTime.now().add(const Duration(days: 1)),
    firstDate: DateTime.now(),
    lastDate: DateTime.now().add(const Duration(days: 365)),
  );
  if (pickedDate == null) return;
  dateCtrl.text = pickedDate.toString().split(' ').first;
  
  final pickedTime = await showTimePicker(context: ctx, initialTime: TimeOfDay.now());
  if (pickedTime == null) return;
  timeCtrl.text = pickedTime.format(ctx);
  
  await showDialog(
    context: ctx,
    builder: (_) => AlertDialog(
      title: const Text('定时发送'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text('日期: ${dateCtrl.text}'),
          Text('时间: ${timeCtrl.text}'),
          const SizedBox(height: 12),
          TextField(
            controller: contentCtrl,
            decoration: const InputDecoration(
              labelText: '消息内容',
              hintText: '将在设定时间自动发送',
            ),
            maxLines: 3,
          ),
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
        TextButton(
          onPressed: () async {
            final scheduledAt = DateTime.parse('${dateCtrl.text} ${timeCtrl.text}:00').millisecondsSinceEpoch;
            final uri = Uri.parse('${api.baseUrl}/api/scheduled-messages');
            final resp = await http.post(
              uri,
              headers: {'Content-Type': 'application/json'},
              body: json.encode({
                'peerId': peerId,
                'isGroup': isGroup,
                'content': contentCtrl.text,
                'kind': 'text',
                'scheduledAt': scheduledAt,
              }),
            );
            if (resp.statusCode == 200 && ctx.mounted) {
              Navigator.pop(ctx);
              ScaffoldMessenger.of(ctx).showSnackBar(const SnackBar(content: Text('定时发送已预约')));
            }
          },
          child: const Text('确定'),
        ),
      ],
    ),
  );
}

/// 5. 阅后即焚
Future<void> showBurnDialog(BuildContext ctx, Map<String, dynamic> msg, SecureChatApi api, int peerId, bool isGroup) async {
  final duration = await showDialog<int>(
    context: ctx,
    builder: (_) => AlertDialog(
      title: const Text('选择销毁时间'),
      content: Column(mainAxisSize: MainAxisSize.min, children: [
        ListTile(title: const Text('30秒'), onTap: () => Navigator.pop(ctx, 30)),
        ListTile(title: const Text('1分钟'), onTap: () => Navigator.pop(ctx, 60)),
        ListTile(title: const Text('5分钟'), onTap: () => Navigator.pop(ctx, 300)),
      ]),
    ),
  );
  if (duration == null) return;
  
  final msgId = msg['id'];
  // 调用服务端 burn 接口
  final uri = Uri.parse('${api.baseUrl}/api/message/burn');
  await http.post(uri, headers: {'Content-Type': 'application/json'}, body: json.encode({
    'messageId': msgId,
    'duration': duration,
  }));
  
  if (ctx.mounted) {
    ScaffoldMessenger.of(ctx).showSnackBar(SnackBar(content: Text('已设置阅后即焚: $duration 秒后销毁')));
  }
}

/// 6. 语音转文字
Future<void> showTranscribeDialog(BuildContext ctx, SecureChatApi api, Map<String, dynamic> msg) async {
  // 获取音频文件路径
  final voiceId = msg['voiceId'];
  if (voiceId == null) return;
  
  ScaffoldMessenger.of(ctx).showSnackBar(const SnackBar(content: Text('语音转文字功能开发中，请等待后续版本')));
}

/// 7. 图片 OCR
Future<void> showOCRDialog(BuildContext ctx, SecureChatApi api, Map<String, dynamic> msg) async {
  ScaffoldMessenger.of(ctx).showSnackBar(const SnackBar(content: Text('OCR功能开发中，请等待后续版本')));
}

/// 8. 快捷回复按钮 (在 composer 中使用)
Widget quickReplyButton(BuildContext context, SecureChatApi api) {
  return IconButton(
    tooltip: '快捷回复',
    onPressed: () => showQuickRepliesSheet(context, api),
    icon: const Icon(Icons.short_text),
  );
}

/// 9. 定时发送按钮
Widget scheduleButton(BuildContext context, SecureChatApi api, int peerId, bool isGroup) {
  return IconButton(
    tooltip: '定时发送',
    onPressed: () => showScheduleDialog(context, api, peerId, isGroup),
    icon: const Icon(Icons.schedule),
  );
}