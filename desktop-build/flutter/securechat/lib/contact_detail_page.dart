import 'dart:convert';

import 'package:flutter/material.dart';

import 'services/securechat_api.dart';
import 'services/app_config.dart';
import 'widgets/ux.dart';

/// 联系人详情页 - 点击联系人时展示对方资料
class ContactDetailPage extends StatefulWidget {
  const ContactDetailPage({
    super.key,
    required this.api,
    required this.config,
    required this.userId,
    required this.name,
    this.isGroup = false,
    this.onOpenChat,
  });

  final SecureChatApi api;
  final AppConfig config;
  final int userId;
  final String name;
  final bool isGroup;
  final VoidCallback? onOpenChat;

  @override
  State<ContactDetailPage> createState() => _ContactDetailPageState();
}

class _ContactDetailPageState extends State<ContactDetailPage> {
  Map<String, dynamic>? _profile;
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadProfile();
  }

  Future<void> _loadProfile() async {
    try {
      final data = await widget.api.userProfile(widget.userId);
      if (!mounted) return;
      setState(() { _profile = data; _loading = false; });
    } catch (e) {
      if (!mounted) return;
      setState(() { _loading = false; _error = e.toString(); });
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = widget.config.theme;
    return Scaffold(
      backgroundColor: t.bg,
      appBar: AppBar(
        backgroundColor: t.bg,
        elevation: 0,
        leading: IconButton(
          icon: Icon(Icons.arrow_back, color: t.text),
          onPressed: () => Navigator.pop(context),
        ),
        title: Text('联系人资料', style: TextStyle(color: t.text, fontSize: 17, fontWeight: FontWeight.w600)),
        centerTitle: true,
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: Ux.green))
          : _error != null
              ? Center(child: Text(_error!, style: TextStyle(color: t.subText)))
              : _buildBody(t),
    );
  }

  Widget _buildBody(AppTheme t) {
    final p = _profile ?? {};
    final name = (p['name'] as String?) ?? widget.name;
    final signature = (p['extra'] is Map ? p['extra']['signature'] as String? : null) ?? '';
    final region = _buildRegion(p);
    final uid = p['uid']?.toString() ?? p['id']?.toString() ?? '';
    final avatar = p['avatar'] as String?;
    final online = p['online'] as bool? ?? false;

    return ListView(
      children: [
        const SizedBox(height: 8),
        // 头像 + 名字 + 在线状态
        Container(
          margin: const EdgeInsets.symmetric(horizontal: 16),
          padding: const EdgeInsets.all(20),
          decoration: BoxDecoration(
            color: t.card,
            borderRadius: BorderRadius.circular(Ux.cardRadius),
          ),
          child: Column(
            children: [
              Stack(
                alignment: Alignment.bottomRight,
                children: [
                  _buildAvatar(avatar, name, 64),
                  if (online)
                    Container(
                      width: 14, height: 14,
                      decoration: BoxDecoration(
                        color: Ux.green,
                        shape: BoxShape.circle,
                        border: Border.all(color: t.card, width: 2),
                      ),
                    ),
                ],
              ),
              const SizedBox(height: 12),
              Text(name, style: TextStyle(color: t.text, fontSize: 20, fontWeight: FontWeight.w700)),
              if (uid.isNotEmpty) ...[
                const SizedBox(height: 4),
                Text('ID: $uid', style: TextStyle(color: t.subText, fontSize: 13)),
              ],
              if (signature.isNotEmpty) ...[
                const SizedBox(height: 8),
                Text(signature, style: TextStyle(color: t.subText, fontSize: 13), textAlign: TextAlign.center),
              ],
              if (region.isNotEmpty) ...[
                const SizedBox(height: 4),
                Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(Icons.location_on_outlined, size: 14, color: t.subText),
                    const SizedBox(width: 4),
                    Text(region, style: TextStyle(color: t.subText, fontSize: 12)),
                  ],
                ),
              ],
            ],
          ),
        ),
        const SizedBox(height: 12),
        // 功能按钮
        Container(
          margin: const EdgeInsets.symmetric(horizontal: 16),
          decoration: BoxDecoration(
            color: t.card,
            borderRadius: BorderRadius.circular(Ux.cardRadius),
          ),
          child: Column(
            children: [
              _buildActionRow(t, Icons.chat_bubble_outline, '发消息', () {
                Navigator.pop(context);
                widget.onOpenChat?.call();
              }),
              if (!widget.isGroup) ...[
                Divider(height: 1, indent: 56, color: t.div),
                _buildActionRow(t, Icons.call_outlined, '语音通话', () {
                  Navigator.pop(context);
                  // TODO: initiate voice call
                }),
                Divider(height: 1, indent: 56, color: t.div),
                _buildActionRow(t, Icons.videocam_outlined, '视频通话', () {
                  Navigator.pop(context);
                  // TODO: initiate video call
                }),
              ],
            ],
          ),
        ),
        const SizedBox(height: 12),
        // 更多操作
        Container(
          margin: const EdgeInsets.symmetric(horizontal: 16),
          decoration: BoxDecoration(
            color: t.card,
            borderRadius: BorderRadius.circular(Ux.cardRadius),
          ),
          child: Column(
            children: [
              _buildActionRow(t, Icons.photo_outlined, '朋友圈', null),
              Divider(height: 1, indent: 56, color: t.div),
              _buildActionRow(t, Icons.label_outline, '设置备注和标签', null),
              Divider(height: 1, indent: 56, color: t.div),
              _buildActionRow(t, Icons.more_horiz, '更多', null),
            ],
          ),
        ),
        const SizedBox(height: 32),
      ],
    );
  }

  Widget _buildAvatar(String? avatar, String name, double size) {
    if (avatar != null && avatar.isNotEmpty) {
      try {
        String raw = avatar;
        if (raw.contains(',')) raw = raw.split(',').last;
        final bytes = base64Decode(raw);
        return ClipRRect(
          borderRadius: BorderRadius.circular(size / 2),
          child: Image.memory(bytes, width: size, height: size, fit: BoxFit.cover),
        );
      } catch (_) {}
    }
    return CircleAvatar(
      radius: size / 2,
      backgroundColor: Ux.green.withValues(alpha: 0.14),
      child: Text(name.isNotEmpty ? name[0].toUpperCase() : '?',
          style: const TextStyle(color: Ux.green, fontSize: 28, fontWeight: FontWeight.w700)),
    );
  }

  Widget _buildActionRow(AppTheme t, IconData icon, String label, VoidCallback? onTap) {
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        child: Row(
          children: [
            Icon(icon, size: 22, color: onTap != null ? t.text : t.subText),
            const SizedBox(width: 12),
            Expanded(child: Text(label, style: TextStyle(
              color: onTap != null ? t.text : t.subText,
              fontSize: 15,
            ))),
            if (onTap != null) Icon(Icons.chevron_right, size: 20, color: t.subText),
          ],
        ),
      ),
    );
  }

  String _buildRegion(Map<String, dynamic> p) {
    final parts = <String>[];
    if (p['country'] != null && (p['country'] as String).isNotEmpty) parts.add(p['country'] as String);
    if (p['province'] != null && (p['province'] as String).isNotEmpty) parts.add(p['province'] as String);
    if (p['city'] != null && (p['city'] as String).isNotEmpty) parts.add(p['city'] as String);
    return parts.join(' ');
  }
}
