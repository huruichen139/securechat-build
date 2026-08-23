import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:file_picker/file_picker.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:record/record.dart';
import 'package:pointycastle/export.dart' as pc;
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:window_manager/window_manager.dart';
import 'chat_features.dart';
import 'package:audioplayers/audioplayers.dart';

import 'services/securechat_api.dart';
import 'services/app_config.dart';
import 'services/chat_crypto.dart';
import 'services/x3dh.dart';
import 'services/call_service.dart';
import 'widgets/app_scaffold.dart';
import 'widgets/window_effect.dart';
import 'widgets/ux.dart';
import 'call_page.dart';
import 'deeplink.dart';
import 'qr_confirm_page.dart';
import 'update_service.dart';
import 'favorites_page.dart';
import 'discover_page.dart';
import 'me_page.dart';
import 'community_tools_page.dart';

const Color _wechatGreen = Color(0xff07c160);

// 全局好友申请（新的朋友）：ContactsView 与聊天视图共享
final gFriendReqs = <int, Map<String, dynamic>>{};
final gFriendReqTick = ValueNotifier<int>(0);
const Color _wechatBubbleMine = Color(0xff95EC69);

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
      final eff = config.effect;
      await windowManager.setBackgroundColor(
        eff == WindowEffectKind.none ? const Color(0xFFF7F7F7) : Colors.transparent,
      );
    } catch (_) {}
  }
  DeepLink.init(api: api, config: config);
  runApp(SecureChatApp(config: config, api: api));
  // 冷启动深链：securechat:// 协议唤起时，URL 作为命令行参数传入，
  // 等首帧渲染完成后再打开对应页面。
  WidgetsBinding.instance.addPostFrameCallback((_) {
    if (!Platform.isWindows) return;
    for (final arg in Platform.executableArguments) {
      if (arg.startsWith('securechat://')) {
        DeepLink.handle(arg);
        break;
      }
    }
  });
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
          navigatorKey: appNavigatorKey,
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

  Future<void> beginPasskey() async {
    if (busy) return;
    final sp = await SharedPreferences.getInstance();
    final raw = sp.getString('sc_passkeys');
    if (raw == null || raw.isEmpty) {
      setState(() => error = '尚未创建 Passkey，请登录后在设置中创建');
      return;
    }
    final list = (jsonDecode(raw) as List).cast<Map<String, dynamic>>();
    if (list.isEmpty) { setState(() => error = '尚未创建 Passkey'); return; }
    final selected = list.length == 1 ? list.first : await showDialog<Map<String, dynamic>>(
      context: context,
      builder: (ctx) => SimpleDialog(
        title: const Text('选择 Passkey'),
        children: list.map((p) => SimpleDialogOption(
          onPressed: () => Navigator.pop(ctx, p),
          child: Text('${p['deviceName'] ?? '设备'}'),
        )).toList(),
      ),
    );
    if (selected == null) return;
    setState(() { busy = true; error = '正在验证 Passkey…'; });
    try {
      final id = selected['credentialId'] as String;
      final secret = selected['secret'] as String;
      final start = await api.passkeyStart(id);
      final mac = pc.HMac(pc.SHA256Digest(), 64)
        ..init(pc.KeyParameter(utf8.encode(secret)))
        ..update(utf8.encode('${start['challenge']}'), 0, '${start['challenge']}'.length);
       final out = Uint8List(mac.macSize);
      mac.doFinal(out, 0);
      final signature = out.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
      final result = await api.passkeyFinish(id, signature);
      await api.applyLoginData(result);
      if (!mounted) return;
      Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => ChatShell(api: api, config: widget.config)));
    } catch (e) {
      if (mounted) setState(() { busy = false; error = e.toString().replaceFirst('Bad state: ', ''); });
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
                    decoration: BoxDecoration(
                      color: config.theme.card,
                      borderRadius: BorderRadius.circular(18),
                      border: Border.all(color: config.theme.div.withValues(alpha: 0.4)),
                      boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: config.theme.isDark ? 0.35 : 0.08), blurRadius: 28, offset: const Offset(0, 12))],
                    ),
                    child: Row(children: [
                      if (!compact) const Expanded(child: WelcomePanel()),
                      Expanded(child: Padding(padding: EdgeInsets.all(compact ? 28 : 58), child: _form(context))),
                    ]),
                  );
                }),
              ),
            ),
            Positioned(top: 16, right: 16, child: Icon(Icons.security, color: config.primary.withValues(alpha: 0.8), size: 18)),
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
      Container(
        padding: const EdgeInsets.all(4),
        decoration: BoxDecoration(color: t.inputBg, borderRadius: BorderRadius.circular(12)),
        child: Row(children: [
          _mode('密码登录', 0, t),
          _mode('邮箱验证码', 1, t),
          _mode('扫码登录', 2, t),
          _mode('Passkey', 3, t),
        ]),
      ),
      const SizedBox(height: 22),
      if (mode == 0) ...[
        TextField(controller: account, style: TextStyle(color: t.text), decoration: InputDecoration(labelText: '用户名或邮箱', labelStyle: TextStyle(color: t.subText))),
        const SizedBox(height: 12),
        TextField(controller: password, obscureText: true, style: TextStyle(color: t.text), decoration: InputDecoration(labelText: '密码', labelStyle: TextStyle(color: t.subText))),
      ] else if (mode == 1) ...[
        TextField(controller: email, style: TextStyle(color: t.text), decoration: InputDecoration(labelText: '邮箱地址', labelStyle: TextStyle(color: t.subText))),
        const SizedBox(height: 12),
        Row(children: [Expanded(child: TextField(controller: code, style: TextStyle(color: t.text), decoration: InputDecoration(labelText: '验证码', labelStyle: TextStyle(color: t.subText)))), const SizedBox(width: 10), OutlinedButton(onPressed: busy ? null : sendEmailCode, child: Text(countdown > 0 ? '$countdown s' : '获取验证码'))]),
      ] else if (mode == 2) ...[
        Center(child: Column(children: [
          Container(width: 176, height: 176, padding: const EdgeInsets.all(12), decoration: BoxDecoration(border: Border.all(color: t.div), borderRadius: BorderRadius.circular(16)), child: qrText == null ? const _QrPlaceholder() : QrImageView(data: qrText!, version: QrVersions.auto)),
          const SizedBox(height: 14),
          Text('请使用已登录的手机扫描此二维码', style: TextStyle(fontWeight: FontWeight.w600, color: t.text)),
          const SizedBox(height: 4),
          Text('手机确认后，电脑端会自动登录', style: TextStyle(color: t.subText, fontSize: 12)),
        ])),
      ] else ...[
        Center(child: Column(children: [
          Container(width: 72, height: 72, decoration: const BoxDecoration(color: Color(0xff2f80ed), borderRadius: BorderRadius.all(Radius.circular(20))), child: const Icon(Icons.key_rounded, color: Colors.white, size: 40)),
          const SizedBox(height: 14),
          Text('使用本地 Passkey 快速登录', style: TextStyle(fontWeight: FontWeight.w600, color: t.text)),
          const SizedBox(height: 4),
          Text('密钥只保存在本地设备，服务器只保存验证凭据', style: TextStyle(color: t.subText, fontSize: 12)),
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
      SizedBox(width: double.infinity, height: 48, child: FilledButton(
        onPressed: busy ? null : (mode == 2 ? beginQr : mode == 3 ? beginPasskey : login),
        child: Text(mode == 3
            ? (busy ? '验证中…' : 'Passkey 登录')
            : busy ? '处理中…' : mode == 2 ? (qrText == null ? '生成二维码' : '等待手机确认') : '登录'),
      )),
      const SizedBox(height: 18),
      Center(child: Text('SecureChat $kAppVersion', style: TextStyle(color: t.subText, fontSize: 12))),
    ]);
  }

  Widget _mode(String label, int value, AppTheme t) {
    final selected = mode == value;
    return Expanded(
      child: GestureDetector(
        onTap: () => setState(() => mode = value),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 180),
          padding: const EdgeInsets.symmetric(vertical: 11),
          decoration: BoxDecoration(color: selected ? widget.config.theme.card : Colors.transparent, borderRadius: BorderRadius.circular(9), boxShadow: selected ? [BoxShadow(color: Colors.black.withValues(alpha: 0.08), blurRadius: 8, offset: const Offset(0, 2))] : null),
          child: Center(child: Text(label, style: TextStyle(fontSize: 12, color: selected ? widget.config.primary : t.subText, fontWeight: selected ? FontWeight.w700 : FontWeight.w500))),
        ),
      ),
    );
  }
}

class WelcomePanel extends StatelessWidget {
  const WelcomePanel({super.key});
  @override
  Widget build(BuildContext context) => Container(
    decoration: const BoxDecoration(color: Color(0xff163d32), borderRadius: BorderRadius.horizontal(left: Radius.circular(18))),
    padding: const EdgeInsets.all(52),
    child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisAlignment: MainAxisAlignment.center, children: [
      Container(width: 54, height: 54, decoration: BoxDecoration(color: _wechatGreen, borderRadius: BorderRadius.circular(14)), child: const Icon(Icons.lock_rounded, color: Colors.white, size: 28)),
      const SizedBox(height: 30),
      const Text('私密地聊天，\n自然地沟通。', style: TextStyle(color: Colors.white, fontSize: 34, height: 1.08, fontWeight: FontWeight.w800)),
      const SizedBox(height: 20),
      const Text('端到端加密 · 多端同步 · 音视频通话', style: TextStyle(color: Color(0xffa9d9c4), fontSize: 14)),
    ]),
  );
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
  int _tab = 0;
  final _chatViewState = GlobalKey<_ChatViewStateState>();
  final _contactsViewState = GlobalKey<_ContactsViewStateState>();
  ({int id, bool isGroup, String name})? _pendingOpen;

  @override
  void initState() {
    super.initState();
    _loadAnnouncements();
  }

  Future<void> _loadAnnouncements() async {
    try {
      final anns = await widget.api.fetchAnnouncements();
      if (!mounted || anns.isEmpty) return;
      for (final a in anns) {
        if (!mounted) return;
        final level = a['level'] ?? 'info';
        final color = level == 'danger' ? Colors.red : level == 'warning' ? Colors.orange : _wechatGreen;
        showDialog(
          context: context,
          builder: (ctx) => AlertDialog(
            icon: Icon(Icons.campaign, color: color, size: 32),
            title: Text(a['title'] ?? '公告'),
            content: Text(a['content'] ?? ''),
            actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('我知道了'))],
          ),
        );
        await Future.delayed(const Duration(milliseconds: 300));
      }
    } catch (_) {}
  }

  void _openChatFromContacts(int id, bool isGroup, String name) {
    setState(() {
      _tab = 0;
      _pendingOpen = (id: id, isGroup: isGroup, name: name);
    });
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
                  child: Row(
                    children: [
                      _rail(config),
                      VerticalDivider(width: 1, thickness: 1, color: config.theme.div),
                      Expanded(
                        child: <Widget>[
                          _ChatView(key: _chatViewState, api: widget.api, config: config, initialOpen: _pendingOpen, onOpenConsumed: () => _pendingOpen = null),
                          ContactsView(key: _contactsViewState, api: widget.api, config: config, onOpenChat: _openChatFromContacts),
                          DiscoverPage(api: widget.api, config: config, onOpenChat: _openChatFromContacts),
                          MePage(api: widget.api, config: config),
                        ][_tab],
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  Future<void> _confirmLogout() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        title: const Text('退出登录'),
        content: const Text('确定要退出当前账号吗？'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('退出')),
        ],
      ),
    );
    if (ok != true) return;
    await widget.api.clearSession();
    if (!mounted) return;
    Navigator.of(context).popUntil((r) => r.isFirst);
  }

  Widget _rail(AppConfig config) {
    final t = config.theme;
    final railBg = t.isDark ? const Color(0xff17181a) : const Color(0xfff2f3f5);
    final items = <(int, IconData, String)>[
      (0, Icons.chat_bubble_outline_rounded, '微信'),
      (1, Icons.contacts_outlined, '通讯录'),
      (2, Icons.explore_outlined, '发现'),
      (3, Icons.person_outline_rounded, '我'),
    ];
    Widget navBtn(int idx, IconData icon, String label) {
      final on = _tab == idx;
      return Tooltip(
        message: label,
        child: InkWell(
          onTap: () => setState(() => _tab = idx),
          borderRadius: BorderRadius.circular(8),
          child: SizedBox(
            width: 54,
            height: 48,
            child: Center(child: Icon(icon, size: 24, color: on ? _wechatGreen : t.subText)),
          ),
        ),
      );
    }
    return Container(
      width: 54,
      color: railBg,
      child: Column(children: [
        const SizedBox(height: 12),
        CircleAvatar(radius: 18, backgroundColor: _wechatGreen, child: const Text('S', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w700, fontSize: 13))),
        const SizedBox(height: 20),
        for (final (i, ic, lb) in items) ...[
          navBtn(i, ic, lb),
          const SizedBox(height: 4),
        ],
        const Spacer(),
        Tooltip(
          message: '退出登录',
          child: InkWell(
            onTap: _confirmLogout,
            borderRadius: BorderRadius.circular(8),
            child: SizedBox(width: 54, height: 48, child: Center(child: Icon(Icons.logout_rounded, size: 22, color: t.subText))),
          ),
        ),
        const SizedBox(height: 10),
      ]),
    );
  }
}

// ─── 微信 Tab：会话列表 + 聊天窗口 ───────────────────────────────────────────

class _ChatView extends StatefulWidget {
  const _ChatView({super.key, required this.api, required this.config, this.initialOpen, this.onOpenConsumed});
  final SecureChatApi api;
  final AppConfig config;
  final ({int id, bool isGroup, String name})? initialOpen;
  final VoidCallback? onOpenConsumed;
  @override
  State<_ChatView> createState() => _ChatViewStateState();
}

class _ChatViewStateState extends State<_ChatView> {
  int selected = -1;
  final input = TextEditingController();
  final messages = <Map<String, dynamic>>[];
  final conversations = <Map<String, dynamic>>[];
  final _deletedIds = <String>{};
  final _unread = <String, int>{};
  final _lastMsg = <String, Map<String, dynamic>>{};
  final _groupReadUsers = <String, Set<int>>{};
  final _unreadDividerKey = GlobalKey();
  bool _deletedLoaded = false;
  WebSocketChannel? socket;
  StreamSubscription? _wsSub;
  int _wsReconnectAttempt = 0;
  CallService? calls;
  final recorder = AudioRecorder();
  bool recording = false;
  int _recordingStart = 0; // 录音开始时间戳（用于计算时长）
  Timer? _recordingTimer;
  int _recordingDuration = 0;
  int _groupOnlineCount = -1; // 当前群在线人数（-1=未知）
  AudioPlayer? voicePlayer;
  String? playingVoiceId;
  Duration _voicePosition = Duration.zero;
  Duration _voiceDuration = Duration.zero;
  int? myId;
  String? selName;
  final _sentIds = <String>{};
  int? replyingTo;
  String? replyPreview;
  final inputFocus = FocusNode();
  final searchCtrl = TextEditingController();
  final ScrollController _msgScroll = ScrollController();
  String _search = '';
  bool _chatSearchVisible = false;
  final _chatSearchCtrl = TextEditingController();
  String _chatSearchQuery = '';
  List<Map<String, dynamic>> _chatSearchResults = [];
  int _chatSearchIdx = -1;
  bool _isTyping = false;
  final _drafts = <String, String>{}; // 会话草稿 keyed by 'f$fid' or 'g$gid'
  final _chatBgColors = <String, Color>{}; // 会话背景色 keyed by convKey
  bool _multiSelectMode = false;
  bool _morePanel = false;
  bool _showScrollDown = false;
  final _selectedMsgs = <Map<String, dynamic>>{};
  double _fontSize = 15.0; // 聊天字体大小
  final _likedMsgs = <String, int>{}; // 双击点赞: msgKey -> 点赞时间戳
  final _mentionMe = <String, bool>{};
  Map<String, dynamic>? _pinnedMsg; // 群聊@我标记 keyed by convKey // 双击点赞: msgKey -> 点赞时间戳

  Map<String, dynamic>? get selConv => selected >= 0 && selected < conversations.length ? conversations[selected] : null;

  /// 会话打开序号：快速切换会话时，旧的历史请求返回后不得再写入当前列表
  /// （否则会把上一个会话的消息追加进来，看起来像"重复/多出消息"）
  int _openSeq = 0;

  /// 是否已存在同一条消息（按 clientMsgId 或服务端 id 去重）。
  /// 本地乐观插入 + 服务端回显 + 历史拉取都可能带来同一条，统一在此挡掉。
  bool _isDuplicateMsg({String? cmid, dynamic id}) {
    if (cmid != null && cmid.isNotEmpty) {
      if (messages.any((m) => m['cmid'] == cmid)) return true;
    }
    if (id != null) {
      if (messages.any((m) => m['id'] != null && m['id'] == id)) return true;
    }
    return false;
  }

  /// 统一的追加入口：先去重，再插入。调用方需在 setState 内使用。
  void _appendMsg(Map<String, dynamic> m) {
    if (_isDuplicateMsg(cmid: m['cmid'] as String?, id: m['id'])) return;
    messages.add(m);
    WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToBottom());
  }

  void _scrollToBottom() {
    if (!_msgScroll.hasClients) return;
    _msgScroll.animateTo(_msgScroll.position.maxScrollExtent, duration: const Duration(milliseconds: 220), curve: Curves.easeOut);
  }

  @override
  void initState() {
    super.initState();
    _pendingOpen = widget.initialOpen;
    if (_pendingOpen != null) widget.onOpenConsumed?.call();
    input.addListener(_onInputChanged);
    _connect();
    _loadData();
    _checkUpdate();
    _loadPrefs();
    _msgScroll.addListener(() { if (mounted) { final atBottom = _msgScroll.position.pixels >= _msgScroll.position.maxScrollExtent - 80; if (_showScrollDown == atBottom) setState(() { _showScrollDown = !atBottom; }); } });
  }

  Future<void> _loadPrefs() async {
    try {
      final sp = await SharedPreferences.getInstance();
      final fs = sp.getDouble('chatFontSize');
      if (fs != null && fs >= 12 && fs <= 22 && mounted) setState(() => _fontSize = fs);
      // 加载聊天背景色
      final bgKeys = sp.getStringList('chatBgColors');
      if (bgKeys != null && mounted) {
        setState(() {
          for (final entry in bgKeys) {
            final parts = entry.split(':');
            if (parts.length == 2) {
              final val = int.tryParse(parts[1]);
              if (val != null) _chatBgColors[parts[0]] = Color(val);
            }
          }
        });
      }
    } catch (_) {}
  }

  void _onInputChanged() {
    final hasText = input.text.trim().isNotEmpty;
    if (hasText != _isTyping) {
      setState(() => _isTyping = hasText);
    }
    // 群聊 @ 提及检测
    if (selConv != null && selConv!['kind'] == 'group') {
      final text = input.text;
      final cursor = input.selection.baseOffset;
      if (cursor > 0 && cursor <= text.length) {
        final before = text.substring(0, cursor);
        final atMatch = RegExp(r'@([^\s@]*)$').firstMatch(before);
        if (atMatch != null && atMatch[1]!.length < 20) {
          _showMentionOverlay(atMatch[1]!);
          return;
        }
      }
      _hideMentionOverlay();
    }
  }

  OverlayEntry? _mentionOverlay;

  void _showMentionOverlay(String query) async {
    try {
      final gid = selConv?['id'] as int?;
      if (gid == null) return;
      final members = await widget.api.groupMembers(gid);
      if (!mounted) return;
      final filtered = query.isEmpty
          ? members
          : members.where((m) {
              final nick = (m['nickname'] ?? m['username'] ?? '').toString().toLowerCase();
              return nick.contains(query.toLowerCase());
            }).toList();
      if (filtered.isEmpty) { _hideMentionOverlay(); return; }
      _hideMentionOverlay();
      _mentionOverlay = OverlayEntry(
        builder: (ctx) => Positioned(
          bottom: 80, left: 60,
          child: Material(elevation: 8, borderRadius: BorderRadius.circular(8), child: Container(
            constraints: const BoxConstraints(maxHeight: 200, maxWidth: 220),
            decoration: BoxDecoration(color: Theme.of(ctx).scaffoldBackgroundColor, borderRadius: BorderRadius.circular(8)),
            child: ListView.builder(
              shrinkWrap: true,
              itemCount: filtered.length > 8 ? 8 : filtered.length,
              itemBuilder: (_, i) {
                final m = filtered[i];
                final nick = (m['nickname'] ?? m['username'] ?? '?').toString();
                final online = m['online'] == true;
                return ListTile(
                  dense: true,
                  leading: Stack(clipBehavior: Clip.none, children: [CircleAvatar(radius: 14, backgroundColor: _wechatGreen, child: Text(nick.isNotEmpty ? nick[0] : '?', style: const TextStyle(color: Colors.white, fontSize: 11))), if (online) Positioned(right: -1, bottom: -1, child: Container(width: 9, height: 9, decoration: BoxDecoration(color: const Color(0xff07c160), shape: BoxShape.circle, border: Border.all(color: Colors.white, width: 1.5)))),
                  ]),
                  title: Text(nick, style: const TextStyle(fontSize: 13)),
                  onTap: () {
                    _insertMention(nick);
                    _hideMentionOverlay();
                  },
                );
              },
            ),
          )),
        ),
      );
      Overlay.of(context).insert(_mentionOverlay!);
    } catch (_) {}
  }

  void _hideMentionOverlay() {
    _mentionOverlay?.remove();
    _mentionOverlay = null;
  }

  void _insertMention(String nick) {
    final text = input.text;
    final cursor = input.selection.baseOffset;
    if (cursor < 0 || cursor > text.length) return;
    final before = text.substring(0, cursor);
    final after = text.substring(cursor);
    final replaced = before.replaceFirst(RegExp(r'@([^\s@]*)$'), '@$nick ');
    input.text = '$replaced$after';
    input.selection = TextSelection.collapsed(offset: replaced.length);
    inputFocus.requestFocus();
  }

  ({int id, bool isGroup, String name})? _pendingOpen;

  bool _updatePrompted = false;
  Future<void> _checkUpdate() async {
    if (_updatePrompted || !Platform.isWindows) return;
    try {
      final svc = UpdateService(api: widget.api);
      final info = await svc.check();
      if (info == null || !mounted) return;
      _updatePrompted = true;
      showDialog(context: context, builder: (_) => _UpdateDialog(info: info, service: svc));
    } catch (_) {}
  }

  Future<void> _loadData() async {
    try {
      final friends = await widget.api.friends();
      final groups = await widget.api.groups();
      final cs = await widget.api.chatSettings();
      final csMap = <int, Map<String, dynamic>>{};
      for (final s in cs) {
        final pid = s['peerId'];
        if (pid is int) csMap[pid] = s;
      }
      if (!mounted) return;
      setState(() {
        conversations.clear();
        for (final f in friends) {
          final settings = csMap[f['id']];
          final fId = f['id'];
          final fPub = (f['pubkey'] ?? f['publicKey'] ?? f['identityKey'] ?? '').toString();
          if (fId is int && fPub.isNotEmpty) cacheIdentityPub(fId, fPub);
          conversations.add({'kind': 'friend', 'id': f['id'], 'name': (f['nickname'] ?? f['username'] ?? '').toString(), 'icon': Icons.person, 'online': f['online'] == true, 'lastSeen': f['lastSeen'], 'pinned': settings?['pinned'] == true, 'muted': settings?['muted'] == true});
        }
        for (final g in groups) {
          final settings = csMap[g['id']];
          conversations.add({'kind': 'group', 'id': g['id'], 'name': (g['name'] ?? '群聊').toString(), 'icon': Icons.groups_rounded, 'online': false, 'pinned': settings?['pinned'] == true, 'muted': settings?['muted'] == true});
        }
        conversations.sort((a, b) { final bp = (b['pinned'] == true) ? 1 : 0; final ap = (a['pinned'] == true) ? 1 : 0; if (bp != ap) return bp - ap; final bu = ((b['unread'] as num?)?.toInt() ?? 0); final au = ((a['unread'] as num?)?.toInt() ?? 0); return bu.compareTo(au); });
        messages.clear();
      });
      final pending = _pendingOpen;
      if (pending != null) {
        _pendingOpen = null;
        await _openConversationById(pending.id, isGroup: pending.isGroup, name: pending.name);
        return;
      }
      if (conversations.isNotEmpty) await _openConversation(0);
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('加载会话失败：$e')));
    }
  }

  int _findConversation(int id, {required bool isGroup}) {
    for (var i = 0; i < conversations.length; i++) {
      final c = conversations[i];
      if (c['kind'] == (isGroup ? 'group' : 'friend') && c['id'] == id) return i;
    }
    return -1;
  }

  /// 从通讯录跳转：按 id 打开好友/群会话；会话列表里没有则临时加入一条再打开
  /// （历史消息由 _openConversation 按 id 拉取，不受会话列表影响）。
  Future<void> _openConversationById(int id, {required bool isGroup, String name = ''}) async {
    if (mounted && (_search.isNotEmpty || searchCtrl.text.isNotEmpty)) {
      setState(() {
        _search = '';
        searchCtrl.clear();
      });
    }
    var idx = _findConversation(id, isGroup: isGroup);
    if (idx < 0) {
      if (!mounted) return;
      setState(() {
        conversations.add({
          'kind': isGroup ? 'group' : 'friend',
          'id': id,
          'name': name,
          'icon': isGroup ? Icons.groups_rounded : Icons.person,
          'online': false,
          'pinned': false,
          'muted': false,
        });
      });
      idx = conversations.length - 1;
    }
    await _openConversation(idx);
  }

  Future<void> _openConversation(int index) async {
    final conv = conversations[index];
    final seq = ++_openSeq;
    // 保存当前草稿
    if (selConv != null) {
      final oldKey = _convKey(selConv!);
      if (input.text.isNotEmpty) { _drafts[oldKey] = input.text; } else { _drafts.remove(oldKey); }
    }
    setState(() { selected = index; _unread.remove(_convKey(conv)); });
    messages.clear();
    // 恢复目标会话草稿
    final newKey = _convKey(conv);
    final draft = _drafts.remove(newKey);
    input.text = draft ?? '';
    if (draft != null && draft.isNotEmpty) inputFocus.requestFocus();
    if (conv['kind'] == 'group') {
      if (mounted) setState(() => selName = conv['name'].toString());
      final gid = conv['id'] as int;
      _groupReadUsers['g$gid'] = <int>{};
      _mentionMe.remove('g$gid');
      if (mounted) setState(() => _groupOnlineCount = -1);
      widget.api.groupMembers(gid).then((members) {
        if (!mounted || selConv?['id'] != gid || selConv?['kind'] != 'group') return;
        final n = members.where((m) => m['online'] == true).length;
        setState(() => _groupOnlineCount = n);
      }).catchError((_) {});
      try {
        final ghis = await widget.api.groupHistory(gid);
        if (!mounted) return;
        final msgs = <Map<String, dynamic>>[];
        for (final m in ghis) {
          final content = (m['content'] ?? '').toString();
          final text = looksLikeRatchetCipher(content)
              ? '[加密消息，历史内容不可在此会话恢复]'
              : await e2eeDecrypt('$gid', content);
          final from = m['from'];
          final mine = from == myId;
          final sender = (m['fromUser'] is Map) ? (((m['fromUser'] as Map)['nickname'] ?? (m['fromUser'] as Map)['username']) ?? '').toString() : null;
          final voice = RegExp(r'^\[语音消息:([0-9a-f-]{8,})(?::(\d+))?\]$').firstMatch(text);
          final read = mine || m['read'] == true;
          final readCount = (m['readCount'] as num?)?.toInt() ?? (mine ? 1 : 0);
          msgs.add(voice != null
              ? {'voiceId': voice[1], 'voiceDur': voice[2] != null ? int.tryParse(voice[2]!) : null, 'mine': mine, 'time': _fmtTs(m['createdAt']), 'ts': m['createdAt'], 'id': m['id'], 'sender': sender, 'replyTo': m['replyTo'], 'replyContent': m['replyContent'], 'read': read, 'readCount': readCount}
              : {'text': text, 'mine': mine, 'time': _fmtTs(m['createdAt']), 'ts': m['createdAt'], 'id': m['id'], 'sender': sender, 'replyTo': m['replyTo'], 'replyContent': m['replyContent'], 'read': read, 'readCount': readCount});
        }
        final dedup = _dedupById(msgs)..removeWhere((m) => _isDeleted(m['id']));
        final pinned = dedup.where((m) => m['pinned'] == true).toList();
        _insertUnreadDivider(dedup);
        if (!mounted || seq != _openSeq) return;
        setState(() { messages..clear()..addAll(dedup); _pinnedMsg = pinned.isNotEmpty ? pinned.last : null; });
        _markIncomingRead();
        socket?.sink.add(jsonEncode({'type': 'group_read', 'payload': {'groupId': gid}}));
        _scrollToLatest();
      } catch (e) { debugPrint('[chat] load group history failed: $e'); }
      return;
    }
    final peerId = conv['id'] as int;
    if (mounted) setState(() => selName = conv['name'].toString());
    try {
      final history = await widget.api.history(peerId);
      if (!mounted || seq != _openSeq) return;
      final msgs = <Map<String, dynamic>>[];
      for (final m in history) {
        final content = (m['content'] ?? '').toString();
        final text = looksLikeRatchetCipher(content)
            ? '[加密消息，历史内容不可在此会话恢复]'
            : await e2eeDecrypt('$peerId', content);
        final mine = m['from'] == myId || (m['from'] ?? 0) == myId || (m['from'] ?? 0) != peerId;
        final voice = RegExp(r'^\[语音消息:([0-9a-f-]{8,})(?::(\d+))?\]$').firstMatch(text);
        final read = m['read'] == true;
        msgs.add(voice != null
            ? {'voiceId': voice[1], 'voiceDur': voice[2] != null ? int.tryParse(voice[2]!) : null, 'mine': mine, 'time': _fmtTs(m['createdAt']), 'ts': m['createdAt'], 'id': m['id'], 'replyTo': m['replyTo'], 'replyContent': m['replyContent'], 'forwardedFrom': m['forwardedFrom'], 'read': read}
            : {'text': text, 'mine': mine, 'time': _fmtTs(m['createdAt']), 'ts': m['createdAt'], 'id': m['id'], 'replyTo': m['replyTo'], 'replyContent': m['replyContent'], 'forwardedFrom': m['forwardedFrom'], 'read': read});
      }
      final dedup = _dedupById(msgs)..removeWhere((m) => _isDeleted(m['id']));
      final pinned = dedup.where((m) => m['pinned'] == true).toList();
      _insertUnreadDivider(dedup);
      if (!mounted || seq != _openSeq) return;
      setState(() { messages..clear()..addAll(dedup); _pinnedMsg = pinned.isNotEmpty ? pinned.last : null; });
      _markIncomingRead();
      socket?.sink.add(jsonEncode({'type': 'read', 'payload': {'from': peerId}}));
      _scrollToLatest();
    } catch (e) { debugPrint('[chat] load history failed: $e'); }
  }

  /// 在第一条未读消息上方插入「N 条未读消息」分割条（仅聊天类消息，不含分割条自身）
  void _insertUnreadDivider(List<Map<String, dynamic>> msgs) {
    // 先插入日期分隔条
    _insertDateSeparators(msgs);
    var unreadCount = 0;
    var firstIdx = -1;
    for (var i = 0; i < msgs.length; i++) {
      final m = msgs[i];
      if (m['divider'] == true || m['dateSep'] == true) continue;
      if (m['mine'] != true && m['read'] != true) {
        unreadCount++;
        if (firstIdx < 0) firstIdx = i;
      }
    }
    if (unreadCount > 0 && firstIdx >= 0) {
      msgs.insert(firstIdx, {'divider': true, 'unreadCount': unreadCount});
    }
  }

  static String _dateLabel(int ts) {
    final dt = DateTime.fromMillisecondsSinceEpoch(ts);
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final msgDay = DateTime(dt.year, dt.month, dt.day);
    final diff = today.difference(msgDay).inDays;
    if (diff == 0) return '今天';
    if (diff == 1) return '昨天';
    if (diff < 7) return '${diff}天前';
    return '${dt.year}/${dt.month}/${dt.day}';
  }

  void _insertDateSeparators(List<Map<String, dynamic>> msgs) {
    if (msgs.isEmpty) return;
    final inserts = <int, Map<String, dynamic>>{};
    String? lastLabel;
    for (var i = 0; i < msgs.length; i++) {
      final ts = msgs[i]['ts'];
      if (ts == null) continue;
      final label = _dateLabel(ts is int ? ts : int.tryParse('$ts') ?? 0);
      if (label != lastLabel) {
        inserts[i] = {'dateSep': true, 'label': label};
        lastLabel = label;
      }
    }
    int offset = 0;
    for (final entry in inserts.entries) {
      msgs.insert(entry.key + offset, entry.value);
      offset++;
    }
  }

  /// 打开会话后：本地把对方发来的消息标记为已读（视觉不再显示"未读"）
  void _markIncomingRead() {
    setState(() {
      for (final m in messages) {
        if (m['mine'] != true) m['read'] = true;
      }
    });
  }

  /// Scroll to newest messages after opening a conversation.
  /// lazy ListView.builder's maxScrollExtent is an estimate on the first frame,
  /// so jump repeatedly over frames until the real bottom is reached.
  void _scrollToLatest() {
    _snapToBottom();
  }

  /// Lazily-built ListView reports maxScrollExtent incrementally;
  /// keep jumping one frame at a time until the real bottom is reached.
  void _snapToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_msgScroll.hasClients) return;
      final pos = _msgScroll.position;
      if (pos.maxScrollExtent > pos.pixels) {
        pos.jumpTo(pos.maxScrollExtent);
        _snapToBottom();
      }
    });
  }

  void _onChatSearchChanged(String q) {
    setState(() {
      _chatSearchQuery = q;
      if (q.isEmpty) {
        _chatSearchResults = [];
        _chatSearchIdx = -1;
        return;
      }
      final lower = q.toLowerCase();
      _chatSearchResults = messages.where((m) {
        final text = (m['text'] ?? '').toString().toLowerCase();
        return text.contains(lower) && m['divider'] != true;
      }).toList();
      _chatSearchIdx = _chatSearchResults.isNotEmpty ? 0 : -1;
    });
    if (_chatSearchResults.isNotEmpty) _scrollToSearchResult(0);
  }

  void _scrollToSearchResult(int idx) {
    if (idx < 0 || idx >= _chatSearchResults.length) return;
    final msg = _chatSearchResults[idx];
    final i = messages.indexOf(msg);
    if (i < 0 || !_msgScroll.hasClients) return;
    final target = (i / messages.length) * _msgScroll.position.maxScrollExtent;
    _msgScroll.animateTo(target.clamp(0.0, _msgScroll.position.maxScrollExtent), duration: const Duration(milliseconds: 300), curve: Curves.easeOut);
    setState(() => _chatSearchIdx = idx);
  }

  Widget _highlightText(String text, String query, {required TextStyle style, int maxLines = 4}) {
    if (query.isEmpty) return Text(text, maxLines: maxLines, overflow: TextOverflow.ellipsis, style: style);
    final lower = text.toLowerCase();
    final qLower = query.toLowerCase();
    final spans = <TextSpan>[];
    int lastIdx = 0;
    while (true) {
      final idx = lower.indexOf(qLower, lastIdx);
      if (idx < 0) { spans.add(TextSpan(text: text.substring(lastIdx), style: style)); break; }
      if (idx > lastIdx) spans.add(TextSpan(text: text.substring(lastIdx, idx), style: style));
      spans.add(TextSpan(text: text.substring(idx, idx + query.length), style: style.copyWith(backgroundColor: const Color(0xfffff176).withValues(alpha: 0.6), color: const Color(0xff1a1a1a))));
      lastIdx = idx + query.length;
    }
    return RichText(maxLines: maxLines, overflow: TextOverflow.ellipsis, text: TextSpan(children: spans));
  }


  void _nextSearchResult() {
    if (_chatSearchResults.isEmpty) return;
    final next = (_chatSearchIdx + 1) % _chatSearchResults.length;
    _scrollToSearchResult(next);
  }

  void _prevSearchResult() {
    if (_chatSearchResults.isEmpty) return;
    final prev = (_chatSearchIdx - 1 + _chatSearchResults.length) % _chatSearchResults.length;
    _scrollToSearchResult(prev);
  }

  void _toggleChatSearch() {
    setState(() {
      _chatSearchVisible = !_chatSearchVisible;
      if (!_chatSearchVisible) {
        _chatSearchCtrl.clear();
        _chatSearchQuery = '';
        _chatSearchResults = [];
        _chatSearchIdx = -1;
      }
    });
    if (_chatSearchVisible) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (_chatSearchVisible) FocusScope.of(context).requestFocus(FocusNode());
      });
    }
  }

  /// 历史列表按服务端 id 去重（服务端重复行/多次拉取时兜底）
  static List<Map<String, dynamic>> _dedupById(List<Map<String, dynamic>> list) {
    final seen = <String>{};
    final out = <Map<String, dynamic>>[];
    for (final m in list) {
      final id = m['id'];
      if (id != null) {
        final k = '$id';
        if (seen.contains(k)) continue;
        seen.add(k);
      }
      out.add(m);
    }
    return out;
  }

  static String _fmtTs(dynamic ts) {
    final v = int.tryParse('$ts');
    if (v == null || v <= 0) return '';
    final t = DateTime.fromMillisecondsSinceEpoch(v);
    final hh = t.hour.toString().padLeft(2, '0');
    final mm = t.minute.toString().padLeft(2, '0');
    return '$hh:$mm';
  }

  Future<void> _connect() async {
    try {
      _wsReconnectAttempt = 0; // 连接成功时重置
      myId = widget.api.myId;
      x3dhApi = widget.api;
      _ensureDeletedLoaded();
      if (myId != null) {
        await ensureE2eeProtocolState(myId!);
        uploadMyPrekeys(widget.api);
      }
      socket = widget.api.connect();
      _wsSub?.cancel();
      _wsSub = socket!.stream.listen((event) async {
        final root = jsonDecode(event as String) as Map<String, dynamic>;
        final type = root['type'];
        if (type == 'msg') {
          final p = (root['payload'] as Map).cast<String, dynamic>();
          if (!mounted) return;
          final cmid = (p['clientMsgId'] ?? '').toString();
          // 自己发的消息：若本地已乐观插入，只补服务端 id，不再插入第二条；
          // 若本地没有（如转发到其他会话后又切回来），则继续走下面的正常插入。
          if (cmid.isNotEmpty && _sentIds.contains(cmid)) {
            final i = messages.lastIndexWhere((m) => m['cmid'] == cmid);
            _sentIds.remove(cmid);
            if (i >= 0) {
              setState(() { messages[i]['id'] = p['id']; messages[i]['status'] = 'sent'; });
              return;
            }
          }
          if (_isDuplicateMsg(cmid: cmid, id: p['id'])) return;
          if (_isDeleted(p['id'])) return;
          final conv = selConv;
          final from = p['from'];
          final to = p['to'];
          final talkingToPeer = conv != null && conv['kind'] == 'friend' && (from == conv['id'] || to == conv['id']);
          final content = (p['content'] ?? '').toString();
          final text = from == myId
              ? (looksLikeRatchetCipher(content) ? '[已发送加密消息]' : content)
              : await e2eeDecrypt('$from', content);
          final voice = RegExp(r'^\[语音消息:([0-9a-f-]{8,})(?::(\d+))?\]$').firstMatch(text);
          if (conv != null && !talkingToPeer) {
            final key = 'f${from == myId ? to : from}';
            setState(() => _unread[key] = (_unread[key] ?? 0) + 1);
            _lastMsg[key] = {'text': text, 'mine': from == myId, 'read': false, 'ts': DateTime.now().millisecondsSinceEpoch};
            return;
          }
          setState(() {
            if (conv == null || talkingToPeer) {
              final mine = p['from'] == myId;
              final inView = conv != null && talkingToPeer;
              if (!mine && inView) {
                socket?.sink.add(jsonEncode({'type': 'read', 'payload': {'from': from}}));
              }
              _appendMsg(voice != null
                  ? {'cmid': cmid, 'voiceId': voice[1], 'voiceDur': voice[2] != null ? int.tryParse(voice[2]!) : null, 'mine': mine, 'time': '现在', 'id': p['id'], 'replyTo': p['replyTo'], 'replyContent': p['replyContent'], 'forwardedFrom': p['forwardedFrom'], 'read': mine ? false : inView}
                  : {'cmid': cmid, 'text': text, 'mine': mine, 'time': '现在', 'id': p['id'], 'replyTo': p['replyTo'], 'replyContent': p['replyContent'], 'forwardedFrom': p['forwardedFrom'], 'read': mine ? false : inView});
              _lastMsg['f${mine ? to : from}'] = {'text': text, 'mine': mine, 'read': mine ? false : inView, 'ts': DateTime.now().millisecondsSinceEpoch};
            }
          });
        } else if (type == 'msg_read') {
          final p = (root['payload'] as Map).cast<String, dynamic>();
          if (!mounted) return;
          final conv = selConv;
          final peerId = p['peerId'];
          if (conv != null && conv['kind'] == 'friend' && conv['id'] == peerId) {
            setState(() {
              for (final m in messages) {
                if (m['mine'] == true) m['read'] = true;
              }
            });
          }
          final last = _lastMsg['f$peerId'];
          if (last != null && last['mine'] == true) last['read'] = true;
          setState(() {});
        } else if (type == 'msg_recall') {
          final p = (root['payload'] as Map).cast<String, dynamic>();
          if (!mounted) return;
          final msgId = p['messageId'];
          if (msgId == null) return;
          setState(() {
            for (int i = messages.length - 1; i >= 0; i--) {
              if (messages[i]['id'] == msgId) { messages.removeAt(i); break; }
            }
          });
          if (selConv != null) {
            final peerId = p['from'];
            final convKey = 'f';
            _lastMsg.remove(convKey);
          }
        } else if (type == 'group_msg_read') {
          final p = (root['payload'] as Map).cast<String, dynamic>();
          if (!mounted) return;
          final conv = selConv;
          final gid = p['groupId'];
          final uid = p['userId'];
          if (conv != null && conv['kind'] == 'group' && conv['id'] == gid && uid != myId) {
            final users = _groupReadUsers.putIfAbsent('g$gid', () => <int>{});
            if (users.add(uid as int)) {
              setState(() {
                for (final m in messages) {
                  if (m['mine'] == true) {
                    m['readCount'] = ((m['readCount'] as num?)?.toInt() ?? 1) + 1;
                  }
                }
              });
              final last = _lastMsg['g$gid'];
              if (last != null && last['mine'] == true) last['read'] = true;
            }
          }
        } else if (type == 'group_msg') {
          final p = (root['payload'] as Map).cast<String, dynamic>();
          if (!mounted) return;
          final cmid = (p['clientMsgId'] ?? '').toString();
          if (cmid.isNotEmpty && _sentIds.contains(cmid)) {
            final i = messages.lastIndexWhere((m) => m['cmid'] == cmid);
            _sentIds.remove(cmid);
            if (i >= 0) {
              setState(() { messages[i]['id'] = p['id']; messages[i]['status'] = 'sent'; });
              return;
            }
          }
          if (_isDuplicateMsg(cmid: cmid, id: p['id'])) return;
          if (_isDeleted(p['id'])) return;
          // 群消息撤回
          if (p['recalled'] == true) {
            final recalledMsgId = p['id'];
            if (recalledMsgId != null) {
              setState(() { for (int i = messages.length - 1; i >= 0; i--) { if (messages[i]['id'] == recalledMsgId) { messages.removeAt(i); break; } } });
            }
            return;
          }
          final conv = selConv;
          final gid = p['groupId'];
          final content = (p['content'] ?? '').toString();
          final text = looksLikeRatchetCipher(content)
              ? '[加密消息]'
              : await e2eeDecrypt('$gid', content);
          final from = p['from'];
          final fromUser = p['fromUser'];
          final sender = (fromUser is Map) ? (((fromUser)['nickname'] ?? fromUser['username']) ?? '').toString() : null;
          final mine = from == myId;
          final voice = RegExp(r'^\[语音消息:([0-9a-f-]{8,})(?::(\d+))?\]$').firstMatch(text);
          // 检测@我
          if (!mine) {
            final myNick = widget.api.myNickname ?? '';
            final myUser = widget.api.myUsername ?? '';
            if (text.contains('@所有人') || (myNick.isNotEmpty && text.contains('@')) || (myUser.isNotEmpty && text.contains('@'))) {
              _mentionMe['g'] = true;
            }
          }
          if (conv == null || conv['kind'] != 'group' || conv['id'] != gid) {
            if (!mine) setState(() => _unread['g$gid'] = (_unread['g$gid'] ?? 0) + 1);
            return;
          }
          setState(() {
            if (!mine) {
              socket?.sink.add(jsonEncode({'type': 'group_read', 'payload': {'groupId': gid}}));
            }
            _appendMsg(voice != null
                ? {'cmid': cmid, 'voiceId': voice[1], 'voiceDur': voice[2] != null ? int.tryParse(voice[2]!) : null, 'mine': mine, 'time': '现在', 'id': p['id'], 'sender': sender, 'replyTo': p['replyTo'], 'forwardedFrom': p['forwardedFrom'], 'read': mine || true, 'readCount': (p['readCount'] as num?)?.toInt() ?? (mine ? 1 : 0)}
                : {'cmid': cmid, 'text': text, 'mine': mine, 'time': '现在', 'id': p['id'], 'sender': sender, 'replyTo': p['replyTo'], 'forwardedFrom': p['forwardedFrom'], 'read': mine || true, 'readCount': (p['readCount'] as num?)?.toInt() ?? (mine ? 1 : 0)});
            _lastMsg['g$gid'] = {'text': text, 'mine': mine, 'read': true, 'ts': DateTime.now().millisecondsSinceEpoch};
          });
        } else if (type == 'user_list') {
          final p = (root['payload'] as Map).cast<String, dynamic>();
          if (!mounted) return;
          final users = (p['users'] as List?)?.cast<Map<String, dynamic>>() ?? [];
          setState(() {
            for (final u in users) {
              final uid = u['id'];
              for (final c in conversations) {
                if (c['kind'] == 'friend' && c['id'] == uid) {
                  c['online'] = u['online'] == true;
                  if (u['lastSeen'] != null) c['lastSeen'] = u['lastSeen'];
                }
              }
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
        } else if (type == 'poke') {
          final p = (root['payload'] as Map).cast<String, dynamic>();
          final nick = (p['fromNick'] ?? '某').toString();
          if (!mounted) return;
          try { ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$nick 拍了拍你'), duration: const Duration(seconds: 2))); } catch (_) {}
        } else if (type == 'friend_req') {
          final p = (root['payload'] as Map).cast<String, dynamic>();
          final fu = (p['fromUser'] as Map?)?.cast<String, dynamic>();
          if (fu != null && fu['id'] is int && mounted) {
            setState(() => gFriendReqs[fu['id'] as int] = fu);
            gFriendReqTick.value++;
            try { ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('${fu['nickname'] ?? '有人'} 请求加你为好友'), duration: const Duration(seconds: 3))); } catch (_) {}
          }
        } else if (type == 'friend_list') {
          if (mounted) _loadData();
        }
      }, onError: (_) {}, onDone: () {
        // WebSocket断开后指数退避重连
        if (!mounted) return;
        final attempt = (_wsReconnectAttempt) + 1;
        _wsReconnectAttempt = attempt;
        final delay = Duration(milliseconds: (2000 * (1 << (attempt - 1))).clamp(2000, 60000));
        debugPrint('[ws] disconnected, reconnecting in ${delay.inSeconds}s (attempt $attempt)');
        Future.delayed(delay, () { if (mounted && socket != null) _connect(); });
      });
    } catch (_) {}
  }

  int? get _talkId {
    final conv = selConv;
    if (conv == null || conv['kind'] == 'group') return null;
    return conv['id'] as int;
  }

  Future<void> _poke() async {
    final to = _talkId;
    if (to == null) return;
    try {
      await widget.api.poke(to);
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已拍一拍'), duration: const Duration(seconds: 1)));
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('拍一拍失败：${e.toString().replaceFirst('Bad state: ', '')}')));
    }
  }

  Future<void> _startCall(bool video) async {
    final to = _talkId;
    if (to == null) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('选择好友后发起通话')));
      return;
    }
    if (socket == null) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('未连接服务器，请检查网络')));
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
      final recStart = _recordingStart;
      final path = await recorder.stop();
      setState(() => recording = false);
      if (path == null) return;
      final durSecs = recStart > 0 ? ((DateTime.now().millisecondsSinceEpoch - recStart) / 1000).round().clamp(1, 3600) : 0;
      try {
        final uploaded = await widget.api.uploadVoice(to, await File(path).readAsBytes(), 'voice-${DateTime.now().millisecondsSinceEpoch}.m4a');
        final id = uploaded['id'];
        final vcmid = 'v${DateTime.now().microsecondsSinceEpoch}';
        _sentIds.add(vcmid);
        socket?.sink.add(jsonEncode({'type': 'msg', 'payload': {'to': to, 'content': '[语音消息:$id:$durSecs]', 'clientMsgId': vcmid}}));
        setState(() => _appendMsg({'cmid': vcmid, 'voiceId': id, 'voiceDur': durSecs, 'mine': true, 'time': '现在', 'read': false}));
        _lastMsg['f$to'] = {'text': '[语音消息]', 'mine': true, 'read': false, 'ts': DateTime.now().millisecondsSinceEpoch};
        try {
          final transcript = await widget.api.transcribe(id);
          if (transcript.isNotEmpty) {
            final tcmid = 't${DateTime.now().microsecondsSinceEpoch}';
            _sentIds.add(tcmid);
            socket?.sink.add(jsonEncode({'type': 'msg', 'payload': {'to': to, 'content': transcript, 'clientMsgId': tcmid}}));
            if (mounted) setState(() => _appendMsg({'cmid': tcmid, 'text': transcript, 'mine': true, 'time': '现在'}));
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
    _recordingStart = DateTime.now().millisecondsSinceEpoch;
    _recordingDuration = 0;
    setState(() => recording = true);
    Timer.periodic(const Duration(seconds: 1), (t) {
      if (!mounted) { t.cancel(); return; }
      final secs = ((DateTime.now().millisecondsSinceEpoch - _recordingStart) / 1000).round();
      if (mounted) setState(() => _recordingDuration = secs);
    });
  }

  @override
  void dispose() {
    _hideMentionOverlay();
    _wsSub?.cancel();
    _voiceSub?.cancel();
    socket?.sink.close();
    calls?.dispose();
    voicePlayer?.dispose();
    _recordingTimer?.cancel();
    recorder.dispose();
    input.removeListener(_onInputChanged);
    input.dispose();
    inputFocus.dispose();
    searchCtrl.dispose();
    _chatSearchCtrl.dispose();
    _msgScroll.dispose();
    super.dispose();
  }

  static String _convKey(Map<String, dynamic> conv) => '${conv['kind'] == 'group' ? 'g' : 'f'}${conv['id']}';

  /// 会话列表副标题：优先显示最后一条消息摘要；自己发的消息附加「已读/未读」
  String _relativeTime(int? ts) {
    if (ts == null || ts <= 0) return '';
    final diff = DateTime.now().millisecondsSinceEpoch - ts;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return '\分钟前';
    if (diff < 86400000) return '\小时前';
    if (diff < 172800000) return '昨天';
    final d = DateTime.fromMillisecondsSinceEpoch(ts);
    return '${d.month}/${d.day}';
  }

  String _convSubtitle(Map<String, dynamic> conv, dynamic theme) {
    final last = _lastMsg[_convKey(conv)];
    if (last == null) {
      return conv['kind'] == 'group' ? '群聊' : (conv['online'] == true ? '在线' : '离线');
    }
    var txt = (last['text'] ?? '').toString();
    // 语音/文件预览
    if (RegExp(r'^\[语音消息:').hasMatch(txt)) txt = '[语音]';
    if (txt.startsWith('__FILE__')) txt = '[文件]';
    if (txt.startsWith('[红包:')) txt = '[红包]';
    final preview = txt.length > 14 ? '${txt.substring(0, 14)}…' : txt;
    if (last['mine'] == true) {
      final read = last['read'] == true ? '已读' : '未读';
      return '$preview · $read';
    }
    return preview;
  }

  Future<void> _ensureDeletedLoaded() async {
    if (_deletedLoaded) return;
    _deletedLoaded = true;
    try {
      final prefs = await SharedPreferences.getInstance();
      _deletedIds.addAll(prefs.getStringList('deletedMsgIds') ?? const []);
    } catch (_) {}
  }

  bool _isDeleted(dynamic id) => _deletedIds.contains('$id');

  @override
  Widget build(BuildContext context) {
    final config = widget.config;
    return Row(children: [
      _leftPanel(config),
      VerticalDivider(width: 1, thickness: 1, color: config.theme.div),
      Expanded(child: _chatArea(config)),
    ]);
  }

  Widget _leftPanel(AppConfig config) {
    final theme = config.theme;
    final items = conversations.where((c) =>
      _search.isEmpty || (c['name'] as String).toLowerCase().contains(_search.toLowerCase())
    ).toList();
    return Container(
      width: 280,
      color: theme.panel,
      child: Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 14, 14, 8),
          child: Row(children: [
            CircleAvatar(radius: 20, backgroundColor: config.primary, child: Text('S', style: TextStyle(color: theme.onAccent, fontWeight: FontWeight.bold, fontSize: 14))),
            const SizedBox(width: 10),
            Expanded(child: Text('微信', style: TextStyle(color: theme.text, fontSize: 17, fontWeight: FontWeight.w700))),
         IconButton(tooltip: '全部已读', onPressed: () { setState(() => _unread.clear()); }, icon: const Icon(Icons.done_all, size: 18), color: _unread.isEmpty ? theme.subText : _wechatGreen),
          ]),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
          child: TextField(
            controller: searchCtrl,
            style: TextStyle(color: theme.text),
            decoration: InputDecoration(
              hintText: '搜索',
              hintStyle: TextStyle(color: theme.subText),
              prefixIcon: Icon(Icons.search, color: theme.subText),
              fillColor: theme.inputBg,
              filled: true,
              border: OutlineInputBorder(borderRadius: BorderRadius.circular(8), borderSide: BorderSide.none),
            ),
            onChanged: (v) => setState(() => _search = v),
          ),
        ),
        const Divider(height: 1),
        Expanded(child: ListView.separated(
          itemCount: items.length,
          separatorBuilder: (_, __) => const Divider(height: 1),
          itemBuilder: (context, i) {
            final conv = items[i];
            final origIdx = conversations.indexOf(conv);
            final isSelected = origIdx == selected;
            final lastTs = _lastMsg[_convKey(conv)]?['ts'] as int?;
            return Material(
              color: isSelected ? config.primary.withValues(alpha: theme.isDark ? 0.28 : 0.12) : Colors.transparent,
              child: InkWell(
                onTap: () => _openConversation(origIdx),
                onLongPress: () => _showConvMenu(origIdx, context),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                  child: Row(children: [
                    Stack(clipBehavior: Clip.none, children: [
                      CircleAvatar(radius: 22, backgroundColor: theme.primary.withValues(alpha: theme.isDark ? 0.25 : 0.14), child: Icon(conv['icon'] as IconData, color: config.primary, size: 22)),
                      if (conv['kind'] == 'friend' && conv['online'] == true) Positioned(right: -1, bottom: -1, child: Container(width: 12, height: 12, decoration: BoxDecoration(color: _wechatGreen, shape: BoxShape.circle, border: Border.all(color: theme.panel, width: 2)))),
                    ]),
                    const SizedBox(width: 10),
                    Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Row(children: [
                        if (conv['pinned'] == true) const Icon(Icons.push_pin, size: 13, color: Color(0xffe67e22)),
                        if (conv['muted'] == true) const Icon(Icons.notifications_off, size: 13, color: Color(0xff999999)),
                        if (conv['pinned'] == true) const SizedBox(width: 3),
                        Expanded(child: Text((conv['name'] ?? '').toString(), maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: theme.text, fontWeight: FontWeight.w600, fontSize: 14))),
                        if (lastTs != null) Text(_relativeTime(lastTs), style: TextStyle(color: theme.subText, fontSize: 10)),
                      ]),
                      const SizedBox(height: 3),
                      Row(mainAxisSize: MainAxisSize.min, children: [
                        Flexible(child: Text(_convSubtitle(conv, theme), maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: theme.subText, fontSize: 12))),
                        if (_mentionMe[_convKey(conv)] == true) ...[
                          const SizedBox(width: 4),
                          Container(padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1), decoration: BoxDecoration(color: _wechatGreen, borderRadius: BorderRadius.circular(3)), child: const Text('@我', style: TextStyle(color: Colors.white, fontSize: 9))),
                        ],
                      ]),
                      if ((_unread[_convKey(conv)] ?? 0) > 0)
                        Padding(
                          padding: const EdgeInsets.only(top: 3),
                          child: Container(
                            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                            decoration: BoxDecoration(color: Colors.red, borderRadius: BorderRadius.circular(9)),
                            child: Text('${_unread[_convKey(conv)]}', style: const TextStyle(color: Colors.white, fontSize: 10)),
                          ),
                        ),
                    ])),
                  ]),
                ),
              ),
            );
          },
        )),
      ]),
    );
  }

  Widget _chatArea(AppConfig config) {
    final t = config.theme;
    final border = Border(bottom: BorderSide(color: t.div));
    final avatarBg = t.primary.withValues(alpha: t.isDark ? 0.28 : 0.14);
    final convKey = selConv != null ? _convKey(selConv!) : null;
    final bgColor = convKey != null ? _chatBgColors[convKey] : null;
    return Column(children: [
      Container(height: 60, padding: const EdgeInsets.symmetric(horizontal: 20), decoration: BoxDecoration(color: t.panel.withValues(alpha: 0.5), border: border), child: Row(children: [
        CircleAvatar(backgroundColor: avatarBg, child: Icon(selConv?['icon'] ?? Icons.person, color: t.primary, size: 22)),
        const SizedBox(width: 10),
        Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(selName ?? '未选择会话', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15, color: t.text)),
          Row(mainAxisSize: MainAxisSize.min, children: [
            Text(selConv != null ? _convStatusLine(selConv!) : '', style: TextStyle(color: t.subText, fontSize: 11)),
            if (_isTyping) ...[
              const SizedBox(width: 6),
              Text('正在输入...', style: TextStyle(color: _wechatGreen, fontSize: 11, fontWeight: FontWeight.w500)),
            ],
          ]),
        ]),
        const Spacer(),
        if (selConv != null) ...[
          IconButton(tooltip: '搜索消息', onPressed: _toggleChatSearch, icon: Icon(Icons.search, color: _chatSearchVisible ? _wechatGreen : t.subText)),
          IconButton(tooltip: _multiSelectMode ? '退出多选' : '多选消息', onPressed: _toggleMultiSelect, icon: Icon(_multiSelectMode ? Icons.close : Icons.checklist, color: _multiSelectMode ? _wechatGreen : t.subText)),
          IconButton(tooltip: '语音通话', onPressed: () => _startCall(false), icon: Icon(Icons.call_outlined, color: t.subText)),
          IconButton(tooltip: '视频通话', onPressed: () => _startCall(true), icon: Icon(Icons.videocam_outlined, color: t.subText)),
          if (selConv!['kind'] == 'friend') IconButton(tooltip: '拍一拍', onPressed: _poke, icon: Icon(Icons.waving_hand_outlined, color: t.subText)),
           IconButton(tooltip: '清空聊天', onPressed: () => _clearConversation(), icon: Icon(Icons.delete_outline, color: t.subText)),
           if (selConv!['kind'] == 'group') IconButton(tooltip: '群成员', onPressed: _showGroupMembers, icon: Icon(Icons.people_outline, color: t.subText)),
          if (selConv!['kind'] == 'group') IconButton(tooltip: '群公告', onPressed: _showGroupAnnouncement, icon: Icon(Icons.campaign_outlined, color: t.subText)),
          if (selConv!['kind'] == 'group') IconButton(tooltip: '群工具（投票/待办）', onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => CommunityToolsPage(api: widget.api, config: widget.config))), icon: Icon(Icons.tune, color: t.subText)),
          PopupMenuButton<int>(
            icon: const Icon(Icons.more_horiz),
            onSelected: (v) => _onContextMenu(v, context),
            itemBuilder: (_) => const [
              PopupMenuItem(value: 0, child: Text('发起群聊')),
              PopupMenuItem(value: 6, child: Text('加入群聊')),
              PopupMenuItem(value: 1, child: Text('发起音视频会议')),
              PopupMenuItem(value: 2, child: Text('添加好友')),
              PopupMenuItem(value: 3, child: Text('查看聊天资料')),
              PopupMenuItem(value: 7, child: Text('设置聊天背景')),
              PopupMenuItem(value: 8, child: Text('字体大小')),
              PopupMenuItem(value: 4, child: Text('我的名片')),
              PopupMenuItem(value: 5, child: Text('扫一扫')),
            ],
          ),
        ],
      ])),
      if (_chatSearchVisible)
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          decoration: BoxDecoration(color: t.panel.withValues(alpha: 0.5), border: Border(bottom: BorderSide(color: t.div))),
          child: Row(children: [
            Expanded(child: TextField(
              controller: _chatSearchCtrl,
              autofocus: true,
              style: TextStyle(color: t.text, fontSize: 14),
              decoration: InputDecoration(
                hintText: '搜索消息内容...',
                hintStyle: TextStyle(color: t.subText, fontSize: 13),
                prefixIcon: Icon(Icons.search, color: t.subText, size: 20),
                suffixIcon: _chatSearchQuery.isNotEmpty
                    ? Row(mainAxisSize: MainAxisSize.min, children: [
                        Text('${_chatSearchIdx >= 0 ? _chatSearchIdx + 1 : 0}/${_chatSearchResults.length}', style: TextStyle(color: t.subText, fontSize: 12)),
                        const SizedBox(width: 4),
                        IconButton(
                          icon: Icon(Icons.keyboard_arrow_up, color: t.subText, size: 20),
                          onPressed: _prevSearchResult,
                          padding: EdgeInsets.zero,
                          constraints: const BoxConstraints(minWidth: 28, minHeight: 28),
                        ),
                        IconButton(
                          icon: Icon(Icons.keyboard_arrow_down, color: t.subText, size: 20),
                          onPressed: _nextSearchResult,
                          padding: EdgeInsets.zero,
                          constraints: const BoxConstraints(minWidth: 28, minHeight: 28),
                        ),
                      ])
                    : null,
                fillColor: t.inputBg,
                filled: true,
                isDense: true,
                contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(8), borderSide: BorderSide.none),
              ),
              onChanged: _onChatSearchChanged,
            )),
            const SizedBox(width: 8),
            IconButton(
              icon: Icon(Icons.close, color: t.subText, size: 20),
              onPressed: _toggleChatSearch,
              padding: EdgeInsets.zero,
              constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
            ),
          ]),
        ),
      if (_pinnedMsg != null) GestureDetector(
        onTap: () {
          final idx = messages.indexWhere((m) => m['id'] == _pinnedMsg!['id']);
          if (idx >= 0) _msgScroll.animateTo(idx * 72.0, duration: const Duration(milliseconds: 300), curve: Curves.easeOut);
        },
        onLongPress: _unpinMessage,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
          decoration: BoxDecoration(color: t.panel.withValues(alpha: 0.85), border: Border(bottom: BorderSide(color: t.div))),
          child: Row(children: [
            const Icon(Icons.push_pin, size: 14, color: Color(0xffe67e22)),
            const SizedBox(width: 6),
            const Expanded(child: Text('置顶消息', maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: Color(0xffe67e22), fontSize: 12))),
            Icon(Icons.close, size: 14, color: t.subText),
          ]),
        ),
      ),
      Expanded(
        child: Stack(children: [
          Positioned.fill(child: messages.isEmpty
            ? Center(child: Column(mainAxisSize: MainAxisSize.min, children: [Icon(Icons.chat_bubble_outline, size: 48, color: t.subText.withValues(alpha: 0.4)), const SizedBox(height: 12), Text('还没有消息', style: TextStyle(color: t.subText, fontSize: 14)), const SizedBox(height: 4), Text('发送消息开始聊天', style: TextStyle(color: t.subText.withValues(alpha: 0.6), fontSize: 12))]))
             : Container(
                 color: bgColor,
                 child: ListView.builder(
                   controller: _msgScroll,
                   padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
                itemCount: messages.length,
                itemBuilder: (_, i) {
                  final msg = messages[i];
                  final isSearchTarget = _chatSearchResults.isNotEmpty && _chatSearchIdx >= 0 && i == messages.indexOf(_chatSearchResults[_chatSearchIdx]);
                  return TweenAnimationBuilder<double>(tween: Tween(begin: 0.03, end: 0.0), duration: const Duration(milliseconds: 200), curve: Curves.easeOut, key: ValueKey(msg['id']?.toString() ?? msg['cmid']?.toString()), builder: (_, v, child) => Transform.translate(offset: Offset(0, v * 100), child: Opacity(opacity: 1.0 - v.abs(), child: child)), child: _bubble(msg, isSearchTarget: isSearchTarget));
                },
              ),
            ),
            ),
          if (_showScrollDown) Positioned(bottom: 16, right: 16, child: GestureDetector(onTap: _scrollToBottom, child: Container(padding: const EdgeInsets.all(8), decoration: BoxDecoration(color: t.panel, shape: BoxShape.circle, boxShadow: [BoxShadow(color: Colors.black26, blurRadius: 4)]), child: Icon(Icons.keyboard_arrow_down, color: t.text, size: 24)))),
        ]),
      ),
      if (_multiSelectMode)
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
          decoration: BoxDecoration(color: t.panel.withValues(alpha: 0.85), border: Border(top: BorderSide(color: t.div))),
          child: Row(children: [
            GestureDetector(onTap: () { setState(() { final selectable = messages.where((m) => m['divider'] != true && m['dateSep'] != true).toList(); if (_selectedMsgs.length >= selectable.length) { _selectedMsgs.clear(); } else { _selectedMsgs.addAll(selectable.where((m) => !_selectedMsgs.any((s) => s['id'] == m['id']))); } }); }, child: Text('已选 / 条', style: TextStyle(color: t.text, fontSize: 13))),
            const Spacer(),
            IconButton(tooltip: '批量转发', onPressed: _selectedMsgs.isEmpty ? null : _batchForward, icon: Icon(Icons.forward, color: _selectedMsgs.isEmpty ? t.subText : _wechatGreen)),
            IconButton(tooltip: '批量收藏', onPressed: _selectedMsgs.isEmpty ? null : _batchFavorite, icon: Icon(Icons.star_outline, color: _selectedMsgs.isEmpty ? t.subText : Colors.amber)),
            IconButton(tooltip: '批量删除', onPressed: _selectedMsgs.isEmpty ? null : _batchDelete, icon: Icon(Icons.delete_outline, color: _selectedMsgs.isEmpty ? t.subText : Colors.red)),
            IconButton(tooltip: '批量撤回', onPressed: _selectedMsgs.isEmpty ? null : _batchRecall, icon: Icon(Icons.backspace, color: _selectedMsgs.isEmpty ? t.subText : Colors.orange)),
            TextButton(onPressed: _toggleMultiSelect, child: const Text('取消')),
          ]),
        ),
      if (replyingTo != null) _replyBar(),
      _composer(),
    ]);
  }

  Widget _replyBar() {
    final t = widget.config.theme;
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 6, 16, 2),
      color: t.panel.withValues(alpha: 0.5),
      child: Row(children: [
        Icon(Icons.reply, color: _wechatGreen, size: 16),
        const SizedBox(width: 8),
        Expanded(child: Text('回复：${replyPreview ?? ''}', maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.subText, fontSize: 12))),
        IconButton(icon: const Icon(Icons.close, size: 16), onPressed: _cancelReply, color: t.subText),
      ]),
    );
  }

  /// 聊天顶栏/资料卡状态行：在线 或「上次在线 xxx前」
  String _convStatusLine(Map<String, dynamic> conv) {
    if (conv['kind'] == 'group') return _groupOnlineCount >= 0 ? '群聊 · ' : '群聊';
    if (conv['online'] == true) return '在线';
    return _lastSeenLabel(conv['lastSeen'] as int?);
  }

  String _lastSeenLabel(int? ts) {
    if (ts == null || ts <= 0) return '离线';
    final diff = DateTime.now().millisecondsSinceEpoch - ts;
    if (diff < 60000) return '刚刚在线';
    if (diff < 3600000) return '${(diff / 60000).floor()} 分钟前在线';
    if (diff < 86400000) return '${(diff / 3600000).floor()} 小时前在线';
    if (diff < 7 * 86400000) return '${(diff / 86400000).floor()} 天前在线';
    final d = DateTime.fromMillisecondsSinceEpoch(ts);
    return '${d.year}/${d.month}/${d.day} 在线';
  }

  Widget _readIcon(Map<String, dynamic> msg) {
    if (selConv != null && selConv!['kind'] == 'group') {
      final rc = (msg['readCount'] as num?)?.toInt() ?? 0;
      return rc > 1 ? Text('已读 ', style: TextStyle(color: widget.config.theme.subText, fontSize: 10)) : const SizedBox.shrink();
    }
    final read = msg['read'] == true;
    return Icon(read ? Icons.done_all : Icons.done, size: 14, color: read ? _wechatGreen : widget.config.theme.subText);
  }

  Widget _bubble(Map<String, dynamic> msg, {bool isSearchTarget = false}) {
    if (msg['divider'] == true) {
      return Center(
        key: _unreadDividerKey,
        child: GestureDetector(
          onTap: _scrollToBottom,
          child: Container(
            margin: const EdgeInsets.symmetric(vertical: 4),
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
            decoration: BoxDecoration(color: widget.config.theme.div.withValues(alpha: 0.6), borderRadius: BorderRadius.circular(10)),
            child: Text('${msg['unreadCount']} 条未读消息', style: TextStyle(color: widget.config.theme.subText, fontSize: 11)),
          ),
        ),
      );
    }
    if (msg['dateSep'] == true) {
      return Center(
        child: Container(
          margin: const EdgeInsets.symmetric(vertical: 8),
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
          decoration: BoxDecoration(color: widget.config.theme.div.withValues(alpha: 0.5), borderRadius: BorderRadius.circular(4)),
          child: Text(msg['label'] ?? '', style: TextStyle(color: widget.config.theme.subText, fontSize: 11)),
        ),
      );
    }
    final mine = msg['mine'] as bool;
    final voiceId = msg['voiceId'] as String?;
    final t = widget.config.theme;
    final replyText = (msg['replyTo'] != null && msg['replyTo'] != 0) ? '回复了一条消息' : null;
    final text = (msg['text'] ?? '').toString();
    final fileMeta = _parseFileMeta(text);
    final redPacketId = _parseRedPacket(text);
    final content = voiceId != null
        ? _voiceBubble(mine, voiceId, msg['voiceDur'] as int?)
        : redPacketId != null
            ? _redPacketBubble(mine, redPacketId, t)
        : fileMeta != null
            ? _fileBubble(mine, fileMeta, t)
            : _textBubble(mine, msg, t);
    final isSelected = _selectedMsgs.any((m) => m['id'] == msg['id'] || (msg['cmid'] != null && m['cmid'] == msg['cmid']));
    return Align(
      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
      child: Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: GestureDetector(
          onTap: _multiSelectMode ? () => setState(() {
            if (isSelected) {
              _selectedMsgs.removeWhere((m) => m['id'] == msg['id'] || (msg['cmid'] != null && m['cmid'] == msg['cmid']));
            } else {
              _selectedMsgs.add(msg);
            }
          }) : null,
          onDoubleTap: _multiSelectMode ? null : () => _likeMessage(msg),
          onLongPress: _multiSelectMode ? null : () => _bubbleMenu(context, msg),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              if (_multiSelectMode && mine) ...[
                Icon(isSelected ? Icons.check_circle : Icons.radio_button_unchecked, color: isSelected ? _wechatGreen : t.subText, size: 20),
                const SizedBox(width: 6),
              ],
              if (!mine) ...[
                CircleAvatar(radius: 16, backgroundColor: t.primary.withValues(alpha: t.isDark ? 0.25 : 0.14), child: const Icon(Icons.person, size: 17, color: _wechatGreen)),
                const SizedBox(width: 8),
              ],
              Column(crossAxisAlignment: mine ? CrossAxisAlignment.end : CrossAxisAlignment.start, children: [
                if (!mine && (msg['sender'] != null) && selConv != null && selConv!['kind'] == 'group')
                  Padding(padding: const EdgeInsets.only(left: 4, bottom: 3), child: Text(msg['sender'], style: TextStyle(color: Color((msg['sender'].hashCode & 0xFFFFFF) | 0xFF000000).withValues(alpha: 0.8), fontSize: 11))),
                if (msg['forwardedFrom'] != null)
                  Padding(
                    padding: const EdgeInsets.only(left: 4, bottom: 3),
                    child: Text('转发的消息', style: TextStyle(color: mine ? t.text : t.subText, fontSize: 11)),
                  ),
                if (replyText != null)
                  Container(
                    margin: const EdgeInsets.only(bottom: 3),
                    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                    decoration: BoxDecoration(
                      color: mine ? Colors.white.withValues(alpha: 0.6) : Colors.black.withValues(alpha: 0.05),
                      border: Border(left: BorderSide(color: _wechatGreen.withValues(alpha: 0.6), width: 3)),
                      borderRadius: BorderRadius.circular(4),
                    ),
                    child: Text(replyPreviewText(msg), maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.subText, fontSize: 12, fontStyle: FontStyle.italic)),
                  ),
                if (isSearchTarget)
                  DecoratedBox(
                    decoration: BoxDecoration(
                      border: Border.all(color: _wechatGreen, width: 2),
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: content,
                  )
                else
                  content,
                const SizedBox(height: 3),
                Padding(
                  padding: EdgeInsets.symmetric(horizontal: mine ? 2 : 16),
                  child: Row(mainAxisSize: MainAxisSize.min, children: [
                    if (mine && msg['status'] == 'sending') ...[
                      const SizedBox(width: 12, height: 12, child: CircularProgressIndicator(strokeWidth: 1.5)),
                      const SizedBox(width: 4),
                    ],
                    GestureDetector(onTap: () { final ts = msg['ts']; if (ts != null) { final dt = ts is int ? DateTime.fromMillisecondsSinceEpoch(ts) : DateTime.tryParse(ts.toString()); if (dt != null && mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(duration: const Duration(seconds: 2), content: Text(dt.year.toString() + '-' + dt.month.toString().padLeft(2, '0') + '-' + dt.day.toString().padLeft(2, '0') + ' ' + dt.hour.toString().padLeft(2, '0') + ':' + dt.minute.toString().padLeft(2, '0') + ':' + dt.second.toString().padLeft(2, '0')))); } }, child: Text(msg['time'] as String, style: TextStyle(color: t.subText, fontSize: 10))),
                    if (mine) ...[
                      const SizedBox(width: 4),
                      _readIcon(msg),
                    ],
                    _likeBadge(msg),
                  ]),
                ),
              ]),
              if (_multiSelectMode && !mine) ...[
                const SizedBox(width: 6),
                Icon(isSelected ? Icons.check_circle : Icons.radio_button_unchecked, color: isSelected ? _wechatGreen : t.subText, size: 20),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Widget _textBubble(bool mine, Map<String, dynamic> msg, dynamic t) {
    return Container(
      constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.72),
      padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 10),
      decoration: BoxDecoration(
        color: mine ? _wechatBubbleMine : t.bubbleOther,
        borderRadius: BorderRadius.only(
          topLeft: const Radius.circular(4),
          topRight: const Radius.circular(4),
          bottomLeft: Radius.circular(mine ? 4 : 14),
          bottomRight: Radius.circular(mine ? 14 : 4),
        ),
        boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: t.isDark ? 0.12 : 0.06), blurRadius: 6, offset: const Offset(0, 2))],
      ),
      child: _chatSearchQuery.isNotEmpty ? _highlightText(msg['text'] as String, _chatSearchQuery, style: TextStyle(color: mine ? const Color(0xff191919) : t.text, fontSize: _fontSize, height: 1.4)) : SelectableText(msg['text'] as String, style: TextStyle(color: mine ? const Color(0xff191919) : t.text, fontSize: _fontSize, height: 1.4)),
    );
  }

  Widget _fileBubble(bool mine, Map<String, dynamic> meta, dynamic t) {
    final name = (meta['name'] ?? '文件').toString();
    final mime = (meta['mime'] ?? '').toString();
    final isImage = mime.startsWith('image/');
    final fileId = meta['id']?.toString();
    final baseUrl = widget.api.baseUrl;
    final token = widget.api.token;
    return Container(
      constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.72),
      decoration: BoxDecoration(
        color: mine ? _wechatBubbleMine : t.bubbleOther,
        borderRadius: BorderRadius.only(
          topLeft: const Radius.circular(4),
          topRight: const Radius.circular(4),
          bottomLeft: Radius.circular(mine ? 4 : 14),
          bottomRight: Radius.circular(mine ? 14 : 4),
        ),
        boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: t.isDark ? 0.12 : 0.06), blurRadius: 6, offset: const Offset(0, 2))],
      ),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        if (isImage && fileId != null)
          ClipRRect(
            borderRadius: const BorderRadius.only(topLeft: Radius.circular(4), topRight: Radius.circular(4)),
            child: Image.network(
              baseUrl + '/api/files/' + fileId,
              width: 200, height: 160, fit: BoxFit.cover,
              headers: {'Authorization': 'Bearer ' + (token ?? '')},
              loadingBuilder: (_, child, progress) => progress == null ? child : SizedBox(width: 200, height: 160, child: Center(child: CircularProgressIndicator(strokeWidth: 2, color: _wechatGreen))),
              errorBuilder: (_, __, ___) => SizedBox(width: 200, height: 100, child: Center(child: Column(mainAxisSize: MainAxisSize.min, children: [Icon(Icons.broken_image, size: 36, color: t.subText), const SizedBox(height: 4), Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 11, color: t.subText))]))),
            ),
          ),
        Padding(
          padding: const EdgeInsets.all(10),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            if (!isImage || fileId == null)
              Icon(isImage ? Icons.image_search_outlined : Icons.insert_drive_file_outlined, size: 28, color: isImage ? _wechatGreen : t.subText),
            if (!isImage || fileId == null) const SizedBox(width: 8),
            Flexible(child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
              Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 13, color: mine ? const Color(0xff1a1a1a) : t.text)),
              Text(_fmtSize((meta['size'] is num) ? meta['size'] as num : (num.tryParse(meta['size'].toString()) ?? 0)), style: TextStyle(fontSize: 11, color: t.subText)),
            ])),
            const SizedBox(width: 8),
            InkWell(onTap: () => _openFile(meta), child: Icon(isImage ? Icons.zoom_in_rounded : Icons.download_rounded, size: 20, color: _wechatGreen)),
          ]),
        ),
      ]),
    );
  }

  String replyPreviewText(Map<String, dynamic> msg) {
    final id = msg['replyTo'];
    if (id == null || id == 0) return '';
    // 先查本地已加载消息
    for (final m in messages) {
      if (m['id'] == id) {
        final s = (m['text'] ?? '').toString();
        if (s.startsWith('__FILE__')) return '文件';
        return s.isEmpty ? '语音消息' : (s.length > 30 ? s.substring(0, 30) + '…' : s);
      }
    }
    // fallback: 服务端附带的 replyContent
    final rc = msg['replyContent'];
    if (rc != null && rc is String && rc.isNotEmpty) {
      final s = rc;
      if (s.startsWith('__FILE__')) return '文件';
      return s.length > 30 ? s.substring(0, 30) + '…' : s;
    }
    return '回复了一条消息';
  }

  Widget _voiceBubble(bool mine, String id, int? dur) {
    final playing = playingVoiceId == id;
    final t = widget.config.theme;
    return GestureDetector(
      onTap: () => _playVoice(id),
      child: Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
      decoration: BoxDecoration(
        color: mine ? _wechatBubbleMine : t.bubbleOther,
        borderRadius: BorderRadius.only(
          topLeft: const Radius.circular(4),
          topRight: const Radius.circular(4),
          bottomLeft: Radius.circular(mine ? 4 : 14),
          bottomRight: Radius.circular(mine ? 14 : 4),
        ),
        boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: t.isDark ? 0.12 : 0.06), blurRadius: 6, offset: const Offset(0, 2))],
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(mine ? Icons.play_arrow_rounded : Icons.play_arrow_rounded, size: 20, color: _wechatGreen),
        ...List.generate(12, (i) {
          final h = 6.0 + ((i * 7 + (playing ? 3 : 0)) % 16);
          return Container(width: 2.5, height: h, margin: const EdgeInsets.only(right: 3), decoration: BoxDecoration(color: playing ? _wechatGreen : t.subText, borderRadius: BorderRadius.circular(2)));
        }),
        const SizedBox(width: 8),
        Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [Text(dur != null ? '语音 ${dur}\u2033' : '语音', style: TextStyle(fontSize: 14, color: mine ? const Color(0xff191919) : t.text)), if (playing && _voiceDuration.inMilliseconds > 0) SizedBox(width: 80, child: LinearProgressIndicator(value: _voicePosition.inMilliseconds / _voiceDuration.inMilliseconds, backgroundColor: t.div, valueColor: const AlwaysStoppedAnimation(_wechatGreen), minHeight: 2)),]),
      ]),
      ),
    );
  }

  StreamSubscription? _voiceSub;

  Future<void> _playVoice(String id) async {
    if (playingVoiceId == id) {
      await voicePlayer?.stop();
      if (mounted) setState(() => playingVoiceId = null);
      return;
    }
    _voiceSub?.cancel();
    await voicePlayer?.dispose();
    final player = AudioPlayer();
    _voiceSub = player.onPlayerComplete.listen((_) {
      if (mounted) setState(() => playingVoiceId = null);
    });
    try {
      final bytes = await widget.api.fetchFile(id);
      final path = '${Directory.systemTemp.path}/securechat-voice-$id.m4a';
      await File(path).writeAsBytes(bytes);
      _voicePosition = Duration.zero;
      _voiceDuration = await player.getDuration() ?? Duration.zero;
      player.onPositionChanged.listen((pos) { if (mounted) setState(() => _voicePosition = pos); });
      player.onDurationChanged.listen((dur) { if (mounted) setState(() => _voiceDuration = dur); });
      await player.play(DeviceFileSource(path));
      voicePlayer = player;
      if (mounted) setState(() => playingVoiceId = id);
    } catch (e) {
      _voiceSub?.cancel();
      player.dispose();
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('语音播放失败：$e')));
    }
  }

  Widget _composer() {
    final conv = selConv;
    final canSend = conv != null;
    final t = widget.config.theme;
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 10, 14, 12),
      decoration: BoxDecoration(color: t.panel.withValues(alpha: 0.5), border: Border(top: BorderSide(color: t.div))),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
      Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
        IconButton(tooltip: recording ? '停止录音' : '语音消息', onPressed: _toggleRecording, icon: Icon(recording ? Icons.stop_circle_outlined : Icons.mic_none_rounded, color: recording ? Colors.red : t.text)),
        if (recording) ...[SizedBox(width: 6), _PulseIndicator(color: Colors.red), SizedBox(width: 4), Text((_recordingDuration ~/ 60).toString().padLeft(2, '0') + ':' + (_recordingDuration % 60).toString().padLeft(2, '0'), style: const TextStyle(color: Colors.red, fontSize: 12, fontWeight: FontWeight.w600)), SizedBox(width: 4), Text('录音中...', style: TextStyle(color: Colors.red, fontSize: 12))],
        IconButton(tooltip: '更多', onPressed: () { if (mounted) setState(() => _morePanel = !_morePanel); }, icon: Icon(_morePanel ? Icons.close : Icons.add_circle_outline, color: t.text)),
        IconButton(tooltip: '表情', onPressed: () => _showEmojiPicker(context), icon: Icon(Icons.emoji_emotions_outlined, color: t.text)),
        Expanded(child: TextField(
          controller: input,
          focusNode: inputFocus,
          minLines: 1,
          maxLines: 4,
          style: TextStyle(color: t.text),
          onChanged: (_) { if (mounted) setState(() {}); _sendTyping(); },
          decoration: InputDecoration(hintText: '输入消息', hintStyle: TextStyle(color: t.subText), filled: true, fillColor: t.inputBg.withValues(alpha: 0.5), border: OutlineInputBorder(borderRadius: BorderRadius.circular(20), borderSide: BorderSide.none)),
        )),
        const SizedBox(width: 8),
        if (conv != null && conv['kind'] == 'group') IconButton(tooltip: '@所有人', onPressed: () { input.text += '@所有人 '; inputFocus.requestFocus(); if (mounted) setState(() {}); }, icon: const Icon(Icons.alternate_email, size: 20)),
        IconButton(tooltip: '快捷回复', onPressed: canSend ? () => _showQuickReplies() : null, icon: const Icon(Icons.short_text)),
        IconButton(tooltip: '定时发送', onPressed: canSend ? () => _showScheduleDialog() : null, icon: const Icon(Icons.schedule)),
        SizedBox(height: 42, child: FilledButton(
          onPressed: canSend && input.text.isNotEmpty ? () => _sendText() : null,
          style: FilledButton.styleFrom(backgroundColor: input.text.isNotEmpty ? _wechatGreen : t.subText, foregroundColor: Colors.white),
          child: const Padding(padding: EdgeInsets.symmetric(horizontal: 12), child: Text('发送')),
        )),
      ]),
      if (_morePanel && canSend) ...[
        const Divider(height: 1),
        Container(
          padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 8),
          child: Wrap(spacing: 22, runSpacing: 16, children: [
            _moreCell(t, Icons.redeem_rounded, '红包', () { setState(() => _morePanel = false); _showSendRedPacket(); }),
            _moreCell(t, Icons.image_outlined, '图片', () { setState(() => _morePanel = false); _pickAndSendFile(imageOnly: true); }),
            _moreCell(t, Icons.folder_outlined, '文件', () { setState(() => _morePanel = false); _pickAndSendFile(); }),
            _moreCell(t, Icons.star_outline, '收藏', () { setState(() => _morePanel = false); Navigator.push(context, MaterialPageRoute(builder: (_) => FavoritesPage(api: widget.api, config: widget.config))); }),
            _moreCell(t, Icons.call_outlined, '语音通话', () { setState(() => _morePanel = false); _startCall(false); }),
            _moreCell(t, Icons.videocam_outlined, '视频通话', () { setState(() => _morePanel = false); _startCall(true); }),
          ]),
        ),
      ],
      ]),
    );
  }

  Widget _moreCell(AppTheme t, IconData icon, String label, VoidCallback onTap) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(10),
      child: SizedBox(
        width: 64,
        child: Column(children: [
          Container(
            width: 52, height: 52,
            decoration: BoxDecoration(color: t.inputBg, borderRadius: BorderRadius.circular(12)),
            child: Icon(icon, color: t.text, size: 26),
          ),
          const SizedBox(height: 6),
          Text(label, style: TextStyle(color: t.subText, fontSize: 11)),
        ]),
      ),
    );
  }

  Future<void> _showSendRedPacket() async {
    final conv = selConv;
    if (conv == null) return;
    final isGroup = conv['kind'] == 'group';
    final amtC = TextEditingController();
    final cntC = TextEditingController(text: '1');
    final greetC = TextEditingController(text: '恭喜发财，大吉大利！');
    String mode = 'random';
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(builder: (ctx, setD) => AlertDialog(
        title: Text(isGroup ? '发群红包' : '发红包'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: amtC, keyboardType: const TextInputType.numberWithOptions(decimal: true), autofocus: true, decoration: const InputDecoration(hintText: '金额（元）', prefixText: '¥ ')),
          if (isGroup) ...[
            const SizedBox(height: 10),
            TextField(controller: cntC, keyboardType: TextInputType.number, decoration: const InputDecoration(hintText: '红包个数')),
            const SizedBox(height: 10),
            Row(children: [
              Expanded(child: ChoiceChip(label: const Text('拼手气'), selected: mode == 'random', onSelected: (_) => setD(() => mode = 'random'))),
              const SizedBox(width: 8),
              Expanded(child: ChoiceChip(label: const Text('普通'), selected: mode == 'average', onSelected: (_) => setD(() => mode = 'average'))),
            ]),
          ],
          const SizedBox(height: 10),
          TextField(controller: greetC, decoration: const InputDecoration(hintText: '祝福语')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('塞钱进红包')),
        ],
      )),
    );
    if (ok != true) return;
    final amount = double.tryParse(amtC.text.trim());
    final count = int.tryParse(cntC.text.trim()) ?? 1;
    if (amount == null || amount <= 0) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('请输入有效金额')));
      return;
    }
    try {
      final r = await widget.api.redPacketSend(
        to: isGroup ? null : conv['id'] as int,
        groupId: isGroup ? conv['id'] as int : null,
        amount: amount,
        count: count,
        mode: mode,
        greeting: greetC.text.trim(),
      );
      // 本地回显红包气泡（服务端 WS 也会推一份，靠 cmid 去重）
      final pid = r['packetId'];
      if (pid != null && mounted) {
        setState(() => messages.add({'cmid': 'rp${r['msgId'] ?? pid}', 'text': '[红包:$pid]', 'mine': true, 'time': '现在'}));
      }
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('红包已发出')));
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('发红包失败：${e.toString().replaceFirst('Bad state: ', '')}')));
    }
  }

  Future<void> _pickAndSendFile({bool imageOnly = false}) async {
    final conv = selConv;
    if (conv == null) return;
    FilePickerResult? res;
    try {
      res = await FilePicker.platform.pickFiles(withData: true, type: imageOnly ? FileType.image : FileType.any);
    } catch (_) {}
    if (res == null || res.files.isEmpty || res.files.single.bytes == null || !mounted) return;
    final f = res.files.single;
    final name = f.name;
    final mime = (f.extension != null && f.extension!.isNotEmpty) ? 'application/${f.extension!.toLowerCase()}' : 'application/octet-stream';
    try {
      final Map<String, dynamic> raw = conv['kind'] == 'group'
          ? await widget.api.uploadGroupFile(conv['id'] as int, f.bytes!, name, mime)
          : await widget.api.uploadAttachment(conv['id'] as int, f.bytes!, name, mime);
      final file = (raw['file'] is Map) ? (raw['file'] as Map).cast<String, dynamic>() : raw;
      final content = '__FILE__' + jsonEncode({'id': file['id'], 'name': file['name'] ?? name, 'size': file['size'] ?? f.bytes!.length, 'mime': file['mime'] ?? mime});
      if (conv['kind'] == 'group') {
        final gcmid = 'ga${DateTime.now().microsecondsSinceEpoch}';
        _sentIds.add(gcmid);
        socket?.sink.add(jsonEncode({'type': 'group_msg', 'payload': {'groupId': conv['id'], 'content': content, 'clientMsgId': gcmid}}));
        if (mounted) setState(() => messages.add({'cmid': gcmid, 'text': content, 'mine': true, 'time': '现在'}));
      } else {
        final cmid = 'fa${DateTime.now().microsecondsSinceEpoch}';
        _sentIds.add(cmid);
        socket?.sink.add(jsonEncode({'type': 'msg', 'payload': {'to': conv['id'], 'content': await e2eeEncrypt('${conv['id']}', content), 'clientMsgId': cmid}}));
        if (mounted) setState(() => messages.add({'cmid': cmid, 'text': content, 'mine': true, 'time': '现在'}));
      }
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('发送文件失败：${e.toString().replaceFirst('Bad state: ', '')}')));
    }
  }

  static Map<String, dynamic>? _parseFileMeta(String text) {
    if (!text.startsWith('__FILE__')) return null;
    try {
      final d = jsonDecode(text.substring('__FILE__'.length));
      if (d is Map) return d.cast<String, dynamic>();
    } catch (_) {}
    return null;
  }

  static int? _parseRedPacket(String text) {
    final match = RegExp(r'^\[红包:(\d+)\]$').firstMatch(text.trim());
    return match == null ? null : int.tryParse(match.group(1)!);
  }

  Widget _redPacketBubble(bool mine, int packetId, dynamic t) {
    return InkWell(
      onTap: () => mine ? _showRedPacketDetail(packetId) : _grabRedPacket(packetId),
      child: Container(
        width: 220,
        decoration: BoxDecoration(
          gradient: const LinearGradient(colors: [Color(0xffe84c3d), Color(0xffc0392b)], begin: Alignment.topLeft, end: Alignment.bottomRight),
          borderRadius: BorderRadius.circular(8),
          boxShadow: [BoxShadow(color: const Color(0xffe84c3d).withValues(alpha: 0.3), blurRadius: 8, offset: const Offset(0, 3))],
        ),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Container(
            width: double.infinity,
            padding: const EdgeInsets.only(top: 6, bottom: 4),
            decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: Colors.white24, width: 0.5))),
            child: const Center(child: Text('恭喜发财 大吉大利', style: TextStyle(color: Color(0xfffff176), fontSize: 11, fontWeight: FontWeight.w500))),
          ),
          Padding(
            padding: const EdgeInsets.all(12),
            child: Row(children: [
              const Icon(Icons.card_giftcard_rounded, color: Colors.white, size: 28),
              const SizedBox(width: 10),
              Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                const Text('红包', style: TextStyle(color: Colors.white, fontSize: 14, fontWeight: FontWeight.bold)),
                const SizedBox(height: 2),
                Text(mine ? '查看领取详情' : '点击领取红包', style: const TextStyle(color: Colors.white70, fontSize: 12)),
              ])),
            ]),
          ),
        ]),
      ),
    );
  }


  Future<void> _grabRedPacket(int packetId) async {
    try {
      final result = await widget.api.grabRedPacket(packetId);
      if (!mounted) return;
      if (result['already'] == true) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('你已经领取过了（${result['amount'] ?? ''} 元）')));
        _showRedPacketDetail(packetId);
        return;
      }
      final balance = result['balance'];
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(balance != null ? '领取成功：${result['amount'] ?? ''} 元，当前余额 $balance 元' : '领取成功：${result['amount'] ?? ''} 元'),
        duration: const Duration(seconds: 3),
      ));
      _showConfetti();
    } catch (e) {
      if (!mounted) return;
      _showRedPacketDetail(packetId, fallbackError: e.toString().replaceFirst('Bad state: ', ''));
    }
  }

  Future<void> _showRedPacketDetail(int packetId, {String? fallbackError}) async {
    try {
      final d = await widget.api.redPacketDetail(packetId);
      if (!mounted) return;
      final sender = (d['sender'] is Map) ? ((d['sender'] as Map)['nickname'] ?? '好友').toString() : '好友';
      final greeting = (d['greeting'] ?? '恭喜发财，大吉大利！').toString();
      final count = (d['count'] as num?)?.toInt() ?? 0;
      final total = (d['totalAmount'] as num?)?.toDouble() ?? 0;
      final remaining = (d['remainingAmount'] as num?)?.toDouble() ?? 0;
      final grabbedByMe = d['grabbedByMe'] == true;
      final myAmount = grabbedByMe ? d['myAmount'] : null;
      final canView = d['canViewAmount'] == true;
      final status = (d['status'] ?? 'active').toString();
      final statusText = switch (status) {
        'finished' => '已被抢完',
        'expired' => '已过期',
        'refunded' => '已退回',
        _ => '进行中',
      };
      final grabUsers = (d['grabs'] is Map) ? (d['grabs'] as Map).values.toList() : const [];
      final grabbedCount = grabUsers.length;
      final myIdLocal = widget.api.myId;
      await showDialog(
        context: context,
        builder: (ctx) => AlertDialog(
          title: Row(children: [
            const Icon(Icons.card_giftcard_rounded, color: Color(0xffe84c3d)),
            const SizedBox(width: 8),
            Flexible(child: Text('$sender 的红包', maxLines: 1, overflow: TextOverflow.ellipsis)),
          ]),
          content: SizedBox(
            width: 340,
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
              if (fallbackError != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Text(fallbackError, style: TextStyle(color: Theme.of(ctx).colorScheme.error, fontSize: 12)),
                ),
              Text(greeting, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
              const SizedBox(height: 6),
              Text(myAmount != null
                  ? '你抢到了 $myAmount 元'
                  : '已抢 $grabbedCount/$count · 已领 ${(total - remaining).toStringAsFixed(2)}/$total 元 · $statusText'),
              if (grabUsers.isNotEmpty) ...[
                const SizedBox(height: 10),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxHeight: 220),
                  child: ListView(shrinkWrap: true, children: [
                    for (final u in grabUsers)
                      if (u is Map)
                        ListTile(
                          dense: true,
                          contentPadding: EdgeInsets.zero,
                          leading: const Icon(Icons.person, size: 20),
                          title: Text((u['nickname'] ?? '用户').toString(), maxLines: 1, overflow: TextOverflow.ellipsis),
                          trailing: Text(canView && myIdLocal != null && u['id'] == myIdLocal
                              ? '${myAmount ?? '抢到了'}'
                              : '抢到了'),
                        ),
                  ]),
                ),
              ],
            ]),
          ),
          actions: [FilledButton(onPressed: () => Navigator.pop(ctx), child: const Text('开心收下'))],
        ),
      );
    } catch (e) {
      if (!mounted) return;
      final msg = fallbackError ?? e.toString().replaceFirst('Bad state: ', '');
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('红包操作失败：$msg')));
    }
  }

  static String _fmtSize(num bytes) {
    if (bytes >= 1048576) return '${(bytes / 1048576).toStringAsFixed(1)} MB';
    if (bytes >= 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
    return '$bytes B';
  }

  void _showConfetti() {
    if (!mounted) return;
    final overlay = Overlay.of(context);
    final entries = <OverlayEntry>[];
    final colors = [Colors.red, Colors.amber, Colors.green, Colors.blue, Colors.pink, Colors.orange];
    for (var i = 0; i < 30; i++) {
      final entry = OverlayEntry(builder: (ctx) {
        final dx = 0.2 + (i % 5) * 0.15;
        return AnimatedPositioned(
          duration: Duration(milliseconds: 1200 + (i * 50)),
          left: MediaQuery.of(ctx).size.width * dx,
          top: -20.0 + (i * 15),
          child: TweenAnimationBuilder<double>(
            tween: Tween(begin: -20.0, end: MediaQuery.of(ctx).size.height * 0.8),
            duration: Duration(milliseconds: 1200 + (i * 50)),
            curve: Curves.easeOut,
            builder: (_, v, __) => Positioned(
              top: v,
              left: MediaQuery.of(ctx).size.width * dx + (i.isEven ? 10 : -10),
              child: Opacity(
                opacity: (v / MediaQuery.of(ctx).size.height).clamp(0.0, 1.0),
                child: Icon(Icons.circle, size: 8 + (i % 3) * 3, color: colors[i % colors.length]),
              ),
            ),
          ),
        );
      });
      entries.add(entry);
      overlay.insert(entry);
    }
    Future.delayed(const Duration(milliseconds: 2500), () { for (final e in entries) { e.remove(); } });
  }
  Future<void> _openFile(Map<String, dynamic> meta) async {
    final id = (meta['id'] ?? '').toString();
    if (id.isEmpty) return;
    final isGroup = selConv != null && selConv!['kind'] == 'group';
    final dlCtrl = ValueNotifier<double>(0.0);
    final dlgCtx = context;
    showDialog(context: dlgCtx, barrierDismissible: false, builder: (_) => ValueListenableBuilder<double>(
      valueListenable: dlCtrl,
      builder: (_, v, __) => AlertDialog(content: Column(mainAxisSize: MainAxisSize.min, children: [
        CircularProgressIndicator(value: v > 0 ? null : null, color: const Color(0xff07c160)),
        const SizedBox(height: 12),
        Text(v > 0 ? '下载中 %' : '下载中...', style: const TextStyle(fontSize: 13)),
      ])),
    ));
    try {
      final bytes = isGroup ? await widget.api.fetchGroupFile(id) : await widget.api.fetchFile(id);
      if (Navigator.canPop(dlgCtx)) Navigator.pop(dlgCtx);
      if (!mounted) return;
      final mime = (meta['mime'] ?? '').toString();
      if (mime.startsWith('image/')) {
        await showDialog(context: context, builder: (_) => Dialog(child: InteractiveViewer(child: Image.memory(bytes))));
      } else {
        final out = await FilePicker.platform.saveFile(fileName: (meta['name'] ?? 'file').toString());
        if (out != null) {
          await File(out).writeAsBytes(bytes);
          if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已保存'), duration: Duration(seconds: 1)));
        }
      }
    } catch (e) {
      if (Navigator.canPop(dlgCtx)) Navigator.pop(dlgCtx);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('文件获取失败：')));
    }
  }
  int _lastTypingSent = 0;
  void _sendTyping() {
    final conv = selConv;
    if (conv == null || conv['kind'] != 'friend') return;
    final now = DateTime.now().millisecondsSinceEpoch;
    if (now - _lastTypingSent < 3000) return;
    _lastTypingSent = now;
    socket?.sink.add(jsonEncode({'type': 'typing', 'payload': {'to': conv['id']}}));
  }

  Future<void> _sendText() async {
    final conv = selConv;
    final text = input.text.trim();
    if (conv == null || text.isEmpty) return;
    final replyMsg = replyingTo;
    await _flushReplyBar();
    input.clear();
    setState(() => replyingTo = null);
    if (conv['kind'] == 'group') {
      final gcmid = 'g${DateTime.now().microsecondsSinceEpoch}';
      _sentIds.add(gcmid);
      socket?.sink.add(jsonEncode({'type': 'group_msg', 'payload': {'groupId': conv['id'], 'content': text, 'clientMsgId': gcmid, 'replyTo': ?replyMsg}}));
      setState(() => messages.add({'cmid': gcmid, 'text': text, 'mine': true, 'time': '现在', 'replyTo': replyMsg, 'read': true, 'readCount': 1, 'status': 'sending'}));
      _lastMsg['g${conv['id']}'] = {'text': text, 'mine': true, 'read': true, 'ts': DateTime.now().millisecondsSinceEpoch};
      return;
    }
    final to = conv['id'] as int;
    final cmid = 'f${DateTime.now().microsecondsSinceEpoch}';
    _sentIds.add(cmid);
    socket?.sink.add(jsonEncode({'type': 'msg', 'payload': {'to': to, 'content': await e2eeEncrypt('$to', text), 'clientMsgId': cmid, 'replyTo': ?replyMsg}}));
    setState(() { messages.add({'cmid': cmid, 'text': text, 'mine': true, 'time': '现在', 'replyTo': replyMsg, 'read': false, 'status': 'sending'}); });
    _lastMsg['f$to'] = {'text': text, 'mine': true, 'read': false, 'ts': DateTime.now().millisecondsSinceEpoch};
  }

  Future<void> _clearConversation([int? index]) async {
    final conv = index != null && index >= 0 && index < conversations.length ? conversations[index] : selConv;
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
    if (conv['kind'] != 'friend') {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('群聊暂不支持清空记录')));
      return;
    }
    try {
      await widget.api.deleteHistory(conv['id'] as int);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('清除失败：$e')));
      return;
    }
    if (!mounted) return;
    setState(() => messages.clear());
    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('聊天记录已清空')));
  }

  Future<void> _exportChat() async {
    final conv = selConv;
    if (conv == null || conv['kind'] != 'friend') {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('暂仅支持导出单聊记录')));
      return;
    }
    try {
      final data = await widget.api.exportChat(conv['id'] as int, format: 'json');
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('已导出 ${data.length} 字节（JSON格式）')));
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('导出失败：$e')));
    }
  }

  void _startReply(Map<String, dynamic> msg) {
    final text = (msg['text'] ?? '').toString();
    setState(() {
      replyingTo = msg['id'] as int?;
      replyPreview = text.startsWith('__FILE__') ? '文件' : (text.isEmpty ? '语音消息' : text);
    });
    inputFocus.requestFocus();
  }

  void _cancelReply() {
    setState(() { replyingTo = null; replyPreview = null; });
  }

  Future<void> _flushReplyBar() async {
    await Future<void>.delayed(const Duration(milliseconds: 0));
  }

  Future<void> _copyMessage(Map<String, dynamic> msg) async {
    final text = (msg['text'] ?? '').toString();
    if (text.isEmpty) return;
    await Clipboard.setData(ClipboardData(text: text));
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已复制')));
  }

  Future<void> _favoriteMessage(Map<String, dynamic> msg) async {
    final id = msg['id'] as int?;
    if (id == null) return;
    try {
      await widget.api.setFavorite(id);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已收藏')));
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('收藏失败：$e')));
    }
  }

  Future<void> _pinMessage(Map<String, dynamic> msg) async {
    final id = msg['id'] as int?;
    if (id == null) return;
    try {
      await widget.api.pinMessage(id, true);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已置顶消息')));
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('置顶失败：$e')));
    }
  }

  void _unpinMessage() async {
    final msg = _pinnedMsg;
    if (msg == null) return;
    final id = msg['id'] as int?;
    if (id == null) return;
    try {
      await widget.api.pinMessage(id, false);
      if (mounted) setState(() => _pinnedMsg = null);
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已取消置顶')));
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('取消置顶失败')));
    }
  }


  void _patMessage(Map<String, dynamic> msg) {
    final conv = selConv;
    if (conv == null) return;
    final senderName = msg['sender']?.toString() ?? '对方';
    final myName = widget.api.myNickname ?? widget.api.myUsername ?? '我';
    final content = myName + '拍了拍' + senderName;
    if (conv['kind'] == 'group') {
      final gcmid = 'gp' + DateTime.now().microsecondsSinceEpoch.toString();
      _sentIds.add(gcmid);
      socket?.sink.add(jsonEncode({'type': 'group_msg', 'payload': {'groupId': conv['id'], 'content': content, 'clientMsgId': gcmid, 'isPat': true}}));
    } else {
      final cmid = 'fp' + DateTime.now().microsecondsSinceEpoch.toString();
      _sentIds.add(cmid);
      socket?.sink.add(jsonEncode({'type': 'msg', 'payload': {'to': conv['id'], 'content': content, 'clientMsgId': cmid, 'isPat': true}}));
    }
  }
  void _deleteLocalMessage(Map<String, dynamic> msg) {
    final id = msg['id'];
    if (id != null) {
      _deletedIds.add('$id');
      SharedPreferences.getInstance().then((prefs) => prefs.setStringList('deletedMsgIds', _deletedIds.toList())).catchError((_) => false);
    }
    setState(() => messages.remove(msg));
    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已删除（仅本端）')));
  }

  Future<void> _forwardMessage(Map<String, dynamic> msg) async {
    if (conversations.isEmpty) return;
    final target = selected;
    String query = '';
    final t = widget.config.theme;
    final selectedFwd = <int>{};
    final picked = await showDialog<List<int>>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setState) {
          final filtered = query.isEmpty
              ? conversations
              : conversations.where((c) => (c['name'] ?? '').toString().toLowerCase().contains(query.toLowerCase())).toList();
          return AlertDialog(
            title: const Text('转发到...'),
            content: SizedBox(
              width: 360, height: 400,
              child: Column(children: [
                TextField(
                  autofocus: true,
                  decoration: InputDecoration(hintText: '搜索联系人/群聊', prefixIcon: const Icon(Icons.search, size: 20), border: const OutlineInputBorder(), contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8)),
                  onChanged: (v) => setState(() => query = v),
                ),
                const SizedBox(height: 8),
                Expanded(child: ListView.builder(
                  itemCount: filtered.length,
                  itemBuilder: (_, i) {
                    final c = filtered[i];
                    final idx = conversations.indexOf(c);
                    return ListTile(
                      dense: true,
                      leading: CircleAvatar(
                        radius: 18,
                        backgroundColor: _wechatGreen,
                        backgroundImage: c['avatar'] != null && (c['avatar'] as String).isNotEmpty ? NetworkImage(c['avatar'] as String) : null,
                        child: c['avatar'] == null || (c['avatar'] as String).isEmpty
                            ? Text((c['name'] ?? '?').toString().substring(0, 1).toUpperCase(), style: const TextStyle(color: Colors.white, fontSize: 14))
                            : null,
                      ),
                      title: Text(c['name']?.toString() ?? '', maxLines: 1, overflow: TextOverflow.ellipsis),
                      subtitle: c['kind'] == 'group' ? const Text('群聊', style: TextStyle(fontSize: 11)) : null,
                      trailing: Icon(selectedFwd.contains(idx) ? Icons.check_circle : Icons.radio_button_unchecked, color: selectedFwd.contains(idx) ? _wechatGreen : t.subText),
                      onTap: () { setState(() { if (selectedFwd.contains(idx)) selectedFwd.remove(idx); else selectedFwd.add(idx); }); },
                    );
                  },
                )),
              ]),
            ),
            actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')), FilledButton(onPressed: selectedFwd.isEmpty ? null : () => Navigator.pop(ctx, selectedFwd.toList()), child: const Text('转发'))],
          );
        },
      ),
    );
    if (picked == null || picked.isEmpty || !mounted) return;
    final text = (msg['text'] ?? '').toString();
    final content = text.isEmpty ? '转发消息' : text;
    int count = 0;
    for (final idx in picked) {
      final conv = conversations[idx];
      if (conv['id'].toString() == target.toString()) continue;
      if (conv['kind'] == 'group') {
        final gcmid = 'gf\$' + 'DateTime.now().microsecondsSinceEpoch';
        _sentIds.add(gcmid);
        socket?.sink.add(jsonEncode({'type': 'group_msg', 'payload': {'groupId': conv['id'], 'content': content, 'clientMsgId': gcmid, 'forwardedFrom': msg['id']}}));
      } else {
        final cmid = 'ff\$' + 'DateTime.now().microsecondsSinceEpoch';
        _sentIds.add(cmid);
        socket?.sink.add(jsonEncode({'type': 'msg', 'payload': {'to': conv['id'], 'content': await e2eeEncrypt(conv['id'].toString(), content), 'clientMsgId': cmid, 'forwardedFrom': msg['id']}}));
      }
      count++;
      await Future.delayed(const Duration(milliseconds: 50));
    }
    if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('已转发到 \$' + 'count 个会话')));
  }

  /// 双击消息点赞：气泡旁弹出爱心动画
  void _likeMessage(Map<String, dynamic> msg) {
    final key = msg['cmid']?.toString() ?? 'id${msg['id']}';
    setState(() => _likedMsgs[key] = DateTime.now().millisecondsSinceEpoch);
    Future.delayed(const Duration(milliseconds: 900), () {
      if (mounted) setState(() => _likedMsgs.remove(key));
    });
  }

  Widget _likeBadge(Map<String, dynamic> msg) {
    final key = msg['cmid']?.toString() ?? 'id${msg['id']}';
    if (!_likedMsgs.containsKey(key)) return const SizedBox.shrink();
    return const Padding(
      padding: EdgeInsets.only(left: 4),
      child: Icon(Icons.favorite, color: Color(0xfffa5151), size: 16),
    );
  }

  Future<void> _shareMessage(Map<String, dynamic> msg) async {
    try {
      final text = msg['text'] ?? msg['content'] ?? '';
      if (text.isNotEmpty) {
        await Clipboard.setData(ClipboardData(text: text));
        if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已复制到剪贴板')));
      }
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('分享失败: $e')));
    }
  }

  void _bubbleMenu(BuildContext context, Map<String, dynamic> msg) {
    final isFromMe = msg['from'] == myId;
    final isFriendChat = selConv != null && selConv!['kind'] == 'friend' && !isFromMe;
    showModalBottomSheet(
      context: context,
      builder: (sheetCtx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          ListTile(leading: const Icon(Icons.copy), title: const Text('复制'), onTap: () { Navigator.pop(sheetCtx); _copyMessage(msg); }),
          ListTile(leading: const Icon(Icons.checklist), title: const Text('多选'), onTap: () { Navigator.pop(sheetCtx); _toggleMultiSelect(); }),
          ListTile(leading: const Icon(Icons.reply), title: const Text('回复'), onTap: () { Navigator.pop(sheetCtx); _startReply(msg); }),
          ListTile(leading: const Icon(Icons.forward), title: const Text('转发'), onTap: () { Navigator.pop(sheetCtx); _forwardMessage(msg); }),
          ListTile(leading: const Icon(Icons.share), title: const Text('分享'), onTap: () { Navigator.pop(sheetCtx); _shareMessage(msg); }),
          ListTile(leading: const Icon(Icons.star_outline), title: const Text('收藏'), onTap: () { Navigator.pop(sheetCtx); _favoriteMessage(msg); }),
          ListTile(leading: const Icon(Icons.waving_hand, size: 20), title: const Text('拍一拍'), onTap: () { Navigator.pop(sheetCtx); _patMessage(msg); }),
          ListTile(leading: const Icon(Icons.push_pin_outlined), title: const Text('置顶消息'), onTap: () { Navigator.pop(sheetCtx); _pinMessage(msg); }),
           ListTile(leading: const Icon(Icons.translate), title: const Text('翻译'), onTap: () { Navigator.pop(sheetCtx); showTranslateDialog(sheetCtx, widget.api, msg['text'] ?? ''); }),
          ListTile(leading: const Icon(Icons.mic), title: const Text('语音转文字'), onTap: () { Navigator.pop(sheetCtx); _showTranscribeDialog(sheetCtx, msg); }),
          ListTile(leading: const Icon(Icons.image_search), title: const Text('提取文字'), onTap: () { Navigator.pop(sheetCtx); _showOCRDialog(sheetCtx, msg); }),
          ListTile(leading: const Icon(Icons.remove), title: const Text('阅后即焚'), onTap: () { Navigator.pop(sheetCtx); _showBurnDialog(sheetCtx, msg); }),
          ListTile(leading: const Icon(Icons.backspace), title: const Text('撤回'), onTap: () { Navigator.pop(sheetCtx); _showRecallDialog(sheetCtx, msg); }),
          if (isFriendChat) ListTile(leading: const Icon(Icons.block, color: Colors.orange), title: const Text('拉黑', style: TextStyle(color: Colors.orange)), onTap: () { Navigator.pop(sheetCtx); _blockCurrentUser(); }),
          ListTile(leading: const Icon(Icons.delete_outline, color: Colors.red), title: const Text('删除', style: TextStyle(color: Colors.red)), onTap: () { Navigator.pop(sheetCtx); _deleteLocalMessage(msg); }),
        ]),
      ),
    );
  }

  void _showQuickReplies() async {
    final result = await showQuickRepliesSheet(context, widget.api);
    if (result != null && result is String && mounted) {
      input.text = result;
      inputFocus.requestFocus();
    }
  }

  void _showScheduleDialog() {
    final conv = selConv;
    if (conv == null) return;
    showScheduleDialog(context, widget.api, conv['id'] as int, conv['kind'] == 'group');
  }

  void _showTranscribeDialog(BuildContext ctx, Map<String, dynamic> msg) {
    showTranscribeDialog(ctx, widget.api, msg);
  }

  void _showOCRDialog(BuildContext ctx, Map<String, dynamic> msg) {
    showOCRDialog(ctx, widget.api, msg);
  }

  void _showBurnDialog(BuildContext ctx, Map<String, dynamic> msg) {
    final conv = selConv;
    if (conv == null) return;
    showBurnDialog(ctx, msg, widget.api, conv['id'] as int, conv['kind'] == 'group');
  }

  void _showRecallDialog(BuildContext ctx, Map<String, dynamic> msg) {
    final conv = selConv;
    if (conv == null) return;
    showRecallDialog(ctx, msg, widget.api, conv['id'] as int, conv['kind'] == 'group',
      onRecalled: () {
        setState(() {
          final idx = messages.indexWhere((m) => m['id'] == msg['id'] || (msg['cmid'] != null && m['cmid'] == msg['cmid']));
          if (idx >= 0) messages.removeAt(idx);
        });
      },
    );
  }

  void _showGroupAnnouncement() {
    final conv = selConv;
    if (conv == null || conv['kind'] != 'group') return;
    final announcement = conv['announcement']?.toString();
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Row(children: [
          Icon(Icons.campaign_outlined, color: const Color(0xff07c160)),
          const SizedBox(width: 8),
          const Text('群公告'),
        ]),
        content: Text(announcement ?? '暂无群公告', style: TextStyle(color: announcement != null ? null : widget.config.theme.subText)),
        actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('关闭'))],
      ),
    );
  }
  void _showGroupMembers() async {
    final conv = selConv;
    if (conv == null || conv['kind'] != 'group') return;
    final gid = conv['id'] as int;
    try {
      final result = await widget.api.groupMembers(gid);
      if (!mounted) return;
      final members = result as List;
      showModalBottomSheet(context: context, builder: (ctx) => Container(
        constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.7),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Padding(padding: const EdgeInsets.all(16), child: Text('群成员（${members.length}）', style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16))),
          Padding(padding: const EdgeInsets.symmetric(horizontal: 12), child: SizedBox(width: double.infinity, child: OutlinedButton.icon(
            onPressed: () async {
              Navigator.pop(ctx);
              _showInviteToGroup(gid);
            },
            icon: const Icon(Icons.person_add_alt_1, size: 18),
            label: const Text('邀请好友进群'),
          ))),
          const Divider(height: 16),
          Expanded(child: ListView.builder(
            itemCount: members.length,
            itemBuilder: (_, i) {
              final m = members[i];
              final nick = (m['nickname'] ?? m['username'] ?? '?').toString();
              final online = m['online'] == true;
              final mid = m['userId'] ?? m['id'];
              return ListTile(
                onLongPress: mid is int ? () => _confirmRemoveMember(ctx, gid, mid, nick) : null,
                leading: Stack(clipBehavior: Clip.none, children: [
                  CircleAvatar(backgroundColor: _wechatGreen, child: Text(nick.isNotEmpty ? nick[0] : '?', style: const TextStyle(color: Colors.white))),
                  if (online) Positioned(right: -1, bottom: -1, child: Container(width: 10, height: 10, decoration: BoxDecoration(color: const Color(0xff07c160), shape: BoxShape.circle, border: Border.all(color: Colors.white, width: 2)))),
                ]),
                title: Text(nick),
                subtitle: Text(online ? '在线' : '离线', style: TextStyle(color: online ? _wechatGreen : widget.config.theme.subText, fontSize: 12)),
                trailing: Text('长按移出', style: TextStyle(color: widget.config.theme.subText.withValues(alpha: 0.5), fontSize: 10)),
              );
            },
          )),
          SafeArea(child: Padding(padding: const EdgeInsets.fromLTRB(12, 4, 12, 10), child: SizedBox(width: double.infinity, child: OutlinedButton(
            style: OutlinedButton.styleFrom(foregroundColor: Colors.red, side: const BorderSide(color: Colors.red)),
            onPressed: () async {
              Navigator.pop(ctx);
              final ok = await showDialog<bool>(context: context, builder: (d) => AlertDialog(
                title: const Text('退出群聊'),
                content: Text('确定退出「${conv['name']}」吗？退出后需要重新被邀请才能加入。'),
                actions: [TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('取消')), FilledButton(onPressed: () => Navigator.pop(d, true), child: const Text('退出'))],
              ));
              if (ok != true) return;
              try {
                await widget.api.groupLeave(gid);
                if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已退出群聊')));
                if (mounted) setState(() { selected = -1; messages.clear(); });
                _loadData();
              } catch (e) {
                if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('退出失败：${e.toString().replaceFirst('Bad state: ', '')}')));
              }
            },
            child: const Text('退出群聊'),
          )))),
        ]),
      ));
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('加载群成员失败')));
    }
  }

  void _confirmRemoveMember(BuildContext sheetCtx, int gid, int userId, String nick) {
    showDialog(context: context, builder: (d) => AlertDialog(
      title: const Text('移出成员'),
      content: Text('将 $nick 移出本群？（仅群主可操作）'),
      actions: [
        TextButton(onPressed: () => Navigator.pop(d), child: const Text('取消')),
        FilledButton(style: FilledButton.styleFrom(backgroundColor: Colors.red), onPressed: () async {
          Navigator.pop(d);
          try {
            await widget.api.groupRemoveMember(gid, userId);
            if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('已移出 $nick')));
            if (sheetCtx.mounted) Navigator.pop(sheetCtx);
            _showGroupMembers();
          } catch (e) {
            if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('移出失败：${e.toString().replaceFirst('Bad state: ', '')}')));
          }
        }, child: const Text('移出')),
      ],
    ));
  }

  void _showInviteToGroup(int gid) async {
    try {
      final friends = await widget.api.friends();
      if (!mounted) return;
      final members = await widget.api.groupMembers(gid);
      if (!mounted) return;
      final memberIds = members.map((m) => m['userId'] ?? m['id']).toSet();
      final candidates = friends.where((f) => !memberIds.contains(f['id'])).toList();
      if (candidates.isEmpty) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('所有好友都已在群里')));
        return;
      }
      final selected = <int>{};
      showModalBottomSheet(context: context, builder: (ctx) => StatefulBuilder(builder: (ctx, setSheet) => Container(
        constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.6),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Padding(padding: const EdgeInsets.all(16), child: Row(children: [
            Expanded(child: Text('选择好友（已选 ${selected.length}）', style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16))),
            FilledButton(onPressed: selected.isEmpty ? null : () async {
              Navigator.pop(ctx);
              try {
                final r = await widget.api.groupInvite(gid, userIds: selected.toList());
                if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('已邀请 ${r['count'] ?? selected.length} 位好友')));
              } catch (e) {
                if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('邀请失败：${e.toString().replaceFirst('Bad state: ', '')}')));
              }
            }, child: const Text('邀请')),
          ])),
          const Divider(height: 1),
          Expanded(child: ListView.builder(
            itemCount: candidates.length,
            itemBuilder: (_, i) {
              final f = candidates[i];
              final fid = f['id'] as int;
              final name = (f['nickname'] ?? f['username'] ?? '').toString();
              final checked = selected.contains(fid);
              return CheckboxListTile(
                value: checked,
                onChanged: (_) => setSheet(() { checked ? selected.remove(fid) : selected.add(fid); }),
                secondary: CircleAvatar(backgroundColor: _wechatGreen, child: Text(name.isNotEmpty ? name[0] : '?', style: const TextStyle(color: Colors.white))),
                title: Text(name),
              );
            },
          )),
        ]),
      )));
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('加载好友列表失败')));
    }
  }

  void _onContextMenu(int v, BuildContext ctx) {
    if (v == 2) _showAddFriendDialog(ctx);
    if (v == 3) _showChatInfo(ctx);
    if (v == 4) _showMyCard(ctx);
    if (v == 5) {
      if (Platform.isAndroid || Platform.isIOS) {
        Navigator.of(ctx).push(MaterialPageRoute(builder: (_) => QrConfirmPage(api: widget.api, config: widget.config)));
      } else {
        ScaffoldMessenger.of(ctx).showSnackBar(const SnackBar(content: Text('扫描仅支持手机端')));
      }
    }
    if (v == 6) _showJoinGroupDialog(ctx);
    if (v == 7) _showBgPicker(ctx);
    if (v == 8) _showFontSizeDialog(ctx);
  }

  void _showFontSizeDialog(BuildContext ctx) {
    showDialog(
      context: ctx,
      builder: (d) => StatefulBuilder(
        builder: (d, setState) => AlertDialog(
          title: const Text('聊天字体大小'),
          content: Column(mainAxisSize: MainAxisSize.min, children: [
            Text('预览：你好，这是一条消息', style: TextStyle(fontSize: _fontSize)),
            const SizedBox(height: 12),
            Row(children: [
              const Text('小'),
              Expanded(child: Slider(min: 12, max: 22, divisions: 10, value: _fontSize, onChanged: (v) => setState(() => _fontSize = v))),
              const Text('大'),
            ]),
            Text('${_fontSize.toStringAsFixed(0)} px', style: TextStyle(color: Theme.of(ctx).colorScheme.onSurfaceVariant, fontSize: 12)),
          ]),
          actions: [
            TextButton(onPressed: () => setState(() => _fontSize = 15.0), child: const Text('默认')),
            TextButton(onPressed: () { SharedPreferences.getInstance().then((p) => p.setDouble('chatFontSize', _fontSize)).catchError((_){}); Navigator.pop(d); }, child: const Text('确定')),
          ],
        ),
      ),
    );
  }

  void _toggleMultiSelect() {
    setState(() {
      _multiSelectMode = !_multiSelectMode;
      if (!_multiSelectMode) _selectedMsgs.clear();
    });
  }

  void _batchDelete() async {
    if (_selectedMsgs.isEmpty) return;
    final count = _selectedMsgs.length;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('删除消息'),
        content: Text('确定删除选中的 $count 条消息？'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('删除', style: TextStyle(color: Colors.red))),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    setState(() {
      for (final msg in _selectedMsgs) {
        final cmid = msg['cmid'] as String?;
        if (cmid != null) _deletedIds.add(cmid);
        messages.removeWhere((m) => m['id'] == msg['id'] || (cmid != null && m['cmid'] == cmid));
      }
      _selectedMsgs.clear();
      _multiSelectMode = false;
    });
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('已删除 $count 条消息')));
  }

  void _batchFavorite() async {
    if (_selectedMsgs.isEmpty) return;
    int count = 0;
    for (final msg in _selectedMsgs) {
      final id = msg['id'] as int?;
      if (id != null) {
        try { await widget.api.setFavorite(id); count++; } catch (_) {}
      }
    }
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('已收藏 $count 条消息')));
      setState(() { _selectedMsgs.clear(); _multiSelectMode = false; });
    }
  }
  void _batchRecall() async {
    if (_selectedMsgs.isEmpty) return;
    final conv = selConv;
    if (conv == null) return;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('撤回消息'),
        content: Text('确定撤回选中的 ${_selectedMsgs.length} 条消息？（仅5分钟内可撤回）'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('撤回')),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    int count = 0;
    for (final msg in _selectedMsgs) {
      final msgId = msg['id'] as int?;
      if (msgId == null) continue;
      try {
        if (conv['kind'] == 'group') { await widget.api.recallGroupMessage(conv['id'] as int, msgId); }
        else { await widget.api.recallMessage(msgId); }
        count++;
      } catch (_) {}
    }
    if (mounted) {
      setState(() {
        for (final msg in _selectedMsgs) {
          messages.removeWhere((m) => m['id'] == msg['id']);
        }
        _selectedMsgs.clear();
        _multiSelectMode = false;
      });
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('已撤回 $count 条消息')));
    }
  }
  void _batchForward() async {
    if (_selectedMsgs.isEmpty) return;
    if (conversations.isEmpty) return;
    String query = '';
    final picked = await showDialog<int>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setState) {
          final filtered = query.isEmpty
              ? conversations
              : conversations.where((c) => (c['name'] ?? '').toString().toLowerCase().contains(query.toLowerCase())).toList();
          return AlertDialog(
            title: Text('转发 ${_selectedMsgs.length} 条消息到...'),
            content: SizedBox(width: 360, height: 400,
              child: Column(children: [
                TextField(
                  autofocus: true,
                  decoration: InputDecoration(hintText: '搜索联系人/群聊', prefixIcon: const Icon(Icons.search, size: 20), border: const OutlineInputBorder(), contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8)),
                  onChanged: (v) => setState(() => query = v),
                ),
                const SizedBox(height: 8),
                Expanded(child: ListView.builder(
                  itemCount: filtered.length,
                  itemBuilder: (_, i) {
                    final c = filtered[i];
                    final idx = conversations.indexOf(c);
                    return ListTile(
                      dense: true,
                      leading: CircleAvatar(radius: 18, backgroundColor: _wechatGreen, child: Text((c['name'] ?? '?').toString().substring(0, 1).toUpperCase(), style: const TextStyle(color: Colors.white, fontSize: 14))),
                      title: Text(c['name']?.toString() ?? '', maxLines: 1, overflow: TextOverflow.ellipsis),
                      subtitle: c['kind'] == 'group' ? const Text('群聊', style: TextStyle(fontSize: 11)) : null,
                      onTap: () => Navigator.pop(ctx, idx),
                    );
                  },
                )),
              ]),
            ),
            actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消'))],
          );
        },
      ),
    );
    if (picked == null || !mounted) return;
    final conv = conversations[picked];
    final texts = _selectedMsgs.map((m) => (m['text'] ?? '').toString()).where((t) => t.isNotEmpty).toList();
    if (texts.isEmpty) return;
    final content = texts.join('\n');
    if (conv['kind'] == 'group') {
      final gcmid = 'gf${DateTime.now().microsecondsSinceEpoch}';
      _sentIds.add(gcmid);
      socket?.sink.add(jsonEncode({'type': 'group_msg', 'payload': {'groupId': conv['id'], 'content': content, 'clientMsgId': gcmid}}));
    } else {
      final cmid = 'ff${DateTime.now().microsecondsSinceEpoch}';
      _sentIds.add(cmid);
      socket?.sink.add(jsonEncode({'type': 'msg', 'payload': {'to': conv['id'], 'content': await e2eeEncrypt('${conv['id']}', content), 'clientMsgId': cmid}}));
    }
    if (!mounted) return;
    setState(() { _selectedMsgs.clear(); _multiSelectMode = false; });
    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已批量转发')));
  }

  void _saveBgColors() {
    try {
      final entries = _chatBgColors.entries.map((e) => '${e.key}:${e.value.value}').toList();
      SharedPreferences.getInstance().then((p) => p.setStringList('chatBgColors', entries)).catchError((_){});
    } catch (_) {}
  }

  void _showAddFriendDialog(BuildContext ctx) {
    final ctrl = TextEditingController();
    showDialog(
      context: ctx,
      builder: (d) => AlertDialog(
        title: const Text('添加好友'),
        content: TextField(controller: ctrl, decoration: const InputDecoration(hintText: '输入对方 UID', prefixIcon: Icon(Icons.person_add))),
        actions: [
          TextButton(onPressed: () => Navigator.pop(d), child: const Text('取消')),
          TextButton(onPressed: () async {
            final uid = ctrl.text.trim();
            if (uid.isEmpty) { ScaffoldMessenger.of(ctx).showSnackBar(const SnackBar(content: Text('请输入 UID'))); return; }
            Navigator.pop(d);
            try {
              await widget.api.addFriend(uid);
              if (!mounted) return;
              ScaffoldMessenger.of(ctx).showSnackBar(const SnackBar(content: Text('好友请求已发送')));
            } catch (e) {
              if (!mounted) return;
              ScaffoldMessenger.of(ctx).showSnackBar(SnackBar(content: Text('发送失败：$e')));
            }
          }, child: const Text('发送请求')),
        ],
      ),
    );
  }

  void _showBgPicker(BuildContext ctx) {
    if (selConv == null) return;
    final convKey = _convKey(selConv!);
    final colors = <Color?>[
      null,
      const Color(0xffededed), const Color(0xffd4edda), const Color(0xffd1ecf1),
      const Color(0xfffce4ec), const Color(0xfffff9c4), const Color(0xffe8eaf6),
      const Color(0xffffe0b2), const Color(0xffe0f2f1), const Color(0xfff3e5f5),
    ];
    showDialog(
      context: ctx,
      builder: (d) => AlertDialog(
        title: const Text('选择聊天背景'),
        content: Wrap(
          spacing: 10, runSpacing: 10,
          children: [
            for (final c in colors)
              GestureDetector(
                onTap: () {
                  setState(() {
                    if (c == null) { _chatBgColors.remove(convKey); } else { _chatBgColors[convKey] = c; }
                  });
                  _saveBgColors();
                  Navigator.pop(d);
                },
                child: Container(
                  width: 48, height: 48,
                  decoration: BoxDecoration(
                    color: c ?? Theme.of(ctx).scaffoldBackgroundColor,
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: _chatBgColors[convKey] == c ? _wechatGreen : Colors.grey.shade300, width: 2),
                  ),
                  child: c == null ? const Icon(Icons.close, size: 18) : null,
                ),
              ),
          ],
        ),
      ),
    );
  }

  void _blockCurrentUser() {
    final conv = selConv;
    if (conv == null || conv['kind'] != 'friend') return;
    final targetId = conv['id'] as int;
    final targetName = conv['name']?.toString() ?? '对方';
    showDialog(
      context: context,
      builder: (d) => AlertDialog(
        title: const Text('拉黑确认'),
        content: Text('确定要拉黑 $targetName 吗？拉黑后将无法收到对方消息。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(d), child: const Text('取消')),
          TextButton(onPressed: () async {
            Navigator.pop(d);
            try {
              await widget.api.blockUser(targetId);
              if (!mounted) return;
              ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('已拉黑 $targetName')));
            } catch (e) {
              if (!mounted) return;
              ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('操作失败：$e')));
            }
          }, child: const Text('拉黑', style: TextStyle(color: Colors.red))),
        ],
      ),
    );
  }

  static const _emojiList = [
    '😀','😂','🤣','😊','😍','🥰','😘','😎','🤔','😤',
    '😭','😱','🥺','🙄','😴','🤗','👍','👎','❤️','🔥',
    '🎉','🎊','💪','🙏','👌','✌️','🤝','👏','💯','⭐',
    '🌟','✨','💫','🌈','☀️','🌙','🍀','🌸','🍎','🎯',
    '🚀','💎','🏆','📱','💻','📷','🎵','☕','🍕','🍰',
  ];

  void _showEmojiPicker(BuildContext ctx) {
    showModalBottomSheet(
      context: ctx,
      builder: (sheetCtx) => SafeArea(
        child: Container(
          height: 280,
          padding: const EdgeInsets.all(8),
          child: GridView.builder(
            gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(crossAxisCount: 8, mainAxisSpacing: 4, crossAxisSpacing: 4),
            itemCount: _emojiList.length,
            itemBuilder: (_, i) => GestureDetector(
              onTap: () {
                final emoji = _emojiList[i];
                final text = input.text;
                final sel = input.selection;
                final start = sel.start >= 0 ? sel.start : text.length;
                input.text = text.substring(0, start) + emoji + text.substring(start);
                input.selection = TextSelection.collapsed(offset: start + emoji.length);
                Navigator.pop(sheetCtx);
                inputFocus.requestFocus();
              },
              child: Center(child: Text(_emojiList[i], style: const TextStyle(fontSize: 24))),
            ),
          ),
        ),
      ),
    );
  }

  void _showJoinGroupDialog(BuildContext ctx) {
    final ctrl = TextEditingController();
    showDialog(
      context: ctx,
      builder: (d) => AlertDialog(
        title: const Text('加入群聊'),
        content: TextField(controller: ctrl, keyboardType: TextInputType.number, decoration: const InputDecoration(hintText: '输入群号', prefixIcon: Icon(Icons.tag))),
        actions: [
          TextButton(onPressed: () => Navigator.pop(d), child: const Text('取消')),
          TextButton(onPressed: () async {
            final gid = int.tryParse(ctrl.text.trim());
            if (gid == null) { ScaffoldMessenger.of(ctx).showSnackBar(const SnackBar(content: Text('请输入有效的群号'))); return; }
            Navigator.pop(d);
            try {
              await widget.api.joinGroup(gid);
              if (!mounted) return;
              ScaffoldMessenger.of(ctx).showSnackBar(const SnackBar(content: Text('已加入群聊')));
              _loadData();
            } catch (e) {
              if (!mounted) return;
              ScaffoldMessenger.of(ctx).showSnackBar(SnackBar(content: Text('加入失败：$e')));
            }
          }, child: const Text('加入')),
        ],
      ),
    );
  }

  void _showConvMenu(int index, BuildContext ctx) {
    final conv = conversations[index];
    if (conv['kind'] != 'friend' && conv['kind'] != 'group') return;
    showModalBottomSheet(
      context: ctx,
      builder: (sheetCtx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          ListTile(leading: Icon(conv['pinned'] == true ? Icons.push_pin : Icons.push_pin_outlined), title: Text(conv['pinned'] == true ? '取消置顶' : '置顶聊天'), onTap: () { Navigator.pop(sheetCtx); _togglePin(index, !(conv['pinned'] == true)); }),
          ListTile(leading: Icon(conv['muted'] == true ? Icons.notifications_active : Icons.notifications_off_outlined), title: Text(conv['muted'] == true ? '取消免打扰' : '消息免打扰'), onTap: () { Navigator.pop(sheetCtx); _toggleMute(index, !(conv['muted'] == true)); }),
          ListTile(leading: const Icon(Icons.delete_outline, color: Colors.red), title: const Text('删除聊天', style: TextStyle(color: Colors.red)), onTap: () { Navigator.pop(sheetCtx); _clearConversation(index); }),
        ]),
      ),
    );
  }

  Future<void> _togglePin(int index, bool pinned) async {
    final conv = conversations[index];
    if (conv['kind'] != 'friend' && conv['kind'] != 'group') return;
    final peerId = conv['id'] as int;
    try {
      await widget.api.setChatSettings(peerId, pinned: pinned);
      if (!mounted) return;
      setState(() => conversations[index]['pinned'] = pinned);
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(pinned ? '已置顶' : '已取消置顶')));
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('操作失败：$e')));
    }
  }

  Future<void> _toggleMute(int index, bool muted) async {
    final conv = conversations[index];
    if (conv['kind'] != 'friend' && conv['kind'] != 'group') return;
    final peerId = conv['id'] as int;
    try {
      await widget.api.setChatSettings(peerId, muted: muted);
      if (!mounted) return;
      setState(() => conversations[index]['muted'] = muted);
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(muted ? '已开启免打扰' : '已取消免打扰')));
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('操作失败：$e')));
    }
  }

  Future<void> _showChatInfo(BuildContext context) async {
    final conv = selConv;
    if (conv == null) return;
    final theme = widget.config.theme;
    if (conv['kind'] == 'group') {
      List<Map<String, dynamic>> members;
      try {
        members = await widget.api.groupMembers(conv['id'] as int);
      } catch (_) {
        members = const [];
      }
      if (!mounted) return;
      showDialog(context: context, builder: (ctx) => Dialog(child: SizedBox(width: 360, child: Padding(padding: const EdgeInsets.all(20), child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Icon(Icons.groups_rounded, color: _wechatGreen),
          const SizedBox(width: 8),
          Expanded(child: Text(conv['name'].toString(), style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16), overflow: TextOverflow.ellipsis)),
          IconButton(icon: const Icon(Icons.close), onPressed: () => Navigator.pop(ctx)),
        ]),
        const SizedBox(height: 6),
        Text('群成员（${members.length}）', style: TextStyle(color: theme.subText, fontSize: 12)),
        const SizedBox(height: 8),
        Flexible(child: ListView(shrinkWrap: true, children: [
          for (final m in members)
            ListTile(dense: true, contentPadding: EdgeInsets.zero, leading: CircleAvatar(radius: 16, child: Text((m['nickname'] ?? m['username'] ?? '?').toString()[0])), title: Text((m['nickname'] ?? m['username'] ?? '').toString(), maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: theme.text, fontSize: 14))),
        ])),
        const SizedBox(height: 8),
        SizedBox(width: double.infinity, child: OutlinedButton(onPressed: () => Navigator.pop(ctx), child: const Text('关闭'))),
      ]), ))));
      return;
    }
    showDialog(context: context, builder: (ctx) => Dialog(child: SizedBox(width: 320, child: Padding(padding: const EdgeInsets.all(20), child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(children: [
        CircleAvatar(backgroundColor: _wechatGreen.withValues(alpha: 0.18), child: Icon(Icons.person, color: _wechatGreen)),
        const SizedBox(width: 12),
        Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(conv['name'].toString(), style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
          Text(_convStatusLine(conv), style: TextStyle(color: theme.subText, fontSize: 12)),
        ])),
        IconButton(icon: const Icon(Icons.close), onPressed: () => Navigator.pop(ctx)),
      ]),
      const SizedBox(height: 12),
      const Divider(height: 1),
      ListTile(leading: const Icon(Icons.download_outlined), title: const Text('导出聊天记录'), onTap: () { Navigator.pop(ctx); _exportChat(); }),
      ListTile(leading: const Icon(Icons.cleaning_services_outlined), title: const Text('清空聊天记录'), onTap: () { Navigator.pop(ctx); _clearConversation(); }),
      ListTile(leading: const Icon(Icons.push_pin_outlined), title: Text(conv['pinned'] == true ? '取消置顶' : '置顶会话'), onTap: () { Navigator.pop(ctx); _togglePin(selected, !(conv['pinned'] == true)); }),
      ListTile(leading: const Icon(Icons.notifications_none), title: Text(conv['muted'] == true ? '取消免打扰' : '消息免打扰'), onTap: () { Navigator.pop(ctx); _toggleMute(selected, !(conv['muted'] == true)); }),
    ]), ))));
  }

  Future<void> _showMyCard(BuildContext context) async {
    Map<String, dynamic> card;
    try {
      card = await widget.api.myCard();
    } catch (e) {
      if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('获取名片失败：${e.toString().replaceFirst('Bad state: ', '')}')));
      return null;
    }
    final uid = (card['uid'] ?? '').toString();
    if (uid.isEmpty) {
      if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('未获取到您的 UID，无法生成名片')));
      return null;
    }
    final name = (card['name'] ?? (card['nickname'] ?? (card['username'] ?? ''))).toString();
    if (context.mounted) {
      showDialog(context: context, builder: (_) => Dialog(child: Padding(padding: const EdgeInsets.all(24), child: Column(mainAxisSize: MainAxisSize.min, children: [
        Text('我的名片', style: TextStyle(fontWeight: FontWeight.w700, color: widget.config.theme.text)),
        const SizedBox(height: 14),
        Text(name.isNotEmpty ? name : uid, style: TextStyle(fontSize: 14, color: widget.config.theme.subText)),
        const SizedBox(height: 16),
        Container(padding: const EdgeInsets.all(12), decoration: BoxDecoration(border: Border.all(color: widget.config.theme.div), borderRadius: BorderRadius.circular(16)), child: QrImageView(data: 'securechat://friend?uid=$uid', version: QrVersions.auto, size: 200)),
        const SizedBox(height: 12),
        Text('让朋友用手机「扫一扫」这个二维码，即可添加我为好友。', textAlign: TextAlign.center, style: TextStyle(fontSize: 12, color: widget.config.theme.subText)),
        const SizedBox(height: 6),
        Text('UID：$uid', style: TextStyle(fontSize: 12, color: widget.config.theme.subText)),
        const SizedBox(height: 10),
        SizedBox(width: double.infinity, child: FilledButton(onPressed: () => Navigator.pop(context), child: const Text('关闭'))),
      ]))));
    }
  }
}

// ─── 通讯录 Tab ──────────────────────────────────────────────────────────────

class ContactsView extends StatefulWidget {
  const ContactsView({super.key, required this.api, required this.config, this.onOpenChat});
  final SecureChatApi api;
  final AppConfig config;
  final void Function(int id, bool isGroup, String name)? onOpenChat;
  @override
  State<ContactsView> createState() => _ContactsViewStateState();
}

class _ContactsViewStateState extends State<ContactsView> {
  final _cSearchCtrl = TextEditingController();
  String _cSearch = '';
  final contacts = <Map<String, dynamic>>[];
  final groups = <Map<String, dynamic>>[];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final friends = await widget.api.friends();
      final grp = await widget.api.groups();
      if (!mounted) return;
      setState(() {
        contacts.clear();
        groups.clear();
        for (final f in friends) {
          contacts.add({
            'id': f['id'],
            'kind': 'friend',
            'name': (f['nickname'] ?? f['username'] ?? '').toString(),
            'online': f['online'] == true,
            'icon': Icons.person,
          });
        }
        for (final g in grp) {
          groups.add({
            'id': g['id'],
            'kind': 'group',
            'name': (g['name'] ?? '群聊').toString(),
            'icon': Icons.groups_rounded,
          });
        }
        _loading = false;
      });
    } catch (e) {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = widget.config.theme;
    return Container(color: t.bg, child: _loading
        ? const Center(child: CircularProgressIndicator())
        : CustomScrollView(
            slivers: [
              SliverToBoxAdapter(child: Padding(padding: const EdgeInsets.fromLTRB(16, 12, 16, 4), child: TextField(controller: _cSearchCtrl, style: TextStyle(color: t.text), decoration: InputDecoration(hintText: '搜索联系人/群聊', hintStyle: TextStyle(color: t.subText), prefixIcon: Icon(Icons.search, color: t.subText), isDense: true, filled: true, fillColor: t.inputBg, border: OutlineInputBorder(borderRadius: BorderRadius.circular(8), borderSide: BorderSide.none)), onChanged: (v) => setState(() => _cSearch = v)))),
              SliverToBoxAdapter(child: Container(margin: const EdgeInsets.only(top: 8, left: 16, right: 16), decoration: BoxDecoration(color: t.card.withValues(alpha: 0.7), borderRadius: BorderRadius.circular(10)), child: Column(children: [
                _contactActionCell(t, Icons.person_add_alt_1, const Color(0xfffa9d3b), '新的朋友', badge: gFriendReqs.isEmpty ? null : gFriendReqs.length, onTap: _showFriendRequests),
                CellDivider(config: widget.config, indent: 68),
                _contactActionCell(t, Icons.group_add, _wechatGreen, '添加朋友', onTap: _showAddFriendDialog),
              ]))),
              _contactSection('联系人', _filterList(contacts), t),
              _contactSection('群聊', _filterList(groups), t),
              const SliverToBoxAdapter(child: SizedBox(height: 24)),
            ],
          ),
    );
  }



  List<Map<String, dynamic>> _filterList(List<Map<String, dynamic>> list) {
    final q = _cSearch.trim().toLowerCase();
    if (q.isEmpty) return list;
    return list.where((c) => (c['name'] as String).toLowerCase().contains(q)).toList();
  }

  Widget _contactActionCell(AppTheme t, IconData icon, Color iconBg, String label, {int? badge, VoidCallback? onTap}) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
          child: Row(children: [
            Stack(clipBehavior: Clip.none, children: [
              Container(width: 40, height: 40, decoration: BoxDecoration(color: iconBg, borderRadius: BorderRadius.circular(8)), child: Icon(icon, color: Colors.white, size: 22)),
              if (badge != null && badge > 0) Positioned(right: -4, top: -4, child: Container(padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1), decoration: BoxDecoration(color: Colors.red, borderRadius: BorderRadius.circular(9)), constraints: const BoxConstraints(minWidth: 16), child: Text('$badge', textAlign: TextAlign.center, style: const TextStyle(color: Colors.white, fontSize: 10)))),
            ]),
            const SizedBox(width: 12),
            Expanded(child: Text(label, style: TextStyle(color: t.text, fontSize: 15, fontWeight: FontWeight.w500))),
          ]),
        ),
      ),
    );
  }

  void _showFriendRequests() {
    final api = widget.api;
    showModalBottomSheet(context: context, builder: (ctx) => ValueListenableBuilder<int>(
      valueListenable: gFriendReqTick,
      builder: (_, __, ___) => SafeArea(child: gFriendReqs.isEmpty
        ? const Padding(padding: EdgeInsets.all(32), child: Center(child: Text('暂无好友申请', style: TextStyle(color: Colors.grey))))
        : ListView(shrinkWrap: true, children: [
            for (final e in gFriendReqs.entries)
              ListTile(
                leading: CircleAvatar(backgroundColor: _wechatGreen, child: Text(((e.value['nickname'] ?? e.value['username'] ?? '?') as String).isNotEmpty ? ((e.value['nickname'] ?? e.value['username'] ?? '?') as String)[0] : '?', style: const TextStyle(color: Colors.white))),
                title: Text((e.value['nickname'] ?? e.value['username'] ?? '').toString()),
                subtitle: Text('UID: ${(e.value['uid'] ?? '').toString()}'),
                trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                  TextButton(onPressed: () async {
                    try { await api.acceptFriend(e.key); } catch (_) {}
                    gFriendReqs.remove(e.key); gFriendReqTick.value++;
                    if (ctx.mounted) Navigator.pop(ctx);
                    if (mounted) { setState(() {}); ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已添加好友'))); }
                  }, child: const Text('接受', style: TextStyle(color: _wechatGreen))),
                  TextButton(onPressed: () async {
                    try { await api.rejectFriend(e.key); } catch (_) {}
                    gFriendReqs.remove(e.key); gFriendReqTick.value++;
                    if (mounted) setState(() {});
                  }, child: const Text('拒绝', style: TextStyle(color: Colors.red))),
                ]),
              ),
          ])),
    ));
  }

  void _showAddFriendDialog() {
    final uidC = TextEditingController();
    showDialog(context: context, builder: (ctx) => AlertDialog(
      title: const Text('添加朋友'),
      content: TextField(controller: uidC, autofocus: true, decoration: const InputDecoration(hintText: '输入对方 UID')),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
        FilledButton(onPressed: () async {
          final uid = uidC.text.trim();
          if (uid.isEmpty) return;
          Navigator.pop(ctx);
          try {
            await widget.api.addFriend(uid);
            if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('已向 $uid 发送好友申请')));
          } catch (e) {
            if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('申请失败：${e.toString().replaceFirst('Bad state: ', '')}')));
          }
        }, child: const Text('发送申请')),
      ],
    ));
  }

  Widget _contactSection(String title, List<Map<String, dynamic>> list, AppTheme t) {
    if (list.isEmpty) return const SliverToBoxAdapter(child: SizedBox.shrink());
    return SliverList(
      delegate: SliverChildBuilderDelegate((context, index) {
        if (index == 0) {
          return Container(
            margin: const EdgeInsets.only(top: 12, left: 16, right: 16),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            decoration: BoxDecoration(color: t.div, borderRadius: BorderRadius.circular(6)),
            child: Text(title, style: TextStyle(color: t.subText, fontSize: 12, fontWeight: FontWeight.w600)),
          );
        }
        if (index >= list.length + 1) return null;
        final item = list[index - 1];
        final name = item['name'] as String;
        final icon = item['icon'] as IconData;
        final online = item['online'] as bool?;
        return Material(
          color: Colors.transparent,
          child: InkWell(
            onTap: () {
              final cb = widget.onOpenChat;
              if (cb == null) return;
              final id = item['id'];
              if (id is int) cb(id, item['kind'] == 'group', item['name'] as String);
            },
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
              child: Row(children: [
                CircleAvatar(radius: 20, backgroundColor: t.primary.withValues(alpha: 0.14), child: Icon(icon, color: _wechatGreen, size: 20)),
                const SizedBox(width: 12),
                Expanded(child: Text(name, style: TextStyle(color: t.text, fontSize: 15, fontWeight: FontWeight.w500))),
                if (online == true) Container(width: 8, height: 8, decoration: const BoxDecoration(color: _wechatGreen, shape: BoxShape.circle)),
              ]),
            ),
          ),
        );
      }),
    );
  }
}

// ─── 底部导航 + 窗口拖拽条 ────────────────────────────────────────────────────

class _WindowDragBar extends StatelessWidget {
  const _WindowDragBar();

  void _action(Future<void> Function() fn) {
    try { fn(); } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final fg = isDark ? const Color(0xffc8d0d8) : const Color(0xff5b6670);
    final bg = isDark ? const Color(0x0a000000) : const Color(0x0affffff);
    Widget btn(IconData icon, Future<void> Function() act, {bool danger = false}) {
      return InkWell(
        onTap: () => _action(act),
        child: Container(width: 46, height: 40, alignment: Alignment.center, child: Icon(icon, size: 16, color: danger ? const Color(0xffe74c3c) : fg)),
      );
    }
    return Container(
      color: bg,
      height: 40,
      child: Column(children: [
        SizedBox(
          height: 40,
          child: Stack(children: [
            Positioned.fill(
              child: DragToMoveArea(
                child: Padding(
                  padding: const EdgeInsets.only(left: 10),
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: Row(children: [
                      const Icon(Icons.lock_outline, size: 15, color: _wechatGreen),
                      const SizedBox(width: 8),
                      Text('SecureChat', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: isDark ? Colors.white70 : Colors.black87)),
                    ]),
                  ),
                ),
              ),
            ),
            Positioned(right: 0, top: 0, bottom: 0, child: Row(children: [
              btn(Icons.remove_rounded, windowManager.minimize),
              btn(Icons.crop_square_rounded, () async {
                final m = await windowManager.isMaximized();
                if (m) { await windowManager.unmaximize(); } else { await windowManager.maximize(); }
              }),
              btn(Icons.close_rounded, windowManager.close, danger: true),
            ])),
          ]),
        ),
        const Divider(height: 1, thickness: 1),
      ]),
    );
  }
}

// ─── 忘记密码 Dialog ──────────────────────────────────────────────────────────

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
        setState(() { countdown--; if (countdown <= 0) t.cancel(); });
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
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('密码已重置，请使用新密码登录')));
      Navigator.pop(context, true);
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

// ─── 更新 Dialog ──────────────────────────────────────────────────────────────

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
    if (down.isEmpty) { setState(() => _msg = '安装包暂未发布，请稍后再试或前往官网下载。'); return; }
    setState(() { _downloading = true; _progress = 0; _msg = ''; });
    final path = await widget.service.download(down, onProgress: (loaded, total) {
      if (mounted) setState(() => _progress = total > 0 ? loaded / total : 0);
    });
    if (!mounted) return;
    setState(() { _downloading = false; _savedPath = path; });
    if (path == null) { setState(() => _msg = '下载失败，请检查网络后重试'); return; }
  }

  Future<void> _run() async {
    final p = _savedPath;
    if (p == null) return;
    final ok = await widget.service.launchInstaller(p);
    if (!mounted) return;
    if (ok) { Navigator.of(context).pop(); } else { setState(() => _msg = '无法自动启动安装程序，请手动打开：$p'); }
  }

  @override
  Widget build(BuildContext context) {
    final latest = (widget.info['latest'] ?? '').toString();
    final notes = (widget.info['releaseNotes'] ?? '').toString();
    return AlertDialog(
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
      title: const Row(children: [Icon(Icons.system_update_alt, color: _wechatGreen), SizedBox(width: 10), Text('发现新版本')]),
      content: SizedBox(
        width: 380,
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('当前：v$kAppVersion   最新：v$latest', style: const TextStyle(fontWeight: FontWeight.w700)),
          const SizedBox(height: 8),
          if (notes.isNotEmpty) Text(notes, style: const TextStyle(color: Color(0xff5b6670), height: 1.4)),
          const SizedBox(height: 14),
          if (_downloading) ...[
            LinearProgressIndicator(value: _progress.clamp(0, 1), color: _wechatGreen),
            const SizedBox(height: 6),
            Text('正在下载安装包… ${(_progress * 100).round()}%', style: const TextStyle(color: Color(0xff5b6670), fontSize: 12)),
          ] else if (_msg.isNotEmpty)
            Text(_msg, style: const TextStyle(color: Color(0xffc0392b), fontSize: 12)),
          if (_savedPath != null)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text('已下载：$_savedPath', maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(color: _wechatGreen, fontSize: 11)),
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
class _PulseIndicator extends StatefulWidget {
  const _PulseIndicator({this.color = Colors.red});
  final Color color;
  @override
  State<_PulseIndicator> createState() => _PulseIndicatorState();
}
class _PulseIndicatorState extends State<_PulseIndicator> with SingleTickerProviderStateMixin {
  late AnimationController _ctrl;
  @override
  void initState() {
    super.initState();
    _ctrl = AnimationController(vsync: this, duration: const Duration(milliseconds: 800))..repeat(reverse: true);
  }
  @override
  void dispose() { _ctrl.dispose(); super.dispose(); }
  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(animation: _ctrl, builder: (_, __) => Container(
      width: 8, height: 8,
      decoration: BoxDecoration(shape: BoxShape.circle, color: widget.color.withValues(alpha: 0.4 + _ctrl.value * 0.6)),
    ));
  }
}
