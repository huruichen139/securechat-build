import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import 'services/app_config.dart';
import 'services/securechat_api.dart';
import 'widgets/ux.dart';

class ReadPage extends StatefulWidget {
  const ReadPage({super.key, required this.config, this.api});
  final AppConfig config;
  final SecureChatApi? api;

  @override
  State<ReadPage> createState() => _ReadPageState();
}

class _ReadPageState extends State<ReadPage> {
  static const _fallback = <Map<String, dynamic>>[
    {'cat': '科技', 'title': 'AI 大模型最新进展：多模态能力再突破', 'src': '科技日报', 'time': '2小时前', 'summary': '新一代多模态大模型在图像理解、代码生成和长文本推理方面取得显著进展，准确率提升 23%。', 'read': '12.5万'},
    {'cat': '财经', 'title': '央行发布最新货币政策报告', 'src': '新华财经', 'time': '3小时前', 'summary': '报告指出将继续实施稳健的货币政策，保持流动性合理充裕，促进综合融资成本稳中有降。', 'read': '8.3万'},
    {'cat': '社会', 'title': '全国高铁里程突破 4.5 万公里', 'src': '人民日报', 'time': '5小时前', 'summary': '随着多条新线路开通运营，全国高铁营业里程再创新高，覆盖 95% 以上百万人口城市。', 'read': '23.1万'},
    {'cat': '体育', 'title': '国足世预赛最新战报', 'src': '体坛周报', 'time': '6小时前', 'summary': '在昨晚的世预赛亚洲区比赛中，国家队凭借下半场两粒进球取得关键胜利，小组出线形势明朗。', 'read': '45.2万'},
    {'cat': '娱乐', 'title': '国庆档电影票房破 30 亿', 'src': '猫眼电影', 'time': '1天前', 'summary': '多部大片同台竞技，主旋律影片领跑票房榜，观影人次超 8000 万，创下近年新高。', 'read': '31.4万'},
  ];

  List<Map<String, dynamic>> _feed = const [];
  List<String> _cats = const ['全部'];
  String _cur = '全部';
  bool _loading = true;
  String? _error;

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
      if (widget.api == null) {
        _feed = _fallback;
        _cats = ['全部', '科技', '财经', '社会', '体育', '娱乐'];
      } else {
        final list = await widget.api!.feedsNews();
        if (list.isEmpty) {
          _feed = _fallback;
          _cats = ['全部', '科技', '财经', '社会', '体育', '娱乐'];
        } else {
          _feed = list;
          final cats = <String>['全部'];
          for (final f in list) {
            final c = (f['cat'] ?? '').toString();
            if (c.isNotEmpty && !cats.contains(c)) cats.add(c);
          }
          _cats = cats;
        }
      }
    } catch (e) {
      _error = e.toString().replaceFirst('Bad state: ', '');
      _feed = _fallback;
      _cats = ['全部', '科技', '财经', '社会', '体育', '娱乐'];
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _openUrl(String? url) async {
    if (url == null || url.isEmpty) return;
    final uri = Uri.tryParse(url);
    if (uri == null) return;
    try {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    final t = (widget.config).theme;
    final list = _cur == '全部' ? _feed : _feed.where((f) => (f['cat'] ?? '').toString() == _cur).toList();
    return Scaffold(
      backgroundColor: t.bg,
      body: Column(children: [
        PageHeader(title: '看一看', config: widget.config, trailing: IconButton(
          tooltip: '刷新',
          icon: Icon(Icons.refresh_rounded, color: t.subText, size: 20),
          onPressed: _loading ? null : _load,
        )),
        SizedBox(
          height: 40,
          child: ListView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 12),
            children: [
              for (final c in _cats)
                Padding(
                  padding: const EdgeInsets.only(right: 8),
                  child: ChoiceChip(
                    label: Text(c, style: TextStyle(fontSize: 12, color: _cur == c ? Colors.white : t.text)),
                    selected: _cur == c,
                    selectedColor: Ux.green,
                    backgroundColor: t.inputBg,
                    onSelected: (_) => setState(() => _cur = c),
                    labelPadding: const EdgeInsets.symmetric(horizontal: 6),
                  ),
                ),
            ],
          ),
        ),
        Expanded(
          child: _loading
              ? Center(child: CircularProgressIndicator(color: Ux.green))
              : list.isEmpty
                  ? Center(
                      child: Column(mainAxisSize: MainAxisSize.min, children: [
                        Icon(Icons.inbox_outlined, color: t.subText, size: 48),
                        const SizedBox(height: 8),
                        Text(_error ?? '该分类暂无资讯', style: TextStyle(color: t.subText, fontSize: 13)),
                      ]),
                    )
                  : RefreshIndicator(
                      color: Ux.green,
                      onRefresh: _load,
                      child: ListView.builder(
                        padding: const EdgeInsets.all(12),
                        itemCount: list.length,
                        itemBuilder: (_, i) {
                          final f = list[i];
                          return Card(
                            margin: const EdgeInsets.only(bottom: 10),
                            color: t.card,
                            child: InkWell(
                              borderRadius: BorderRadius.circular(Ux.cardRadius),
                              onTap: () => _openArticle(f, t),
                              child: Padding(
                                padding: const EdgeInsets.all(14),
                                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                  Container(
                                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                                    decoration: BoxDecoration(color: Ux.green.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(4)),
                                    child: Text((f['cat'] ?? '').toString(), style: TextStyle(color: Ux.green, fontSize: 11)),
                                  ),
                                  const SizedBox(height: 8),
                                  Text((f['title'] ?? '').toString(), style: TextStyle(color: t.text, fontSize: 15, fontWeight: FontWeight.w600)),
                                  const SizedBox(height: 6),
                                  Text((f['summary'] ?? '').toString(), maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.subText, fontSize: 13, height: 1.4)),
                                  const SizedBox(height: 8),
                                  Row(children: [
                                    Text((f['src'] ?? '').toString(), style: TextStyle(color: t.subText, fontSize: 11)),
                                    const SizedBox(width: 10),
                                    Text((f['time'] ?? '').toString(), style: TextStyle(color: t.subText, fontSize: 11)),
                                    const Spacer(),
                                    if ((f['read'] ?? '').toString().isNotEmpty)
                                      Text('${f['read']} 阅读', style: TextStyle(color: t.subText, fontSize: 11)),
                                  ]),
                                ]),
                              ),
                            ),
                          );
                        },
                      ),
                    ),
        ),
      ]),
    );
  }

  void _openArticle(Map<String, dynamic> f, AppTheme t) {
    final url = (f['url'] ?? '').toString();
    showDialog(
      context: context,
      builder: (ctx) => Dialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        child: Container(
          width: 560,
          constraints: const BoxConstraints(maxHeight: 560),
          padding: const EdgeInsets.all(20),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                decoration: BoxDecoration(color: Ux.green.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(4)),
                child: Text((f['cat'] ?? '').toString(), style: TextStyle(color: Ux.green, fontSize: 11)),
              ),
              const Spacer(),
              IconButton(icon: const Icon(Icons.close, size: 18), onPressed: () => Navigator.pop(ctx)),
            ]),
            const SizedBox(height: 4),
            Text((f['title'] ?? '').toString(), style: TextStyle(color: t.text, fontSize: 18, fontWeight: FontWeight.w700)),
            const SizedBox(height: 6),
            Text('${f['src'] ?? ''} · ${f['time'] ?? ''}${(f['read'] ?? '').toString().isNotEmpty ? ' · ${f['read']} 阅读' : ''}', style: TextStyle(color: t.subText, fontSize: 12)),
            const SizedBox(height: 14),
            Flexible(
              child: SingleChildScrollView(
                child: Text((f['summary'] ?? '').toString(), style: TextStyle(color: t.text, fontSize: 14, height: 1.7)),
              ),
            ),
            if (url.isNotEmpty) ...[
              const SizedBox(height: 12),
              Align(
                alignment: Alignment.centerRight,
                child: FilledButton.icon(
                  onPressed: () { Navigator.pop(ctx); _openUrl(url); },
                  icon: const Icon(Icons.open_in_new_rounded, size: 18),
                  label: const Text('打开原文'),
                ),
              ),
            ],
          ]),
        ),
      ),
    );
  }
}
