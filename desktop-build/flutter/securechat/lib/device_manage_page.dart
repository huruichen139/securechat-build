import 'package:flutter/material.dart';

import 'services/app_config.dart';
import 'services/securechat_api.dart';
import 'widgets/ux.dart';

class DeviceManagePage extends StatefulWidget {
  const DeviceManagePage({super.key, required this.api, required this.config});

  final SecureChatApi api;
  final AppConfig config;

  @override
  State<DeviceManagePage> createState() => _DeviceManagePageState();
}

class _DeviceManagePageState extends State<DeviceManagePage> {
  List<Map<String, dynamic>> _devices = [];
  bool _loading = true;
  AppTheme get _t => widget.config.theme;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final r = await widget.api.listDevices();
      final devices = (r['devices'] as List? ?? const []).cast<Map<String, dynamic>>();
      if (!mounted) return;
      setState(() {
        _devices = devices;
        _loading = false;
      });
    } catch (e) {
      if (mounted) {
        setState(() => _loading = false);
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('加载设备失败：$e')));
      }
    }
  }

  Future<void> _kick(Map<String, dynamic> d) async {
    final deviceId = '${d['deviceId']}';
    final name = '${d['deviceName'] ?? '设备'}';
    final isCurrent = deviceId == widget.api.deviceId;
    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: _t.card,
        title: Text('移除设备', style: TextStyle(color: _t.text)),
        content: Text(
          isCurrent ? '这是当前设备，移除前请确认。' : '确定要移除「$name」吗？移除后该设备需重新登录。',
          style: TextStyle(color: _t.subText),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Colors.redAccent),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('移除'),
          ),
        ],
      ),
    );
    if (confirm != true) return;
    try {
      await widget.api.kickDevice(deviceId);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('已移除「$name」')));
      }
      await _load();
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('移除失败：$e')));
    }
  }

  Future<void> _refresh() async {
    setState(() => _loading = true);
    await _load();
  }

  String _iconFor(String type) {
    switch (type) {
      case 'android':
        return '📱';
      case 'ios':
        return '🍎';
      case 'macos':
        return '💻';
      case 'linux':
      case 'desktop':
        return '🖥️';
      default:
        return '📟';
    }
  }

  String _fmtTime(int ms) {
    if (ms <= 0) return '';
    final dt = DateTime.fromMillisecondsSinceEpoch(ms);
    final now = DateTime.now();
    String pad(int n) => n.toString().padLeft(2, '0');
    if (dt.year == now.year && dt.month == now.month && dt.day == now.day) {
      return '活跃于今天 ${pad(dt.hour)}:${pad(dt.minute)}';
    }
    if (dt.year == now.year) {
      return '活跃于 ${dt.month}月${dt.day}日';
    }
    return '活跃于 ${dt.year}-${pad(dt.month)}-${pad(dt.day)}';
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return Scaffold(
        backgroundColor: _t.bg,
        appBar: AppBar(backgroundColor: _t.bg, title: Text('登录设备管理', style: TextStyle(color: _t.text)), iconTheme: IconThemeData(color: _t.text)),
        body: const Center(child: CircularProgressIndicator()),
      );
    }
    return Scaffold(
      backgroundColor: _t.bg,
      appBar: AppBar(
        backgroundColor: _t.bg,
        title: Text('登录设备管理', style: TextStyle(color: _t.text)),
        iconTheme: IconThemeData(color: _t.text),
        actions: [
          IconButton(icon: const Icon(Icons.refresh), color: _t.text, onPressed: _refresh),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _refresh,
        color: Ux.green,
        child: ListView(
          padding: const EdgeInsets.all(12),
          children: [
            SectionCard(config: widget.config, padding: const EdgeInsets.all(14), children: [
              Text('受信设备', style: TextStyle(color: _t.text, fontWeight: FontWeight.w700)),
              const SizedBox(height: 6),
              Text(
                '以下是登录过你账号的设备。你可以移除不再使用的设备，移除后该设备需要重新扫码登录。',
                style: TextStyle(color: _t.subText, fontSize: 12, height: 1.5),
              ),
            ]),
            const SizedBox(height: 10),
            if (_devices.isEmpty)
              Padding(
                padding: const EdgeInsets.all(24),
                child: Column(children: [
                  Icon(Icons.devices_other_outlined, size: 56, color: _t.subText.withValues(alpha: 0.5)),
                  const SizedBox(height: 12),
                  Text('暂无其他登录设备', style: TextStyle(color: _t.subText)),
                ]),
              )
            else
              ..._devices.map((d) {
                final isCurrent = '${d['deviceId']}' == widget.api.deviceId;
                return Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: Card(
                    color: _t.card,
                    elevation: 0,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(Ux.cardRadius),
                      side: BorderSide(color: isCurrent ? Ux.green.withValues(alpha: 0.4) : Colors.transparent),
                    ),
                    child: ListTile(
                      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 4),
                      leading: Container(
                        width: 44,
                        height: 44,
                        decoration: BoxDecoration(
                          color: Ux.cellIconBg(_t),
                          borderRadius: BorderRadius.circular(10),
                        ),
                        child: Center(
                          child: Text(_iconFor('${d['deviceType'] ?? ''}'), style: const TextStyle(fontSize: 22)),
                        ),
                      ),
                      title: Row(children: [
                        Flexible(child: Text('${d['deviceName'] ?? '设备'}', style: TextStyle(color: _t.text, fontWeight: FontWeight.w600), overflow: TextOverflow.ellipsis)),
                        const SizedBox(width: 6),
                        if (isCurrent)
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                            decoration: BoxDecoration(color: Ux.green.withValues(alpha: 0.15), borderRadius: BorderRadius.circular(4)),
                            child: const Text('当前设备', style: TextStyle(color: Ux.green, fontSize: 11, fontWeight: FontWeight.w600)),
                          ),
                      ]),
                      subtitle: Padding(
                        padding: const EdgeInsets.only(top: 4),
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Text(
                            [
                              if (d['deviceType'] != null && '${d['deviceType']}'.isNotEmpty) '${d['deviceType']}',
                              if (d['platform'] != null && '${d['platform']}'.isNotEmpty) '${d['platform']}',
                            ].join(' · '),
                            style: TextStyle(color: _t.subText, fontSize: 12),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            '${d['lastActiveAt'] != null ? _fmtTime((d['lastActiveAt'] as num).toInt()) : '不在线'}'
                            '${d['ip'] != null && '${d['ip']}'.isNotEmpty ? ' · ${d['ip']}' : ''}',
                            style: TextStyle(color: _t.subText.withValues(alpha: 0.8), fontSize: 11),
                          ),
                        ]),
                      ),
                      trailing: _devices.length > 1 || !isCurrent
                          ? IconButton(
                              icon: const Icon(Icons.delete_outline, color: Colors.redAccent),
                              tooltip: '移除',
                              onPressed: () => _kick(d),
                            )
                          : null,
                    ),
                  ),
                );
              }),
            const SizedBox(height: 6),
            if (_devices.length > 1)
              Center(
                child: TextButton.icon(
                  onPressed: () => _kick(_devices.first),
                  icon: const Icon(Icons.logout, size: 18),
                  label: const Text('退出所有其他设备'),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
