import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:audioplayers/audioplayers.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:record/record.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:window_manager/window_manager.dart';

import 'services/securechat_api.dart';
import 'services/app_config.dart';
import 'services/chat_crypto.dart';
import 'services/call_service.dart';
import 'widgets/app_scaffold.dart';
import 'widgets/window_effect.dart';
import 'call_page.dart';
import 'settings_page.dart';
import 'features_center.dart';
import 'ai_page.dart';
import 'scan_authorize_page.dart';
import 'file_repository_page.dart';
import 'update_service.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final config = await AppConfig.init();
  final api = SecureChatApi();
  await api.restoreSession();
  if (Platform.isWindows) {
    try {
      await windowManager.ensureInitialized();
      await windowManager.setMinimumSize(const Size(920, 640));
      await windowManager.setTitleBarStyle(TitleBarStyle.hidden, windowButtonVisibility: true);
    } catch (_) {}
  }
  runApp(SecureChatApp(config: config, api: api));
}

class SecureChatApp extends StatefulWidget {
  const SecureChatApp({super.key, required this.config, required this.api});
  final AppConfig config;
  final SecureChatApi api;
  @override
  State<SecureChatApp> createState() => _SecureChatAppState();
}

class _SecureChatAppState extends State<SecureChatApp> {
  @override
  Widget build(BuildContext context) {
    final config = widget.config;
    return AnimatedBuilder(
      animation: config,
      builder: (context, _) {
        final t = config.theme;
        return MaterialApp(
          debugShowCheckedModeBanner: false,
          title: 'SecureChat',
          theme: t.theme(),
          darkTheme: config.dark.theme(),
          themeMode: config.mode == ThemeModeEx.dark ? ThemeMode.dark : ThemeMode.light,
          builder: (context, child) {
            return MediaQuery(
              data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(config.fontScale)),
              child: child ?? const SizedBox.shrink(),
            );
          },
          home: widget.api.isLoggedIn ? ChatShell(api: widget.api, config: config) : LoginPage(config: config),
        );
      },
    );
  }
}

class LoginPage extends StatefulWidget {
  const LoginPage({super.key, required this.config});
  final AppConfig config;
  @override
  State<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> {
  int mode = 0;
  final api = SecureChatApi();
  Timer? qrTimer;
  Timer? codeTimer;
  int countdown = 0;
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
    codeTimer?.cancel();
    account.dispose();
    password.dispose();
    email.dispose();
    code.dispose();
    super.dispose();
  }

  Future<void> sendEmailCode() async {
    final em = email.text.trim();
    if (em.isEmpty) {
      if (mounted) setState(() => error = '请先输入邮箱地址');
      return;
    }
    if (countdown > 0) return;
    setState(() { busy = true; error = null; });
    try {
      await api.sendEmailCode(em);
      if (!mounted) return;
      countdown = 60;
      error = '验证码已发送，请查收邮箱';
      codeTimer?.cancel();
      codeTimer = Timer.periodic(const Duration(seconds: 1), (t) {
        if (!mounted) { t.cancel(); return; }
        setState(() {
          countdown--;
          if (countdown <= 0) t.cancel();
        });
      });
    } catch (e) {
      if (mounted) setState(() => error = e.toString().replaceFirst('Bad state: ', ''));
    } finally {
      if (mounted) setState(() => busy = false);
    }
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
      Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => ChatShell(api: api, config: widget.config)));
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
            Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => ChatShell(api: api, config: widget.config)));
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

  void _showForgotPassword(BuildContext context) {
    showDialog(context: context, builder: (_) => _ForgotPasswordDialog(api: api));
  }

  @override
  Widget build(BuildContext context) {
    final config = widget.config;
    return AnimatedBuilder(
      animation: config,
      builder: (context, _) {
        final glass = config.mode == ThemeModeEx.glass || config.effect != WindowEffectKind.none;
        return Scaffold(
          body: Stack(children: [
            if (glass) Positioned.fill(child: AppScaffold(config: config, body: const SizedBox.expand())),
            Positioned.fill(child: BgLayer(theme: config.theme, config: config)),
            Align(
              alignment: Alignment.center,
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 980, maxHeight: 620),
                child: LayoutBuilder(builder: (context, box) {
                  final compact = box.maxWidth < 700;
                  return Container(
                    decoration: BoxDecoration(color: config.theme.card, borderRadius: BorderRadius.circular(24), boxShadow: const [BoxShadow(color: Colors.black26, blurRadius: 35, offset: Offset(0, 18))]),
                    child: Row(children: [
                      if (!compact) const Expanded(child: WelcomePanel()),
                      Expanded(child: Padding(padding: EdgeInsets.all(compact ? 28 : 58), child: _form(context))),
                    ]),
                  );
                }),
              ),
            ),
            const Positioned(top: 16, right: 16, child: Icon(Icons.security, color: Color(0xffffffff), size: 18)),
          ]),
        );
      },
    );
  }

  Widget _form(BuildContext context) {
    final t = widget.config.theme;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisAlignment: MainAxisAlignment.center, children: [
      Text('登录 SecureChat', style: TextStyle(fontSize: 28, fontWeight: FontWeight.w800, color: t.text)),
      const SizedBox(height: 8),
      Text('你的消息，只属于你和收件人。', style: TextStyle(color: t.subText)),
      const SizedBox(height: 30),
      Row(children: [
        _mode('密码登录', 0),
        _mode('邮箱验证码', 1),
        _mode('扫码登录', 2),
      ]),
      const SizedBox(height: 22),
      if (mode == 0) ...[
        TextField(controller: account, style: TextStyle(color: t.text), decoration: InputDecoration(labelText: '用户名或邮箱', labelStyle: TextStyle(color: t.subText))),
        const SizedBox(height: 12),
        TextField(controller: password, obscureText: true, style: TextStyle(color: t.text), decoration: InputDecoration(labelText: '密码', labelStyle: TextStyle(color: t.subText))),
      ] else if (mode == 1) ...[
        TextField(controller: email, style: TextStyle(color: t.text), decoration: InputDecoration(labelText: '邮箱地址', labelStyle: TextStyle(color: t.subText))),
        const SizedBox(height: 12),
        Row(children: [Expanded(child: TextField(controller: code, style: TextStyle(color: t.text), decoration: InputDecoration(labelText: '验证码', labelStyle: TextStyle(color: t.subText)))), const SizedBox(width: 10), OutlinedButton(onPressed: busy ? null : sendEmailCode, child: Text(countdown > 0 ? '$countdown s' : '获取验证码'))]),
      ] else ...[
        Center(child: Column(children: [
          Container(width: 176, height: 176, padding: const EdgeInsets.all(12), decoration: BoxDecoration(border: Border.all(color: t.div), borderRadius: BorderRadius.circular(16)), child: qrText == null ? const _QrPlaceholder() : QrImageView(data: qrText!, version: QrVersions.auto)),
          const SizedBox(height: 14),
          Text('请使用已登录的手机扫描此二维码', style: TextStyle(fontWeight: FontWeight.w600, color: t.text)),
          const SizedBox(height: 4),
          Text('手机确认后，电脑端会自动登录', style: TextStyle(color: t.subText, fontSize: 12)),
        ])),
      ],
      if (error != null) Padding(padding: const EdgeInsets.only(top: 14), child: Text(error!, style: const TextStyle(color: Color(0xffc0392b), fontSize: 12))),
      const SizedBox(height: 8),
      Align(
        alignment: Alignment.centerLeft,
        child: TextButton(
          onPressed: () => _showForgotPassword(context),
          style: TextButton.styleFrom(foregroundColor: widget.config.primary),
          child: const Text('忘记密码？', style: TextStyle(fontSize: 13)),
        ),
      ),
      const SizedBox(height: 6),
      SizedBox(width: double.infinity, height: 48, child: FilledButton(onPressed: busy ? null : (mode == 2 ? beginQr : login), child: Text(busy ? '处理中…' : mode == 2 ? (qrText == null ? '生成二维码' : '等待手机确认') : '登录'))),
      const SizedBox(height: 18),
      Center(child: Text('SecureChat $kAppVersion', style: TextStyle(color: t.subText, fontSize: 12))),
    ]);
  }

  Widget _mode(String label, int value) {
    final t = widget.config.theme;
    return Expanded(
      child: GestureDetector(
        onTap: () => setState(() => mode = value),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 180),
          padding: const EdgeInsets.symmetric(vertical: 11),
          decoration: BoxDecoration(color: mode == value ? widget.config.primary.withValues(alpha: 0.18) : Colors.transparent, borderRadius: BorderRadius.circular(10)),
          child: Center(child: Text(label, style: TextStyle(fontSize: 12, color: mode == value ? widget.config.primary : t.subText, fontWeight: mode == value ? FontWeight.w700 : FontWeight.w500))),
        ),
      ),
    );
  }
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
  const ChatShell({super.key, required this.api, required this.config});
  final SecureChatApi api;
  final AppConfig config;
  @override
  State<ChatShell> createState() => _ChatShellState();
}

class _ChatShellState extends State<ChatShell> {
  int selected = 0;
  final input = TextEditingController();
  final messages = <Map<String, dynamic>>[];
  final conversations = <Map<String, dynamic>>[];
  WebSocketChannel? socket;
  CallService? calls;
  final recorder = AudioRecorder();
  bool recording = false;
  AudioPlayer? voicePlayer;
  String? playingVoiceId;
  int? myId;
  String? selName;
  final _sentIds = <String>{};

  Map<String, dynamic>? get selConv => selected >= 0 && selected < conversations.length ? conversations[selected] : null;

  @override
  void initState() {
    super.initState();
    _connect();
    _loadData();
    _checkUpdate();
  }

  bool _updatePrompted = false;
  Future<void> _checkUpdate() async {
    if (_updatePrompted || !Platform.isWindows) return;
    try {
      final svc = UpdateService(api: widget.api);
      final info = await svc.check();
      if (info == null || !mounted) return;
      _updatePrompted = true;
      showDialog(
        context: context,
        builder: (_) => _UpdateDialog(info: info, service: svc),
      );
    } catch (_) {}
  }

  Future<void> _loadData() async {
    try {
      final friends = await widget.api.friends();
      final groups = await widget.api.groups();
      if (!mounted) return;
      setState(() {
        conversations.clear();
        for (final f in friends) {
          conversations.add({'kind': 'friend', 'id': f['id'], 'name': (f['nickname'] ?? f['username'] ?? '').toString(), 'icon': Icons.person, 'online': f['online'] == true});
        }
        for (final g in groups) {
          conversations.add({'kind': 'group', 'id': g['id'], 'name': (g['name'] ?? '群聊').toString(), 'icon': Icons.groups_rounded, 'online': false});
        }
        messages.clear();
      });
      if (conversations.isNotEmpty) await _openConversation(0);
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('加载会话失败：$e')));
    }
  }

  Future<void> _openConversation(int index) async {
    final conv = conversations[index];
    setState(() => selected = index);
    messages.clear();
    if (conv['kind'] == 'group') {
      if (mounted) setState(() => selName = conv['name'].toString());
      return;
    }
    final peerId = conv['id'] as int;
    if (mounted) setState(() => selName = conv['name'].toString());
    try {
      final history = await widget.api.history(peerId);
      if (!mounted) return;
      final msgs = <Map<String, dynamic>>[];
      for (final m in history) {
        final content = (m['content'] ?? '').toString();
        final text = readChatText(content);
        final mine = m['from'] == myId || (m['from'] ?? 0) == myId || (m['from'] ?? 0) != peerId;
        final voice = RegExp(r'^\[语音消息:([0-9a-f-]{8,})\]$').firstMatch(text);
        msgs.add(voice != null
            ? {'voiceId': voice[1], 'mine': mine, 'time': _fmtTs(m['createdAt'])}
            : {'text': text, 'mine': mine, 'time': _fmtTs(m['createdAt'])});
      }
      if (!mounted) return;
      setState(() {
        messages
          ..clear()
          ..addAll(msgs);
      });
    } catch (_) {}
  }

  static String _fmtTs(dynamic ts) {
    final v = int.tryParse('$ts');
    if (v == null || v <= 0) return '';
    final t = DateTime.fromMillisecondsSinceEpoch(v);
    final hh = t.hour.toString().padLeft(2, '0');
    final mm = t.minute.toString().padLeft(2, '0');
    return '$hh:$mm';
  }

  void _connect() {
    try {
      socket = widget.api.connect();
      myId = widget.api.myId;
      socket!.stream.listen((event) {
        final root = jsonDecode(event as String) as Map<String, dynamic>;
        final type = root['type'];
        if (type == 'msg') {
          final p = (root['payload'] as Map).cast<String, dynamic>();
          if (!mounted) return;
          final cmid = (p['clientMsgId'] ?? '').toString();
          if (cmid.isNotEmpty && _sentIds.contains(cmid)) {
            _sentIds.remove(cmid);
            return;
          }
          final conv = selConv;
          final from = p['from'];
          final to = p['to'];
          final talkingToPeer = conv != null && conv['kind'] == 'friend' && (from == conv['id'] || to == conv['id']);
          final content = (p['content'] ?? '').toString();
          final text = readChatText(content);
          final voice = RegExp(r'^\[语音消息:([0-9a-f-]{8,})\]$').firstMatch(text);
          setState(() {
            if (conv == null || talkingToPeer) {
              messages.add(voice != null
                  ? {'voiceId': voice[1], 'mine': p['from'] == myId, 'time': '现在'}
                  : {'text': text, 'mine': p['from'] == myId, 'time': '现在'});
            }
          });
        } else if (type == 'signal') {
          final p = (root['payload'] as Map).cast<String, dynamic>();
          final service = calls;
          if (service != null) {
            service.onSignal(p['from'] as int?, p['sub'] as String?, p['data']);
            if (service.status == CallStatus.ringing && mounted) {
              Navigator.of(context).push(MaterialPageRoute(builder: (_) => CallPage(service: service, peerName: '对方', config: widget.config)));
            }
          }
        }
      }, onError: (_) {});
    } catch (_) {}
  }

  int? get _talkId {
    final conv = selConv;
    if (conv == null || conv['kind'] == 'group') return null;
    return conv['id'] as int;
  }

  Future<void> _startCall(bool video) async {
    final to = _talkId;
    if (to == null) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('选择好友后发起通话')));
      return;
    }
    final service = calls ??= CallService(socket: socket!);
    if (service.busy) return;
    await service.startCall(to, withVideo: video);
    if (!mounted) return;
    Navigator.of(context).push(MaterialPageRoute(builder: (_) => CallPage(service: service, peerName: selName ?? '对方', config: widget.config)));
  }

  Future<void> _toggleRecording() async {
    final to = _talkId;
    if (to == null) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('选择好友后发送语音')));
      return;
    }
    if (recording) {
      final path = await recorder.stop();
      setState(() => recording = false);
      if (path == null) return;
      try {
        final uploaded = await widget.api.uploadVoice(to, await File(path).readAsBytes(), 'voice-${DateTime.now().millisecondsSinceEpoch}.m4a');
        final id = uploaded['id'];
        final vcmid = 'v${DateTime.now().microsecondsSinceEpoch}';
        _sentIds.add(vcmid);
        socket?.sink.add(jsonEncode({'type': 'msg', 'payload': {'to': to, 'content': '[语音消息:$id]', 'clientMsgId': vcmid}}));
        setState(() => messages.add({'voiceId': id, 'mine': true, 'time': '现在'}));
        try {
          final transcript = await widget.api.transcribe(id);
          if (transcript.isNotEmpty) {
            final tcmid = 't${DateTime.now().microsecondsSinceEpoch}';
            _sentIds.add(tcmid);
            socket?.sink.add(jsonEncode({'type': 'msg', 'payload': {'to': to, 'content': transcript, 'clientMsgId': tcmid}}));
            if (mounted) setState(() => messages.add({'text': transcript, 'mine': true, 'time': '现在'}));
          }
        } catch (_) {
          if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('语音已发送，转写服务暂不可用')));
        }
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
    voicePlayer?.dispose();
    recorder.dispose();
    input.dispose();
    super.dispose();
  }

  void _showQrAuth() {
    showDialog(context: context, builder: (_) => _QrAuthDialog(api: widget.api));
  }

  @override
  Widget build(BuildContext context) {
    final config = widget.config;
    return AnimatedBuilder(
      animation: config,
      builder: (context, _) {
        return AppScaffold(
          config: config,
          body: SafeArea(
            child: Column(
              children: [
                if (Platform.isWindows) const _WindowDragBar(),
                Expanded(
                  child: LayoutBuilder(builder: (context, c) {
                    final desktop = c.maxWidth >= 760;
                    return Column(children: [
                      Expanded(
                        child: Row(children: [
                          if (desktop) _sidebar(c.maxWidth),
                          Expanded(child: SizedBox(width: double.infinity, child: _conversation())),
                        ]),
                      ),
                      if (!desktop) _mobileNav(context),
                    ]);
                  }),
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  Widget _sidebar(double width) {
    final theme = widget.config.theme;
    final text = theme.text;
    final sub = theme.subText;
    return SizedBox(
      width: width < 1000 ? 290 : 330,
      child: ColoredBox(
        color: theme.sidebar.withValues(alpha: 0.82),
        child: Column(children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 20, 14, 12),
            child: Row(children: [
              CircleAvatar(radius: 18, backgroundColor: widget.config.primary, child: const Text('S', style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold))),
              const SizedBox(width: 10),
              Expanded(child: Text('我的消息', style: TextStyle(color: text, fontSize: 17, fontWeight: FontWeight.w700))),
              IconButton(onPressed: () {}, icon: Icon(Icons.edit_square, color: sub)),
            ]),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14),
            child: TextField(
              style: TextStyle(color: text),
              decoration: InputDecoration(
                hintText: '搜索会话',
                hintStyle: TextStyle(color: sub),
                prefixIcon: Icon(Icons.search, color: sub),
                fillColor: theme.inputBg,
              ),
            ),
          ),
          const SizedBox(height: 14),
          Expanded(child: ListView(children: [
            for (var i = 0; i < conversations.length; i++) _conversationTile(i, conversations[i]),
          ])),
          Divider(height: 1, thickness: 1, color: theme.div),
          _navRow(Icons.auto_awesome_outlined, 'AI 助手', () => Navigator.push(context, MaterialPageRoute(builder: (_) => AiPage(api: widget.api, config: widget.config))), color: sub),
          _navRow(Icons.qr_code_2, '扫码授权', () => Navigator.push(context, MaterialPageRoute(builder: (_) => ScanAuthorizePage(api: widget.api, config: widget.config))), color: sub),
          _navRow(Icons.settings_outlined, '设置', () => Navigator.push(context, MaterialPageRoute(builder: (_) => SettingsPage(config: widget.config, api: widget.api))), color: sub),
          _navRow(Icons.apps_rounded, '功能中心', () => _openFeatures(context), color: sub),
        ]),
      ),
    );
  }

  Widget _navRow(IconData icon, String label, VoidCallback onTap, {required Color color}) => InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 14),
          child: Row(children: [
            Icon(icon, color: color, size: 19),
            const SizedBox(width: 10),
            Text(label, style: TextStyle(color: color)),
          ]),
        ),
      );

  Widget _mobileNav(BuildContext context) {
    Widget tile(IconData icon, String label, VoidCallback onTap) => InkWell(
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 6),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              Icon(icon, size: 22, color: widget.config.primary),
              const SizedBox(height: 2),
              Text(label, style: TextStyle(fontSize: 10, color: widget.config.theme.text)),
            ]),
          ),
        );
    return Container(
      color: widget.config.theme.panel,
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceAround,
            children: [
              tile(Icons.chat_bubble_outline, '会话', () {}),
              tile(Icons.auto_awesome_outlined, 'AI', () => Navigator.push(context, MaterialPageRoute(builder: (_) => AiPage(api: widget.api, config: widget.config)))),
              tile(Icons.qr_code_2, '扫码授权', () => Navigator.push(context, MaterialPageRoute(builder: (_) => ScanAuthorizePage(api: widget.api, config: widget.config)))),
              tile(Icons.apps_rounded, '功能', () => _openFeatures(context)),
              tile(Icons.settings_outlined, '设置', () => Navigator.push(context, MaterialPageRoute(builder: (_) => SettingsPage(config: widget.config, api: widget.api)))),
            ],
          ),
        ),
      ),
    );
  }

  void _openFeatures(BuildContext context) {
    showModalBottomSheet(
      context: context,
      backgroundColor: Colors.transparent,
      builder: (_) => _FeaturesSheet(api: widget.api, config: widget.config),
    );
  }

  Widget _contextMenu() => PopupMenuButton<int>(
        icon: const Icon(Icons.more_horiz),
        onSelected: (v) {},
        itemBuilder: (_) => const [
          PopupMenuItem(value: 0, child: Text('发起群聊')),
          PopupMenuItem(value: 1, child: Text('发起音视频会议')),
          PopupMenuItem(value: 2, child: Text('添加好友')),
          PopupMenuItem(value: 3, child: Text('查看聊天资料')),
        ],
      );

  Widget _conversationTile(int index, Map<String, dynamic> conv) => InkWell(
        onTap: () => _openConversation(index),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 160),
          margin: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(
            color: index == selected ? widget.config.theme.primary.withValues(alpha: widget.config.theme.isDark ? 0.35 : 0.18) : Colors.transparent,
            borderRadius: BorderRadius.circular(12),
          ),
          child: Row(children: [
            CircleAvatar(radius: 22, backgroundColor: const Color(0xffd9eee4), child: Icon(conv['icon'] as IconData, color: const Color(0xff168457))),
            const SizedBox(width: 10),
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text((conv['name'] ?? '').toString(), maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: widget.config.theme.text, fontWeight: FontWeight.w600)),
              const SizedBox(height: 4),
              Text(conv['kind'] == 'group' ? '群聊' : (conv['online'] == true ? '在线' : '离线'), maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: widget.config.theme.subText, fontSize: 12)),
            ])),
          ]),
        ),
      );

  Widget _conversation() {
    final t = widget.config.theme;
    final border = Border(bottom: BorderSide(color: t.div));
    return Column(children: [
      Container(height: 70, padding: const EdgeInsets.symmetric(horizontal: 24), decoration: BoxDecoration(color: t.panel.withValues(alpha: 0.5), border: border), child: Row(children: [
        const CircleAvatar(backgroundColor: Color(0xffd9eee4), child: Icon(Icons.person, color: Color(0xff168457))),
        const SizedBox(width: 12),
        Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(selName ?? '未选择会话', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 16, color: t.text)),
          const Text('SecureChat', style: TextStyle(color: Color(0xff18a66a), fontSize: 12)),
        ]),
        const Spacer(),
        IconButton(tooltip: '手机快捷登录', onPressed: () => _showQrAuth(), icon: Icon(Icons.qr_code_2, color: t.text)),
        IconButton(tooltip: '语音通话', onPressed: () => _startCall(false), icon: Icon(Icons.call_outlined, color: t.text)),
        IconButton(tooltip: '视频通话', onPressed: () => _startCall(true), icon: Icon(Icons.videocam_outlined, color: t.text)),
        IconButton(tooltip: '清空聊天', onPressed: selConv == null ? null : () => _clearConversation(), icon: Icon(Icons.delete_outline, color: t.text)),
        _contextMenu(),
      ])),
      Expanded(child: messages.isEmpty ? Center(child: Text('还没有消息', style: TextStyle(color: t.subText))) : ListView.builder(padding: const EdgeInsets.fromLTRB(24, 22, 24, 16), itemCount: messages.length, itemBuilder: (_, i) => _bubble(messages[i]))),
      _composer(),
    ]);
  }

  Widget _bubble(Map<String, dynamic> msg) {
    final mine = msg['mine'] as bool;
    final voiceId = msg['voiceId'] as String?;
    final t = widget.config.theme;
    return Align(alignment: mine ? Alignment.centerRight : Alignment.centerLeft, child: Padding(padding: const EdgeInsets.only(bottom: 14), child: Row(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.end, children: [
      if (!mine) const CircleAvatar(radius: 16, backgroundColor: Color(0xffd9eee4), child: Icon(Icons.person, size: 17, color: Color(0xff168457))),
      if (!mine) const SizedBox(width: 8),
      Column(crossAxisAlignment: mine ? CrossAxisAlignment.end : CrossAxisAlignment.start, children: [
        voiceId != null
            ? _voiceBubble(mine, voiceId)
            : Container(constraints: const BoxConstraints(maxWidth: 520), padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 11), decoration: BoxDecoration(color: mine ? t.bubbleMine : t.bubbleOther, borderRadius: BorderRadius.only(topLeft: const Radius.circular(16), topRight: const Radius.circular(16), bottomLeft: Radius.circular(mine ? 16 : 4), bottomRight: Radius.circular(mine ? 4 : 16))), child: Text(msg['text'] as String, style: TextStyle(color: t.text, fontSize: 14))),
        const SizedBox(height: 4),
        Text(msg['time'] as String, style: TextStyle(color: t.subText, fontSize: 10)),
      ]),
    ])));
  }

  Widget _voiceBubble(bool mine, String id) {
    final playing = playingVoiceId == id;
    final t = widget.config.theme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
      decoration: BoxDecoration(color: mine ? t.bubbleMine : t.bubbleOther, borderRadius: BorderRadius.only(topLeft: const Radius.circular(16), topRight: const Radius.circular(16), bottomLeft: Radius.circular(mine ? 16 : 4), bottomRight: Radius.circular(mine ? 4 : 16))),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        IconButton(icon: Icon(playing ? Icons.stop_rounded : Icons.play_arrow_rounded, size: 22), color: const Color(0xff168457), onPressed: () => _toggleVoice(id)),
        Row(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.center, children: List.generate(12, (i) {
          final h = 6.0 + ((i * 7 + (playing ? 3 : 0)) % 16);
          return Container(width: 2.5, height: h, margin: const EdgeInsets.only(right: 3), decoration: BoxDecoration(color: playing ? const Color(0xff168457) : t.subText, borderRadius: BorderRadius.circular(2)));
        })),
        const SizedBox(width: 8),
        Text('语音', style: TextStyle(fontSize: 12, color: mine ? const Color(0xff168457) : t.subText)),
      ]),
    );
  }

  Future<void> _toggleVoice(String id) async {
    if (playingVoiceId == id) {
      await voicePlayer?.stop();
      if (mounted) setState(() => playingVoiceId = null);
      return;
    }
    await voicePlayer?.dispose();
    final player = AudioPlayer();
    player.onPlayerComplete.listen((_) {
      if (mounted) setState(() => playingVoiceId = null);
    });
    try {
      final bytes = await widget.api.fetchFile(id);
      final path = '${Directory.systemTemp.path}/securechat-voice-$id.m4a';
      await File(path).writeAsBytes(bytes);
      await player.play(DeviceFileSource(path));
      voicePlayer = player;
      if (mounted) setState(() => playingVoiceId = id);
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('语音播放失败：$e')));
    }
  }

  Widget _composer() {
    final conv = selConv;
    final canSend = conv != null;
    final t = widget.config.theme;
    return Container(padding: const EdgeInsets.fromLTRB(18, 12, 18, 16), color: t.panel.withValues(alpha: 0.5), child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
      IconButton(tooltip: recording ? '停止录音' : '语音消息', onPressed: _toggleRecording, icon: Icon(recording ? Icons.stop_circle_outlined : Icons.mic_none_rounded, color: recording ? Colors.red : t.text)),
      IconButton(tooltip: '附件', onPressed: () {}, icon: Icon(Icons.add_circle_outline, color: t.text)),
      Expanded(child: TextField(controller: input, minLines: 1, maxLines: 4, style: TextStyle(color: t.text), decoration: InputDecoration(hintText: '输入消息', hintStyle: TextStyle(color: t.subText), filled: true, fillColor: t.inputBg.withValues(alpha: 0.5), border: OutlineInputBorder(borderRadius: BorderRadius.circular(24), borderSide: BorderSide.none)))),
      const SizedBox(width: 10),
      FilledButton(onPressed: canSend ? () => _sendText() : null, child: const Text('发送')),
    ]));
  }

  Future<void> _sendText() async {
    final conv = selConv;
    final text = input.text.trim();
    if (conv == null || text.isEmpty) return;
    input.clear();
    if (conv['kind'] == 'group') {
      final gcmid = 'g${DateTime.now().microsecondsSinceEpoch}';
      _sentIds.add(gcmid);
      socket?.sink.add(jsonEncode({'type': 'group_msg', 'payload': {'groupId': conv['id'], 'content': writeChatText(text), 'clientMsgId': gcmid}}));
      setState(() => messages.add({'text': text, 'mine': true, 'time': '现在'}));
      return;
    }
    final to = conv['id'] as int;
    final cmid = 'f${DateTime.now().microsecondsSinceEpoch}';
    _sentIds.add(cmid);
    socket?.sink.add(jsonEncode({'type': 'msg', 'payload': {'to': to, 'content': writeChatText(text), 'clientMsgId': cmid}}));
    setState(() { messages.add({'text': text, 'mine': true, 'time': '现在'}); });
  }

  Future<void> _clearConversation() async {
    final conv = selConv;
    if (conv == null) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        title: const Text('清空聊天记录'),
        content: Text('确定要清空与「${conv['name']}」的所有聊天记录吗？此操作不可恢复。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('清空')),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    if (conv['kind'] == 'friend') {
      try {
        await widget.api.deleteHistory(conv['id'] as int);
      } catch (e) {
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('清除失败：$e')));
        return;
      }
    }
    if (!mounted) return;
    setState(() => messages.clear());
    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('聊天记录已清空')));
  }
}

class _WindowDragBar extends StatelessWidget {
  const _WindowDragBar();

  void _action(Future<void> Function() fn) {
    try {
      fn();
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final fg = isDark ? const Color(0xffc8d0d8) : const Color(0xff5b6670);
    final bg = isDark ? const Color(0x0a000000) : const Color(0x0affffff);
    Widget btn(IconData icon, Future<void> Function() act, {bool danger = false}) {
      return InkWell(
        onTap: () => _action(act),
        child: Container(
          width: 46,
          height: 40,
          alignment: Alignment.center,
          child: Icon(icon, size: 16, color: danger ? const Color(0xffe74c3c) : fg),
        ),
      );
    }

    return Container(
      color: bg,
      height: 40,
      child: Column(children: [
        SizedBox(
          height: 40,
          child: Row(children: [
            const SizedBox(width: 12),
            const Icon(Icons.lock_outline, size: 15, color: Color(0xff18a66a)),
            const SizedBox(width: 8),
            const Text('SecureChat', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
            const Spacer(),
            const DragToMoveArea(child: SizedBox(width: 40, height: 40)),
            btn(Icons.remove_rounded, windowManager.minimize),
            btn(Icons.crop_square_rounded, () async {
              final m = await windowManager.isMaximized();
              if (m) {
                await windowManager.unmaximize();
              } else {
                await windowManager.maximize();
              }
            }),
            btn(Icons.close_rounded, windowManager.close, danger: true),
          ]),
        ),
        const Divider(height: 1, thickness: 1),
      ]),
    );
  }
}

class _FeaturesSheet extends StatelessWidget {
  const _FeaturesSheet({this.api, this.config});

  final SecureChatApi? api;
  final AppConfig? config;

  Future<void> _push(BuildContext context, Widget page) => Navigator.of(context).push(MaterialPageRoute(builder: (_) => page));

  void _openUrl(String url) {
    try {
      Process.start('cmd', ['/c', 'start', '', url]);
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    final entries = <(String, IconData, Widget)>[
      ('安全便签', Icons.sticky_note_2_outlined, const NotesPage()),
      ('待办清单', Icons.checklist_rounded, const TodoPage()),
      ('快捷回复', Icons.bolt_outlined, const QuickRepliesPage()),
      ('文件仓库', Icons.folder_outlined, api != null && config != null ? FileRepositoryPage(api: api!, config: config!) : const FileCenterPage()),
      ('我的收藏', Icons.favorite_outline, const FavoritesPage()),
      ('定时提醒', Icons.alarm_outlined, const ReminderPage()),
      ('在线状态', Icons.mood_outlined, const MoodStatusPage()),
    ];
    final webServices = <(String, IconData, String)>[
      ('网盘', Icons.cloud_outlined, 'http://mc.32768.top:5213'),
      ('邮箱', Icons.mail_outline, 'https://mail.32768.top'),
      ('AI 网页', Icons.smart_toy_outlined, 'https://ai.32768.top'),
    ];
    final theme = Theme.of(context);
    return SafeArea(
      child: Container(
        decoration: BoxDecoration(color: theme.colorScheme.surface, borderRadius: const BorderRadius.vertical(top: Radius.circular(24)), boxShadow: const [BoxShadow(color: Colors.black26, blurRadius: 30, offset: Offset(0, -4))]),
        padding: const EdgeInsets.fromLTRB(20, 18, 20, 24),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('功能中心', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 17, color: theme.colorScheme.onSurface)),
          const SizedBox(height: 14),
          Wrap(spacing: 14, runSpacing: 14, children: [
            for (final e in entries)
              _gridItem(context, e.$1, e.$2, () => _push(context, e.$3)),
          ]),
          const SizedBox(height: 18),
          Text('我的服务', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 17, color: theme.colorScheme.onSurface)),
          const SizedBox(height: 14),
          Wrap(spacing: 14, runSpacing: 14, children: [
            for (final s in webServices)
              _gridItem(context, s.$1, s.$2, () => _openUrl(s.$3)),
          ]),
          const SizedBox(height: 6),
        ]),
      ),
    );
  }

  Widget _gridItem(BuildContext context, String label, IconData icon, VoidCallback onTap) {
    final scheme = Theme.of(context).colorScheme;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(16),
      child: Container(
        width: 84,
        padding: const EdgeInsets.symmetric(vertical: 12),
        decoration: BoxDecoration(color: scheme.secondaryContainer.withValues(alpha: 0.45), borderRadius: BorderRadius.circular(16)),
        child: Column(children: [
          Icon(icon, color: const Color(0xff18a66a), size: 26),
          const SizedBox(height: 8),
          Text(label, style: const TextStyle(fontSize: 12)),
        ]),
      ),
    );
  }
}

class _QrAuthDialog extends StatefulWidget {
  const _QrAuthDialog({required this.api});
  final SecureChatApi api;
  @override
  State<_QrAuthDialog> createState() => _QrAuthDialogState();
}

class _QrAuthDialogState extends State<_QrAuthDialog> {
  String? qrText;
  String? error;
  bool busy = false;
  Timer? timer;

  @override
  void initState() {
    super.initState();
    _create();
  }

  Future<void> _create() async {
    setState(() { busy = true; error = null; });
    try {
      final data = await widget.api.createQrLogin();
      final token = data['token'] as String?;
      final text = data['qrText'] as String?;
      if (token == null || text == null) throw StateError('二维码创建失败');
      if (!mounted) return;
      setState(() { qrText = text; busy = false; });
      timer?.cancel();
      timer = Timer.periodic(const Duration(seconds: 2), (_) async {
        try {
          final status = await widget.api.qrStatus(token);
          if (status['status'] == 'confirmed' && mounted) {
            timer?.cancel();
            Navigator.pop(context, true);
            ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已在其他设备完成登录')));
          }
        } catch (_) {}
      });
    } catch (e) {
      if (mounted) setState(() { error = e.toString().replaceFirst('Bad state: ', ''); busy = false; });
    }
  }

  @override
  void dispose() {
    timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Dialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(24)),
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            const Text('手机快捷登录', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
            const SizedBox(height: 6),
            const Text('使用已登录的手机扫描此二维码，即可在本机登录同一账号', textAlign: TextAlign.center, style: TextStyle(color: Color(0xff77818a), fontSize: 13)),
            const SizedBox(height: 18),
            if (busy)
              const SizedBox(height: 160, child: Center(child: CircularProgressIndicator()))
            else if (error != null)
              Padding(padding: const EdgeInsets.all(20), child: Column(children: [
                const Icon(Icons.error_outline, color: Colors.redAccent, size: 40),
                const SizedBox(height: 8),
                Text(error!, textAlign: TextAlign.center, style: const TextStyle(color: Colors.redAccent)),
                const SizedBox(height: 12),
                FilledButton.tonal(onPressed: _create, child: const Text('重试')),
              ]))
            else
              Container(
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(16), border: Border.all(color: const Color(0xffe3e8eb))),
                child: QrImageView(data: qrText!, size: 180, version: QrVersions.auto),
              ),
            const SizedBox(height: 8),
            Text('二维码每 10 分钟刷新', style: const TextStyle(color: Color(0xff9aa5ab), fontSize: 11)),
          ]),
        ),
      );
}

class _ForgotPasswordDialog extends StatefulWidget {
  const _ForgotPasswordDialog({required this.api});
  final SecureChatApi api;
  @override
  State<_ForgotPasswordDialog> createState() => _ForgotPasswordDialogState();
}

class _ForgotPasswordDialogState extends State<_ForgotPasswordDialog> {
  final email = TextEditingController();
  final code = TextEditingController();
  final password = TextEditingController();
  Timer? timer;
  int countdown = 0;
  bool busy = false;
  bool sent = false;
  String? error;

  @override
  void dispose() {
    timer?.cancel();
    email.dispose();
    code.dispose();
    password.dispose();
    super.dispose();
  }

  Future<void> send() async {
    final em = email.text.trim();
    if (em.isEmpty) return setState(() => error = '请先输入邮箱地址');
    setState(() { busy = true; error = null; });
    try {
      await widget.api.sendResetCode(em);
      if (!mounted) return;
      setState(() { sent = true; countdown = 60; busy = false; });
      timer?.cancel();
      timer = Timer.periodic(const Duration(seconds: 1), (t) {
        if (!mounted) { t.cancel(); return; }
        setState(() {
          countdown--;
          if (countdown <= 0) t.cancel();
        });
      });
    } catch (e) {
      if (mounted) setState(() { error = e.toString().replaceFirst('Bad state: ', ''); busy = false; });
    }
  }

  Future<void> submit() async {
    final em = email.text.trim();
    final cd = code.text.trim();
    final pw = password.text;
    if (em.isEmpty || cd.isEmpty || pw.isEmpty) return setState(() => error = '请完整填写邮箱、验证码和新密码');
    if (pw.length < 6) return setState(() => error = '新密码至少6位');
    setState(() { busy = true; error = null; });
    try {
      await widget.api.resetPassword(em, cd, pw);
      if (!mounted) return;
      Navigator.pop(context, true);
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('密码已重置，请使用新密码登录')));
    } catch (e) {
      if (mounted) setState(() { error = e.toString().replaceFirst('Bad state: ', ''); busy = false; });
    }
  }

  @override
  Widget build(BuildContext context) => Dialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(24)),
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: SingleChildScrollView(
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
              const Text('重置密码', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
              const SizedBox(height: 6),
              const Text('我们会向你注册的邮箱发送验证码，验证后即可设置新密码。', style: TextStyle(color: Color(0xff77818a), fontSize: 13)),
              const SizedBox(height: 18),
              TextField(controller: email, enabled: !busy, decoration: const InputDecoration(labelText: '注册邮箱')),
              const SizedBox(height: 12),
              Row(children: [
                Expanded(child: TextField(controller: code, enabled: !busy || sent, decoration: const InputDecoration(labelText: '验证码'))),
                const SizedBox(width: 10),
                SizedBox(height: 48, child: OutlinedButton(onPressed: busy ? null : send, child: Text(countdown > 0 ? '$countdown s' : '获取验证码'))),
              ]),
              const SizedBox(height: 12),
              TextField(controller: password, enabled: !busy, obscureText: true, decoration: const InputDecoration(labelText: '新密码')),
              if (error != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(error!, style: const TextStyle(color: Color(0xffc0392b), fontSize: 13))),
              const SizedBox(height: 18),
              SizedBox(width: double.infinity, height: 46, child: FilledButton(onPressed: busy ? null : submit, child: Text(busy ? '提交中…' : '重置密码'))),
            ]),
          ),
        ),
      );
}

class _UpdateDialog extends StatefulWidget {
  const _UpdateDialog({required this.info, required this.service});
  final Map<String, dynamic> info;
  final UpdateService service;
  @override
  State<_UpdateDialog> createState() => _UpdateDialogState();
}

class _UpdateDialogState extends State<_UpdateDialog> {
  bool _downloading = false;
  double _progress = 0;
  String _msg = '';
  String? _savedPath;

  Future<void> _startDownload() async {
    final down = (widget.info['download'] ?? '').toString();
    if (down.isEmpty) {
      setState(() => _msg = '安装包暂未发布，请稍后再试或前往官网下载。');
      return;
    }
    setState(() {
      _downloading = true;
      _progress = 0;
      _msg = '';
    });
    final path = await widget.service.download(
      down,
      onProgress: (loaded, total) {
        if (mounted) {
          setState(() => _progress = total > 0 ? loaded / total : 0);
        }
      },
    );
    if (!mounted) return;
    setState(() {
      _downloading = false;
      _savedPath = path;
    });
    if (path == null) {
      setState(() => _msg = '下载失败，请检查网络后重试');
      return;
    }
  }

  Future<void> _run() async {
    final p = _savedPath;
    if (p == null) return;
    final ok = await widget.service.launchInstaller(p);
    if (!mounted) return;
    if (ok) {
      Navigator.of(context).pop();
    } else {
      setState(() => _msg = '无法自动启动安装程序，请手动打开：$p');
    }
  }

  @override
  Widget build(BuildContext context) {
    final latest = (widget.info['latest'] ?? '').toString();
    final notes = (widget.info['releaseNotes'] ?? '').toString();
    return AlertDialog(
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
      title: const Row(children: [
        Icon(Icons.system_update_alt, color: Color(0xff18a66a)),
        SizedBox(width: 10),
        Text('发现新版本'),
      ]),
      content: SizedBox(
        width: 380,
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('当前：v$kAppVersion   最新：v$latest', style: const TextStyle(fontWeight: FontWeight.w700)),
          const SizedBox(height: 8),
          if (notes.isNotEmpty)
            Text(notes, style: const TextStyle(color: Color(0xff5b6670), height: 1.4)),
          const SizedBox(height: 14),
          if (_downloading) ...[
            LinearProgressIndicator(value: _progress.clamp(0, 1), color: const Color(0xff18a66a)),
            const SizedBox(height: 6),
            Text('正在下载安装包… ${(_progress * 100).round()}%', style: const TextStyle(color: Color(0xff5b6670), fontSize: 12)),
          ] else if (_msg.isNotEmpty)
            Text(_msg, style: const TextStyle(color: Color(0xffc0392b), fontSize: 12)),
          if (_savedPath != null)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text('已下载：$_savedPath', maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Color(0xff18a66a), fontSize: 11)),
            ),
        ]),
      ),
      actions: [
        TextButton(onPressed: _downloading ? null : () => Navigator.of(context).pop(), child: const Text('稍后')),
        if (_savedPath != null)
          FilledButton(onPressed: _run, child: const Text('立即安装'))
        else
          FilledButton(onPressed: _downloading ? null : _startDownload, child: Text(_downloading ? '下载中…' : '下载并更新')),
      ],
    );
  }
}
