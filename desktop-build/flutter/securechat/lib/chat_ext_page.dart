// module: chat-ext (worker batch2)
// 聊天增强 Flutter 页：表情发送 / 合并转发查看 / 聊天背景设置 的入口与管理页。
// 供 features_center / main.dart 挂载：Navigator.push(ChatExtPage(api, config, [convId], [isGroup]))
import 'package:flutter/material.dart';

import 'services/chat_ext_service.dart';
import 'services/securechat_api.dart';

const _kTint = Color(0xff07c160);

class ChatExtPage extends StatefulWidget {
  const ChatExtPage({
    super.key,
    required this.api,
    required this.config,
    this.convId,
    this.isGroup = false,
    this.convName,
  });
  final SecureChatApi api;
  final dynamic config;
  final int? convId;
  final bool isGroup;
  final String? convName;

  @override
  State<ChatExtPage> createState() => _ChatExtPageState();
}

class _ChatExtPageState extends State<ChatExtPage> {
  late final ChatExtService _svc;
  final _ta = TextEditingController();
  final _bgColor = TextEditingController();
  Map<String, dynamic>? _bg;
  bool _sending = false;
  List<Map<String, dynamic>> _myMessages = [];

  static const List<String> _kEmojis = [
    '😀','😁','😂','🤣','😊','😇','🙂','😉','😍','🤩','😘','😋','😜','😝','🤪','😎','🤓','🥳','😏','😒','😢','😭','😤','😡','🤬','🥺','😳','😱','😨','🤗','🤔','🤭','😴','🙄','😬','😷','🤒','🥶','😈','👻','💀','👋','👌','👍','👎','👏','🙌','🤝','💪','🫶','❤️','🧡','💛','💚','💙','💜','🖤','💔','💕','💋','💯','💥','💫','✨','🔥','🎉','🎊','🎈','🎁','🎂','🍰','🍕','🍺','🍻','🥂','☕','🌸','🌹','🌻','🍀','🌈','⚡','🌙','⭐','🎵','🎶','🏆','🚀','🛸','🌍','💎','🧧','💌','📌',
  ];

  @override
  void initState() {
    super.initState();
    _svc = ChatExtService(widget.api);
    _loadBg();
    if (widget.convId != null) _loadMessages();
  }

  @override
  void dispose() {
    _ta.dispose();
    _bgColor.dispose();
    super.dispose();
  }

  Future<void> _loadBg() async {
    final id = widget.convId;
    if (id == null) return;
    final bg = await _svc.getBackground(id);
    if (!mounted) return;
    setState(() {
      _bg = bg;
      _bgColor.text = (bg?['value']?.toString()) ?? '';
    });
  }

  Future<void> _loadMessages() async {
    final id = widget.convId;
    if (id == null) return;
    try {
      final history = await widget.api.history(id);
      if (!mounted) return;
      setState(() {
        _myMessages = history.where((m) => (m['from'] ?? 0) == widget.api.myId).toList();
      });
    } catch (_) {}
  }

  void _toast(String msg) {
    ScaffoldMessenger.of(context).hideCurrentSnackBar();
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg), duration: const Duration(seconds: 2)));
  }

  Future<void> _sendText(String content, {String? emoji}) async {
    final id = widget.convId;
    if (id == null || widget.isGroup) return;
    if (_sending) return;
    setState(() => _sending = true);
    try {
      if (emoji != null) {
        await _svc.sendEmoji(id, emoji);
        _toast('已发送 $emoji');
      } else {
        await _svc.sendEnhanced(id, content);
        _toast('已发送');
      }
    } catch (e) {
      _toast('发送失败：${e.toString().replaceFirst('Bad state: ', '')}');
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _recallLast() async {
    if (_myMessages.isEmpty) {
      _toast('当前会话没有可撤回的我的消息');
      return;
    }
    final last = _myMessages.last;
    final ts = (last['createdAt'] ?? 0);
    if (DateTime.now().millisecondsSinceEpoch - (ts is int ? ts : int.tryParse('$ts') ?? 0) > 2 * 60 * 1000) {
      _toast('最近一条消息已超过 2 分钟，无法撤回');
      return;
    }
    final id = last['id'];
    if (id == null) {
      _toast('仅支持撤回已同步的消息');
      return;
    }
    try {
      await _svc.recall(id as int);
      _toast('已撤回');
      await _loadMessages();
    } catch (e) {
      _toast('撤回失败：${e.toString().replaceFirst('Bad state: ', '')}');
    }
  }

  Future<void> _openForwardPicker() async {
    if (widget.convId == null) {
      _toast('请先进入一个会话再使用转发');
      return;
    }
    final id = widget.convId!;
    // 收集当前会话附近可转发消息（取最近若干条）
    List<Map<String, dynamic>> pool;
    try {
      pool = await widget.api.history(id);
    } catch (_) {
      pool = _myMessages;
    }
    pool = pool.take(20).toList();
    if (pool.isEmpty) {
      _toast('当前会话没有可转发的消息');
      return;
    }
    if (!mounted) return;
    final selected = await showDialog<List<int>>(
      context: context,
      builder: (ctx) {
        final chosen = <int>{};
        return StatefulBuilder(
          builder: (ctx2, setLocal) => SimpleDialog(
            title: Text('选择要转发的消息（可多选）'),
            children: [
              SizedBox(
                width: 360,
                height: 320,
                child: ListView(
                  shrinkWrap: true,
                  children: [
                    for (final m in pool.reversed)
                      CheckboxListTile(
                        dense: true,
                        controlAffinity: ListTileControlAffinity.leading,
                        activeColor: _kTint,
                        value: chosen.contains(m['id']),
                        title: Text(_preview(m['content']), maxLines: 1, overflow: TextOverflow.ellipsis),
                        subtitle: Text(m['from'] == widget.api.myId ? '我·${_time(m['createdAt'])}' : '对方·${_time(m['createdAt'])}'),
                        onChanged: (v) {
                          setLocal(() {
                            if (v == true) {
                              chosen.add(m['id'] as int);
                            } else {
                              chosen.remove(m['id']);
                            }
                          });
                        },
                      ),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                child: Row(children: [
                  FilledButton(
                    onPressed: chosen.isEmpty ? null : () => Navigator.pop(ctx, [0, ...chosen]),
                    child: const Text('合并转发'),
                  ),
                  const SizedBox(width: 8),
                  OutlinedButton(
                    onPressed: chosen.isEmpty ? null : () => Navigator.pop(ctx, chosen.toList()),
                    child: const Text('逐条转发'),
                  ),
                ]),
              ),
            ],
          ),
        );
      },
    );
    if (selected == null || selected.isEmpty) return;
    final merge = selected.contains(0);
    final ids = selected.where((x) => x != 0).toSet().toList();
    if (ids.isEmpty) return;
    await _pickTargetsAndForward(ids, merge: merge);
  }

  Future<Map<String, dynamic>?> _pickTargets() async {
    List<Map<String, dynamic>> friends;
    List<Map<String, dynamic>> groups;
    try {
      friends = await widget.api.friends();
      groups = await widget.api.groups();
    } catch (_) {
      friends = const [];
      groups = const [];
    }
    final all = <Map<String, dynamic>>[
      for (final f in friends) {'kind': 'friend', 'id': f['id'], 'name': (f['nickname'] ?? f['username'] ?? '#${f['id']}')},
      for (final g in groups) {'kind': 'group', 'id': g['id'], 'name': '${g['name']}（群）'},
    ];
    if (all.isEmpty) {
      _toast('没有可转发的好友或群');
      return null;
    }
    if (!mounted) return null;
    final chosen = await showDialog<Map<String, dynamic>>(
      context: context,
      builder: (ctx) => SimpleDialog(
        title: const Text('转发到…'),
        children: [
          for (final t in all)
            SimpleDialogOption(
              onPressed: () => Navigator.pop(ctx, t),
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 6),
                child: Row(children: [
                  Icon(t['kind'] == 'group' ? Icons.groups_rounded : Icons.person, size: 18, color: _kTint),
                  const SizedBox(width: 10),
                  Text(t['name'].toString()),
                ]),
              ),
            ),
        ],
      ),
    );
    return chosen;
  }

  Future<void> _pickTargetsAndForward(List<int> ids, {required bool merge}) async {
    final target = await _pickTargets();
    if (target == null) return;
    final t = [{'id': target['id'], 'kind': target['kind']}];
    try {
      await _svc.forwardMany(ids, t, merge: merge);
      _toast(merge ? '已合并转发 ${ids.length} 条' : '已转发 ${ids.length} 条');
    } catch (e) {
      _toast('转发失败：${e.toString().replaceFirst('Bad state: ', '')}');
    }
  }

  String _preview(dynamic content) {
    final s = (content ?? '').toString();
    if (s.startsWith('[合并转发]')) return '[合并转发] ${(s.length > 14 ? s.substring(14, s.length > 40 ? 40 : s.length) : '')}…';
    if (s.startsWith('[emoji:')) return '（表情）$s';
    if (s.startsWith('[语音消息:')) return '（语音消息）';
    if (s.length > 30) return '${s.substring(0, 30)}…';
    return s;
  }

  static String _time(dynamic ts) {
    final v = int.tryParse('$ts');
    if (v == null || v <= 0) return '';
    final t = DateTime.fromMillisecondsSinceEpoch(v);
    final hh = t.hour.toString().padLeft(2, '0');
    final mm = t.minute.toString().padLeft(2, '0');
    return '$hh:$mm';
  }

  Future<void> _saveBackground() async {
    final id = widget.convId;
    if (id == null) return;
    final colorText = _bgColor.text.trim();
    Map<String, dynamic>? bg;
    if (colorText.isNotEmpty) {
      final hex = _normalizeHex(colorText);
      if (hex != null) bg = {'kind': 'color', 'value': hex};
    }
    await _svc.setBackground(id, bg);
    if (!mounted) return;
    setState(() => _bg = bg);
    _toast(bg == null ? '已恢复默认背景' : '聊天背景已保存');
  }

  String? _normalizeHex(String s) {
    var v = s.replaceAll('#', '').trim();
    if (v.length == 6) v = 'ff$v';
    if (v.length == 8 && RegExp(r'^[0-9a-fA-F]{8}$').hasMatch(v)) return '#$v';
    if (RegExp(r'^[0-9a-fA-F]{6}$').hasMatch(s.replaceAll('#', ''))) {
      final r = s.replaceAll('#', '');
      return '#ff$r';
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final t = widget.config.theme as dynamic;
    final textColor = (t.text as Color? ?? Colors.black87);
    final subColor = (t.subText as Color? ?? Colors.black54);
    final panel = (t.panel as Color? ?? Colors.white);

    return Scaffold(
      backgroundColor: panel,
      appBar: AppBar(
        backgroundColor: _kTint,
        foregroundColor: Colors.white,
        title: Text('聊天增强${widget.convName != null ? ' · ${widget.convName}' : ''}'),
        actions: [
          IconButton(icon: const Icon(Icons.forward), tooltip: '多选/合并转发', onPressed: _openForwardPicker),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          if (widget.convId != null) ...[
            _section('当前会话', Icons.chat_bubble_outline),
            _card(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('目标会话：${widget.convName ?? (widget.isGroup ? '群聊' : '好友')}', style: TextStyle(color: textColor, fontSize: 13)),
                if (widget.isGroup)
                  Padding(padding: const EdgeInsets.only(top: 6), child: Text('群聊不支持单向拍一拍/表情发送，可进入好友会话使用。', style: TextStyle(color: _kTint, fontSize: 12))),
              ]),
            ),
          ],
          _section('聊天背景（本地保存）', Icons.wallpaper),
          _card(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Expanded(
                  child: TextField(
                    controller: _bgColor,
                    style: TextStyle(color: textColor),
                    enabled: !_isEmptyConv(),
                    decoration: const InputDecoration(hintText: '十六进制颜色，如 #07c160 或 #1660ff', isDense: true),
                  ),
                ),
                const SizedBox(width: 10),
                FilledButton(onPressed: _isEmptyConv() ? null : _saveBackground, child: const Text('保存背景')),
              ]),
              const SizedBox(height: 8),
              Wrap(spacing: 8, runSpacing: 8, children: [
                for (final c in ['#e6f4ea', '#fbf3db', '#fde9e4', '#e7ecf7', '#fff4d6', '#e9f5e5', '#f0f0f5', '#ffffff'])
                  _swatch(c),
                ActionChip(avatar: const Icon(Icons.backspace_outlined, size: 16), label: const Text('默认'), onPressed: _isEmptyConv() ? null : () {
                  setState(() => _bgColor.clear());
                  _saveBackground();
                }),
              ]),
              if (_bg != null)
                Padding(padding: const EdgeInsets.only(top: 10), child: Text('当前背景：${_bg!['kind'] == 'image' ? '图片' : '${_bg!['value']}'}', style: TextStyle(color: subColor, fontSize: 12))),
            ]),
          ),
          if (!widget.isGroup && widget.convId != null) ...[
            _section('发送到当前会话', Icons.send),
            _card(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('点按表情即发送（保存为 [emoji] 特殊消息）', style: TextStyle(color: subColor, fontSize: 12)),
                const SizedBox(height: 10),
                TextField(controller: _ta, maxLines: 2, decoration: InputDecoration(hintText: '输入文本消息', contentPadding: const EdgeInsets.all(10), border: OutlineInputBorder(borderRadius: BorderRadius.circular(10)))),
                const SizedBox(height: 8),
                Row(children: [
                  Expanded(child: Wrap(spacing: 4, runSpacing: 4, children: [
                    for (final e in _kEmojis.take(32)) _emojiChip(e),
                  ])),
                ]),
                const SizedBox(height: 8),
                Align(
                  alignment: Alignment.centerRight,
                  child: FilledButton(
                    onPressed: _sending ? null : () => _sendText(_ta.text.trim()),
                    child: Text(_ta.text.trim().isEmpty && !_sending ? '发送文本' : '发送'),
                  ),
                ),
              ]),
            ),
          ],
          if (widget.convId != null) ...[
            _section('撤回 & 管理', Icons.undo),
            _card(
              child: Column(children: [
                ListTile(leading: Icon(Icons.undo, color: _kTint), title: const Text('撤回最近的自己消息'), subtitle: const Text('仅限 2 分钟内发送'), onTap: _recallLast),
                ListTile(leading: Icon(Icons.forward_to_inbox, color: _kTint), title: const Text('转发消息'), subtitle: const Text('可单条、逐条或合并转发到好友/群'), onTap: _openForwardPicker),
                const Divider(height: 1),
              ]),
            ),
          ],
        ],
      ),
    );
  }

  bool _isEmptyConv() => widget.convId == null;

  Widget _section(String title, IconData icon) => Padding(
        padding: const EdgeInsets.only(top: 8, bottom: 8),
        child: Row(children: [
          Icon(icon, size: 17, color: _kTint),
          const SizedBox(width: 8),
          Text(title, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
        ]),
      );

  Widget _card({required Widget child}) => Container(
        margin: const EdgeInsets.only(bottom: 6),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: const Color(0x14000000)),
          color: Colors.white.withValues(alpha: 0.6),
        ),
        child: child,
      );

  Widget _swatch(String color) => InkWell(
        onTap: _isEmptyConv() ? null : () => setState(() => _bgColor.text = color),
        borderRadius: BorderRadius.circular(16),
        child: Container(
          width: 32,
          height: 32,
          decoration: BoxDecoration(color: _parse(color), borderRadius: BorderRadius.circular(16), border: Border.all(color: const Color(0x22000000))),
        ),
      );

  Color _parse(String hex) {
    var s = hex.replaceAll('#', '');
    if (s.length == 6) s = 'ff$s';
    return Color(int.tryParse(s, radix: 16) ?? 0xFF07C160);
  }

  Widget _emojiChip(String e) => InkWell(
        onTap: () => _sendText('', emoji: e),
        borderRadius: BorderRadius.circular(8),
        child: Container(
          padding: const EdgeInsets.all(6),
          decoration: BoxDecoration(color: _kTint.withValues(alpha: 0.08), borderRadius: BorderRadius.circular(8)),
          child: Text(e, style: const TextStyle(fontSize: 16)),
        ),
      );
}