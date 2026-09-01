import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../services/app_config.dart';
import 'ux.dart';

/// Windows 风格消息弹窗：从屏幕右侧滑入，显示消息预览
/// 支持：关闭按钮、免打扰设置、点击跳转到会话
class ToastNotification extends StatefulWidget {
  const ToastNotification({
    super.key,
    required this.sender,
    required this.content,
    required this.isGroup,
    this.groupName,
    this.onTap,
    this.onDismiss,
    this.onMute,
    this.config,
  });

  final String sender;
  final String content;
  final bool isGroup;
  final String? groupName;
  final VoidCallback? onTap;
  final VoidCallback? onDismiss;
  final VoidCallback? onMute;
  final AppConfig? config;

  @override
  State<ToastNotification> createState() => _ToastNotificationState();
}

class _ToastNotificationState extends State<ToastNotification>
    with SingleTickerProviderStateMixin {
  late AnimationController _controller;
  late Animation<Offset> _slideAnim;
  Timer? _autoDismissTimer;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 350),
    );
    _slideAnim = Tween<Offset>(
      begin: const Offset(1.0, 0.0),
      end: Offset.zero,
    ).animate(CurvedAnimation(parent: _controller, curve: Curves.easeOutCubic));
    _controller.forward();
    _autoDismissTimer = Timer(const Duration(seconds: 5), _dismiss);
  }

  void _dismiss() {
    if (!mounted) return;
    _controller.reverse().then((_) {
      widget.onDismiss?.call();
    });
  }

  @override
  void dispose() {
    _autoDismissTimer?.cancel();
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = widget.config?.theme;
    final isDark = t?.isDark ?? false;
    final bg = isDark ? const Color(0xff2c3440) : const Color(0xffffffff);
    final textC = isDark ? const Color(0xffe6eaef) : const Color(0xff17212b);
    final subC = isDark ? const Color(0xff8b96a1) : const Color(0xff77818a);

    return SlideTransition(
      position: _slideAnim,
      child: Align(
        alignment: Alignment.topRight,
        child: Padding(
          padding: const EdgeInsets.only(top: 50, right: 16),
          child: GestureDetector(
            onTap: () {
              _autoDismissTimer?.cancel();
              widget.onTap?.call();
              _dismiss();
            },
            child: Material(
              color: Colors.transparent,
              child: Container(
                width: 360,
                constraints: BoxConstraints(
                  maxHeight: MediaQuery.of(context).size.height * 0.4,
                ),
                decoration: BoxDecoration(
                  color: bg,
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(
                    color: isDark
                        ? Colors.white.withValues(alpha: 0.08)
                        : Colors.black.withValues(alpha: 0.06),
                    width: 1,
                  ),
                  boxShadow: [
                    BoxShadow(
                      color: Colors.black.withValues(alpha: isDark ? 0.4 : 0.12),
                      blurRadius: 20,
                      offset: const Offset(0, 4),
                      spreadRadius: 0,
                    ),
                  ],
                ),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    // 顶部栏：应用名 + 关闭按钮
                    Padding(
                      padding: const EdgeInsets.fromLTRB(14, 10, 8, 0),
                      child: Row(
                        children: [
                          Icon(Icons.chat_bubble_outline, size: 14, color: Ux.green),
                          const SizedBox(width: 6),
                          Expanded(
                            child: Text(
                              'SecureChat',
                              style: TextStyle(
                                color: subC,
                                fontSize: 11,
                                fontWeight: FontWeight.w500,
                              ),
                            ),
                          ),
                          // 免打扰按钮
                          if (widget.onMute != null)
                            GestureDetector(
                              onTap: () {
                                _autoDismissTimer?.cancel();
                                widget.onMute?.call();
                                _dismiss();
                              },
                              child: Padding(
                                padding: const EdgeInsets.symmetric(horizontal: 6),
                                child: Icon(Icons.notifications_off_outlined, size: 14, color: subC),
                              ),
                            ),
                          // 关闭按钮
                          GestureDetector(
                            onTap: () {
                              _autoDismissTimer?.cancel();
                              _dismiss();
                            },
                            child: Padding(
                              padding: const EdgeInsets.symmetric(horizontal: 6),
                              child: Icon(Icons.close, size: 14, color: subC),
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 6),
                    // 消息内容区域
                    Padding(
                      padding: const EdgeInsets.fromLTRB(14, 0, 14, 12),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          // 发送者头像占位（圆形字母头像）
                          CircleAvatar(
                            radius: 18,
                            backgroundColor: Ux.green.withValues(alpha: 0.15),
                            child: Text(
                              widget.sender.isNotEmpty ? widget.sender[0].toUpperCase() : '?',
                              style: TextStyle(
                                color: Ux.green,
                                fontSize: 15,
                                fontWeight: FontWeight.bold,
                              ),
                            ),
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                // 发送者名称 + 群名
                                Row(
                                  children: [
                                    Flexible(
                                      child: Text(
                                        widget.sender,
                                        style: TextStyle(
                                          color: textC,
                                          fontSize: 13,
                                          fontWeight: FontWeight.w600,
                                        ),
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                      ),
                                    ),
                                    if (widget.isGroup && widget.groupName != null) ...[
                                      Padding(
                                        padding: const EdgeInsets.only(left: 6),
                                        child: Text(
                                          widget.groupName!,
                                          style: TextStyle(color: subC, fontSize: 11),
                                          maxLines: 1,
                                          overflow: TextOverflow.ellipsis,
                                        ),
                                      ),
                                    ],
                                  ],
                                ),
                                const SizedBox(height: 3),
                                // 消息预览
                                Text(
                                  widget.content,
                                  style: TextStyle(
                                    color: subC,
                                    fontSize: 12,
                                    height: 1.3,
                                  ),
                                  maxLines: 2,
                                  overflow: TextOverflow.ellipsis,
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// 弹窗管理器：管理弹窗队列，最多同时显示 3 个
class ToastManager {
  static final ToastManager _instance = ToastManager._();
  factory ToastManager() => _instance;
  ToastManager._();

  final List<_ToastEntry> _queue = [];
  int _maxVisible = 3;
  bool _globalMuted = false;
  OverlayEntry? _overlay;

  bool get isMuted => _globalMuted;
  set isMuted(bool v) => _globalMuted = v;

  void show({
    required BuildContext context,
    required String sender,
    required String content,
    required bool isGroup,
    String? groupName,
    VoidCallback? onTap,
    AppConfig? config,
  }) {
    if (_globalMuted) return;

    final overlay = Overlay.of(context);
    late OverlayEntry entry;

    entry = OverlayEntry(
      builder: (ctx) => ToastNotification(
        sender: sender,
        content: content,
        isGroup: isGroup,
        groupName: groupName,
        config: config,
        onTap: onTap,
        onDismiss: () {
          entry.remove();
          _queue.removeWhere((e) => e.entry == entry);
          _showNext(context);
        },
        onMute: () {
          _globalMuted = true;
        },
      ),
    );

    if (_queue.length >= _maxVisible) {
      // 移除最早的一个
      final oldest = _queue.removeAt(0);
      oldest.entry.remove();
    }

    _queue.add(_ToastEntry(entry: entry));
    overlay.insert(entry);
  }

  void _showNext(BuildContext context) {
    // 队列中如果有等待显示的，可以在这里处理
  }

  void dismissAll() {
    for (final e in _queue) {
      e.entry.remove();
    }
    _queue.clear();
  }
}

class _ToastEntry {
  final OverlayEntry entry;
  _ToastEntry({required this.entry});
}
