import 'package:flutter/material.dart';

import 'services/app_config.dart';
import 'widgets/ux.dart';

class ReadPage extends StatefulWidget {
  const ReadPage({super.key, required this.config});
  final AppConfig config;

  @override
  State<ReadPage> createState() => _ReadPageState();
}

class _ReadPageState extends State<ReadPage> {
  static const _cats = ['全部', '科技', '财经', '社会', '体育', '生活', '娱乐'];
  static const _feed = [
    {'cat': '科技', 'title': 'AI 大模型最新进展：多模态能力再突破', 'src': '科技日报', 'time': '2小时前', 'summary': '新一代多模态大模型在图像理解、代码生成和长文本推理方面取得显著进展，准确率提升 23%。', 'read': '12.5万'},
    {'cat': '财经', 'title': '央行发布最新货币政策报告', 'src': '新华财经', 'time': '3小时前', 'summary': '报告指出将继续实施稳健的货币政策，保持流动性合理充裕，促进综合融资成本稳中有降。', 'read': '8.3万'},
    {'cat': '社会', 'title': '全国高铁里程突破 4.5 万公里', 'src': '人民日报', 'time': '5小时前', 'summary': '随着多条新线路开通运营，全国高铁营业里程再创新高，覆盖 95% 以上百万人口城市。', 'read': '23.1万'},
    {'cat': '体育', 'title': '国足世预赛最新战报', 'src': '体坛周报', 'time': '6小时前', 'summary': '在昨晚的世预赛亚洲区比赛中，国家队凭借下半场两粒进球取得关键胜利，小组出线形势明朗。', 'read': '45.2万'},
    {'cat': '生活', 'title': '秋季养生指南：这些食物最养肺', 'src': '健康时报', 'time': '8小时前', 'summary': '入秋后气候干燥，专家推荐梨、百合、银耳、蜂蜜等润肺食材，搭配适量运动增强免疫力。', 'read': '6.7万'},
    {'cat': '国际', 'title': '全球气候大会达成新共识', 'src': '环球时报', 'time': '12小时前', 'summary': '各方就减排目标、资金支持和技术转移等核心议题达成一致，将加速可再生能源部署。', 'read': '15.9万'},
    {'cat': '娱乐', 'title': '国庆档电影票房破 30 亿', 'src': '猫眼电影', 'time': '1天前', 'summary': '多部大片同台竞技，主旋律影片领跑票房榜，观影人次超 8000 万，创下近年新高。', 'read': '31.4万'},
    {'cat': '科技', 'title': '国产芯片制造工艺取得新进展', 'src': '半导体行业观察', 'time': '1天前', 'summary': '国内半导体企业在先进制程量产方面取得突破，良率稳步提升，国产替代进程加速推进。', 'read': '9.8万'},
    {'cat': '教育', 'title': '2025 考研报名时间公布', 'src': '中国教育报', 'time': '1天前', 'summary': '教育部发布考研日程安排，网上预报名将于本月启动，全国预计报考人数超 500 万。', 'read': '7.2万'},
    {'cat': '汽车', 'title': '新能源汽车销量连续多月增长', 'src': '汽车之家', 'time': '2天前', 'summary': '最新数据显示新能源汽车渗透率突破 45%，多款新车型上市带动市场需求持续旺盛。', 'read': '5.6万'},
  ];

  String _cur = '全部';

  @override
  Widget build(BuildContext context) {
    final t = (widget.config).theme;
    final list = _cur == '全部' ? _feed : _feed.where((f) => f['cat']! == _cur).toList();
    return Scaffold(
      backgroundColor: t.bg,
      body: Column(children: [
        PageHeader(title: '看一看', config: widget.config),
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
                        child: Text(f['cat']!, style: TextStyle(color: Ux.green, fontSize: 11)),
                      ),
                      const SizedBox(height: 8),
                      Text(f['title']!, style: TextStyle(color: t.text, fontSize: 15, fontWeight: FontWeight.w600)),
                      const SizedBox(height: 6),
                      Text(f['summary']!, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.subText, fontSize: 13, height: 1.4)),
                      const SizedBox(height: 8),
                      Row(children: [
                        Text(f['src']!, style: TextStyle(color: t.subText, fontSize: 11)),
                        const SizedBox(width: 10),
                        Text(f['time']!, style: TextStyle(color: t.subText, fontSize: 11)),
                        const Spacer(),
                        Text('${f['read']!} 阅读', style: TextStyle(color: t.subText, fontSize: 11)),
                      ]),
                    ]),
                  ),
                ),
              );
            },
          ),
        ),
      ]),
    );
  }

  void _openArticle(Map<String, String> f, AppTheme t) {
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
                child: Text(f['cat']!, style: TextStyle(color: Ux.green, fontSize: 11)),
              ),
              const Spacer(),
              IconButton(icon: const Icon(Icons.close, size: 18), onPressed: () => Navigator.pop(ctx)),
            ]),
            const SizedBox(height: 4),
            Text(f['title']!, style: TextStyle(color: t.text, fontSize: 18, fontWeight: FontWeight.w700)),
            const SizedBox(height: 6),
            Text('${f['src']!} · ${f['time']!} · ${f['read']!} 阅读', style: TextStyle(color: t.subText, fontSize: 12)),
            const SizedBox(height: 14),
            SingleChildScrollView(
              child: Text(f['summary']!, style: TextStyle(color: t.text, fontSize: 14, height: 1.7)),
            ),
          ]),
        ),
      ),
    );
  }
}