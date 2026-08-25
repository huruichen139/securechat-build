// module: pay (worker batch6)
// 钱包增强入口页：收付款码、付款码收款/付款、转账、群收款+接龙、生活缴费/手机充值、钱包账单。
// 独立文件，不改动 wallet_page.dart / securechat_api.dart；复用 SecureChatApi 的 baseUrl/token。
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:file_picker/file_picker.dart';
import 'package:http/http.dart' as http;

import 'services/securechat_api.dart';
import 'services/app_config.dart';
import 'widgets/ux.dart';

class WalletExtraPage extends StatefulWidget {
  const WalletExtraPage({super.key, required this.api, required this.config});
  final SecureChatApi api;
  final dynamic config;

  @override
  State<WalletExtraPage> createState() => _WalletExtraPageState();
}

class _WalletExtraPageState extends State<WalletExtraPage> {
  final _tempControllers = <TextEditingController>[];
  TextEditingController _tc([String? text]) { final c = TextEditingController(text: text); _tempControllers.add(c); return c; }

  @override
  void dispose() { for (final c in _tempControllers) { c.dispose(); } super.dispose(); }

  String _money(num v) => v.toStringAsFixed(2);

  SecureChatApi get api => widget.api;
  String get _base => (api.baseUrl.endsWith('/') ? api.baseUrl : '${api.baseUrl}/');

  Uri _uri(String path, [Map<String, String>? q]) {
    final root = Uri.parse(_base);
    return root.replace(
      path: '${root.path.replaceAll(RegExp(r'/$'), '')}${path.startsWith('/') ? path : '/$path'}',
      queryParameters: q,
    );
  }

  Future<Map<String, dynamic>> _req(String method, String path, {Object? body, Map<String, String>? query, bool auth = true}) async {
    final headers = <String, String>{
      'Content-Type': 'application/json',
      if (auth && api.token != null) 'Authorization': 'Bearer ${api.token}',
    };
    final uri = _uri(path, query);
    final resp = switch (method) {
      'POST' => await http.post(uri, headers: headers, body: jsonEncode(body ?? const {})),
      'DELETE' => await http.delete(uri, headers: headers),
      _ => await http.get(uri, headers: headers),
    };
    Map<String, dynamic> data;
    try {
      data = jsonDecode(resp.body) as Map<String, dynamic>;
    } catch (_) {
      data = {'error': resp.body};
    }
    if (resp.statusCode < 200 || resp.statusCode >= 300) {
      throw StateError(data['error']?.toString() ?? '请求失败 (${resp.statusCode})');
    }
    return data;
  }

  double _balance = 0;
  bool _loading = true;
  List<Map<String, dynamic>> _bills = [];

  @override
  void initState() {
    super.initState();
    _reload();
  }

  Future<void> _reload() async {
    setState(() {
      _loading = true;
    });
    try {
      final w = await api.wallet();
      _balance = (w['balance'] as num?)?.toDouble() ?? 0;
      _bills = await _billsList();
    } catch (_) {}
    if (mounted) setState(() => _loading = false);
  }

  Future<List<Map<String, dynamic>>> _billsList() async {
    final data = await _req('GET', '/api/pay/bills');
    return ((data['bills'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  String _fmtTime(dynamic ms) {
    final m = ms is int ? ms : int.tryParse('$ms') ?? 0;
    if (m == 0) return '';
    final dt = DateTime.fromMillisecondsSinceEpoch(m);
    String two(int x) => x.toString().padLeft(2, '0');
    return '${dt.year}/${two(dt.month)}/${two(dt.day)} ${two(dt.hour)}:${two(dt.minute)}';
  }

  String _catLabel(String c) {
    switch (c) {
      case 'transfer': return '转账';
      case 'collect': return '群收款';
      case 'paycode': return '付款码';
      case 'receive_code': return '扫码收款';
      case 'life': return '生活缴费';
      case 'phone': return '手机充值';
      default: return c;
    }
  }

  Future<T?> _dialog<T>(Widget child) => showDialog<T>(
        context: context,
        barrierDismissible: true,
        builder: (ctx) => Dialog(child: SingleChildScrollView(child: child)),
      );

  String? _pasted;

  // ---------- 付款码 ----------
  String _err(Object e) => e.toString().replaceFirst('Bad state: ', '');

  Future<void> _showCodeView(String type, String token, String qrText) async {
    final t = widget.config.theme;
    final imgUrl = Uri.encodeFull('$_base/api/qrcode/render?text=${Uri.encodeComponent(qrText)}&w=360');
    await _dialog(Container(
      width: 320,
      padding: const EdgeInsets.all(16),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        Text(type == 'pay' ? '我的付款码（10 分钟内有效）' : '收款码', style: TextStyle(fontWeight: FontWeight.w700, color: t.text)),
        const SizedBox(height: 12),
        Image.network(imgUrl, width: 260, height: 260, errorBuilder: (_, _, _) => const Icon(Icons.qr_code, size: 200)),
        const SizedBox(height: 8),
        Text('token: $token', style: TextStyle(fontSize: 11, color: t.subText)),
      ]),
    ));
  }

  Future<void> _makePayCode() async {
    try {
      final r = await _req('POST', '/api/pay/code/pay');
      final token = (r['code'] as Map<String, dynamic>?)?['token'] ?? '';
      if (mounted) await _showCodeView('pay', token, r['qrText']?.toString() ?? 'securechat://pay?token=$token');
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('生成失败：${_err(e)}')));
    }
  }

  // ---------- 扫码入口（粘贴 token，模拟 jsqr 解码跳转） ----------
  Future<void> _scanPaste() async {
    final tkC = _tc(_pasted ?? '');
    final tok = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('扫码 / 输入码内容'),
        content: TextField(controller: tkC, autofocus: true, decoration: const InputDecoration(hintText: 'securechat://pay?... 或 token')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(onPressed: () {
            var t = tkC.text.trim();
            final m = RegExp(r'token=([^&]+)').firstMatch(t);
            if (m != null) t = Uri.decodeComponent(m.group(1)!);
            Navigator.pop(ctx, t);
          }, child: const Text('解析')),
        ],
      ),
    );
    if (tok == null || tok.isEmpty) return;
    try {
      final info = await _req('GET', '/api/pay/code/${Uri.encodeComponent(tok)}/info');
      if (!mounted) return;
      final saleType = info['type'];
      final who = saleType == 'pay' ? info['payer'] : info['receiver'];
      final whoName = (who is Map && who['nickname'] != null) ? '${who['nickname']}' : ((who is Map && who['username'] != null) ? '${who['username']}' : '对方');
      final amtC = _tc(saleType == 'receive' && info['amount'] != null ? '${info['amount']}' : '');
      final rmC = _tc();
      final doIt = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: Text(saleType == 'pay' ? '向 $whoName 收款' : '向 $whoName 付款'),
          content: Column(mainAxisSize: MainAxisSize.min, children: [
            TextField(controller: amtC, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(hintText: '金额')),
            const SizedBox(height: 10),
            TextField(controller: rmC, decoration: const InputDecoration(hintText: '备注（可选）')),
          ]),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
            FilledButton(onPressed: () => Navigator.pop(ctx, true), child: Text(saleType == 'pay' ? '确认收款' : '确认付款')),
          ],
        ),
      );
      if (doIt != true) return;
      final a = double.tryParse(amtC.text.trim());
      if (a == null || a <= 0) {
        if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('金额无效')));
        return;
      }
      final path = saleType == 'pay'
          ? '/api/pay/code/pay/${Uri.encodeComponent(tok)}/confirm'
          : '/api/pay/code/receive/${Uri.encodeComponent(tok)}/confirm';
      final r = await _req('POST', path, body: {'amount': a, 'remark': rmC.text.trim()});
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('成功，余额 ¥${_money((r['balance'] ?? 0) as num)}')));
      }
      await _reload();
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('失败：${_err(e)}')));
    }
  }

  // ---------- 转账 ----------
  Future<void> _transfer() async {
    final uidC = _tc();
    final amtC = _tc();
    final rmC = _tc();
    final doIt = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('转账好友'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: uidC, decoration: const InputDecoration(hintText: '收款人 ID (UID)')),
          const SizedBox(height: 10),
          TextField(controller: amtC, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(hintText: '金额')),
          const SizedBox(height: 10),
          TextField(controller: rmC, decoration: const InputDecoration(hintText: '备注（可选）')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('转账')),
        ],
      ),
    );
    if (doIt != true) return;
    final uid = uidC.text.trim();
    final a = double.tryParse(amtC.text.trim());
    if (uid.isEmpty || a == null || a <= 0) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('请填写 UID 和金额')));
      return;
    }
    try {
      final r = await api.transfer(uid, a, remark: rmC.text.trim());
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('转账成功，余额 ¥${_money((r['balance'] ?? 0) as num)}')));
      }
      await _reload();
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('失败：${_err(e)}')));
    }
  }

  // ---------- 群收款 ----------
  Future<void> _groupCollect() async {
    List<Map<String, dynamic>> groups = [];
    try {
      groups = await api.groups();
    } catch (_) {}
    if (!mounted) return;
    if (groups.isEmpty) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('请先加入群聊')));
      return;
    }
    final gController = _ValueDropdownController<String>();
    final gSel = _ValueDropdown<String>(
      label: '选择群',
      options: groups.map((g) => Dropdown(value: '${g['id']}', label: '${g['name'] ?? g['id']}')).toList(),
      initial: '${groups.first['id']}',
      controller: gController,
    );
    final titleC = _tc('聚餐AA');
    final amtC = _tc();
    final doIt = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('群收款'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          gSel,
          TextField(controller: titleC, decoration: const InputDecoration(labelText: '收款说明')),
          const SizedBox(height: 10),
          TextField(controller: amtC, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: '每人金额')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('发起')),
        ],
      ),
    );
    if (doIt != true) return;
    final gid = int.tryParse(gController.value ?? '');
    final a = double.tryParse(amtC.text.trim());
    if (gid == null || titleC.text.trim().isEmpty || a == null || a <= 0) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('请填写完整信息')));
      return;
    }
    try {
      final r = await _req('POST', '/api/pay/group/collect', body: {'groupId': gid, 'title': titleC.text.trim(), 'amount': a});
      final id = r['collect']?['id'];
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已发起群收款')));
        await _showCollectDetail(id);
      }
      await _reload();
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('失败：${_err(e)}')));
    }
  }

  Future<void> _showCollectDetail(int id) async {
    final t = widget.config.theme;
    try {
      final c = (await _req('GET', '/api/pay/group/collect/$id'))['collect'] as Map<String, dynamic>?;
      if (c == null) return;
      final members = (c['members'] as List?) ?? const [];
      final paid = c['viewerPaid'] == true;
      await _dialog(Container(
        width: 360,
        padding: const EdgeInsets.all(16),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('¥${c['amount']}', style: const TextStyle(fontSize: 26, fontWeight: FontWeight.w800, color: Color(0xFF07C160))),
          Text('${c['title']} · ${c['paidCount']}/${c['memberCount']} 已缴', style: TextStyle(color: t.subText)),
          if (c['status'] == 'open' && !paid) ...[
            const SizedBox(height: 12),
            FilledButton(
              onPressed: () async {
                try {
                  await _req('POST', '/api/pay/group/collect/$id/pay', body: {'remark': c['title']});
                  if (mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('缴款成功')));
                    Navigator.of(context).pop();
                    await _showCollectDetail(id);
                  }
                } catch (e) {
                  if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('缴款失败：${_err(e)}')));
                }
              },
              child: Text('立即缴款（¥${c['amount']}）'),
            ),
          ],
          const Divider(),
          ...members.map((m) {
            final mName = '${m['name'] ?? ''}';
            return ListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              leading: CircleAvatar(radius: 14, backgroundColor: Ux.cellIconBg(t), child: Text(mName.isNotEmpty ? mName.characters.first : '?', style: TextStyle(color: t.text))),
              title: Text(mName, style: TextStyle(fontSize: 13, color: t.text)),
              trailing: Text(m['paid'] == true ? '已缴' : '未缴',
                  style: TextStyle(color: m['paid'] == true ? Ux.green : t.subText, fontSize: 12)),
            );
          }),
        ]),
      ));
    } catch (_) {}
  }

  // ---------- 群接龙 ----------
  Future<void> _groupSolection() async {
    List<Map<String, dynamic>> groups = [];
    try {
      groups = await api.groups();
    } catch (_) {}
    if (!mounted) return;
    if (groups.isEmpty) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('请先加入群聊')));
      return;
    }
    final gController = _ValueDropdownController<String>();
    final gSel = _ValueDropdown<String>(
      label: '选择群',
      options: groups.map((g) => Dropdown(value: '${g['id']}', label: '${g['name'] ?? g['id']}')).toList(),
      initial: '${groups.first['id']}',
      controller: gController,
    );
    final subC = _tc('周末聚会报名');
    final doIt = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('发起群接龙'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          gSel,
          TextField(controller: subC, decoration: const InputDecoration(labelText: '接龙主题')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('发起')),
        ],
      ),
    );
    if (doIt != true) return;
    final gid = int.tryParse(gController.value ?? '');
    if (gid == null || subC.text.trim().isEmpty) return;
    try {
      final r = await _req('POST', '/api/pay/group/solection', body: {'groupId': gid, 'subject': subC.text.trim()});
      final id = r['solection']?['id'];
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已发起接龙')));
        await _showSolectionDetail(id);
      }
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('失败：${_err(e)}')));
    }
  }

  Future<void> _showSolectionDetail(int id) async {
    final t = widget.config.theme;
    try {
      final s = (await _req('GET', '/api/pay/group/solection/$id'))['solection'] as Map<String, dynamic>?;
      if (s == null) return;
      final entries = (s['entries'] as List?) ?? const [];
      final joined = entries.any((e) => e['userId'] == api.myId);
      await _dialog(Container(
        width: 360,
        padding: const EdgeInsets.all(16),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('${s['subject']}', style: TextStyle(fontWeight: FontWeight.w700, color: t.text)),
          Text('${entries.length} 人已报名', style: TextStyle(color: t.subText, fontSize: 12)),
          if (s['status'] == 'open') ...[
            const SizedBox(height: 10),
            if (joined)
              OutlinedButton(
                onPressed: () async {
                  try {
                    await _req('DELETE', '/api/pay/group/solection/$id/join');
                    if (mounted) {
                      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已取消报名')));
                      Navigator.of(context).pop();
                      await _showSolectionDetail(id);
                    }
                  } catch (e) {
                    if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('失败：${_err(e)}')));
                  }
                },
                child: const Text('取消报名'),
              )
            else
              FilledButton(
                onPressed: () async {
                  try {
                    await _req('POST', '/api/pay/group/solection/$id/join', body: {'remark': '+1'});
                    if (mounted) {
                      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('报名成功 +1')));
                      Navigator.of(context).pop();
                      await _showSolectionDetail(id);
                    }
                  } catch (e) {
                    if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('失败：${_err(e)}')));
                  }
                },
                child: const Text('报名接龙 +1'),
              ),
          ],
          const Divider(),
          ...() sync* {
            var i = 0;
            for (final e in entries) {
              yield Padding(
                padding: const EdgeInsets.symmetric(vertical: 3),
                child: Text('${++i}. ${e['name']}${(e['remark'] ?? '').toString().isNotEmpty ? '（${e['remark']}）' : ''}',
                    style: TextStyle(fontSize: 13, color: t.text)),
              );
            }
          }(),
        ]),
      ));
    } catch (_) {}
  }

  // ---------- 生活缴费 / 手机充值 ----------
  Future<void> _lifePay() async {
    Map<String, dynamic> catalog = {};
    try {
      catalog = await _req('GET', '/api/pay/life/catalog');
    } catch (_) {}
    if (!mounted) return;
    final cats = ((catalog['categories'] as List?) ?? const []);
    if (cats.isEmpty) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('缴费目录不可用')));
      return;
    }
    final catController = _ValueDropdownController<Map<String, dynamic>>();
    final catSel = _ValueDropdown<Map<String, dynamic>>(
      label: '缴费项目',
      options: cats.map((c) => Dropdown(value: c as Map<String, dynamic>, label: '${c['label']}')).toList(),
      initial: cats.first as Map<String, dynamic>,
      controller: catController,
    );
    final firstCat = cats.first as Map<String, dynamic>;
    final provController = _ValueDropdownController<String>();
    final provs = (firstCat['providers'] as List?) ?? const [];
    if (provs.isEmpty) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('该分类暂无缴费项目')));
      return;
    }
    final provSel = _ValueDropdown<String>(
      label: '机构',
      options: provs.map((p) => Dropdown(value: '$p', label: '$p')).toList(),
      initial: null,
      controller: provController,
    );
    final accC = _tc();
    final amtC = _tc();
    final doIt = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('生活缴费 / 手机充值'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          const Text('演示环境：仅扣减余额生成凭证，不产生真实到账', style: TextStyle(fontSize: 11, color: Color(0xFFB26A00))),
          const SizedBox(height: 8),
          catSel,
          provSel,
          TextField(controller: accC, decoration: const InputDecoration(labelText: '户号 / 手机号')),
          const SizedBox(height: 10),
          TextField(controller: amtC, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: '金额')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('确认缴费')),
        ],
      ),
    );
    if (doIt != true) return;
    final cat = catController.value;
    final prov = provController.value;
    final a = double.tryParse(amtC.text.trim());
    if (cat == null || prov == null || accC.text.isEmpty || a == null || a <= 0) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('请填写完整信息')));
      return;
    }
    try {
      final r = await _req('POST', '/api/pay/life/pay', body: {'category': cat['key'], 'provider': prov, 'account': accC.text.trim(), 'amount': a});
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('缴费成功，凭证 #${r['payment']?['id']}，余额 ¥${_money((r['payment']?['balance'] ?? 0) as num)}')));
      }
      await _reload();
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('缴费失败：${_err(e)}')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final cfg = widget.config as AppConfig;
    final t = cfg.theme;
    final entries = <(IconData, String, VoidCallback)>[
      (Icons.swap_horiz, '转账', _transfer),
      (Icons.real_estate_agent, '我的收款码', _myPersonalQr),
      (Icons.qr_code, '站内付款码', _makePayCode),
      (Icons.center_focus_weak, '扫码支付', _scanPaste),
      (Icons.groups, '群收款', _groupCollect),
      (Icons.view_list, '群接龙', _groupSolection),
      (Icons.redeem, '充值', _redeem),
      (Icons.home_work, '缴费充值', _lifePay),
      (Icons.real_estate_agent, '我的收款码', _myPersonalQr),
    ];
    return Scaffold(
      backgroundColor: t.bg,
      body: Column(children: [
        PageHeader(title: '支付与生活', config: cfg),
        Expanded(
          child: _loading
              ? const Center(child: CircularProgressIndicator())
              : RefreshIndicator(
                  onRefresh: _reload,
                  child: ListView(
                    padding: const EdgeInsets.all(12),
                    children: [
                      _balanceCard(cfg),
                      const SizedBox(height: 16),
                      SectionCard(
                        config: cfg,
                        padding: const EdgeInsets.all(12),
                        children: [
                          GridView.count(
                            crossAxisCount: 4,
                            shrinkWrap: true,
                            physics: const NeverScrollableScrollPhysics(),
                            mainAxisSpacing: 10,
                            crossAxisSpacing: 10,
                            childAspectRatio: 0.9,
                            children: entries.map((e) => _tile(cfg, e.$1, e.$2, e.$3)).toList(),
                          ),
                        ],
                      ),
                      SectionTitle(config: cfg, title: '钱包账单'),
                      SectionCard(
                        config: cfg,
                        children: _bills.isEmpty
                            ? [
                                Padding(
                                  padding: const EdgeInsets.symmetric(vertical: 32),
                                  child: Center(child: Text('暂无账单记录', style: TextStyle(color: t.subText))),
                                ),
                              ]
                            : [
                                for (var i = 0; i < _bills.length; i++) ...[
                                  if (i > 0) CellDivider(config: cfg, indent: 60),
                                  _billRow(cfg, _bills[i]),
                                ],
                              ],
                      ),
                      const SizedBox(height: 24),
                    ],
                  ),
                ),
        ),
      ]),
    );
  }

  // ============ 我的真实收款码（支付宝/微信）============
  Future<void> _myPersonalQr() async {
    final cfg = widget.config as AppConfig;
    await Navigator.push(context, MaterialPageRoute(builder: (_) => _PersonalQrPage(api: widget.api, config: cfg)));
    if (mounted) setState(() {});
  }

  Widget _balanceCard(AppConfig cfg) {    final t = cfg.theme;
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: t.card.withValues(alpha: 0.85),
        borderRadius: BorderRadius.circular(Ux.cardRadius),
        border: Border.all(color: t.div.withValues(alpha: 0.6)),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('我的余额（元）', style: TextStyle(fontSize: 13, color: t.subText)),
        const SizedBox(height: 6),
        Text(_balance.toStringAsFixed(2), style: TextStyle(fontSize: 34, fontWeight: FontWeight.w800, color: t.text)),
      ]),
    );
  }

  Widget _billRow(AppConfig cfg, Map<String, dynamic> b) {
    final t = cfg.theme;
    final ined = (b['kind'] ?? '').toString() == 'in';
    final amount = (b['amount'] as num?)?.toDouble() ?? 0;
    final title = '${b['title'] ?? _catLabel('${b['category']}')}';
    final peer = '${b['peerName'] ?? ''}';
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      child: Row(children: [
        Container(
          width: 34,
          height: 34,
          decoration: BoxDecoration(color: Ux.cellIconBg(t), borderRadius: BorderRadius.circular(8)),
          child: Icon(ined ? Icons.south_west : Icons.north_east, color: ined ? Ux.green : t.text, size: 18),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: TextStyle(fontSize: 15, color: t.text, fontWeight: FontWeight.w500)),
            const SizedBox(height: 2),
            Text('${_fmtTime(b['createdAt'])}${peer.isNotEmpty ? ' · $peer' : ''}',
                style: TextStyle(color: t.subText, fontSize: 12)),
          ]),
        ),
        Text('${ined ? '+' : '-'}${_money(amount)}',
            style: TextStyle(color: ined ? Ux.green : t.text, fontWeight: FontWeight.w700)),
      ]),
    );
  }

  Widget _tile(AppConfig cfg, IconData icon, String label, VoidCallback onTap) {
    final t = cfg.theme;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(Ux.radius),
      child: Container(
        decoration: BoxDecoration(color: Ux.cellIconBg(t), borderRadius: BorderRadius.circular(Ux.radius)),
        padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 4),
        child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
          Icon(icon, color: Ux.green, size: 20),
          const SizedBox(height: 6),
          Text(label, style: TextStyle(color: t.text, fontSize: 11)),
        ]),
      ),
    );
  }

  Future<void> _redeem() async {
    final c = TextEditingController();
    final code = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('兑换码充值'),
        content: TextField(controller: c, autofocus: true, decoration: const InputDecoration(hintText: '请输入兑换码')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, c.text.trim()), child: const Text('兑换')),
        ],
      ),
    );
    if (code == null || code.isEmpty) return;
    try {
      final r = await api.redeem(code);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('兑换成功，+${r['value']}')));
        await _reload();
      }
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('兑换失败：${_err(e)}')));
    }
  }
}

class Dropdown<T> {
  const Dropdown({required this.value, required this.label});
  final T value;
  final String label;
}

// 简易可控下拉框：onChanged 持久化当前值便于外部通过 controller 读取，
// 也直接回调最新选择。
class _ValueDropdown<T> extends StatefulWidget {
  const _ValueDropdown({required this.label, required this.options, this.initial, this.controller});
  final String label;
  final List<Dropdown<T>> options;
  final T? initial;
  final _ValueDropdownController<T>? controller;

  @override
  State<_ValueDropdown<T>> createState() => _ValueDropdownState<T>();
}

class _ValueDropdownState<T> extends State<_ValueDropdown<T>> {
  T? _v;
  @override
  void initState() {
    super.initState();
    _v = widget.initial ?? (widget.options.isNotEmpty ? widget.options.first.value : null);
    if (widget.controller != null) widget.controller!.value = _v;
  }

  void _onChanged(T? v) {
    setState(() => _v = v);
    if (widget.controller != null) widget.controller!.value = v;
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(widget.label, style: const TextStyle(fontSize: 12, color: Colors.grey)),
        DropdownButtonFormField<T>(
          initialValue: _v,
          items: widget.options.map((o) => DropdownMenuItem(value: o.value, child: Text(o.label))).toList(),
          onChanged: _onChanged,
          decoration: const InputDecoration(isDense: true, contentPadding: EdgeInsets.symmetric(horizontal: 10, vertical: 8)),
        ),
      ],
    );
  }
}

// ============ 我的真实收款码（支付宝/微信收款二维码）============
// 上传自己的真实收款二维码截图保存到服务器，可设置使用次数（-1=无上限），
// 全屏查看、被扫一次计数、重置、删除。
class PayQrShowPage extends StatefulWidget {
  const PayQrShowPage({super.key, required this.api, required this.config});
  final SecureChatApi api;
  final AppConfig config;
  @override
  State<PayQrShowPage> createState() => _PayQrShowPageState();
}

class _PayQrShowPageState extends State<PayQrShowPage> {
  List<Map<String, dynamic>> _codes = [];
  bool _loading = true;
  int _idx = 0;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final list = await widget.api.personalQrList();
      if (!mounted) return;
      setState(() { _codes = list; _loading = false; });
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _goManage() async {
    await Navigator.push(context, MaterialPageRoute(builder: (_) => _PersonalQrPage(api: widget.api, config: widget.config)));
    if (mounted) _load();
  }

  @override
  Widget build(BuildContext context) {
    final t = widget.config.theme;
    final hasCodes = _codes.isNotEmpty;
    final safeIdx = _codes.isEmpty ? 0 : (_idx % _codes.length);
    return Scaffold(
      backgroundColor: Colors.black87,
      body: SafeArea(
        child: Column(children: [
          Row(children: [
            IconButton(onPressed: () => Navigator.pop(context), icon: const Icon(Icons.arrow_back, color: Colors.white)),
            const Expanded(child: Text('收付款', textAlign: TextAlign.center, style: TextStyle(color: Colors.white, fontSize: 17, fontWeight: FontWeight.w600))),
            IconButton(onPressed: _goManage, icon: const Icon(Icons.settings, color: Colors.white)),
            const SizedBox(width: 8),
          ]),
          Expanded(child: _loading
              ? const Center(child: CircularProgressIndicator(color: Colors.white))
              : !hasCodes
                  ? Center(child: Column(mainAxisSize: MainAxisSize.min, children: [
                      const Icon(Icons.qr_code_2, size: 72, color: Colors.white54),
                      const SizedBox(height: 14),
                      const Text('还没有收款码', style: TextStyle(color: Colors.white70)),
                      const SizedBox(height: 6),
                      const Text('上传你的支付宝/微信真实收款码\n对方扫码即可向你付款', textAlign: TextAlign.center, style: TextStyle(color: Colors.white38, fontSize: 12)),
                      const SizedBox(height: 18),
                      FilledButton.icon(
                        onPressed: () async {
                          final ok = await showDialog<bool>(context: context, builder: (d) => AlertDialog(
                            title: const Text('生成我的收款码'),
                            content: const Text('将跳转到收款码管理，上传你在支付宝/微信里的真实收款码截图即可。'),
                            actions: [
                              TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('取消')),
                              FilledButton(onPressed: () => Navigator.pop(d, true), child: const Text('去生成')),
                            ],
                          ));
                          if (ok == true && mounted) await _goManage();
                        },
                        icon: const Icon(Icons.qr_code_2),
                        label: const Text('立即生成'),
                      ),
                    ]))
                  : Column(children: [
                      Expanded(child: GestureDetector(
                        onTap: () => setState(() => _idx = (safeIdx + 1) % _codes.length),
                        child: Center(child: Container(
                          padding: const EdgeInsets.all(14),
                          decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(18)),
                          child: Column(mainAxisSize: MainAxisSize.min, children: [
                            Image.memory(base64Decode((_codes[safeIdx]['image'] as String).split(',').last), width: MediaQuery.of(context).size.width * 0.68, fit: BoxFit.contain),
                            const SizedBox(height: 10),
                            Text(_codes[safeIdx]['type'] == 'alipay' ? '支付宝收款码' : '微信收款码', style: const TextStyle(color: Colors.black87, fontWeight: FontWeight.w700)),
                            Text('已用 ${_codes[safeIdx]['usedCount']} / ${(_codes[safeIdx]['maxUses'] as num) < 0 ? '无限' : _codes[safeIdx]['maxUses']}', style: const TextStyle(color: Colors.black45, fontSize: 12)),
                          ]),
                        )),
                      )),
                      Padding(padding: const EdgeInsets.all(16), child: Text('点击二维码切换（${safeIdx + 1}/${_codes.length}）· 右上角设置管理', style: const TextStyle(color: Colors.white38, fontSize: 12))),
                    ])),
        ]),
      ),
    );
  }
}

// 可变引用，用于在弹窗关闭后读取下拉框当前值
class _ValueDropdownController<T> {
  T? value;
}

// ============ 我的真实收款码（支付宝/微信收款二维码）============
// 上传自己的真实收款码截图保存到服务器，可设置使用次数（-1=无上限），
// 全屏查看、被扫一次计数、重置、删除。
class _PersonalQrPage extends StatefulWidget {
  const _PersonalQrPage({required this.api, required this.config});
  final SecureChatApi api;
  final AppConfig config;
  @override
  State<_PersonalQrPage> createState() => _PersonalQrPageState();
}

class _PersonalQrPageState extends State<_PersonalQrPage> {
  List<Map<String, dynamic>> _codes = [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      final list = await widget.api.personalQrList();
      if (!mounted) return;
      setState(() { _codes = list; _loading = false; _error = null; });
    } catch (e) {
      if (!mounted) return;
      setState(() { _loading = false; _error = e.toString().replaceFirst('Bad state: ', ''); });
    }
  }

  Future<void> _upload(String type) async {
    final picked = await FilePicker.platform.pickFiles(type: FileType.image, withData: true);
    if (picked == null || picked.files.isEmpty || picked.files.first.bytes == null) return;
    final b64 = 'data:image/png;base64,' + base64Encode(picked.files.first.bytes!);
    // 次数设置：-1 无上限，或正整数
    int maxUses = -1;
    final ctrl = TextEditingController(text: '-1');
    final ok = await showDialog<bool>(
      context: context,
      builder: (dctx) => AlertDialog(
        title: Text(type == 'alipay' ? '设置支付宝收款码次数' : '设置微信收款码次数'),
        content: TextField(controller: ctrl, keyboardType: TextInputType.number, decoration: const InputDecoration(hintText: '-1 表示无上限，或输入次数如 10')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(dctx, true), child: const Text('确定')),
        ],
      ),
    );
    if (ok != true) return;
    maxUses = int.tryParse(ctrl.text.trim()) ?? -1;
    try {
      await widget.api.personalQrSave(type: type, image: b64, maxUses: maxUses);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('收款码已保存')));
        _load();
      }
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('保存失败：${e.toString().replaceFirst('Bad state: ', '')}')));
    }
  }

  Future<void> _view(Map<String, dynamic> code) async {
    final exhausted = code['exhausted'] == true;
    await showDialog<void>(
      context: context,
      builder: (ctx) => Dialog(
        backgroundColor: Colors.transparent,
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(16)),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              Text(code['type'] == 'alipay' ? '支付宝收款码' : '微信收款码', style: const TextStyle(color: Colors.black87, fontWeight: FontWeight.w700)),
              const SizedBox(height: 8),
              if (exhausted)
                const Padding(padding: EdgeInsets.all(24), child: Text('已达到使用次数上限', style: TextStyle(color: Colors.red)))
              else
                InteractiveViewer(child: Image.memory(base64Decode((code['image'] as String).split(',').last), width: 280, fit: BoxFit.contain)),
              const SizedBox(height: 6),
              Text('已用 ${code['usedCount']} / ${code['maxUses'] < 0 ? '无限' : code['maxUses']}', style: const TextStyle(color: Colors.black54, fontSize: 12)),
            ]),
          ),
          const SizedBox(height: 12),
          Row(mainAxisAlignment: MainAxisAlignment.center, children: [
            TextButton.icon(onPressed: () => Navigator.pop(ctx), icon: const Icon(Icons.close, color: Colors.white), label: const Text('关闭', style: TextStyle(color: Colors.white))),
            TextButton.icon(
              onPressed: () async {
                try { await widget.api.personalQrUse((code['id'] as num).toInt()); if (ctx.mounted) Navigator.pop(ctx); _load(); } catch (_) {}
              },
              icon: const Icon(Icons.touch_app, color: Colors.white),
              label: const Text('被扫一次+1', style: TextStyle(color: Colors.white)),
            ),
          ]),
        ]),
      ),
    );
  }

  Future<void> _confirm(String action, Map<String, dynamic> code) async {
    try {
      if (action == 'reset') await widget.api.personalQrReset((code['id'] as num).toInt());
      if (action == 'delete') await widget.api.personalQrDelete((code['id'] as num).toInt());
      if (mounted) _load();
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.toString().replaceFirst('Bad state: ', ''))));
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = widget.config.theme;
    return Scaffold(
      backgroundColor: t.bg,
      body: Column(children: [
        PageHeader(title: '我的收款码', config: widget.config),
        Expanded(child: _loading
            ? const Center(child: CircularProgressIndicator())
            : ListView(
                padding: const EdgeInsets.all(14),
                children: [
                  Row(children: [
                    Expanded(child: FilledButton.icon(onPressed: () => _upload('alipay'), icon: const Icon(Icons.upload), label: const Text('上传支付宝码'))),
                    const SizedBox(width: 10),
                    Expanded(child: FilledButton.icon(onPressed: () => _upload('wxpay'), icon: const Icon(Icons.upload), label: const Text('上传微信码'))),
                  ]),
                  const SizedBox(height: 8),
                  Text('上传你在支付宝/微信里的真实收款二维码截图；可设使用次数（-1为无上限）。点卡片全屏展示供对方扫。', style: TextStyle(color: t.subText, fontSize: 12)),
                  const SizedBox(height: 12),
                  if (_error != null) Padding(padding: const EdgeInsets.only(bottom: 10), child: Text(_error!, style: const TextStyle(color: Colors.red))),
                  for (final c in _codes)
                    Card(
                      color: t.card.withValues(alpha: 0.9),
                      child: ListTile(
                        onTap: () => _view(c),
                        leading: (c['image'] as String?) != null
                            ? ClipRRect(borderRadius: BorderRadius.circular(8), child: Image.memory(base64Decode((c['image'] as String).split(',').last), width: 52, height: 52, fit: BoxFit.cover))
                            : const Icon(Icons.qr_code),
                        title: Text(c['type'] == 'alipay' ? '支付宝收款码' : '微信收款码', style: TextStyle(color: t.text)),
                        subtitle: Text('已用 ${c['usedCount']} / ${c['maxUses'] < 0 ? '无限' : c['maxUses']}${c['exhausted'] == true ? '（已达上限）' : ''}', style: TextStyle(color: t.subText, fontSize: 12)),
                        trailing: PopupMenuButton<String>(
                          onSelected: (v) => _confirm(v, c),
                          itemBuilder: (_) => [
                            const PopupMenuItem(value: 'reset', child: Text('重置次数')),
                            const PopupMenuItem(value: 'delete', child: Text('删除', style: TextStyle(color: Colors.red))),
                          ],
                        ),
                      ),
                    ),
                ],
              )),
      ]),
    );
  }
}