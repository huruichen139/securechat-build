import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import 'services/securechat_api.dart';
import 'services/app_config.dart';
import 'widgets/ux.dart';

class WalletPage extends StatefulWidget {
  const WalletPage({super.key, required this.api, required this.config});
  final SecureChatApi api;
  final dynamic config;
  @override
  State<WalletPage> createState() => _WalletPageState();
}

class _WalletPageState extends State<WalletPage> {
  double _balance = 0;
  bool _loading = true;
  String? _error;
  final List<Map<String, dynamic>> _txn = [];

  @override
  void initState() {
    super.initState();
    _reload();
  }

  Future<void> _reload() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final w = await widget.api.wallet();
      _balance = (w['balance'] as num?)?.toDouble() ?? 0;
      _txn
        ..clear()
        ..addAll(await widget.api.walletTxn());
    } catch (e) {
      _error = e.toString().replaceFirst('Bad state: ', '');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _rechargeSheet() async {
    final amtC = TextEditingController(text: '10');
    final codeC = TextEditingController();
    String payType = 'alipay'; // alipay | wxpay | qqpay | redeem
    final t = (widget.config as AppConfig).theme;
    final ok = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => StatefulBuilder(builder: (ctx, setSheet) {
        Widget chip(String label, IconData icon, String val) {
          final sel = payType == val;
          return Expanded(child: InkWell(
            onTap: () => setSheet(() => payType = val),
            borderRadius: BorderRadius.circular(10),
            child: Container(
              padding: const EdgeInsets.symmetric(vertical: 12),
              decoration: BoxDecoration(
                color: sel ? Ux.green.withValues(alpha: 0.1) : t.bg,
                border: Border.all(color: sel ? Ux.green : t.div, width: sel ? 1.5 : 1),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Column(children: [
                Icon(icon, color: sel ? Ux.green : t.subText, size: 22),
                const SizedBox(height: 4),
                Text(label, style: TextStyle(fontSize: 12, color: sel ? Ux.green : t.subText, fontWeight: sel ? FontWeight.w600 : FontWeight.w400)),
              ]),
            ),
          ));
        }
        return Padding(
        padding: EdgeInsets.fromLTRB(20, 20, 20, 20 + MediaQuery.of(ctx).viewInsets.bottom),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text('余额充值', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 17)),
          const SizedBox(height: 14),
          Row(children: [chip('支付宝', Icons.payment, 'alipay'), const SizedBox(width: 8), chip('微信', Icons.chat_bubble_outline, 'wxpay'), const SizedBox(width: 8), chip('兑换码', Icons.redeem, 'redeem')]),
          const SizedBox(height: 14),
          if (payType == 'redeem') ...[
            TextField(controller: codeC, autofocus: true, decoration: const InputDecoration(hintText: '请输入兑换码')),
          ] else ...[
            Wrap(spacing: 8, children: [10.0, 20.0, 50.0, 100.0, 500.0].map((v) => ChoiceChip(
              label: Text('¥${v.toStringAsFixed(0)}'),
              selected: amtC.text == v.toStringAsFixed(0),
              onSelected: (_) { amtC.text = v.toStringAsFixed(0); setSheet(() {}); },
            )).toList()),
            const SizedBox(height: 12),
            TextField(controller: amtC, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(hintText: '自定义金额（元）', prefixText: '¥ ')),
          ],
          const SizedBox(height: 16),
          SizedBox(width: double.infinity, child: FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(payType == 'redeem' ? '立即兑换' : (payType == 'qqpay' ? '去QQ钱包支付' : (payType == 'wxpay' ? '去微信支付' : '去支付宝支付'))),
          )),
        ]),
        );
      }),
    );
    if (ok != true) return;
    if (payType == 'redeem') {
      if (codeC.text.trim().isEmpty) return;
      await _redeemWithCode(codeC.text.trim());
      return;
    }
    final amount = double.tryParse(amtC.text.trim());
    if (amount == null || amount < 0.01) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('请输入有效金额')));
      return;
    }
    try {
      final r = await widget.api.walletRecharge(amount, type: payType);
      final payUrl = (r['payUrl'] ?? '').toString();
      final orderNo = (r['orderNo'] ?? '').toString();
      if (payUrl.isEmpty) throw '未获取到支付地址';
      final launched = await launchUrl(Uri.parse(payUrl), mode: LaunchMode.externalApplication);
      if (!launched && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已生成支付链接，浏览器未自动打开')));
      }
      _pollRecharge(orderNo);
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('充值失败：${e.toString().replaceFirst('Bad state: ', '')}')));
    }
  }

  Future<void> _redeemWithCode(String code) async {
    try {
      final r = await widget.api.redeem(code);
      if (!mounted) return;
      setState(() => _balance = (r['balance'] as num?)?.toDouble() ?? _balance);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('兑换成功，+${r['value']}')));
        await _reload();
      }
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('兑换失败：${e.toString().replaceFirst('Bad state: ', '')}')));
    }
  }

  Future<void> _pollRecharge(String orderNo) async {
    if (orderNo.isEmpty) return;
    for (var i = 0; i < 60; i++) {
      await Future.delayed(const Duration(seconds: 3));
      if (!mounted) return;
      try {
        final s = await widget.api.rechargeStatus(orderNo);
        if (s['status'] == 'paid') {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('充值成功 +¥${s['amount']}')));
          await _reload();
          return;
        }
      } catch (_) {}
    }
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
      final r = await widget.api.redeem(code);
      if (!mounted) return;
      setState(() => _balance = (r['balance'] as num?)?.toDouble() ?? _balance);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('兑换成功，+${r['value']}')));
        await _reload();
      }
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('兑换失败：${e.toString().replaceFirst('Bad state: ', '')}')));
    }
  }

  Future<void> _transfer() async {
    final uidC = TextEditingController();
    final amtC = TextEditingController();
    final remarkC = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('转账'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: uidC, decoration: const InputDecoration(hintText: '收款人 ID (UID)')),
          const SizedBox(height: 10),
          TextField(controller: amtC, keyboardType: TextInputType.number, decoration: const InputDecoration(hintText: '金额')),
          const SizedBox(height: 10),
          TextField(controller: remarkC, decoration: const InputDecoration(hintText: '备注（可选）')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('转账')),
        ],
      ),
    );
    if (ok != true) return;
    final toUid = uidC.text.trim();
    final amt = double.tryParse(amtC.text.trim());
    if (toUid.isEmpty || amt == null || amt <= 0) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('请填写收款人 UID 和有效金额')));
      return;
    }
    try {
      final r = await widget.api.transfer(toUid, amt, remark: remarkC.text.trim());
      if (!mounted) return;
      setState(() => _balance = (r['balance'] as num?)?.toDouble() ?? _balance);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('转账成功')));
        await _reload();
      }
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('转账失败：${e.toString().replaceFirst('Bad state: ', '')}')));
    }
  }

  String _fmtTxn(Map<String, dynamic> t) {
    final ms = t['createdAt'] is int ? t['createdAt'] as int : int.tryParse('${t['createdAt']}') ?? 0;
    if (ms == 0) return '';
    final dt = DateTime.fromMillisecondsSinceEpoch(ms);
    String two(int x) => x.toString().padLeft(2, '0');
    return '${dt.month}/${dt.day} ${two(dt.hour)}:${two(dt.minute)}';
  }

  String _kindLabel(String k) {
    switch (k) {
      case 'recharge': return '充值';
      case 'transfer': return '转账';
      case 'in': return '收款';
      case 'out': return '转出';
      case 'red_packet': return '红包';
      default: return k;
    }
  }

  @override
  Widget build(BuildContext context) {
    final cfg = widget.config as AppConfig;
    final t = cfg.theme;
    return Scaffold(
      backgroundColor: t.bg,
      body: Column(children: [
        PageHeader(title: '钱包', config: cfg),
        Expanded(
          child: _loading
              ? const Center(child: CircularProgressIndicator())
              : _error != null
                  ? Center(child: Text(_error!, style: TextStyle(color: t.subText)))
                  : RefreshIndicator(
                      onRefresh: _reload,
                      child: ListView(
                        padding: const EdgeInsets.all(12),
                        children: [
                          _balanceCard(cfg),
                          const SizedBox(height: 16),
                          Row(children: [
                            Expanded(child: SectionTitle(config: cfg, title: '交易记录')),
                            IconButton(
                              onPressed: _reload,
                              icon: Icon(Icons.refresh, color: t.subText, size: 20),
                              tooltip: '刷新',
                            ),
                          ]),
                          SectionCard(
                            config: cfg,
                            children: _txn.isEmpty
                                ? [
                                    Padding(
                                      padding: const EdgeInsets.symmetric(vertical: 32),
                                      child: Center(child: Text('暂无交易记录', style: TextStyle(color: t.subText))),
                                    ),
                                  ]
                                : [
                                    for (var i = 0; i < _txn.length; i++) ...[
                                      if (i > 0) CellDivider(config: cfg, indent: 60),
                                      _txnRow(cfg, _txn[i]),
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

  Widget _balanceCard(AppConfig cfg) {
    final t = cfg.theme;
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
        const SizedBox(height: 18),
        Row(children: [
          Expanded(child: _actionBtn(cfg, Icons.account_balance_wallet_outlined, '充值', _rechargeSheet)),
          const SizedBox(width: 12),
          Expanded(child: _actionBtn(cfg, Icons.currency_exchange, '转账', _transfer)),
        ]),
      ]),
    );
  }

  Widget _actionBtn(AppConfig cfg, IconData icon, String label, VoidCallback onTap) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(Ux.radius),
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 12),
        decoration: BoxDecoration(color: Ux.green, borderRadius: BorderRadius.circular(Ux.radius)),
        child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
          Icon(icon, color: Colors.white, size: 18),
          const SizedBox(width: 6),
          Text(label, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w600)),
        ]),
      ),
    );
  }

  Widget _txnRow(AppConfig cfg, Map<String, dynamic> t) {
    final t2 = cfg.theme;
    final kind = _kindLabel((t['kind'] ?? '').toString());
    final amount = (t['amount'] as num?)?.toDouble() ?? 0;
    final inKind = (t['kind'] ?? '').toString();
    final incoming = inKind == 'in' || inKind == 'recharge';
    final peer = (t['peerName'] ?? '').toString();
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      child: Row(children: [
        Container(
          width: 34,
          height: 34,
          decoration: BoxDecoration(color: Ux.cellIconBg(t2), borderRadius: BorderRadius.circular(8)),
          child: Icon(incoming ? Icons.south_west : Icons.north_east, color: incoming ? Ux.green : t2.text, size: 18),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(peer.isEmpty ? kind : '$kind · $peer', style: TextStyle(fontSize: 15, color: t2.text, fontWeight: FontWeight.w500)),
            const SizedBox(height: 2),
            Text(_fmtTxn(t), style: TextStyle(fontSize: 12, color: t2.subText)),
          ]),
        ),
        Text('${incoming ? '+' : '-'}$amount', style: TextStyle(color: incoming ? Ux.green : t2.text, fontWeight: FontWeight.w700)),
      ]),
    );
  }
}
