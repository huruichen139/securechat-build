import 'dart:io';

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'services/app_config.dart';
import 'services/securechat_api.dart';
import 'update_service.dart';
import 'widgets/app_scaffold.dart';

class SettingsPage extends StatefulWidget {
  const SettingsPage({super.key, required this.config, required this.api});

  final AppConfig config;
  final SecureChatApi api;

  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  int _bgColorIndex = 0;
  bool _demoStealth = false;
  bool _demoAutoClear = false;
  bool _demoReadReceipt = false;
  bool _demoDeviceLock = false;
  String? _clearInfo;
  String _cacheSizeText = '计算中…';
  int _cacheFileCount = 0;

  static const _kPrivacyStealth = 'privacy_stealth';
  static const _kPrivacyAutoClear = 'privacy_autoclear';
  static const _kPrivacyReadReceipt = 'privacy_read_receipt';
  static const _kPrivacyDeviceLock = 'privacy_device_lock';

  static const List<Color> _bgColors = [
    Color(0xff2c3e50),
    Color(0xff1e293b),
    Color(0xff4c1d95),
    Color(0xff065f46),
    Color(0xff7f1d1d),
    Color(0xff0e7490),
  ];

  @override
  void initState() {
    super.initState();
    _loadPrefs();
    _scanCache();
  }

  Future<void> _loadPrefs() async {
    final sp = await SharedPreferences.getInstance();
    if (mounted) {
      setState(() {
        _demoStealth = sp.getBool(_kPrivacyStealth) ?? false;
        _demoAutoClear = sp.getBool(_kPrivacyAutoClear) ?? false;
        _demoReadReceipt = sp.getBool(_kPrivacyReadReceipt) ?? false;
        _demoDeviceLock = sp.getBool(_kPrivacyDeviceLock) ?? false;
      });
    }
  }

  Future<void> _savePrivacy(String key, bool value) async {
    final sp = await SharedPreferences.getInstance();
    await sp.setBool(key, value);
  }

  Future<void> _scanCache() async {
    int total = 0;
    int count = 0;
    try {
      final tmp = await Directory.systemTemp.create();
      await for (final entry in tmp.list(recursive: false, followLinks: false)) {
        final name = entry.path.split(Platform.pathSeparator).last;
        if (name.startsWith('securechat-voice-')) {
          try {
            if (entry is File) {
              total += await entry.length();
              count++;
            } else if (entry is Directory) {
              await for (final sub in entry.list(recursive: true, followLinks: false)) {
                if (sub is File) {
                  total += await sub.length();
                  count++;
                }
              }
            }
          } catch (_) {}
        }
      }
    } catch (_) {}
    if (mounted) {
      setState(() {
        _cacheFileCount = count;
        _cacheSizeText = _fmtSize(total);
      });
    }
  }

  String _fmtSize(int bytes) {
    if (bytes < 1024) return '$bytes B';
    if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
    if (bytes < 1024 * 1024 * 1024) return '${(bytes / 1024 / 1024).toStringAsFixed(1)} MB';
    return '${(bytes / 1024 / 1024 / 1024).toStringAsFixed(1)} GB';
  }

  Future<void> _clearCache() async {
    int deleted = 0;
    try {
      final tmp = await Directory.systemTemp.create();
      await for (final entry in tmp.list(recursive: false, followLinks: false)) {
        final name = entry.path.split(Platform.pathSeparator).last;
        if (name.startsWith('securechat-voice-')) {
          try {
            if (entry is File) {
              await entry.delete();
              deleted++;
            } else if (entry is Directory) {
              await entry.delete(recursive: true);
              deleted++;
            }
          } catch (_) {}
        }
      }
    } catch (_) {}
    await _scanCache();
    if (mounted) {
      setState(() => _clearInfo = '已清除 $deleted 个缓存文件');
      _toast(context, '已清除 $deleted 个缓存文件');
    }
  }

  @override
  Widget build(BuildContext context) {
    final config = widget.config;
    return AnimatedBuilder(
      animation: config,
      builder: (context, _) {
        final t = config.theme;
        return AppScaffold(
          config: config,
          body: SafeArea(
            child: DefaultTabController(
              length: 5,
              child: Scaffold(
                backgroundColor: Colors.transparent,
                appBar: AppBar(
                  backgroundColor: Colors.transparent,
                  title: const Text('设置'),
                  leading: const CloseButton(),
                  bottom: TabBar(
                    isScrollable: true,
                    labelColor: config.primary,
                    indicatorColor: config.primary,
                    tabs: const [
                      Tab(text: '外观'),
                      Tab(text: '聊天'),
                      Tab(text: '通用'),
                      Tab(text: '隐私'),
                      Tab(text: '存储'),
                    ],
                  ),
                ),
                body: TabBarView(
                  children: [
                    _appearance(config, t),
                    _chat(config, t),
                    _general(config, t),
                    _privacy(t),
                    _storage(t),
                  ],
                ),
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _appearance(AppConfig config, AppTheme t) {
    return _list(t, [
      _sectionTitle(t, '主题风格'),
      _card(t, child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _label(t, '界面模式'),
          const SizedBox(height: 10),
          SegmentedButton<ThemeModeEx>(
            segments: const [
              ButtonSegment(value: ThemeModeEx.light, label: Text('亮色'), icon: Icon(Icons.light_mode_outlined)),
              ButtonSegment(value: ThemeModeEx.dark, label: Text('暗色'), icon: Icon(Icons.dark_mode_outlined)),
              ButtonSegment(value: ThemeModeEx.glass, label: Text('玻璃'), icon: Icon(Icons.blur_on_outlined)),
            ],
            selected: {config.mode},
            onSelectionChanged: (s) => config.setMode(s.first),
          ),
        ],
      )),
      _sectionTitle(t, '材质效果'),
      _card(t, child: Column(
        children: [for (final kind in WindowEffectKind.values) _effectRadio(config, kind, t)],
      )),
      _sectionTitle(t, '主题色'),
      _card(t, child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _label(t, '选择主题色'),
          const SizedBox(height: 10),
          Wrap(
            spacing: 12,
            runSpacing: 12,
            children: [
              for (final color in AppConfig.presetColors)
                GestureDetector(
                  onTap: () => config.setPrimary(color),
                  child: AnimatedContainer(
                    duration: const Duration(milliseconds: 180),
                    width: 34,
                    height: 34,
                    decoration: BoxDecoration(
                      color: color,
                      shape: BoxShape.circle,
                      border: Border.all(
                        color: config.primary.toARGB32() == color.toARGB32() ? t.text : Colors.transparent,
                        width: 2.5,
                      ),
                    ),
                    child: config.primary.toARGB32() == color.toARGB32()
                        ? Icon(Icons.check, color: color.computeLuminance() > 0.5 ? Colors.black : Colors.white, size: 18)
                        : null,
                  ),
                ),
            ],
          ),
        ],
      )),
      _sectionTitle(t, '字号'),
      _card(t, child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
            _label(t, '界面字号'),
            Text('${(config.fontScale * 100).round()}%', style: TextStyle(color: config.primary, fontWeight: FontWeight.w700)),
          ]),
          Slider(
            value: config.fontScale,
            min: 0.3,
            max: 1.5,
            divisions: 24,
            label: '${(config.fontScale * 100).round()}%',
            onChanged: (v) => config.setFontScale((v * 10).round() / 10),
          ),
          const SizedBox(height: 8),
          Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
            Text('30%', style: TextStyle(fontSize: 11, color: config.theme.subText)),
            Text('100%', style: TextStyle(fontSize: 11, color: config.theme.subText)),
            Text('150%', style: TextStyle(fontSize: 11, color: config.theme.subText)),
          ]),
        ],
      )),
      _sectionTitle(t, '背景'),
      _card(t, child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _label(t, '背景类型'),
          const SizedBox(height: 10),
          SegmentedButton<int>(
            segments: const [
              ButtonSegment(value: 0, label: Text('纯色'), icon: Icon(Icons.format_color_fill_outlined)),
              ButtonSegment(value: 1, label: Text('渐变'), icon: Icon(Icons.gradient_outlined)),
            ],
            selected: {config.bgKind},
            onSelectionChanged: (s) => config.setBgKind(s.first),
          ),
          const SizedBox(height: 20),
          _label(t, '背景颜色'),
          const SizedBox(height: 10),
          Wrap(
            spacing: 12,
            runSpacing: 12,
            children: [
              for (var i = 0; i < _bgColors.length; i++)
                GestureDetector(
                  onTap: () {
                    setState(() => _bgColorIndex = i);
                    config.setBgColor(_bgColors[i]);
                  },
                  child: AnimatedContainer(
                    duration: const Duration(milliseconds: 180),
                    width: 34,
                    height: 34,
                    decoration: BoxDecoration(
                      color: _bgColors[i],
                      shape: BoxShape.circle,
                      border: Border.all(color: _bgColorIndex == i ? t.text : Colors.transparent, width: 2.5),
                    ),
                    child: _bgColorIndex == i ? const Icon(Icons.check, color: Colors.white, size: 18) : null,
                  ),
                ),
            ],
          ),
          const SizedBox(height: 20),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('面板模糊'),
            subtitle: const Text('为面板叠加柔和模糊质感'),
            secondary: const Icon(Icons.tonality),
            value: config.blurPanel,
            onChanged: (v) => config.setBlurPanel(v),
          ),
        ],
      )),
    ]);
  }

  Widget _effectRadio(AppConfig config, WindowEffectKind kind, AppTheme t) {
    final selected = config.effect == kind;
    return ListTile(
      dense: true,
      contentPadding: EdgeInsets.zero,
      leading: Icon(
        selected ? Icons.check_circle : Icons.radio_button_unchecked,
        color: selected ? config.primary : t.subText,
      ),
      title: Text(kind.label),
      onTap: () => config.setEffect(kind),
    );
  }

  Widget _chat(AppConfig config, AppTheme t) {
    return _list(t, [
      _sectionTitle(t, '气泡样式'),
      _card(t, child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SegmentedButton<BubbleStyle>(
            segments: const [
              ButtonSegment(value: BubbleStyle.round, label: Text('圆角'), icon: Icon(Icons.sentiment_satisfied_alt)),
              ButtonSegment(value: BubbleStyle.soft, label: Text('柔和'), icon: Icon(Icons.blur_circular)),
              ButtonSegment(value: BubbleStyle.sharp, label: Text('直角'), icon: Icon(Icons.square_outlined)),
            ],
            selected: {config.bubbleStyle},
            onSelectionChanged: (s) => config.setBubbleStyle(s.first),
            showSelectedIcon: false,
          ),
        ],
      )),
      _sectionTitle(t, '消息行为'),
      _card(t, child: Column(
        children: [
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('Enter 发送'),
            subtitle: const Text('开启后回车直接发送消息'),
            secondary: const Icon(Icons.keyboard_return_outlined),
            value: config.enterSend,
            onChanged: (v) => config.setEnterSend(v),
          ),
          const Divider(height: 1),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('紧凑模式'),
            subtitle: const Text('减少气泡与间距，显示更多内容'),
            secondary: const Icon(Icons.view_compact_outlined),
            value: config.dense,
            onChanged: (v) => config.setDense(v),
          ),
          const Divider(height: 1),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('显示时间'),
            secondary: const Icon(Icons.schedule_outlined),
            value: config.showTimestamp,
            onChanged: (v) => config.setShowTimestamp(v),
          ),
          const Divider(height: 1),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('显示昵称与在线状态'),
            secondary: const Icon(Icons.badge_outlined),
            value: config.showStatusbar,
            onChanged: (v) => config.setShowStatusbar(v),
          ),
        ],
      )),
    ]);
  }

  Widget _general(AppConfig config, AppTheme t) {
    return _list(t, [
      _sectionTitle(t, '体验'),
      _card(t, child: Column(
        children: [
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('回声反馈'),
            subtitle: const Text('按键时提供触觉反馈'),
            secondary: const Icon(Icons.vibration_outlined),
            value: config.haptic,
            onChanged: (v) => config.setHaptic(v),
          ),
          const Divider(height: 1),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('彩色文字'),
            subtitle: const Text('在界面中强调展示彩虹配色'),
            secondary: const Icon(Icons.palette_outlined),
            value: config.accentText,
            onChanged: (v) => config.setAccentText(v),
          ),
        ],
      )),
      _sectionTitle(t, '帮助'),
      _card(t, child: Column(
        children: [
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.help_outline),
            title: const Text('帮助中心'),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => _toast(context, '帮助中心即将上线，可反馈至 admin 邮箱'),
          ),
          const Divider(height: 1),
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.rate_review_outlined),
            title: const Text('给 SecureChat 评分'),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => _toast(context, '感谢支持'),
          ),
        ],
      )),
      _sectionTitle(t, '关于'),
      _card(t, child: Column(
        children: [
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.system_update_alt_outlined),
            title: const Text('检查更新'),
            onTap: () => _checkUpdate(context),
          ),
          const Divider(height: 1),
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.info_outline),
            title: const Text('版本'),
            trailing: Text(kAppVersion, style: TextStyle(color: t.subText)),
          ),
        ],
      )),
    ]);
  }

  Widget _privacy(AppTheme t) {
    return _list(t, [
      _sectionTitle(t, '隐私保护'),
      _card(t, child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(children: [Icon(Icons.lock_outline, color: widget.config.primary), const SizedBox(width: 10), Expanded(child: Text('端到端加密', style: TextStyle(color: t.text, fontWeight: FontWeight.w700)))]),
          const SizedBox(height: 8),
          Text('你的聊天内容仅由你和对方持有密钥，服务端无法读取。', style: TextStyle(color: t.subText)),
          const SizedBox(height: 8),
          Divider(height: 1, color: t.div),
          const SizedBox(height: 8),
          Text('· 每条消息独立会话密钥\n· 不使用端到端加密即拒绝发送\n· 加密状态可在会话中随时查看', style: TextStyle(color: t.subText)),
          const SizedBox(height: 16),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('隐身模式'),
            subtitle: const Text('隐藏在线状态与已读回执'),
            secondary: const Icon(Icons.visibility_off_outlined),
            value: _demoStealth,
            onChanged: (v) {
              setState(() => _demoStealth = v);
              _savePrivacy(_kPrivacyStealth, v);
            },
          ),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('自动清除消息'),
            subtitle: const Text('离开会话后自动删除本地副本'),
            secondary: const Icon(Icons.delete_sweep_outlined),
            value: _demoAutoClear,
            onChanged: (v) {
              setState(() => _demoAutoClear = v);
              _savePrivacy(_kPrivacyAutoClear, v);
            },
          ),
        ],
      )),
      _sectionTitle(t, '设备与回执'),
      _card(t, child: Column(
        children: [
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('已读回执'),
            subtitle: const Text('展示消息已被对方读取'),
            secondary: const Icon(Icons.done_all_outlined),
            value: _demoReadReceipt,
            onChanged: (v) {
              setState(() => _demoReadReceipt = v);
              _savePrivacy(_kPrivacyReadReceipt, v);
            },
          ),
          const Divider(height: 1),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('登录设备锁定'),
            subtitle: const Text('新设备登录需再次验证'),
            secondary: const Icon(Icons.phonelink_lock_outlined),
            value: _demoDeviceLock,
            onChanged: (v) {
              setState(() => _demoDeviceLock = v);
              _savePrivacy(_kPrivacyDeviceLock, v);
            },
          ),
        ],
      )),
    ]);
  }

  Widget _storage(AppTheme t) {
    return _list(t, [
      _sectionTitle(t, '存储占用'),
      _card(t, child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(children: [Icon(Icons.folder_open_outlined, color: t.text), const SizedBox(width: 10), Text('当前缓存大小', style: TextStyle(color: t.text, fontWeight: FontWeight.w700))]),
          const SizedBox(height: 8),
          Text('约 $_cacheSizeText（$_cacheFileCount 个文件）', style: TextStyle(fontSize: 28, fontWeight: FontWeight.w800, color: t.text)),
          const SizedBox(height: 8),
          Text('包含语音缓存等临时文件（位于系统临时目录 securechat-voice-*）。', style: TextStyle(color: t.subText)),
          const Divider(height: 28),
          Row(children: [
            Expanded(
              child: ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.cleaning_services_outlined),
                title: const Text('清除缓存'),
                onTap: _clearCache,
              ),
            ),
            if (_clearInfo != null)
              Padding(padding: const EdgeInsets.only(right: 8), child: Icon(Icons.check_circle, color: widget.config.primary)),
          ]),
        ],
      )),
    ]);
  }

  Widget _list(AppTheme t, List<Widget> children) {
    return ListView(
      padding: const EdgeInsets.fromLTRB(20, 20, 20, 40),
      children: children,
    );
  }

  Widget _sectionTitle(AppTheme t, String title) => Padding(
        padding: const EdgeInsets.fromLTRB(4, 16, 0, 10),
        child: Text(title, style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: widget.config.primary, letterSpacing: 0.5)),
      );

  Widget _card(AppTheme t, {required Widget child}) {
    return Container(
      margin: const EdgeInsets.only(bottom: 16),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      decoration: BoxDecoration(
        color: t.card.withValues(alpha: 0.82),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: t.div.withValues(alpha: 0.5)),
        boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: t.isDark ? 0.2 : 0.05), blurRadius: 12, offset: const Offset(0, 4))],
      ),
      child: child,
    );
  }

  Widget _label(AppTheme t, String text) => Text(text, style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: t.subText));

  void _toast(BuildContext context, String message) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> _checkUpdate(BuildContext context) async {
    final svc = UpdateService(api: widget.api);
    final info = await svc.check();
    if (!mounted) return;
    if (info == null) {
      _toast(this.context, '已是最新版本（v$kAppVersion）');
      return;
    }
    if (!mounted) return;
    showDialog(context: this.context, builder: (_) => _SimpleUpdateDialog(info: info, service: svc));
  }
}

class _SimpleUpdateDialog extends StatefulWidget {
  const _SimpleUpdateDialog({required this.info, required this.service});
  final Map<String, dynamic> info;
  final UpdateService service;
  @override
  State<_SimpleUpdateDialog> createState() => _SimpleUpdateDialogState();
}

class _SimpleUpdateDialogState extends State<_SimpleUpdateDialog> {
  bool _downloading = false;
  double _progress = 0;
  String _msg = '';
  String? _savedPath;

  Future<void> _start() async {
    final down = (widget.info['download'] ?? '').toString();
    if (down.isEmpty) {
      setState(() => _msg = '安装包暂未发布，请稍后再试。');
      return;
    }
    setState(() {
      _downloading = true;
      _progress = 0;
    });
    final path = await widget.service.download(down, onProgress: (l, t) {
      if (mounted) setState(() => _progress = t > 0 ? l / t : 0);
    });
    if (!mounted) return;
    setState(() {
      _downloading = false;
      _savedPath = path;
    });
    if (path == null) setState(() => _msg = '下载失败，请检查网络后重试');
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
    final t = Theme.of(context).colorScheme;
    return AlertDialog(
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
      title: const Text('发现新版本'),
      content: SizedBox(
        width: 360,
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('当前 v$kAppVersion → 最新 v${widget.info['latest']}', style: const TextStyle(fontWeight: FontWeight.w700)),
          const SizedBox(height: 8),
          Text((widget.info['releaseNotes'] ?? '').toString(), style: TextStyle(color: t.onSurfaceVariant)),
          const SizedBox(height: 12),
          if (_downloading) ...[
            LinearProgressIndicator(value: _progress.clamp(0, 1), color: t.primary),
            const SizedBox(height: 6),
            Text('下载中 ${(_progress * 100).round()}%', style: TextStyle(color: t.onSurfaceVariant, fontSize: 12)),
          ] else if (_msg.isNotEmpty)
            Text(_msg, style: const TextStyle(color: Color(0xffc0392b), fontSize: 12)),
          if (_savedPath != null)
            Padding(padding: const EdgeInsets.only(top: 4), child: Text('已保存：$_savedPath', maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.primary, fontSize: 11))),
        ]),
      ),
      actions: [
        TextButton(onPressed: _downloading ? null : () => Navigator.of(context).pop(), child: const Text('关闭')),
        if (_savedPath != null)
          FilledButton(onPressed: _run, child: const Text('立即安装'))
        else
          FilledButton(onPressed: _downloading ? null : _start, child: Text(_downloading ? '下载中…' : '下载并更新')),
      ],
    );
  }
}
