// module: groups (worker batch1)
// 群聊体系 Flutter 页面：群列表 → 群房间（发消息、@提及、公告、成员、文件、设置）。
// 独立文件，仅依赖 services/group_service.dart + services/securechat_api.dart。
import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import 'services/group_service.dart';
import 'services/securechat_api.dart';

class GroupPage extends StatefulWidget {
  const GroupPage({super.key, required this.api, required this.config});
  final SecureChatApi api;
  final dynamic config;
  @override
  State<GroupPage> createState() => _GroupPageState();
}

class _GroupPageState extends State<GroupPage> {
  late final GroupService _svc;
  final List<Map<String, dynamic>> _groups = [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _svc = GroupService(widget.api);
    _reload();
  }

  Future<void> _reload() async {
    setState(() { _loading = true; _error = null; });
    try {
      final g = await _svc.listGroups();
      _groups
        ..clear()
        ..addAll(g);
    } catch (e) {
      _error = e.toString().replaceFirst('Bad state: ', '');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _createGroup() async {
    final List<Map<String, dynamic>> pool;
    try { pool = await _svc.friendPool(); }
    catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('好友加载失败：${e.toString().replaceFirst('Bad state: ', '')}')));
      return;
    }
    // 收集选中的好友 UID
    final selected = <String>{};
    final nameCtrl = TextEditingController();
    await showDialog(context: context, builder: (ctx) => StatefulBuilder(
      builder: (ctx, setState) => AlertDialog(
        title: const Text('创建群聊'),
        content: SizedBox(width: 340, child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          TextField(controller: nameCtrl, decoration: const InputDecoration(labelText: '群名')),
          const SizedBox(height: 10),
          Text('选择好友（可选，多选）', style: TextStyle(color: Theme.of(ctx).colorScheme.onSurfaceVariant, fontSize: 12)),
          const SizedBox(height: 6),
          Flexible(child: SizedBox(height: 200, child: ListView(shrinkWrap: true, children: [
            for (final u in pool)
              CheckboxListTile(
                dense: true, contentPadding: EdgeInsets.zero,
                title: Text(((u['nickname'] ?? u['username'] ?? '').toString()) + '（${u['uid'] ?? ''}）', maxLines: 1, overflow: TextOverflow.ellipsis),
                value: selected.contains(u['uid']),
                onChanged: (v) => setState(() { if (v == true) selected.add(u['uid'].toString()); else selected.remove(u['uid'].toString()); }),
              ),
          ]))),
        ])),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(onPressed: () async {
            final name = nameCtrl.text.trim();
            if (name.isEmpty) { return; }
            Navigator.pop(ctx);
            try {
              await _svc.createGroup(name, selected.toList());
              if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('群「$name」创建成功')));
              await _reload();
            } catch (e) {
              if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('创建失败：$e')));
            }
          }, child: const Text('创建')),
        ],
      ),
    ));
  }

  Future<void> _openRoom(int groupId) async {
    final ok = await Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => _GroupRoom(api: widget.api, config: widget.config, groupId: groupId),
    ));
    if (ok == true) await _reload();
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Scaffold(
      backgroundColor: cs.surface,
      appBar: AppBar(
        backgroundColor: cs.surface,
        elevation: 0,
        title: const Text('群聊', style: TextStyle(fontWeight: FontWeight.w700)),
        leading: IconButton(icon: const Icon(Icons.arrow_back), onPressed: () => Navigator.of(context).maybePop()),
        actions: [
          IconButton(icon: Icon(Icons.group_add, color: cs.primary), tooltip: '创建群聊', onPressed: _createGroup),
          IconButton(icon: Icon(Icons.refresh, color: cs.primary), tooltip: '刷新', onPressed: _reload),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(child: Text(_error!, style: TextStyle(color: cs.error)))
              : _groups.isEmpty
                  ? Center(child: Text('还没有群聊，点右上角创建', style: TextStyle(color: cs.onSurfaceVariant)))
                  : ListView.separated(
                      padding: const EdgeInsets.all(12),
                      itemCount: _groups.length,
                      separatorBuilder: (_, i) => const SizedBox(height: 8),
                      itemBuilder: (_, i) {
                        final g = _groups[i];
                        final color = widget.config.theme.primary;
                        final name = (g['displayName'] ?? g['name'] ?? '群聊').toString();
                        final isOwner = g['ownerId'] != null && widget.api.myId != null && g['ownerId'] == widget.api.myId;
                        return Card(
                          elevation: 0,
                          color: cs.surface,
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14), side: BorderSide(color: cs.outlineVariant.withValues(alpha: 0.5))),
                          child: ListTile(
                            onTap: () => _openRoom(g['id'] as int),
                            leading: CircleAvatar(backgroundColor: color.withValues(alpha: 0.15), child: Text(name.isNotEmpty ? name[0] : '群', style: TextStyle(color: color))),
                            title: Text(name + (isOwner ? '（群主）' : ''), maxLines: 1, overflow: TextOverflow.ellipsis),
                            subtitle: Text(
                              '${(g['memberCount'] ?? 0)} 成员' + ((g['announcement'] != null && (g['announcement']['pinned'] == true)) ? ' · 置顶公告' : '') + (g['muted'] == true ? ' · 免打扰' : ''),
                              style: TextStyle(color: cs.onSurfaceVariant, fontSize: 12),
                            ),
                            trailing: g['announcement'] != null ? const Icon(Icons.push_pin, size: 16, color: Color(0xffe67e22)) : null,
                          ),
                        );
                      },
                    ),
    );
  }
}

// ---------------- 群房间 ----------------
class _GroupRoom extends StatefulWidget {
  const _GroupRoom({required this.api, required this.config, required this.groupId});
  final SecureChatApi api;
  final dynamic config;
  final int groupId;
  @override
  State<_GroupRoom> createState() => _GroupRoomState();
}

class _GroupRoomState extends State<_GroupRoom> {
  late final GroupService _svc;
  List<Map<String, dynamic>> _msgs = [];
  List<Map<String, dynamic>> _members = [];
  Map<String, dynamic>? _detail;
  String? _announcement;
  bool _pinned = false;
  bool _isOwner = false;
  bool _loading = true;
  bool _busy = false;
  final _input = TextEditingController();
  String _groupName = '';

  @override
  void initState() {
    super.initState();
    _svc = GroupService(widget.api);
    _load();
  }

  Future<void> _load() async {
    setState(() { _loading = true; });
    try {
      final d = await _svc.groupDetail(widget.groupId);
      final g = d['group'] as Map<String, dynamic>;
      _detail = d;
      _groupName = (g['displayName'] ?? g['name'] ?? '群聊').toString();
      _isOwner = g['isOwner'] == true;
      final ann = g['announcement'];
      _announcement = ann is Map ? (ann['content'] ?? '').toString() : '';
      _pinned = ann is Map && ann['pinned'] == true;
      _members = ((g['members'] as List?) ?? const []).cast<Map<String, dynamic>>();
      final h = await _svc.history(widget.groupId);
      _msgs = h;
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('载入群失败：${e.toString().replaceFirst('Bad state: ', '')}')));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _send() async {
    final text = _input.text.trim();
    if (text.isEmpty || _busy) return;
    _input.clear();
    setState(() => _busy = true);
    try {
      await _svc.sendMessage(widget.groupId, text, clientMsgId: 'gm${DateTime.now().microsecondsSinceEpoch}');
      await _load();
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('发送失败：${e.toString().replaceFirst('Bad state: ', '')}')));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _insertAt(String nick) {
    final s = _input.text;
    if (s.endsWith('@') || RegExp(r'@\w*$').hasMatch(s)) {
      _input.text = s.replaceFirst(RegExp(r'@\w*$'), '@$nick ');
    } else {
      _input.text = '$s@$nick ';
    }
    _input.selection = TextSelection.collapsed(offset: _input.text.length);
  }

  Future<void> _editAnnouncement() async {
    final ctrl = TextEditingController(text: _announcement ?? '');
    await showDialog(context: context, builder: (ctx) => AlertDialog(
      title: const Text('编辑群公告'),
      content: TextField(controller: ctrl, maxLines: 4, decoration: const InputDecoration(hintText: '公告内容')),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
        FilledButton(onPressed: () async {
          final c = ctrl.text.trim();
          Navigator.pop(ctx);
          try { await _svc.setAnnouncement(widget.groupId, c); await _load(); }
          catch (e) { if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('公告更新失败：$e'))); }
        }, child: const Text('保存')),
      ],
    ));
  }

  Future<void> _togglePin() async {
    try { await _svc.pinAnnouncement(widget.groupId, on: !_pinned); await _load(); }
    catch (e) { if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('操作失败：$e'))); }
  }

  Future<void> _invite() async {
    final list = await _svc.friendPool();
    final selected = <String>{};
    await showDialog(context: context, builder: (ctx) => StatefulBuilder(
      builder: (ctx, setState) => AlertDialog(
        title: const Text('邀请成员入群'),
        content: SizedBox(width: 320, child: Flexible(child: SizedBox(height: 260, child: ListView(shrinkWrap: true, children: [
          for (final u in list)
            CheckboxListTile(
              dense: true, contentPadding: EdgeInsets.zero,
              title: Text(((u['nickname'] ?? u['username'] ?? '').toString()) + '（${u['uid'] ?? ''}）', maxLines: 1, overflow: TextOverflow.ellipsis),
              value: selected.contains(u['uid']),
              onChanged: (v) => setState(() { if (v == true) selected.add(u['uid'].toString()); else selected.remove(u['uid'].toString()); }),
            ),
        ])))),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(onPressed: () async {
            Navigator.pop(ctx);
            try { await _svc.invite(widget.groupId, selected.toList()); await _load(); }
            catch (e) { if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('邀请失败：$e'))); }
          }, child: const Text('邀请')),
        ],
      ),
    ));
  }

  Future<void> _showSettings() async {
    final g = (_detail?['group'] as Map<String, dynamic>?) ?? {};
    final noteCtrl = TextEditingController(text: (g['displayName'] ?? '').toString() == (g['name'] ?? '').toString() ? '' : (g['displayName'] ?? '').toString());
    final nickCtrl = TextEditingController(text: (g['myNickname'] ?? '').toString());
    final muted = g['muted'] == true;
    var newMuted = muted;
    final files = <Map<String, dynamic>>[];
    try { final d = await _svc.fileList(widget.groupId); files.addAll(d); } catch (_) {}

    if (!mounted) return;
    await showDialog(context: context, builder: (ctx) => StatefulBuilder(
      builder: (ctx, setState) => AlertDialog(
        title: Text(_groupName),
        content: SizedBox(width: 360, child: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          SwitchListTile(contentPadding: EdgeInsets.zero, title: const Text('消息免打扰'), value: newMuted, onChanged: (v) => setState(() => newMuted = v)),
          TextField(controller: noteCtrl, decoration: const InputDecoration(labelText: '群备注（本群显示名）')),
          const SizedBox(height: 8),
          TextField(controller: nickCtrl, decoration: const InputDecoration(labelText: '我在本群昵称')),
          const SizedBox(height: 12),
          const Text('群成员与文件', style: TextStyle(fontWeight: FontWeight.w700)),
          const SizedBox(height: 4),
          for (final m in _members)
            Row(children: [
              Expanded(child: Text(((m['myNickname'] ?? m['nickname'] ?? m['username']) ?? '?').toString() + (m['id'] == g['ownerId'] ? '（群主）' : ''), overflow: TextOverflow.ellipsis)),
              if (_isOwner && m['id'] != g['ownerId'])
                TextButton(onPressed: () async { try { await _svc.removeMember(widget.groupId, m['id'] as int); if (mounted) setState(() {}); await _load(); } catch (e) {} }, child: const Text('移除', style: TextStyle(color: Colors.red))),
            ]),
          for (final f in files)
            ListTile(dense: true, contentPadding: EdgeInsets.zero, leading: const Icon(Icons.insert_drive_file, size: 18), title: Text(f['name'].toString(), maxLines: 1, overflow: TextOverflow.ellipsis), subtitle: Text((f['uploader'] ?? '').toString(), style: const TextStyle(fontSize: 11)), trailing: _isOwner ? IconButton(icon: const Icon(Icons.delete_outline, size: 18), onPressed: () async { try { await _svc.deleteFile(widget.groupId, f['id'].toString()); await _load(); } catch (e) {} }) : null),
        ]))),
        actions: [
          if (_isOwner)
            TextButton(onPressed: () => _danger(ctx, dissolve: true), child: const Text('解散群', style: TextStyle(color: Colors.red))),
          if (!_isOwner)
            TextButton(onPressed: () => _danger(ctx, dissolve: false), child: const Text('退出群', style: TextStyle(color: Colors.red))),
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () async {
            Navigator.pop(ctx, true);
            try {
              await _svc.setSettings(widget.groupId, muted: newMuted, note: noteCtrl.text.trim(), nickname: nickCtrl.text.trim());
              await _load();
            } catch (e) { if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('保存失败：$e'))); }
          }, child: const Text('保存')),
        ],
      ),
    ));
    // 设置弹窗关闭后，若调用了 _load 已刷新
  }

  Future<void> _danger(BuildContext dialogCtx, {required bool dissolve}) async {
    final tip = dissolve ? '解散后群消息与成员关系将全部删除，确认？' : '确认退出该群？';
    final ok = await showDialog<bool>(context: context, builder: (ctx) => AlertDialog(
      title: Text(dissolve ? '解散群' : '退出群'),
      content: Text(tip),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
        FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('确认')),
      ],
    ));
    if (ok != true) return;
    if (dissolve) await _svc.dissolve(widget.groupId);
    else await _svc.leave(widget.groupId);
    if (mounted) Navigator.of(context).pop(true);
  }

  Future<void> _showMsgMenu(int msgId, bool mine) async {
    final replyTo = (_msgs.firstWhere((m) => m['id'] == msgId, orElse: () => <String, dynamic>{})['replyTo'] as int?) ?? null;
    final pinned = ((_msgs.firstWhere((m) => m['id'] == msgId, orElse: () => <String, dynamic>{})['pinned'] as bool?) ?? false);
    await showModalBottomSheet(
      context: context,
      builder: (sheetCtx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          ListTile(leading: const Icon(Icons.reply), title: const Text('引用回复'), onTap: () async { Navigator.pop(sheetCtx); await _doReply(msgId); }),
          ListTile(leading: Icon(pinned ? Icons.push_pin : Icons.push_pin_outlined), title: Text(pinned ? '取消置顶' : '置顶消息'), onTap: () async { Navigator.pop(sheetCtx); try { await _svc.pinMessage(widget.groupId, msgId, pinned: !pinned); await _load(); } catch (e) { if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('操作失败：$e'))); } }),
        ]),
      ),
    );
  }

  Future<void> _doReply(int msgId) async {
    final refMsg = _msgs.firstWhere((m) => m['id'] == msgId, orElse: () => <String, dynamic>{}) as Map<String, dynamic>?;
    final refContent = (refMsg?['content'] ?? '[消息]').toString().substring(0, 40);
    final ctrl = TextEditingController();
    await showDialog(context: context, builder: (ctx) => AlertDialog(
      title: const Text('引用回复'),
      content: Column(mainAxisSize: MainAxisSize.min, children: [
        Container(
          padding: const EdgeInsets.all(8),
          decoration: BoxDecoration(color: const Color(0xFFE8F5E9), borderRadius: BorderRadius.circular(8)),
          child: Text('「$refContent」', style: const TextStyle(fontSize: 12, color: Color(0xFF2E7D32))),
        ),
        const SizedBox(height: 8),
        TextField(controller: ctrl, autofocus: true, decoration: const InputDecoration(hintText: '输入回复内容')),
      ]),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
        FilledButton(onPressed: () async {
          Navigator.pop(ctx);
          try { await _svc.replyMessage(widget.groupId, msgId, replyTo: ctrl.text.trim().isEmpty ? null : msgId); await _load(); }
          catch (e) { if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('操作失败：$e'))); }
        }, child: const Text('确认')),
      ],
    ));
  }

  Future<void> _uploadFile() async {
    final res = await FilePicker.platform.pickFiles();
    if (res == null || res.files.isEmpty) return;
    final f = res.files.single;
    final bytes = f.bytes;
    final path = f.path;
    if (bytes == null && path == null) return;
    try {
      if (bytes != null) {
        await _svc.uploadFile(widget.groupId, bytes, f.name, mime: 'application/octet-stream');
      } else {
        final data = await File(path!).readAsBytes();
        await _svc.uploadFile(widget.groupId, data, f.name, mime: 'application/octet-stream', path: path);
      }
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('文件已上传')));
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('上传失败：$e')));
    }
  }

  @override
  void dispose() {
    _input.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final color = widget.config.theme.primary;
    return Scaffold(
      backgroundColor: cs.surface,
      appBar: AppBar(
        backgroundColor: cs.surface,
        elevation: 0,
        titleSpacing: 0,
        title: Text(_groupName.isEmpty ? '群房间' : _groupName, maxLines: 1, overflow: TextOverflow.ellipsis),
        leading: IconButton(icon: const Icon(Icons.arrow_back), onPressed: () => Navigator.of(context).maybePop()),
        actions: [
          IconButton(icon: Icon(Icons.group_add, color: cs.primary), tooltip: '邀请', onPressed: _invite),
          IconButton(icon: Icon(Icons.folder_open_outlined, color: cs.primary), tooltip: '上传文件', onPressed: _uploadFile),
          IconButton(icon: Icon(Icons.settings_outlined, color: cs.primary), tooltip: '群设置', onPressed: _showSettings),
        ],
      ),
      body: Column(children: [
        // 置顶公告
        if (_announcement != null && _announcement!.isNotEmpty)
          InkWell(
            onTap: _isOwner ? _editAnnouncement : null,
            child: Container(width: double.infinity, padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10), margin: const EdgeInsets.fromLTRB(12, 8, 12, 0), decoration: BoxDecoration(color: cs.surfaceContainerHighest.withValues(alpha: 0.5), borderRadius: BorderRadius.circular(10)),
              child: Row(children: [
                Icon(Icons.campaign, size: 16, color: _pinned ? const Color(0xffe67e22) : cs.onSurfaceVariant),
                const SizedBox(width: 8),
                Expanded(child: Text('公告${_pinned ? '(置顶)' : ''}：$_announcement', maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(color: cs.onSurface, fontSize: 13))),
                if (_isOwner)
                  IconButton(tooltip: _pinned ? '取消置顶' : '置顶公告', onPressed: _togglePin, icon: Icon(Icons.push_pin, color: _pinned ? const Color(0xffe67e22) : cs.onSurfaceVariant, size: 18)),
                if (_isOwner)
                  IconButton(tooltip: '编辑公告', onPressed: _editAnnouncement, icon: const Icon(Icons.edit, size: 18)),
              ]),
            ),
          ),
        Expanded(
          child: _loading
              ? const Center(child: CircularProgressIndicator())
              : _msgs.isEmpty
                  ? Center(child: Text('还没有群消息', style: TextStyle(color: cs.onSurfaceVariant)))
                  : ListView.builder(
                      padding: const EdgeInsets.all(14),
                      itemCount: _msgs.length,
                      itemBuilder: (_, i) {
                        final m = _msgs[i];
                        final mine = m['from'] == widget.api.myId;
                        final fu = (m['fromUser'] is Map) ? ((m['fromUser']) as Map) : const {};
                        final sender = (fu['nickname'] ?? fu['username'] ?? '用户').toString();
                        final content = (m['content'] ?? '').toString();
                        final pinned = (m['pinned'] as bool?) ?? false;
                        final replyTo = (m['replyTo'] as int?) ?? null;
                        return GestureDetector(
                          onLongPress: () => _showMsgMenu(m['id'] as int, mine),
                          child: Align(
                            alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
                            child: Padding(padding: const EdgeInsets.only(bottom: 12), child: Row(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.end, children: [
                              if (!mine) CircleAvatar(radius: 15, backgroundColor: color.withValues(alpha: 0.15), child: Text(sender.isNotEmpty ? sender[0] : '?', style: TextStyle(color: color, fontSize: 12))),
                              if (!mine) const SizedBox(width: 8),
                              Flexible(child: Container(
                                padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 9),
                                constraints: const BoxConstraints(maxWidth: 520),
                                decoration: BoxDecoration(
                                  color: mine ? cs.primaryContainer : cs.surfaceContainerHighest.withValues(alpha: 0.6),
                                  borderRadius: BorderRadius.only(topLeft: const Radius.circular(14), topRight: const Radius.circular(14), bottomLeft: Radius.circular(mine ? 14 : 4), bottomRight: Radius.circular(mine ? 4 : 14)),
                                ),
                                child: Column(crossAxisAlignment: mine ? CrossAxisAlignment.end : CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                                  Row(mainAxisSize: MainAxisSize.min, children: [
                                    if (!mine) Padding(padding: const EdgeInsets.only(right: 4, bottom: 3), child: Text(sender, style: TextStyle(color: color, fontSize: 11, fontWeight: FontWeight.w600))),
                                    const Spacer(),
                                    if (pinned) Icon(Icons.push_pin, size: 12, color: const Color(0xffe67e22)),
                                    if (replyTo != null) const SizedBox(width: 4),
                                    if (replyTo != null) Icon(Icons.reply, size: 12, color: cs.onSurfaceVariant),
                                  ]),
                                  if (replyTo != null)
                                    Padding(padding: const EdgeInsets.only(bottom: 4), child: Container(
                                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 3),
                                      decoration: BoxDecoration(color: cs.outlineVariant.withValues(alpha: 0.3), borderRadius: BorderRadius.circular(6)),
                                      child: Text('回复 ${_msgs.firstWhere((x) => x['id'] == replyTo, orElse: () => {'fromUser': {'nickname': '?'}})['fromUser']['nickname'] ?? '?'}：${(_msgs.firstWhere((x) => x['id'] == replyTo, orElse: () => {'content': '[已撤回]'})['content'] ?? '[已撤回]').toString().substring(0, 30)}${((m['content'] ?? '').toString().length > 30) ? '…' : ''}', style: TextStyle(color: cs.onSurfaceVariant, fontSize: 11)),
                                    )),
                                  SelectableText(content, style: TextStyle(color: cs.onSurface, fontSize: 14, height: 1.4)),
                                ]),
                              )),
                            ])),
                          ),
                        );
                      },
                    ),
        ),
        // 输入区 + @ 提及
        Container(
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 14),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            // @ 成员快捷选择
            SizedBox(height: 32, child: ListView(scrollDirection: Axis.horizontal, children: [
              ActionChip(label: const Text('@全部'), avatar: const Icon(Icons.group, size: 16), onPressed: () => _insertAt('全部')),
              for (final mm in _members)
                Padding(padding: const EdgeInsets.only(left: 6), child: ActionChip(label: Text(((mm['myNickname'] ?? mm['nickname'] ?? mm['username']) ?? '?').toString()), avatar: const Icon(Icons.person, size: 14), onPressed: () => _insertAt(((mm['myNickname'] ?? mm['nickname'] ?? mm['username']) ?? '?').toString()))),
            ])),
            const SizedBox(height: 6),
            Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
              Expanded(child: TextField(controller: _input, minLines: 1, maxLines: 4, style: TextStyle(color: cs.onSurface), decoration: InputDecoration(hintText: '输入消息，@ 提及成员', hintStyle: TextStyle(color: cs.onSurfaceVariant), filled: true, fillColor: cs.surfaceContainerHighest.withValues(alpha: 0.5), border: OutlineInputBorder(borderRadius: BorderRadius.circular(24), borderSide: BorderSide.none)))),
              const SizedBox(width: 10),
              SizedBox(height: 44, child: FilledButton.icon(onPressed: _busy ? null : (() => _send()), icon: const Icon(Icons.send, size: 16), label: const Text('发送'))),
            ]),
          ]),
        ),
      ]),
    );
  }
}