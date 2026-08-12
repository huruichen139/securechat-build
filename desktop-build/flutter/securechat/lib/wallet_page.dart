import 'package:flutter/material.dart';

import 'services/securechat_api.dart';

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
    final cs = Theme.of(context).colorScheme;
    final color = widget.config.theme.primary;
    return Scaffold(
      backgroundColor: cs.surface,
      appBar: AppBar(
        backgroundColor: cs.surface,
        elevation: 0,
        title: Text('钱包', style: TextStyle(color: cs.onSurface, fontWeight: FontWeight.w700)),
        leading: IconButton(icon: Icon(Icons.arrow_back, color: cs.onSurface), onPressed: () => Navigator.of(context).maybePop()),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(child: Text(_error!, style: TextStyle(color: cs.error)))
              : ListView(padding: const EdgeInsets.all(16), children: [
                  // 余额卡
                  Container(
                    padding: const EdgeInsets.all(22),
                    decoration: BoxDecoration(
                      gradient: LinearGradient(colors: [color, color.withValues(alpha: 0.7)]),
                      borderRadius: BorderRadius.circular(18),
                    ),
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text('我的余额（元）', style: TextStyle(color: cs.onPrimary.withValues(alpha: 0.85), fontSize: 13)),
                      const SizedBox(height: 8),
                      Text(_balance.toStringAsFixed(2), style: TextStyle(color: cs.onPrimary, fontSize: 36, fontWeight: FontWeight.w800)),
                      const SizedBox(height: 18),
                      Row(children: [
                        Expanded(child: _cardBtn(Icons.redeem, '充值', color, cs, _redeem)),
                        Expanded(child: _cardBtn(Icons.currency_exchange, '转账', color, cs, _transfer)),
                      ]),
                    ]),
                  ),
                  const SizedBox(height: 16),
                  Row(children: [
                    Text('交易记录', style: TextStyle(color: cs.onSurface, fontWeight: FontWeight.w600)),
                    const Spacer(),
                    IconButton(icon: Icon(Icons.refresh, color: color), tooltip: '刷新', onPressed: _reload),
                  ]),
                  const SizedBox(height: 4),
                  if (_txn.isEmpty)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 30),
                      child: Center(child: Text('暂无交易记录', style: TextStyle(color: cs.onSurfaceVariant))),
                    )
                  else
                    ..._txn.map((t) {
                      final kind = _kindLabel((t['kind'] ?? '').toString());
                      final amount = (t['amount'] as num?)?.toDouble() ?? 0;
                      final inKind = (t['kind'] ?? '').toString();
                      final incoming = inKind == 'in' || inKind == 'recharge';
                      final peer = (t['peerName'] ?? '').toString();
                      return ListTile(
                        contentPadding: EdgeInsets.zero,
                        leading: CircleAvatar(backgroundColor: color.withValues(alpha: 0.12), child: Icon(incoming ? Icons.south_west : Icons.north_east, color: color, size: 18)),
                        title: Text(peer.isEmpty ? kind : '$kind · $peer', style: TextStyle(color: cs.onSurface)),
                        subtitle: Text(_fmtTxn(t), style: TextStyle(color: cs.onSurfaceVariant, fontSize: 12)),
                        trailing: Text('${incoming ? '+' : '-'}$amount', style: TextStyle(color: incoming ? color : cs.onSurface, fontWeight: FontWeight.w700)),
                      );
                    }),
                ]),
    );
  }

  Widget _cardBtn(IconData icon, String label, Color color, ColorScheme cs, VoidCallback onTap) => InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 12),
          decoration: BoxDecoration(color: cs.onPrimary.withValues(alpha: 0.15), borderRadius: BorderRadius.circular(12)),
          child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
            Icon(icon, color: cs.onPrimary, size: 18),
            const SizedBox(width: 6),
            Text(label, style: TextStyle(color: cs.onPrimary, fontWeight: FontWeight.w600)),
          ]),
        ),
      );
}