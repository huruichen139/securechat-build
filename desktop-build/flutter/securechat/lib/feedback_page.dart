import 'package:flutter/material.dart';

import 'services/app_config.dart';
import 'services/securechat_api.dart';
import 'widgets/app_scaffold.dart';
import 'widgets/ux.dart';

/// 反馈类型：value 必须与服务端一致（bug / suggestion / complaint / other）
class FeedbackKind {
  const FeedbackKind(this.value, this.label, this.icon);
  final String value;
  final String label;
  final IconData icon;

  static const all = <FeedbackKind>[
    FeedbackKind('bug', '问题反馈', Icons.bug_report_outlined),
    FeedbackKind('suggestion', '功能建议', Icons.lightbulb_outline),
    FeedbackKind('complaint', '投诉', Icons.report_gmailerrorred_outlined),
    FeedbackKind('other', '其他', Icons.chat_bubble_outline),
  ];

  static String labelOf(String? value) {
    for (final k in all) {
      if (k.value == value) return k.label;
    }
    return '其他';
  }

  static IconData iconOf(String? value) {
    for (final k in all) {
      if (k.value == value) return k.icon;
    }
    return Icons.chat_bubble_outline;
  }
}

/// 内容最少字数，与服务端 400 校验保持一致
const int kFeedbackMinLength = 10;

String _errText(Object e) => e.toString().replaceFirst('Bad state: ', '').replaceFirst('Exception: ', '');

String _fmtTime(dynamic v) {
  final ms = v is int ? v : int.tryParse('$v') ?? 0;
  if (ms <= 0) return '';
  final dt = DateTime.fromMillisecondsSinceEpoch(ms);
  String two(int x) => x.toString().padLeft(2, '0');
  return '${dt.year}/${two(dt.month)}/${two(dt.day)} ${two(dt.hour)}:${two(dt.minute)}';
}

/// 意见反馈：提交表单 + 我的反馈列表
class FeedbackPage extends StatefulWidget {
  const FeedbackPage({super.key, required this.config, required this.api, this.initialTab = 0});

  final AppConfig config;
  final SecureChatApi api;
  final int initialTab;

  @override
  State<FeedbackPage> createState() => _FeedbackPageState();
}

class _FeedbackPageState extends State<FeedbackPage> with SingleTickerProviderStateMixin {
  late final TabController _tab;
  final _content = TextEditingController();

  String _kind = FeedbackKind.all.first.value;
  bool _submitting = false;
  String? _formError;

  final _items = <Map<String, dynamic>>[];
  bool _loading = false;
  bool _loaded = false;
  String? _listError;

  @override
  void initState() {
    super.initState();
    _tab = TabController(length: 2, vsync: this, initialIndex: widget.initialTab.clamp(0, 1));
    _content.addListener(_onContentChanged);
    if (_tab.index == 1) _reload();
    _tab.addListener(() {
      if (_tab.index == 1 && !_loaded && !_loading) _reload();
    });
  }

  @override
  void dispose() {
    _content.removeListener(_onContentChanged);
    _content.dispose();
    _tab.dispose();
    super.dispose();
  }

  void _onContentChanged() {
    // 用户开始修改后清掉上一次的校验提示，并刷新字数指示
    if (_formError != null) {
      setState(() => _formError = null);
    } else {
      setState(() {});
    }
  }

  Future<void> _reload() async {
    setState(() {
      _loading = true;
      _listError = null;
    });
    try {
      final rows = await widget.api.myFeedbacks();
      if (!mounted) return;
      setState(() {
        _items
          ..clear()
          ..addAll(rows);
        _loaded = true;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _listError = '加载反馈失败：${_errText(e)}');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _submit() async {
    final text = _content.text.trim();
    if (text.length < kFeedbackMinLength) {
      setState(() => _formError = '内容至少 $kFeedbackMinLength 字，当前 ${text.length} 字');
      return;
    }
    setState(() {
      _submitting = true;
      _formError = null;
    });
    try {
      await widget.api.sendFeedback(_kind, text);
      if (!mounted) return;
      _content.clear();
      setState(() {
        _kind = FeedbackKind.all.first.value;
        _loaded = false;
      });
      _toast('反馈已提交，感谢你的反馈');
      _tab.animateTo(1);
      await _reload();
    } catch (e) {
      if (!mounted) return;
      final msg = _errText(e);
      setState(() => _formError = '提交失败：$msg');
      _toast('提交失败：$msg');
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  void _toast(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
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
            child: Column(children: [
              PageHeader(title: '意见反馈', config: config),
              Container(
                color: t.card.withValues(alpha: 0.85),
                child: TabBar(
                  controller: _tab,
                  labelColor: config.primary,
                  indicatorColor: config.primary,
                  unselectedLabelColor: t.subText,
                  labelStyle: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
                  tabs: const [Tab(text: '写反馈'), Tab(text: '我的反馈')],
                ),
              ),
              Expanded(
                child: TabBarView(
                  controller: _tab,
                  children: [_form(config, t), _listView(config, t)],
                ),
              ),
            ]),
          ),
        );
      },
    );
  }

  Widget _form(AppConfig config, AppTheme t) {
    final len = _content.text.trim().length;
    final ok = len >= kFeedbackMinLength;
    return ListView(
      padding: const EdgeInsets.only(top: 4, bottom: 40),
      children: [
        SectionTitle(config: config, title: '反馈类型'),
        SectionCard(
          config: config,
          padding: const EdgeInsets.fromLTRB(14, 14, 14, 14),
          children: [
            Wrap(
              spacing: 10,
              runSpacing: 10,
              children: [
                for (final k in FeedbackKind.all)
                  _KindChip(
                    config: config,
                    kind: k,
                    selected: _kind == k.value,
                    onTap: () => setState(() => _kind = k.value),
                  ),
              ],
            ),
          ],
        ),
        SectionTitle(config: config, title: '详细描述'),
        SectionCard(
          config: config,
          padding: const EdgeInsets.fromLTRB(14, 14, 14, 14),
          children: [
            Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              TextField(
                controller: _content,
                minLines: 5,
                maxLines: 10,
                maxLength: 1000,
                enabled: !_submitting,
                style: TextStyle(color: t.text, fontSize: 14),
                decoration: InputDecoration(
                  hintText: '请描述你遇到的问题或建议，至少 $kFeedbackMinLength 字。'
                      '如果是问题反馈，请说明操作步骤与出现的现象。',
                  hintStyle: TextStyle(color: t.subText, fontSize: 13),
                  counterText: '',
                ),
              ),
              const SizedBox(height: 8),
              Row(children: [
                Icon(
                  ok ? Icons.check_circle_outline : Icons.info_outline,
                  size: 15,
                  color: ok ? config.primary : t.subText,
                ),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    ok ? '已输入 $len 字' : '还需 ${kFeedbackMinLength - len} 字（至少 $kFeedbackMinLength 字）',
                    style: TextStyle(fontSize: 12, color: ok ? config.primary : t.subText),
                  ),
                ),
                Text('$len/1000', style: TextStyle(fontSize: 12, color: t.subText)),
              ]),
              if (_formError != null) ...[
                const SizedBox(height: 10),
                _ErrorLine(text: _formError!),
              ],
              const SizedBox(height: 14),
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: _submitting ? null : _submit,
                  child: Text(_submitting ? '提交中…' : '提交反馈'),
                ),
              ),
            ]),
          ],
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 14, 20, 0),
          child: Text(
            '反馈提交后可在「我的反馈」中查看处理状态。',
            style: TextStyle(fontSize: 12, color: t.subText),
          ),
        ),
      ],
    );
  }

  Widget _listView(AppConfig config, AppTheme t) {
    if (_loading && _items.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_listError != null && _items.isEmpty) {
      return _EmptyState(
        config: config,
        icon: Icons.wifi_off_outlined,
        title: '加载失败',
        detail: _listError,
        actionLabel: '重试',
        onAction: _reload,
      );
    }
    if (_items.isEmpty) {
      return _EmptyState(
        config: config,
        icon: Icons.inbox_outlined,
        title: '还没有提交过反馈',
        detail: '在「写反馈」里描述你遇到的问题或建议，提交后可在这里跟踪处理状态。',
        actionLabel: '去写反馈',
        onAction: () => _tab.animateTo(0),
      );
    }
    return RefreshIndicator(
      onRefresh: _reload,
      child: ListView(
        padding: const EdgeInsets.only(top: 4, bottom: 40),
        children: [
          if (_listError != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 12, 20, 0),
              child: _ErrorLine(text: _listError!),
            ),
          SectionTitle(config: config, title: '共 ${_items.length} 条反馈'),
          for (final f in _items)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: SectionCard(
                config: config,
                padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
                children: [
                  Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Row(children: [
                      Icon(FeedbackKind.iconOf(f['kind']?.toString()), size: 17, color: t.subText),
                      const SizedBox(width: 8),
                      Text(
                        FeedbackKind.labelOf(f['kind']?.toString()),
                        style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: t.text),
                      ),
                      const Spacer(),
                      _StatusBadge(config: config, status: f['status']?.toString()),
                    ]),
                    const SizedBox(height: 8),
                    Text(
                      (f['content'] ?? '').toString(),
                      style: TextStyle(fontSize: 13, height: 1.5, color: t.text),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      _fmtTime(f['createdAt'] ?? f['created_at']),
                      style: TextStyle(fontSize: 11, color: t.subText),
                    ),
                  ]),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

/// 系统公告
class AnnouncementsPage extends StatefulWidget {
  const AnnouncementsPage({super.key, required this.config, required this.api});

  final AppConfig config;
  final SecureChatApi api;

  @override
  State<AnnouncementsPage> createState() => _AnnouncementsPageState();
}

class _AnnouncementsPageState extends State<AnnouncementsPage> {
  final _items = <Map<String, dynamic>>[];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _reload();
  }

  Future<void> _reload() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final rows = await widget.api.announcements();
      // 置顶优先，其次按时间倒序（服务端已排序，这里再兜底一次）
      final sorted = [...rows];
      int topOf(Map<String, dynamic> a) {
        final v = a['top'];
        if (v is bool) return v ? 1 : 0;
        return int.tryParse('$v') ?? 0;
      }

      int timeOf(Map<String, dynamic> a) {
        final v = a['createdAt'] ?? a['created_at'];
        return v is int ? v : int.tryParse('$v') ?? 0;
      }

      sorted.sort((a, b) {
        final byTop = topOf(b).compareTo(topOf(a));
        if (byTop != 0) return byTop;
        return timeOf(b).compareTo(timeOf(a));
      });
      if (!mounted) return;
      setState(() {
        _items
          ..clear()
          ..addAll(sorted);
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = '公告加载失败：${_errText(e)}');
    } finally {
      if (mounted) setState(() => _loading = false);
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
            child: Column(children: [
              PageHeader(
                title: '系统公告',
                config: config,
                trailing: IconButton(
                  tooltip: '刷新',
                  onPressed: _loading ? null : _reload,
                  icon: const Icon(Icons.refresh_rounded, size: 19),
                  color: t.text,
                ),
              ),
              Expanded(child: _body(config, t)),
            ]),
          ),
        );
      },
    );
  }

  Widget _body(AppConfig config, AppTheme t) {
    if (_loading && _items.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null && _items.isEmpty) {
      return _EmptyState(
        config: config,
        icon: Icons.wifi_off_outlined,
        title: '加载失败',
        detail: _error,
        actionLabel: '重试',
        onAction: _reload,
      );
    }
    if (_items.isEmpty) {
      return _EmptyState(
        config: config,
        icon: Icons.campaign_outlined,
        title: '暂无公告',
        detail: '当前没有生效中的系统公告，发布新公告时会在这里显示。',
        actionLabel: '刷新',
        onAction: _reload,
      );
    }
    return RefreshIndicator(
      onRefresh: _reload,
      child: ListView(
        padding: const EdgeInsets.only(top: 4, bottom: 40),
        children: [
          if (_error != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 12, 20, 0),
              child: _ErrorLine(text: _error!),
            ),
          SectionTitle(config: config, title: '共 ${_items.length} 条公告'),
          for (final a in _items) _card(config, t, a),
        ],
      ),
    );
  }

  Widget _card(AppConfig config, AppTheme t, Map<String, dynamic> a) {
    final topVal = a['top'];
    final isTop = topVal is bool ? topVal : (int.tryParse('$topVal') ?? 0) != 0;
    final level = (a['level'] ?? 'info').toString();
    final accent = _levelColor(config, level);
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: SectionCard(
        config: config,
        padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
        children: [
          Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Icon(_levelIcon(level), size: 17, color: accent),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  (a['title'] ?? '无标题').toString(),
                  style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700, color: t.text),
                ),
              ),
              if (isTop) ...[
                const SizedBox(width: 8),
                _Badge(text: '置顶', color: config.primary),
              ],
            ]),
            const SizedBox(height: 8),
            Text(
              (a['content'] ?? '').toString(),
              style: TextStyle(fontSize: 13, height: 1.6, color: t.text),
            ),
            const SizedBox(height: 8),
            Row(children: [
              Text(_levelLabel(level), style: TextStyle(fontSize: 11, color: accent)),
              const SizedBox(width: 8),
              Text(
                _fmtTime(a['createdAt'] ?? a['created_at']),
                style: TextStyle(fontSize: 11, color: t.subText),
              ),
            ]),
          ]),
        ],
      ),
    );
  }

  Color _levelColor(AppConfig config, String level) {
    switch (level) {
      case 'warning':
        return const Color(0xffe08a2e);
      case 'danger':
        return const Color(0xffe0533d);
      default:
        return config.primary;
    }
  }

  IconData _levelIcon(String level) {
    switch (level) {
      case 'warning':
        return Icons.warning_amber_rounded;
      case 'danger':
        return Icons.error_outline_rounded;
      default:
        return Icons.campaign_outlined;
    }
  }

  String _levelLabel(String level) {
    switch (level) {
      case 'warning':
        return '重要';
      case 'danger':
        return '紧急';
      default:
        return '通知';
    }
  }
}

class _KindChip extends StatelessWidget {
  const _KindChip({required this.config, required this.kind, required this.selected, required this.onTap});

  final AppConfig config;
  final FeedbackKind kind;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final t = config.theme;
    return Material(
      color: Colors.transparent,
      borderRadius: BorderRadius.circular(Ux.radius),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(Ux.radius),
        child: AnimatedContainer(
          duration: Ux.fast,
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
          decoration: BoxDecoration(
            color: selected ? config.primary.withValues(alpha: 0.14) : t.inputBg.withValues(alpha: 0.7),
            borderRadius: BorderRadius.circular(Ux.radius),
            border: Border.all(
              color: selected ? config.primary : t.div.withValues(alpha: 0.6),
              width: selected ? 1.4 : 1,
            ),
          ),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            Icon(kind.icon, size: 16, color: selected ? config.primary : t.subText),
            const SizedBox(width: 6),
            Text(
              kind.label,
              style: TextStyle(
                fontSize: 13,
                fontWeight: selected ? FontWeight.w600 : FontWeight.w500,
                color: selected ? config.primary : t.text,
              ),
            ),
          ]),
        ),
      ),
    );
  }
}

class _StatusBadge extends StatelessWidget {
  const _StatusBadge({required this.config, required this.status});

  final AppConfig config;
  final String? status;

  @override
  Widget build(BuildContext context) {
    final t = config.theme;
    switch (status) {
      case 'processing':
        return _Badge(text: '处理中', color: config.primary);
      case 'closed':
        return _Badge(text: '已处理', color: t.subText);
      case 'open':
      default:
        return const _Badge(text: '待处理', color: Color(0xffe08a2e));
    }
  }
}

class _Badge extends StatelessWidget {
  const _Badge({required this.text, required this.color});

  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: color.withValues(alpha: 0.5)),
      ),
      child: Text(text, style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: color)),
    );
  }
}

class _ErrorLine extends StatelessWidget {
  const _ErrorLine({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    const c = Color(0xffe0533d);
    return Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
      const Icon(Icons.error_outline, size: 15, color: c),
      const SizedBox(width: 6),
      Expanded(child: Text(text, style: const TextStyle(fontSize: 12, color: c))),
    ]);
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState({
    required this.config,
    required this.icon,
    required this.title,
    this.detail,
    this.actionLabel,
    this.onAction,
  });

  final AppConfig config;
  final IconData icon;
  final String title;
  final String? detail;
  final String? actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    final t = config.theme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 36),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Icon(icon, size: 38, color: t.subText.withValues(alpha: 0.7)),
          const SizedBox(height: 12),
          Text(title, style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: t.text)),
          if (detail != null) ...[
            const SizedBox(height: 8),
            Text(
              detail!,
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 13, height: 1.5, color: t.subText),
            ),
          ],
          if (actionLabel != null && onAction != null) ...[
            const SizedBox(height: 16),
            OutlinedButton(onPressed: onAction, child: Text(actionLabel!)),
          ],
        ]),
      ),
    );
  }
}
