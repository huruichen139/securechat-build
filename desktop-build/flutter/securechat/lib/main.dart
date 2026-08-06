import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:record/record.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'services/securechat_api.dart';
import 'services/call_service.dart';
import 'call_page.dart';
import 'qr_confirm_page.dart';

void main() => runApp(const SecureChatApp());

class SecureChatApp extends StatelessWidget {
  const SecureChatApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      title: 'SecureChat',
      theme: ThemeData(
        useMaterial3: true,
        scaffoldBackgroundColor: const Color(0xfff5f7f9),
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xff18a66a)),
        fontFamily: 'Segoe UI',
        inputDecorationTheme: InputDecorationTheme(
          filled: true,
          fillColor: const Color(0xfff1f4f6),
          border: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide.none),
          contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
        ),
      ),
      home: const LoginPage(),
    );
  }
}

class LoginPage extends StatefulWidget {
  const LoginPage({super.key});
  @override
  State<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> {
  int mode = 0;
  final api = SecureChatApi();
  Timer? qrTimer;
  String? qrText;
  bool busy = false;
  String? error;
  final account = TextEditingController();
  final password = TextEditingController();
  final email = TextEditingController();
  final code = TextEditingController();

  @override
  void dispose() {
    qrTimer?.cancel();
    account.dispose();
    password.dispose();
    email.dispose();
    code.dispose();
    super.dispose();
  }

  Future<void> login() async {
    if (busy) return;
    setState(() { busy = true; error = null; });
    try {
      if (mode == 0) {
        await api.login(account.text.trim(), password.text);
      } else if (mode == 1) {
        await api.loginByCode(email.text.trim(), code.text.trim());
      } else {
        if (qrText == null) await beginQr();
        return;
      }
      if (!mounted) return;
      Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => ChatShell(api: api)));
    } catch (e) {
      if (mounted) setState(() => error = e.toString().replaceFirst('Bad state: ', ''));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> beginQr() async {
    try {
      final data = await api.createQrLogin();
      final token = data['token'] as String?;
      final text = data['qrText'] as String?;
      if (token == null || text == null) throw StateError('二维码创建失败');
      setState(() { qrText = text; error = null; });
      qrTimer?.cancel();
      qrTimer = Timer.periodic(const Duration(seconds: 2), (_) async {
        try {
          final status = await api.qrStatus(token);
          if (status['status'] == 'confirmed') {
            qrTimer?.cancel();
            final result = await api.consumeQrLogin(token);
            if (!mounted) return;
            if (result['status'] != 'ok') throw StateError('二维码尚未确认');
            Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => ChatShell(api: api)));
          }
        } catch (e) {
          qrTimer?.cancel();
          if (mounted) setState(() => error = e.toString().replaceFirst('Bad state: ', ''));
        }
      });
    } catch (e) {
      if (mounted) setState(() => error = e.toString().replaceFirst('Bad state: ', ''));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Stack(children: [
        Positioned.fill(child: Container(color: const Color(0xff10201d))),
        Align(
          alignment: Alignment.center,
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 980, maxHeight: 620),
            child: LayoutBuilder(builder: (context, box) {
              final compact = box.maxWidth < 700;
              return Container(
                decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(24), boxShadow: const [BoxShadow(color: Colors.black26, blurRadius: 35, offset: Offset(0, 18))]),
                child: Row(children: [
                  if (!compact) const Expanded(child: WelcomePanel()),
                  Expanded(child: Padding(padding: EdgeInsets.all(compact ? 28 : 58), child: _form(context))),
                ]),
              );
            }),
          ),
        ),
      ]),
    );
  }

  Widget _form(BuildContext context) {
    return Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisAlignment: MainAxisAlignment.center, children: [
      const Text('登录 SecureChat', style: TextStyle(fontSize: 28, fontWeight: FontWeight.w800, color: Color(0xff17212b))),
      const SizedBox(height: 8),
      const Text('你的消息，只属于你和收件人。', style: TextStyle(color: Color(0xff77818a))),
      const SizedBox(height: 30),
      Row(children: [
        _mode('密码登录', 0),
        _mode('邮箱验证码', 1),
        _mode('扫码登录', 2),
      ]),
      const SizedBox(height: 22),
      if (mode == 0) ...[
        TextField(controller: account, decoration: const InputDecoration(labelText: '用户名或邮箱')),
        const SizedBox(height: 12),
        TextField(controller: password, obscureText: true, decoration: const InputDecoration(labelText: '密码')),
      ] else if (mode == 1) ...[
        TextField(controller: email, decoration: const InputDecoration(labelText: '邮箱地址')),
        const SizedBox(height: 12),
        Row(children: [Expanded(child: TextField(controller: code, decoration: const InputDecoration(labelText: '验证码'))), const SizedBox(width: 10), OutlinedButton(onPressed: () {}, child: const Text('获取验证码'))]),
      ] else ...[
        Center(child: Column(children: [
          Container(width: 176, height: 176, padding: const EdgeInsets.all(12), decoration: BoxDecoration(border: Border.all(color: const Color(0xffdbe4e1)), borderRadius: BorderRadius.circular(16)), child: qrText == null ? const _QrPlaceholder() : QrImageView(data: qrText!, version: QrVersions.auto)),
          const SizedBox(height: 14),
          const Text('请使用已登录的手机扫描此二维码', style: TextStyle(fontWeight: FontWeight.w600)),
          const SizedBox(height: 4),
          const Text('手机确认后，电脑端会自动登录', style: TextStyle(color: Color(0xff77818a), fontSize: 12)),
        ])),
      ],
      if (error != null) Padding(padding: const EdgeInsets.only(top: 14), child: Text(error!, style: const TextStyle(color: Color(0xffc0392b), fontSize: 12))),
      const SizedBox(height: 24),
      SizedBox(width: double.infinity, height: 48, child: FilledButton(onPressed: busy ? null : (mode == 2 ? beginQr : login), child: Text(busy ? '处理中…' : mode == 2 ? (qrText == null ? '生成二维码' : '等待手机确认') : '登录'))),
      const SizedBox(height: 18),
      const Center(child: Text('SecureChat 1.25.0', style: TextStyle(color: Color(0xffa3adb3), fontSize: 12))),
    ]);
  }

  Widget _mode(String label, int value) => Expanded(child: GestureDetector(onTap: () => setState(() => mode = value), child: AnimatedContainer(duration: const Duration(milliseconds: 180), padding: const EdgeInsets.symmetric(vertical: 11), decoration: BoxDecoration(color: mode == value ? const Color(0xffe5f6ed) : Colors.transparent, borderRadius: BorderRadius.circular(10)), child: Center(child: Text(label, style: TextStyle(fontSize: 12, color: mode == value ? const Color(0xff138752) : const Color(0xff77818a), fontWeight: mode == value ? FontWeight.w700 : FontWeight.w500))))));
}

class WelcomePanel extends StatelessWidget {
  const WelcomePanel({super.key});
  @override
  Widget build(BuildContext context) => Container(decoration: const BoxDecoration(color: Color(0xff163d32), borderRadius: BorderRadius.horizontal(left: Radius.circular(24))), padding: const EdgeInsets.all(52), child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisAlignment: MainAxisAlignment.center, children: [
    Container(width: 54, height: 54, decoration: BoxDecoration(color: const Color(0xff23b878), borderRadius: BorderRadius.circular(16)), child: const Icon(Icons.lock_rounded, color: Colors.white, size: 28)),
    const SizedBox(height: 30), const Text('私密地聊天，\n自然地沟通。', style: TextStyle(color: Colors.white, fontSize: 34, height: 1.08, fontWeight: FontWeight.w800)),
    const SizedBox(height: 20), const Text('端到端加密 · 多端同步 · 音视频通话', style: TextStyle(color: Color(0xffa9d9c4), fontSize: 14)),
  ]));
}

class _QrPlaceholder extends StatelessWidget {
  const _QrPlaceholder();
  @override
  Widget build(BuildContext context) => CustomPaint(painter: _QrPainter());
}

class _QrPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final p = Paint()..color = const Color(0xff17212b);
    const n = 19;
    final cell = size.width / n;
    for (var y = 0; y < n; y++) {
      for (var x = 0; x < n; x++) {
        final finder = (x < 7 && y < 7) || (x > 11 && y < 7) || (x < 7 && y > 11);
        final edge = finder && ((x % 6 == 0) || (y % 6 == 0));
        final fill = finder ? edge || (x > 1 && x < 5 && y > 1 && y < 5) : ((x * 7 + y * 11 + x * y) % 5 < 2);
        if (fill) canvas.drawRect(Rect.fromLTWH(x * cell, y * cell, cell - 1, cell - 1), p);
      }
    }
  }
  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

class ChatShell extends StatefulWidget {
  const ChatShell({super.key, required this.api});
  final SecureChatApi api;
  @override
  State<ChatShell> createState() => _ChatShellState();
}

class _ChatShellState extends State<ChatShell> {
  int selected = 0;
  final input = TextEditingController();
  final messages = <Map<String, dynamic>>[
    {'text': '欢迎使用 SecureChat', 'mine': false, 'time': '09:41'},
  ];
  WebSocketChannel? socket;
  CallService? calls;
  final recorder = AudioRecorder();
  bool recording = false;

  @override
  void initState() {
    super.initState();
    _connect();
  }

  void _connect() {
    try {
      socket = widget.api.connect();
      socket!.stream.listen((event) {
        final root = jsonDecode(event as String) as Map<String, dynamic>;
        final type = root['type'];
        if (type == 'msg') {
          final p = (root['payload'] as Map).cast<String, dynamic>();
          if (!mounted) return;
          setState(() => messages.add({'text': p['content'] ?? '', 'mine': false, 'time': '现在'}));
        } else if (type == 'signal') {
          final p = (root['payload'] as Map).cast<String, dynamic>();
          final service = calls;
          if (service != null) {
            service.onSignal(p['from'] as int?, p['sub'] as String?, p['data']);
            if (service.status == CallStatus.ringing && mounted) {
              Navigator.of(context).push(MaterialPageRoute(builder: (_) => CallPage(service: service, peerName: '林默')));
            }
          }
        }
      }, onError: (_) {});
    } catch (_) {}
  }

  Future<void> _startCall(bool video) async {
    final service = calls ??= CallService(socket: socket!);
    if (service.busy) return;
    await service.startCall(2, withVideo: video);
    if (!mounted) return;
    Navigator.of(context).push(MaterialPageRoute(builder: (_) => CallPage(service: service, peerName: '林默')));
  }

  Future<void> _toggleRecording() async {
    if (recording) {
      final path = await recorder.stop();
      setState(() => recording = false);
      if (path == null) return;
      try {
        final uploaded = await widget.api.uploadVoice(2, await File(path).readAsBytes(), 'voice-${DateTime.now().millisecondsSinceEpoch}.m4a');
        final id = uploaded['id'];
        socket?.sink.add(jsonEncode({'type': 'msg', 'payload': {'to': 2, 'content': '[语音消息:$id]', 'clientMsgId': 'v${DateTime.now().microsecondsSinceEpoch}'}}));
        setState(() => messages.add({'text': '语音消息', 'mine': true, 'time': '现在'}));
      } catch (e) {
        if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('语音发送失败：$e')));
      }
      return;
    }
    if (!await recorder.hasPermission()) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('需要麦克风权限')));
      return;
    }
    await recorder.start(const RecordConfig(encoder: AudioEncoder.aacLc, bitRate: 64000, sampleRate: 44100), path: '${Directory.systemTemp.path}/securechat-${DateTime.now().millisecondsSinceEpoch}.m4a');
    setState(() => recording = true);
  }

  @override
  void dispose() {
    socket?.sink.close();
    calls?.dispose();
    recorder.dispose();
    input.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(backgroundColor: const Color(0xfff4f6f8), body: SafeArea(child: LayoutBuilder(builder: (context, c) {
      final desktop = c.maxWidth >= 760;
      return Row(children: [
        if (desktop) _sidebar(c.maxWidth),
        Expanded(child: _conversation()),
      ]);
    })));
  }

  Widget _sidebar(double width) => SizedBox(width: width < 1000 ? 290 : 330, child: Container(color: const Color(0xff17212b), child: Column(children: [
    Padding(padding: const EdgeInsets.fromLTRB(18, 20, 14, 12), child: Row(children: [const CircleAvatar(backgroundColor: Color(0xff23b878), child: Text('S', style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold))), const SizedBox(width: 10), const Expanded(child: Text('我的消息', style: TextStyle(color: Colors.white, fontSize: 17, fontWeight: FontWeight.w700))), IconButton(onPressed: () {}, icon: const Icon(Icons.edit_square, color: Color(0xffb5c2ca)))])),
    Padding(padding: const EdgeInsets.symmetric(horizontal: 14), child: TextField(style: const TextStyle(color: Colors.white), decoration: InputDecoration(hintText: '搜索会话', hintStyle: const TextStyle(color: Color(0xff82919b)), prefixIcon: const Icon(Icons.search, color: Color(0xff82919b)), fillColor: const Color(0xff24323d)))),
    const SizedBox(height: 14),
    Expanded(child: ListView(children: [_conversationTile('林默', '更清爽了，通话和语音也放在这里。', Icons.person, true), _conversationTile('SecureChat 团队', '新的客户端看起来怎么样？', Icons.groups_rounded, false), _conversationTile('文件传输助手', '暂无新消息', Icons.folder_rounded, false)])),
    const Padding(padding: EdgeInsets.all(18), child: Row(children: [Icon(Icons.settings_outlined, color: Color(0xff9aabb5), size: 19), SizedBox(width: 10), Text('设置', style: TextStyle(color: Color(0xff9aabb5)))])),
  ])));

  Widget _conversationTile(String title, String preview, IconData icon, bool active) => Container(margin: const EdgeInsets.symmetric(horizontal: 8, vertical: 3), padding: const EdgeInsets.all(10), decoration: BoxDecoration(color: active ? const Color(0xff2a3d49) : Colors.transparent, borderRadius: BorderRadius.circular(12)), child: Row(children: [CircleAvatar(radius: 22, backgroundColor: const Color(0xffd9eee4), child: Icon(icon, color: const Color(0xff168457))), const SizedBox(width: 10), Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(title, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w600)), const SizedBox(height: 4), Text(preview, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Color(0xff9aabb5), fontSize: 12))])), const Text('09:43', style: TextStyle(color: Color(0xff82919b), fontSize: 10))]));

  Widget _conversation() => Column(children: [
    Container(height: 70, padding: const EdgeInsets.symmetric(horizontal: 24), decoration: const BoxDecoration(color: Colors.white, border: Border(bottom: BorderSide(color: Color(0xffe3e8eb)))), child: Row(children: [const CircleAvatar(backgroundColor: Color(0xffd9eee4), child: Icon(Icons.person, color: Color(0xff168457))), const SizedBox(width: 12), const Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.start, children: [Text('林默', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 16)), Text('在线', style: TextStyle(color: Color(0xff18a66a), fontSize: 12))]),         const Spacer(), IconButton(tooltip: '手机扫码登录授权', onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => QrConfirmPage(api: widget.api))), icon: const Icon(Icons.qr_code_scanner)), IconButton(tooltip: '语音通话', onPressed: () => _startCall(false), icon: const Icon(Icons.call_outlined)), IconButton(tooltip: '视频通话', onPressed: () => _startCall(true), icon: const Icon(Icons.videocam_outlined)), IconButton(tooltip: '更多', onPressed: () {}, icon: const Icon(Icons.more_horiz))])),
    Expanded(child: ListView.builder(padding: const EdgeInsets.fromLTRB(24, 22, 24, 16), itemCount: messages.length, itemBuilder: (_, i) => _bubble(messages[i]))),
    _composer(),
  ]);

  Widget _bubble(Map<String, dynamic> msg) { final mine = msg['mine'] as bool; return Align(alignment: mine ? Alignment.centerRight : Alignment.centerLeft, child: Padding(padding: const EdgeInsets.only(bottom: 14), child: Row(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.end, children: [if (!mine) const CircleAvatar(radius: 16, backgroundColor: Color(0xffd9eee4), child: Icon(Icons.person, size: 17, color: Color(0xff168457))), if (!mine) const SizedBox(width: 8), Column(crossAxisAlignment: mine ? CrossAxisAlignment.end : CrossAxisAlignment.start, children: [Container(constraints: const BoxConstraints(maxWidth: 520), padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 11), decoration: BoxDecoration(color: mine ? const Color(0xffb7efd2) : Colors.white, borderRadius: BorderRadius.only(topLeft: const Radius.circular(16), topRight: const Radius.circular(16), bottomLeft: Radius.circular(mine ? 16 : 4), bottomRight: Radius.circular(mine ? 4 : 16))), child: Text(msg['text'] as String, style: const TextStyle(color: Color(0xff17212b), fontSize: 14))), const SizedBox(height: 4), Text(msg['time'] as String, style: const TextStyle(color: Color(0xff9aa5ab), fontSize: 10))])]))); }

  Widget _composer() => Container(padding: const EdgeInsets.fromLTRB(18, 12, 18, 16), color: Colors.white, child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [IconButton(tooltip: recording ? '停止录音' : '语音消息', onPressed: _toggleRecording, icon: Icon(recording ? Icons.stop_circle_outlined : Icons.mic_none_rounded, color: recording ? Colors.red : null)), IconButton(tooltip: '附件', onPressed: () {}, icon: const Icon(Icons.add_circle_outline)), Expanded(child: TextField(controller: input, minLines: 1, maxLines: 4, decoration: const InputDecoration(hintText: '输入消息'))), const SizedBox(width: 10), FilledButton(onPressed: () { final text = input.text.trim(); if (text.isEmpty) return; socket?.sink.add(jsonEncode({'type': 'msg', 'payload': {'to': 2, 'content': text, 'clientMsgId': 'f${DateTime.now().microsecondsSinceEpoch}'}})); setState(() { messages.add({'text': text, 'mine': true, 'time': '现在'}); input.clear(); }); }, child: const Text('发送'))]));
}
