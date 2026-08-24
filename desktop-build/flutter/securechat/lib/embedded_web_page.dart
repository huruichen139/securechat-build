import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';
import 'services/app_config.dart';

class EmbeddedWebPage extends StatelessWidget {
  const EmbeddedWebPage({super.key, required this.title, required this.url, required this.config});
  final String title;
  final String url;
  final AppConfig config;

  @override
  Widget build(BuildContext context) {
    final t = config.theme;
    return Scaffold(
      backgroundColor: t.bg,
      appBar: AppBar(
        backgroundColor: t.panel,
        foregroundColor: t.text,
        title: Text(title, style: TextStyle(color: t.text, fontSize: 16)),
        leading: IconButton(
          icon: Icon(Icons.arrow_back_ios, color: t.text),
          onPressed: () => Navigator.pop(context),
        ),
      ),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(_iconForTitle(title), size: 64, color: t.subText.withValues(alpha: 0.5)),
              const SizedBox(height: 16),
              Text(title, style: TextStyle(color: t.text, fontSize: 22, fontWeight: FontWeight.w700)),
              const SizedBox(height: 8),
              Text(url, style: TextStyle(color: t.subText, fontSize: 13)),
              const SizedBox(height: 24),
              SizedBox(
                width: 280,
                child: FilledButton.icon(
                  onPressed: () async {
                    try { await launchUrl(Uri.parse(url), mode: LaunchMode.platformDefault); } catch (_) { if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('无法打开链接'))); }
                  },
                  icon: const Icon(Icons.open_in_new, size: 18),
                  label: const Text('在浏览器中打开'),
                  style: FilledButton.styleFrom(backgroundColor: const Color(0xff07c160), padding: const EdgeInsets.symmetric(vertical: 12)),
                ),
              ),
              const SizedBox(height: 12),
              OutlinedButton.icon(
                onPressed: () {
                  final ctrl = TextEditingController(text: url);
                  showDialog(context: context, builder: (_) => AlertDialog(
                    title: const Text('复制链接'),
                    content: TextField(controller: ctrl, readOnly: true, decoration: const InputDecoration(border: OutlineInputBorder())),
                    actions: [
                      TextButton(onPressed: () => Navigator.pop(context), child: const Text('关闭')),
                      FilledButton(onPressed: () async { ctrl.selection = TextSelection(baseOffset: 0, extentOffset: url.length); await Clipboard.setData(ClipboardData(text: url)); if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已复制'))); Navigator.of(context).pop(); }, child: const Text('全选复制')),
                    ],
                  ));
                },
                icon: const Icon(Icons.copy, size: 18),
                label: const Text('复制链接'),
              ),
            ],
          ),
        ),
      ),
    );
  }

  IconData _iconForTitle(String title) {
    if (title.contains('AI') || title.contains('中转')) return Icons.psychology_outlined;
    if (title.contains('网盘') || title.contains('云')) return Icons.cloud_outlined;
    if (title.contains('服务器') || title.contains('管理') || title.contains('MC')) return Icons.dns_outlined;
    return Icons.language;
  }
}
