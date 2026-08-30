import 'dart:io';

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'device_manage_page.dart';
import 'feedback_page.dart';
import 'services/app_config.dart';
import 'services/securechat_api.dart';
import 'update_service.dart';
import 'widgets/app_scaffold.dart';
import 'main.dart';
import 'widgets/ux.dart';

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

  /// 隐私开关：保存到本机偏好并给出明确提示（服务端暂不支持这些设置）
  void _togglePrivacy(String label, String key, bool value) {
    setState(() {
      switch (key) {
        case _kPrivacyStealth:
          _demoStealth = value;
        case _kPrivacyAutoClear:
          _demoAutoClear = value;
        case _kPrivacyReadReceipt:
          _demoReadReceipt = value;
        case _kPrivacyDeviceLock:
          _demoDeviceLock = value;
      }
    });
    _savePrivacy(key, value);
    _toast(context, '$label已${value ? '开启' : '关闭'}（本机偏好，服务端暂不支持同步）');
  }

  Future<void> _changePassword(BuildContext context) async {
    final oldC = TextEditingController();
    final newC = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (dctx) => AlertDialog(
        title: const Text('修改密码'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: oldC, obscureText: true, decoration: const InputDecoration(labelText: '当前密码')),
          const SizedBox(height: 10),
          TextField(controller: newC, obscureText: true, decoration: const InputDecoration(labelText: '新密码（至少6位）')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(dctx, true), child: const Text('确认修改')),
        ],
      ),
    );
    oldC.dispose();
    newC.dispose();
    if (ok != true || !context.mounted) return;
    if (oldC.text.isEmpty || newC.text.length < 6) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('请填写当前密码且新密码至少6位')));
      return;
    }
    try {
      await widget.api.changePassword(oldC.text, newC.text);
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('密码已修改，请重新登录'), backgroundColor: Color(0xff07c160)));
      await widget.api.clearSession();
      if (context.mounted) {
        Navigator.of(context).pushAndRemoveUntil(MaterialPageRoute(builder: (_) => LoginPage(config: widget.config)), (r) => false);
      }
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('修改失败：${e.toString().replaceFirst('Bad state: ', '')}')));
      }
    }
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
              child: Column(
                children: [
                  PageHeader(title: '设置', config: config),
                  _tabBar(config, t),
                  Expanded(
                    child: TabBarView(
                      children: [
                        _appearance(config, t),
                        _chat(config, t),
                        _general(config, t),
                        _privacy(config, t),
                        _storage(config, t),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _tabBar(AppConfig config, AppTheme t) {
    return Container(
      color: t.card.withValues(alpha: 0.85),
      child: TabBar(
        isScrollable: true,
        labelColor: config.primary,
        indicatorColor: config.primary,
        unselectedLabelColor: t.subText,
        labelStyle: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
        tabs: const [
          Tab(text: '外观'),
          Tab(text: '聊天'),
          Tab(text: '通用'),
          Tab(text: '隐私'),
          Tab(text: '存储'),
        ],
      ),
    );
  }

  Widget _appearance(AppConfig config, AppTheme t) {
    return _list([
      SectionTitle(config: config, title: '主题风格'),
      SectionCard(
        config: config,
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
        children: [
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('界面模式', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: t.subText)),
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
          ),
        ],
      ),
      SectionTitle(config: config, title: '材质效果'),
      SectionCard(
        config: config,
        children: [
          for (final kind in WindowEffectKind.values)
            ListCell(
              config: config,
              icon: _effectIcon(kind),
              title: kind.label,
              showArrow: false,
              trailing: Icon(
                config.effect == kind ? Icons.check_circle : Icons.radio_button_unchecked,
                color: config.effect == kind ? config.primary : t.subText,
                size: 20,
              ),
              onTap: () => config.setEffect(kind),
            ),
        ],
      ),
      SectionTitle(config: config, title: '主题色'),
      SectionCard(
        config: config,
        padding: const EdgeInsets.all(14),
        children: [
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('选择主题色', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: t.subText)),
              const SizedBox(height: 12),
              Wrap(
                spacing: 12,
                runSpacing: 12,
                children: [
                  for (final color in AppConfig.presetColors)
                    GestureDetector(
                      onTap: () => config.setPrimary(color),
                      child: AnimatedContainer(
                        duration: Ux.fast,
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
          ),
        ],
      ),
      SectionTitle(config: config, title: '字号'),
      SectionCard(
        config: config,
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
        children: [
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
                Text('界面字号', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: t.subText)),
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
              const SizedBox(height: 4),
              Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
                Text('30%', style: TextStyle(fontSize: 11, color: t.subText)),
                Text('100%', style: TextStyle(fontSize: 11, color: t.subText)),
                Text('150%', style: TextStyle(fontSize: 11, color: t.subText)),
              ]),
            ],
          ),
        ],
      ),
      SectionTitle(config: config, title: '背景'),
      SectionCard(
        config: config,
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
        children: [
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('背景类型', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: t.subText)),
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
              Text('背景颜色', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: t.subText)),
              const SizedBox(height: 12),
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
                        duration: Ux.fast,
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
              const SizedBox(height: 16),
              ListCell(
                config: config,
                icon: Icons.tonality,
                title: '面板模糊',
                subtitle: '为面板叠加柔和模糊质感',
                showArrow: false,
                trailing: Switch(
                  value: config.blurPanel,
                  onChanged: (v) => config.setBlurPanel(v),
                  activeThumbColor: config.primary,
                ),
              ),
            ],
          ),
        ],
      ),
    ]);
  }

  IconData _effectIcon(WindowEffectKind kind) {
    switch (kind) {
      case WindowEffectKind.none:
        return Icons.block_outlined;
      case WindowEffectKind.mica:
        return Icons.grid_view_outlined;
      case WindowEffectKind.acrylic:
        return Icons.blur_on_outlined;
      case WindowEffectKind.blur:
        return Icons.blur_linear_outlined;
      case WindowEffectKind.smoke:
        return Icons.air_outlined;
      case WindowEffectKind.metallic:
        return Icons.view_week_outlined;
      case WindowEffectKind.frosted:
        return Icons.ac_unit_outlined;
      case WindowEffectKind.etched:
        return Icons.grain_outlined;
      case WindowEffectKind.shadow:
        return Icons.layers_outlined;
    }
  }

  Widget _chat(AppConfig config, AppTheme t) {
    return _list([
      SectionTitle(config: config, title: '气泡样式'),
      SectionCard(
        config: config,
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
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
      ),
      SectionTitle(config: config, title: '消息行为'),
      SectionCard(
        config: config,
        children: [
          ListCell(
            config: config,
            icon: Icons.keyboard_return_outlined,
            title: 'Enter 发送',
            subtitle: '开启后回车直接发送消息',
            showArrow: false,
            trailing: Switch(value: config.enterSend, onChanged: (v) => config.setEnterSend(v), activeThumbColor: config.primary),
          ),
          CellDivider(config: config),
          ListCell(
            config: config,
            icon: Icons.view_compact_outlined,
            title: '紧凑模式',
            subtitle: '减少气泡与间距，显示更多内容',
            showArrow: false,
            trailing: Switch(value: config.dense, onChanged: (v) => config.setDense(v), activeThumbColor: config.primary),
          ),
          CellDivider(config: config),
          ListCell(
            config: config,
            icon: Icons.schedule_outlined,
            title: '显示时间',
            showArrow: false,
            trailing: Switch(value: config.showTimestamp, onChanged: (v) => config.setShowTimestamp(v), activeThumbColor: config.primary),
          ),
          CellDivider(config: config),
          ListCell(
            config: config,
            icon: Icons.badge_outlined,
            title: '显示昵称与在线状态',
            showArrow: false,
            trailing: Switch(value: config.showStatusbar, onChanged: (v) => config.setShowStatusbar(v), activeThumbColor: config.primary),
          ),
        ],
      ),
    ]);
  }

  Widget _general(AppConfig config, AppTheme t) {
    return _list([
      SectionTitle(config: config, title: '体验'),
      SectionCard(
        config: config,
        children: [
          ListCell(
            config: config,
            icon: Icons.vibration_outlined,
            title: '回声反馈',
            subtitle: '按键时提供触觉反馈',
            showArrow: false,
            trailing: Switch(value: config.haptic, onChanged: (v) => config.setHaptic(v), activeThumbColor: config.primary),
          ),
          CellDivider(config: config),
          ListCell(
            config: config,
            icon: Icons.palette_outlined,
            title: '彩色文字',
            subtitle: '在界面中强调展示彩虹配色',
            showArrow: false,
            trailing: Switch(value: config.accentText, onChanged: (v) => config.setAccentText(v), activeThumbColor: config.primary),
          ),
        ],
      ),
      SectionTitle(config: config, title: '帮助与反馈'),
      SectionCard(
        config: config,
        children: [
          ListCell(
            config: config,
            icon: Icons.rate_review_outlined,
            title: '意见反馈',
            subtitle: '提交问题、建议或投诉，我们会跟进处理',
            onTap: () => _openFeedback(0),
          ),
          CellDivider(config: config),
          ListCell(
            config: config,
            icon: Icons.inbox_outlined,
            title: '我的反馈',
            subtitle: '查看已提交反馈的处理状态',
            onTap: () => _openFeedback(1),
          ),
        ],
      ),
      SectionTitle(config: config, title: '账号与安全'),
      SectionCard(
        config: config,
        children: [
          ListCell(
            config: config,
            icon: Icons.lock_outline,
            title: '修改密码',
            subtitle: '定期修改密码更安全',
            onTap: () => _changePassword(context),
          ),
          CellDivider(config: config),
          ListCell(
            config: config,
            icon: Icons.devices_outlined,
            title: '登录设备管理',
            subtitle: '查看并移除已登录设备',
            onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => DeviceManagePage(api: widget.api, config: config))),
          ),
        ],
      ),
      SectionTitle(config: config, title: '关于'),
      SectionCard(
        config: config,
        children: [
          ListCell(
            config: config,
            icon: Icons.campaign_outlined,
            title: '系统公告',
            subtitle: '查看服务端发布的公告与维护通知',
            onTap: _openAnnouncements,
          ),
          CellDivider(config: config),
          ListCell(
            config: config,
            icon: Icons.system_update_alt_outlined,
            title: '检查更新',
            onTap: () => _checkUpdate(context),
          ),
          CellDivider(config: config),
          ListCell(
            config: config,
            icon: Icons.info_outline,
            title: '版本',
            showArrow: false,
            trailing: Text(kAppVersion, style: TextStyle(color: t.subText)),
          ),
        ],
      ),
      SectionTitle(config: config, title: '账户'),
      SectionCard(
        config: config,
        children: [
          ListCell(
            config: config,
            icon: Icons.logout,
            iconColor: const Color(0xffe0533d),
            title: '退出登录',
            onTap: () async {
              final sure = await showDialog<bool>(
                context: context,
                builder: (dctx) => AlertDialog(
                  title: const Text('退出登录'),
                  content: const Text('退出后需要重新输入账号密码登录，确定退出？'),
                  actions: [
                    TextButton(onPressed: () => Navigator.pop(dctx, false), child: const Text('取消')),
                    FilledButton(onPressed: () => Navigator.pop(dctx, true), child: const Text('退出', style: TextStyle(color: Color(0xffe0533d)))),
                  ],
                ),
              );
              if (sure != true || !mounted) return;
              await widget.api.clearSession();
              if (!mounted) return;
              Navigator.of(context).pushAndRemoveUntil(
                MaterialPageRoute(builder: (_) => LoginPage(config: config)),
                (route) => false,
              );
            },
          ),
        ],
      ),
    ]);
  }

  Widget _privacy(AppConfig config, AppTheme t) {
    return _list([
      SectionTitle(config: config, title: '隐私保护'),
      SectionCard(
        config: config,
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
        children: [
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(children: [
                Icon(Icons.lock_outline, color: config.primary),
                const SizedBox(width: 10),
                Expanded(child: Text('端到端加密', style: TextStyle(color: t.text, fontWeight: FontWeight.w700))),
              ]),
              const SizedBox(height: 8),
              Text('你的聊天内容仅由你和对方持有密钥，服务端无法读取。', style: TextStyle(color: t.subText, fontSize: 13)),
              const SizedBox(height: 8),
              Divider(height: 1, color: t.div),
              const SizedBox(height: 8),
              Text('· 每条消息独立会话密钥\n· 不使用端到端加密即拒绝发送\n· 加密状态可在会话中随时查看', style: TextStyle(color: t.subText, fontSize: 13)),
              const SizedBox(height: 12),
              Padding(
                padding: const EdgeInsets.only(top: 4, bottom: 8),
                child: Text('以下为本地偏好：仅保存于本设备，服务端暂不支持同步。', style: TextStyle(color: t.subText, fontSize: 12)),
              ),
              ListCell(
                config: config,
                icon: Icons.visibility_off_outlined,
                title: '隐身模式',
                subtitle: '本机偏好，仅本设备生效',
                showArrow: false,
                trailing: Switch(
                  value: _demoStealth,
                  onChanged: (v) => _togglePrivacy('隐身模式', _kPrivacyStealth, v),
                  activeThumbColor: config.primary,
                ),
              ),
              ListCell(
                config: config,
                icon: Icons.delete_sweep_outlined,
                title: '自动清除消息',
                subtitle: '本机偏好，仅本设备生效',
                showArrow: false,
                trailing: Switch(
                  value: _demoAutoClear,
                  onChanged: (v) => _togglePrivacy('自动清除消息', _kPrivacyAutoClear, v),
                  activeThumbColor: config.primary,
                ),
              ),
            ],
          ),
        ],
      ),
      SectionTitle(config: config, title: '设备与回执'),
      SectionCard(
        config: config,
        children: [
          ListCell(
            config: config,
            icon: Icons.done_all_outlined,
            title: '已读回执',
            subtitle: '本机偏好，仅本设备生效',
            showArrow: false,
            trailing: Switch(
              value: _demoReadReceipt,
              onChanged: (v) => _togglePrivacy('已读回执', _kPrivacyReadReceipt, v),
              activeThumbColor: config.primary,
            ),
          ),
          CellDivider(config: config),
          ListCell(
            config: config,
            icon: Icons.phonelink_lock_outlined,
            title: '登录设备锁定',
            subtitle: '本机偏好，仅本设备生效',
            showArrow: false,
            trailing: Switch(
              value: _demoDeviceLock,
              onChanged: (v) => _togglePrivacy('登录设备锁定', _kPrivacyDeviceLock, v),
              activeThumbColor: config.primary,
            ),
          ),
        ],
      ),
    ]);
  }

  Widget _storage(AppConfig config, AppTheme t) {
    return _list([
      SectionTitle(config: config, title: '存储占用'),
      SectionCard(
        config: config,
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 16),
        children: [
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(children: [
                Icon(Icons.folder_open_outlined, color: t.text),
                const SizedBox(width: 10),
                Text('当前缓存大小', style: TextStyle(color: t.text, fontWeight: FontWeight.w700)),
              ]),
              const SizedBox(height: 8),
              Text('约 $_cacheSizeText（$_cacheFileCount 个文件）', style: TextStyle(fontSize: 28, fontWeight: FontWeight.w800, color: t.text)),
              const SizedBox(height: 8),
              Text('包含语音缓存等临时文件（位于系统临时目录 securechat-voice-*）。', style: TextStyle(color: t.subText, fontSize: 13)),
              const SizedBox(height: 16),
              ListCell(
                config: config,
                icon: Icons.cleaning_services_outlined,
                title: '清除缓存',
                onTap: _clearCache,
                trailing: _clearInfo != null
                    ? Row(mainAxisSize: MainAxisSize.min, children: [
                        Text(_clearInfo!, style: TextStyle(fontSize: 11, color: t.subText)),
                        const SizedBox(width: 6),
                        Icon(Icons.check_circle, color: config.primary, size: 18),
                      ])
                    : null,
              ),
            ],
          ),
        ],
      ),
    ]);
  }

  Widget _list(List<Widget> children) {
    return ListView(
      padding: const EdgeInsets.only(top: 4, bottom: 40),
      children: children,
    );
  }

  void _toast(BuildContext context, String message) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
  }

  void _openFeedback(int tab) {
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => FeedbackPage(config: widget.config, api: widget.api, initialTab: tab),
    ));
  }

  void _openAnnouncements() {
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => AnnouncementsPage(config: widget.config, api: widget.api),
    ));
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
