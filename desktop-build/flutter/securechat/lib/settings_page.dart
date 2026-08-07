import 'package:flutter/material.dart';

import 'services/app_config.dart';
import 'services/securechat_api.dart';
import 'update_service.dart';
import 'widgets/window_effect.dart';

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

  static const List<Color> _bgColors = [
    Color(0xff2c3e50),
    Color(0xff1e293b),
    Color(0xff4c1d95),
    Color(0xff065f46),
    Color(0xff7f1d1d),
    Color(0xff0e7490),
  ];

  @override
  Widget build(BuildContext context) {
    final config = widget.config;
    return AnimatedBuilder(
      animation: config,
      builder: (context, _) {
        return DefaultTabController(
          length: 5,
          child: Scaffold(
            appBar: AppBar(
              title: const Text('设置'),
              leading: const CloseButton(),
              bottom: TabBar(
                isScrollable: true,
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
                _appearance(config),
                _chat(config),
                _general(config),
                _privacy(),
                _storage(),
              ],
            ),
          ),
        );
      },
    );
  }

  Widget _appearance(AppConfig config) {
    final theme = config.theme;
    return _list([
      _sectionTitle('主题风格'),
      _card(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _label('界面模式'),
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
      ),
      _sectionTitle('材质效果'),
      _card(
        child: Column(
          children: [
            for (final kind in WindowEffectKind.values) _effectRadio(config, kind),
          ],
        ),
      ),
      _sectionTitle('主题色'),
      _card(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _label('选择主题色'),
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
                          color: config.primary.toARGB32() == color.toARGB32() ? theme.text : Colors.transparent,
                          width: 2.5,
                        ),
                      ),
                      child: config.primary.toARGB32() == color.toARGB32()
                          ? Icon(
                              Icons.check,
                              color: color.computeLuminance() > 0.5 ? Colors.black : Colors.white,
                              size: 18,
                            )
                          : null,
                    ),
                  ),
              ],
            ),
          ],
        ),
      ),
      _sectionTitle('字号'),
      _card(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                _label('界面字号'),
                Text(
                  '${(config.fontScale * 100).round()}%',
                  style: TextStyle(color: theme.primary, fontWeight: FontWeight.w700),
                ),
              ],
            ),
            Slider(
              value: config.fontScale,
              min: 0.8,
              max: 1.4,
              divisions: 6,
              label: '${(config.fontScale * 100).round()}%',
              onChanged: (v) => config.setFontScale((v * 10).round() / 10),
            ),
          ],
        ),
      ),
      _sectionTitle('背景'),
      _card(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _label('背景类型'),
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
            _label('背景颜色'),
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
                        border: Border.all(
                          color: _bgColorIndex == i ? theme.text : Colors.transparent,
                          width: 2.5,
                        ),
                      ),
                      child: _bgColorIndex == i
                          ? const Icon(Icons.check, color: Colors.white, size: 18)
                          : null,
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
        ),
      ),
    ]);
  }

  Widget _effectRadio(AppConfig config, WindowEffectKind kind) {
    final selected = config.effect == kind;
    return ListTile(
      dense: true,
      contentPadding: EdgeInsets.zero,
      leading: Icon(
        selected ? Icons.check_circle : Icons.radio_button_unchecked,
        color: selected ? Theme.of(context).colorScheme.primary : Theme.of(context).colorScheme.onSurfaceVariant,
      ),
      title: Text(kind.label),
      onTap: () => config.setEffect(kind),
    );
  }

  Widget _chat(AppConfig config) {
    return _list([
      _sectionTitle('气泡样式'),
      _card(
        child: Column(
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
        ),
      ),
      _sectionTitle('消息行为'),
      _card(
        child: Column(
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
        ),
      ),
    ]);
  }

  Widget _general(AppConfig config) {
    return _list([
      _sectionTitle('体验'),
      _card(
        child: Column(
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
        ),
      ),
      _sectionTitle('帮助'),
      _card(
        child: Column(
          children: [
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: const Icon(Icons.help_outline),
              title: const Text('帮助中心'),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => _toast(context, '帮助中心即将上线'),
            ),
            const Divider(height: 1),
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: const Icon(Icons.rate_review_outlined),
              title: const Text('给 SecureChat 评分'),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => _toast(context, '感谢你的支持'),
            ),
          ],
        ),
      ),
      _sectionTitle('关于'),
      _card(
        child: Column(
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
              trailing: const Text('1.42.0', style: TextStyle(color: Colors.grey)),
            ),
          ],
        ),
      ),
    ]);
  }

  Widget _privacy() {
    return _list([
      _sectionTitle('隐私保护'),
      _card(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Row(
              children: [
                Icon(Icons.lock_outline, color: Color(0xff18a66a)),
                SizedBox(width: 10),
                Expanded(child: Text('端到端加密', style: TextStyle(fontWeight: FontWeight.w700))),
              ],
            ),
            const SizedBox(height: 8),
            const Text('你的聊天内容仅由你和对方持有密钥，服务端无法读取。'),
            const SizedBox(height: 8),
            const Divider(height: 1),
            const SizedBox(height: 8),
            const Text('· 每条消息独立会话密钥\n· 不使用端到端加密即拒绝发送\n· 加密状态可在会话中随时查看'),
            const SizedBox(height: 16),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('隐身模式'),
              subtitle: const Text('隐藏在线状态与已读回执'),
              secondary: const Icon(Icons.visibility_off_outlined),
              value: _demoStealth,
              onChanged: (v) => setState(() => _demoStealth = v),
            ),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('自动清除消息'),
              subtitle: const Text('离开会话后自动删除本地副本'),
              secondary: const Icon(Icons.delete_sweep_outlined),
              value: _demoAutoClear,
              onChanged: (v) => setState(() => _demoAutoClear = v),
            ),
          ],
        ),
      ),
      _sectionTitle('设备与回执'),
      _card(
        child: Column(
          children: [
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('已读回执'),
              subtitle: const Text('展示消息已被对方读取'),
              secondary: const Icon(Icons.done_all_outlined),
              value: _demoReadReceipt,
              onChanged: (v) => setState(() => _demoReadReceipt = v),
            ),
            const Divider(height: 1),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('登录设备锁定'),
              subtitle: const Text('新设备登录需再次验证'),
              secondary: const Icon(Icons.phonelink_lock_outlined),
              value: _demoDeviceLock,
              onChanged: (v) => setState(() => _demoDeviceLock = v),
            ),
          ],
        ),
      ),
    ]);
  }

  Widget _storage() {
    return _list([
      _sectionTitle('存储占用'),
      _card(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Row(
              children: [
                Icon(Icons.folder_open_outlined),
                SizedBox(width: 10),
                Text('当前缓存大小', style: TextStyle(fontWeight: FontWeight.w700)),
              ],
            ),
            const SizedBox(height: 8),
            const Text('约 128 MB', style: TextStyle(fontSize: 28, fontWeight: FontWeight.w800)),
            const SizedBox(height: 8),
            const Text('包含语音缓存、图片缩略图与离线消息副本。'),
            const Divider(height: 28),
            Row(
              children: [
                Expanded(
                  child: ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: const Icon(Icons.cleaning_services_outlined),
                    title: const Text('清除缓存'),
                    onTap: () {
                      setState(() => _clearInfo = '已清除 128 MB 缓存');
                      _toast(context, '缓存已清除');
                    },
                  ),
                ),
                if (_clearInfo != null)
                  Padding(
                    padding: const EdgeInsets.only(right: 8),
                    child: Icon(Icons.check_circle, color: Theme.of(context).colorScheme.primary),
                  ),
              ],
            ),
          ],
        ),
      ),
      _sectionTitle('演示布局'),
      _card(
        child: Stack(children: [
          BgLayer(theme: widget.config.theme, config: widget.config),
          Padding(
            padding: const EdgeInsets.all(16),
            child: Text(
              '背景预览',
              style: TextStyle(color: Theme.of(context).colorScheme.onSurface, fontWeight: FontWeight.w600),
            ),
          ),
        ]),
      ),
    ]);
  }

  Widget _list(List<Widget> children) {
    return ListView(
      padding: const EdgeInsets.fromLTRB(20, 20, 20, 40),
      children: children,
    );
  }

  Widget _sectionTitle(String title) => Padding(
        padding: const EdgeInsets.fromLTRB(4, 8, 0, 10),
        child: Text(
          title,
          style: TextStyle(
            fontSize: 13,
            fontWeight: FontWeight.w700,
            color: Theme.of(context).colorScheme.primary,
            letterSpacing: 0.5,
          ),
        ),
      );

  Widget _card({required Widget child}) {
    return Container(
      margin: const EdgeInsets.only(bottom: 16),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surface,
        borderRadius: BorderRadius.circular(16),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.05),
            blurRadius: 12,
            offset: const Offset(0, 4),
          ),
        ],
      ),
      child: child,
    );
  }

  Widget _label(String text) => Text(
        text,
        style: TextStyle(
          fontSize: 13,
          fontWeight: FontWeight.w600,
          color: Theme.of(context).colorScheme.onSurfaceVariant,
        ),
      );

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
    showDialog(
      context: this.context,
      builder: (_) => _SimpleUpdateDialog(info: info, service: svc),
    );
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
    return AlertDialog(
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
      title: const Text('发现新版本'),
      content: SizedBox(
        width: 360,
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('当前 v$kAppVersion → 最新 v${widget.info['latest']}', style: const TextStyle(fontWeight: FontWeight.w700)),
          const SizedBox(height: 8),
          Text((widget.info['releaseNotes'] ?? '').toString(), style: const TextStyle(color: Color(0xff5b6670))),
          const SizedBox(height: 12),
          if (_downloading) ...[
            LinearProgressIndicator(value: _progress.clamp(0, 1), color: const Color(0xff18a66a)),
            const SizedBox(height: 6),
            Text('下载中 ${(_progress * 100).round()}%', style: const TextStyle(color: Color(0xff5b6670), fontSize: 12)),
          ] else if (_msg.isNotEmpty)
            Text(_msg, style: const TextStyle(color: Color(0xffc0392b), fontSize: 12)),
          if (_savedPath != null)
            Padding(padding: const EdgeInsets.only(top: 4), child: Text('已保存：$_savedPath', maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Color(0xff18a66a), fontSize: 11))),
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
