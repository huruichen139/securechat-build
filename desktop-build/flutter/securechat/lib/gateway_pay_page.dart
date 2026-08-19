// module: gateway pay —— 本地客户端直接扣款确认页：
// 扫码（securechat://gateway/pay?order=xxx）或收银台深链进入，
// 展示订单，检查/创建对该商户的授权（mode=local），用户明确确认后扣款。
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:window_manager/window_manager.dart';

import 'services/app_config.dart';
import 'services/securechat_api.dart';
import 'widgets/ux.dart';

class GatewayPayPage extends StatefulWidget {
  const GatewayPayPage({super.key, required this.api, required this.config, required this.orderNo});
  final SecureChatApi api;
  final AppConfig config;
  final String orderNo;

  @override
  State<GatewayPayPage> createState() => _GatewayPayPageState();
}

class _GatewayPayPageState extends State<GatewayPayPage> {
  Map<String, dynamic>? _order;
  Map<String, dynamic>? _auth;
  String? _status;
  bool _busy = false;
  bool _creatingAuth = false;
  final _authAmt = TextEditingController();

  @override
  void initState() {
    super.initState();
    _authAmt.text = '';
    _pinToFront();
    _load();
  }

  /// 本地扣款确认场景：把窗口置顶并带到前台，避免被商户应用遮挡。
  Future<void> _pinToFront() async {
    if (Platform.isWindows || Platform.isMacOS || Platform.isLinux) {
      try {
        await windowManager.setAlwaysOnTop(true);
        await windowManager.focus();
      } catch (_) {}
    }
  }

  @override
  void dispose() {
    _unpinWindow();
    _authAmt.dispose();
    super.dispose();
  }

  Future<void> _unpinWindow() async {
    if (Platform.isWindows || Platform.isMacOS || Platform.isLinux) {
      try {
        await windowManager.setAlwaysOnTop(false);
      } catch (_) {}
    }
  }

  Future<void> _load() async {
    setState(() { _busy = true; _status = null; });
    try {
      final order = await widget.api.gatewayOrder(widget.orderNo);
      setState(() => _order = (order['order'] ?? order) as Map<String, dynamic>);
      final r = await widget.api.gatewayAuthorizations();
      final list = (r['authorizations'] as List? ?? []);
      final merchantId = _order?['merchantId'];
      final amount = (_order?['amount'] as num?)?.toDouble() ?? 0;
      Map<String, dynamic>? auth;
      for (final a in list) {
        final m = a as Map<String, dynamic>;
        if (m['merchantId'] == merchantId && m['status'] == 'active' && ((m['maxAmount'] as num?)?.toDouble() ?? 0) >= amount) {
          auth = m;
          break;
        }
      }
      setState(() => _auth = auth);
      if (auth != null) {
        _authAmt.text = ((auth['maxAmount'] as num?)?.toDouble() ?? amount).toStringAsFixed(2);
      } else if (amount > 0) {
        _authAmt.text = amount.toStringAsFixed(2);
      }
    } catch (e) {
      setState(() => _status = '加载订单失败：${e.toString().replaceFirst('Bad state: ', '')}');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _createAuth() async {
    final amount = (_order?['amount'] as num?)?.toDouble() ?? 0;
    final merchantId = _order?['merchantId'];
    if (merchantId == null || amount <= 0) return;
    final maxAmt = double.tryParse(_authAmt.text.trim());
    if (maxAmt == null || maxAmt <= 0 || maxAmt < amount) {
      setState(() => _status = '授权额度不能小于订单金额 ¥${amount.toStringAsFixed(2)}');
      return;
    }
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('创建授权'),
        content: Text('确认给该商户授权 ¥${maxAmt.toStringAsFixed(2)}（90 天有效）？\n每次扣款仍需你确认。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('确认授权')),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    setState(() { _creatingAuth = true; _status = null; });
    try {
      await widget.api.gatewayCreateAuthorization(merchantId as int, maxAmt, 'local');
      if (mounted) setState(() { _status = '授权成功，可确认支付'; _creatingAuth = false; });
      await _load();
    } catch (e) {
      if (mounted) setState(() { _status = '授权失败：${e.toString().replaceFirst('Bad state: ', '')}'; _creatingAuth = false; });
    }
  }

  Future<void> _confirmPay() async {
    final amount = (_order?['amount'] as num?)?.toDouble() ?? 0;
    if (amount <= 0) return;
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('确认扣款'),
        content: Text('确认从 SecureChat 钱包扣款 ¥${amount.toStringAsFixed(2)} 支付本订单？'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('确认支付')),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    setState(() { _busy = true; _status = null; });
    try {
      await widget.api.gatewayConfirm(widget.orderNo, amount);
      if (!mounted) return;
      Navigator.pop(context);
    } catch (e) {
      if (mounted) setState(() { _busy = false; _status = '支付失败：${e.toString().replaceFirst('Bad state: ', '')}'; });
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = widget.config.theme;
    final order = _order;
    final amount = (order?['amount'] as num?)?.toDouble() ?? 0;
    final status = (order?['status'] ?? '') as String;
    return Scaffold(
      backgroundColor: t.bg,
      body: Column(children: [
        PageHeader(title: '网关支付确认', config: widget.config, trailing: const SizedBox.shrink()),
        Expanded(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(20),
            child: Column(children: [
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(color: t.card, borderRadius: BorderRadius.circular(12), border: Border.all(color: t.div, width: 0.5)),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  _row('订单号', widget.orderNo, t),
                  _row('商户', '${order?['merchantName'] ?? 'SecureChat 商户'}', t),
                  _row('说明', '${order?['subject'] ?? ''}', t),
                  _row('金额', '¥${amount.toStringAsFixed(2)}', t, money: true),
                  _row('状态', status, t),
                ]),
              ),
              const SizedBox(height: 16),
              if (_auth == null)
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(16),
                  decoration: BoxDecoration(color: t.card, borderRadius: BorderRadius.circular(12), border: Border.all(color: t.div, width: 0.5)),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text('尚未给该商户授权', style: TextStyle(color: t.text, fontWeight: FontWeight.w600)),
                    const SizedBox(height: 8),
                    Row(children: [
                      Text('授权额度（¥）', style: TextStyle(color: t.subText, fontSize: 13)),
                      const SizedBox(width: 8),
                      SizedBox(width: 110, child: TextField(controller: _authAmt, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(isDense: true, border: OutlineInputBorder()))),
                    ]),
                    const SizedBox(height: 10),
                    Text('授权后商户可在额度内发起扣款，每次扣款仍需你确认', style: TextStyle(color: t.subText, fontSize: 12)),
                    const SizedBox(height: 12),
                    SizedBox(width: double.infinity, child: OutlinedButton(onPressed: _creatingAuth ? null : _createAuth, child: Text(_creatingAuth ? '创建中…' : '创建授权'))),
                  ]),
                )
              else
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(16),
                  decoration: BoxDecoration(color: t.card, borderRadius: BorderRadius.circular(12), border: Border.all(color: t.div, width: 0.5)),
                  child: Text('已授权该商户（额度 ¥${((_auth?['maxAmount'] as num?)?.toDouble() ?? 0).toStringAsFixed(2)}，local）', style: TextStyle(color: t.subText, fontSize: 13)),
                ),
              if (_status != null) ...[
                const SizedBox(height: 12),
                Text(_status!, textAlign: TextAlign.center, style: TextStyle(color: t.subText, fontSize: 13)),
              ],
              const SizedBox(height: 20),
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  style: FilledButton.styleFrom(backgroundColor: const Color(0xFF07C160), padding: const EdgeInsets.symmetric(vertical: 14)),
                  onPressed: (_busy || amount <= 0 || status == 'paid') ? null : _confirmPay,
                  child: Text(status == 'paid' ? '订单已支付' : '确认支付 ¥${amount.toStringAsFixed(2)}'),
                ),
              ),
            ]),
          ),
        ),
      ]),
    );
  }

  Widget _row(String k, String v, AppTheme t, {bool money = false}) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        SizedBox(width: 64, child: Text(k, style: TextStyle(color: t.subText, fontSize: 13))),
        Expanded(child: Text(v, textAlign: TextAlign.right, style: TextStyle(color: money ? const Color(0xFFE4393C) : t.text, fontSize: money ? 17 : 13, fontWeight: money ? FontWeight.w700 : FontWeight.w400))),
      ]),
    );
  }
}