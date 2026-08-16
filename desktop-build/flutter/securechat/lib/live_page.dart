// module: live_page (worker batch4) —— Flutter 直播页：开播/列表/进房+聊天室（轮询弹幕）/回放
import 'dart:async';

import 'package:flutter/material.dart';

import 'services/app_config.dart';
import 'services/media_api.dart';
import 'services/securechat_api.dart';
import 'widgets/ux.dart';

class LivePage extends StatefulWidget {
  const LivePage({super.key, required this.api, required this.config});
  final SecureChatApi api;
  final dynamic config;
  @override
  State<LivePage> createState() => _LivePageState();
}

class _LivePageState extends State<LivePage> {
  late final MediaService _svc = MediaService(widget.api);
  List<Map<String, dynamic>> _rooms = [];
  bool _loading = true;
  String? _error;

  AppConfig get _cfg => widget.config as AppConfig;
  AppTheme get _t => _cfg.theme;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      _rooms = await _svc.liveRooms();
    } catch (e) {
      _error = e.toString().replaceFirst('Bad state: ', '');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _start() async {
    final t = TextEditingController();
    final url = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('开播'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: t, decoration: const InputDecoration(hintText: '直播间标题')),
          const SizedBox(height: 8),
          TextField(controller: url, decoration: const InputDecoration(hintText: '拉流地址（HLS m3u8 / RTMP，可留空=纯聊天室）')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('开播')),
        ],
      ),
    );
    if (ok != true || t.text.trim().isEmpty) return;
    try {
      final room = await _svc.startLive(t.text.trim(), streamUrl: url.text.trim());
      if (mounted) {
        Navigator.of(context).push(MaterialPageRoute(builder: (_) => _LiveRoomView(svc: _svc, room: room, isHost: true, config: _cfg)));
      }
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('开播失败：$e')));
    }
  }

  String _fmt(dynamic v) {
    final ms = v is int ? v : int.tryParse('$v') ?? 0;
    if (ms == 0) return '';
    final dt = DateTime.fromMillisecondsSinceEpoch(ms);
    String two(int x) => x.toString().padLeft(2, '0');
    return '${dt.month}/${dt.day} ${two(dt.hour)}:${two(dt.minute)}';
  }

  @override
  Widget build(BuildContext context) {
    final t = _t;
    return Scaffold(
      backgroundColor: t.bg,
      body: Column(children: [
        PageHeader(
          title: '直播',
          config: _cfg,
          trailing: IconButton(
            onPressed: _start,
            icon: Icon(Icons.add_circle_outline, color: t.text, size: 20),
          ),
        ),
        Expanded(
          child: _loading
              ? Center(child: CircularProgressIndicator(color: t.subText))
              : _error != null
                  ? Center(child: Text(_error!, style: TextStyle(color: t.subText)))
                  : _rooms.isEmpty
                      ? Center(child: Text('当前没有直播，点右上角开播', style: TextStyle(color: t.subText)))
                      : ListView.builder(
                          padding: const EdgeInsets.symmetric(vertical: 12),
                          itemCount: _rooms.length,
                          itemBuilder: (_, i) {
                            final r = _rooms[i];
                            final live = r['status'] == 'live';
                            return InkWell(
                              onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => _LiveRoomView(svc: _svc, room: r, isHost: r['hostId'] == widget.api.myId, config: _cfg))),
                              child: Container(
                                margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
                                padding: const EdgeInsets.all(14),
                                decoration: BoxDecoration(
                                  color: t.card.withValues(alpha: 0.85),
                                  borderRadius: BorderRadius.circular(Ux.cardRadius),
                                  border: Border.all(color: t.div.withValues(alpha: 0.6)),
                                ),
                                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                  Row(children: [
                                    Container(
                                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                                      decoration: BoxDecoration(color: live ? Ux.green : Ux.cellIconBg(t), borderRadius: BorderRadius.circular(10)),
                                      child: Text(live ? '● 直播中' : '已结束', style: TextStyle(color: live ? Colors.white : t.subText, fontSize: 11)),
                                    ),
                                    const Spacer(),
                                    Text(_fmt(r['startedAt']), style: TextStyle(color: t.subText, fontSize: 11)),
                                  ]),
                                  const SizedBox(height: 8),
                                  Text(_svc.str(r['title']), style: TextStyle(color: t.text, fontSize: 15, fontWeight: FontWeight.w600)),
                                  const SizedBox(height: 4),
                                  Text('主播：${_svc.str(r['hostNickname'])} · 观看 ${_svc.toInt(r['viewerCount'])} · 点赞 ${_svc.toInt(r['likeCount'])}', style: TextStyle(color: t.subText, fontSize: 12)),
                                ]),
                              ),
                            );
                          },
                        ),
        ),
      ]),
    );
  }
}

class _LiveRoomView extends StatefulWidget {
  const _LiveRoomView({required this.svc, required this.room, this.isHost = false, required this.config});
  final MediaService svc;
  final Map<String, dynamic> room;
  final bool isHost;
  final AppConfig config;
  @override
  State<_LiveRoomView> createState() => _LiveRoomViewState();
}

class _LiveRoomViewState extends State<_LiveRoomView> {
  late final MediaService svc = widget.svc;
  late Map<String, dynamic> _room;
  final _chatCtl = TextEditingController();
  final List<Map<String, dynamic>> _chats = [];
  Timer? _poll;
  bool _loading = true;

  AppTheme get _t => widget.config.theme;

  bool get _live => _room['status'] == 'live';

  @override
  void initState() {
    super.initState();
    _room = widget.room;
    _loadRoom();
    _pollChats();
    if (_live) _poll = Timer.periodic(const Duration(seconds: 2), (_) => _pollChats());
  }

  Future<void> _loadRoom() async {
    try {
      final r = await svc.liveRoom(svc.toInt(_room['id']));
      if (mounted) setState(() {
        _room = r;
      });
    } catch (e) {
      // 单次拉取失败不打断；轮询会自动补齐
    }
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _pollChats() async {
    try {
      final rows = await svc.liveChat(svc.toInt(_room['id']));
      if (!mounted) return;
      // 只追加新弹幕
      final existing = _chats.map((c) => svc.toInt(c['id'])).toSet();
      final fresh = rows.where((c) => !existing.contains(svc.toInt(c['id']))).toList();
      if (fresh.isNotEmpty) setState(() => _chats.addAll(fresh));
    } catch (_) {}
  }

  Future<void> _send() async {
    final t = _chatCtl.text.trim();
    if (t.isEmpty) return;
    _chatCtl.clear();
    try {
      await svc.sendChat(svc.toInt(_room['id']), t);
      _pollChats();
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('发送失败：$e')));
    }
  }

  Future<void> _end() async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('结束直播'),
        content: const Text('可以填写回放地址（HLS 或 /api/media/...，可留空）：'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('结束')),
        ],
      ),
    );
    if (confirm != true) return;
    try {
      await svc.endLive(svc.toInt(_room['id']));
      _poll?.cancel();
      if (mounted) {
        setState(() {
          _room['status'] = 'ended';
        });
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已结束直播')));
      }
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('结束失败：$e')));
    }
  }

  @override
  void dispose() {
    _poll?.cancel();
    _chatCtl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = _t;
    final streamUrl = svc.absolute(svc.str(_room['streamUrl']));
    return Scaffold(
      backgroundColor: t.bg,
      body: Column(children: [
        PageHeader(
          title: svc.str(_room['title']),
          config: widget.config,
          trailing: widget.isHost
              ? TextButton(
                  onPressed: _end,
                  style: TextButton.styleFrom(foregroundColor: t.subText),
                  child: const Text('结束'),
                )
              : null,
        ),
        Expanded(
          child: _loading
              ? Center(child: CircularProgressIndicator(color: t.subText))
              : Column(children: [
                  // 视频 / 降级：无流时显示文案
                  Container(
                    height: 200,
                    color: Colors.black,
                    alignment: Alignment.center,
                    child: streamUrl.isEmpty
                        ? Text(_live ? '主播未配置视频流\n文字 + 聊天室模式' : '回放地址未配置', textAlign: TextAlign.center, style: TextStyle(color: Colors.white70))
                        : Column(mainAxisAlignment: MainAxisAlignment.center, children: [
                            Text(_live ? '● 直播中' : '回放', style: TextStyle(color: Ux.green, fontWeight: FontWeight.w700)),
                            const SizedBox(height: 8),
                            TextButton(
                              onPressed: () => ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('视频地址：$streamUrl'))),
                              child: const Text('视频地址', style: TextStyle(color: Colors.white)),
                            ),
                          ]),
                  ),
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                    child: Row(children: [
                      InkWell(onTap: () async {
                        try {
                          await svc.likeRoom(svc.toInt(_room['id']), on: _room['likedByMe'] != true);
                          _loadRoom();
                        } catch (_) {}
                      }, child: Row(children: [
                        Icon(Icons.favorite, size: 18, color: _room['likedByMe'] == true ? Ux.green : t.subText),
                        const SizedBox(width: 4),
                        Text('${svc.toInt(_room['likeCount'])}', style: TextStyle(color: t.subText, fontSize: 12)),
                      ])),
                      const SizedBox(width: 18),
                      InkWell(onTap: () => ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('观看 ${svc.toInt(_room['viewerCount'])}'))), child: Icon(Icons.remove_red_eye_outlined, size: 18, color: t.subText)),
                    ]),
                  ),
                  Divider(height: 1, color: t.div.withValues(alpha: 0.6)),
                  Expanded(
                    child: ListView.builder(
                      padding: const EdgeInsets.all(16),
                      itemCount: _chats.length,
                      itemBuilder: (_, i) {
                        final c = _chats[i];
                        return Padding(
                          padding: const EdgeInsets.only(bottom: 6),
                          child: Text.rich(TextSpan(children: [
                            TextSpan(text: '${svc.str(c['nickname']) == '' ? '用户${c['userId']}' : svc.str(c['nickname'])}：', style: TextStyle(color: Ux.green, fontWeight: FontWeight.w600)),
                            TextSpan(text: svc.str(c['content']), style: TextStyle(color: t.text)),
                          ])),
                        );
                      },
                    ),
                  ),
                  Container(
                    padding: const EdgeInsets.fromLTRB(16, 10, 16, 16),
                    decoration: BoxDecoration(color: t.bg, border: Border(top: BorderSide(color: t.div.withValues(alpha: 0.6)))),
                    child: Row(children: [
                      Expanded(child: TextField(controller: _chatCtl, enabled: _live, style: TextStyle(color: t.text), decoration: InputDecoration(hintText: '发一条弹幕…', hintStyle: TextStyle(color: t.subText), isDense: true), onSubmitted: (_) => _send())),
                      const SizedBox(width: 8),
                      FilledButton(onPressed: _live ? _send : null, style: FilledButton.styleFrom(backgroundColor: Ux.green, foregroundColor: Colors.white), child: const Text('发送')),
                    ]),
                  ),
                ]),
        ),
      ]),
    );
  }
}
