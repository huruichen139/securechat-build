// module: profile_page —— 个人资料编辑（头像 / 昵称 / 性别 / 签名 / 地区）
//
// 头像走 POST /api/avatar（data URI，服务端硬限整串 256KB）；
// 其余字段走 POST /api/profile，签名与性别落在 extra 的 signature / gender 键。
// 注意：服务端 extra 是「整体覆盖」语义，所以保存时必须把原有 extra 合并后回传。
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import 'services/app_config.dart';
import 'services/securechat_api.dart';
import 'widgets/ux.dart';

/// 头像 data URI 上限，与服务端 `/api/avatar` 的校验保持一致（整串长度 256KB）
const int kAvatarDataUriLimit = 256 * 1024;

/// 把 `data:image/xxx;base64,....` 解成字节。非 data URI 或解码失败返回 null。
Uint8List? decodeAvatarDataUri(Object? value) {
  if (value is! String || !value.startsWith('data:image/')) return null;
  final comma = value.indexOf(',');
  if (comma < 0 || comma + 1 >= value.length) return null;
  try {
    return base64Decode(value.substring(comma + 1));
  } catch (_) {
    return null;
  }
}

/// 按魔术字节判断图片 MIME，识别不出时退回扩展名，最后退回 image/png
String _sniffImageMime(Uint8List b, String name) {
  if (b.length >= 8 && b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4E && b[3] == 0x47) return 'image/png';
  if (b.length >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF) return 'image/jpeg';
  if (b.length >= 4 && b[0] == 0x47 && b[1] == 0x49 && b[2] == 0x46) return 'image/gif';
  if (b.length >= 12 && b[0] == 0x52 && b[1] == 0x49 && b[2] == 0x46 && b[3] == 0x46 && b[8] == 0x57 && b[9] == 0x45) {
    return 'image/webp';
  }
  if (b.length >= 2 && b[0] == 0x42 && b[1] == 0x4D) return 'image/bmp';
  final ext = name.contains('.') ? name.split('.').last.toLowerCase() : '';
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'bmp':
      return 'image/bmp';
    default:
      return 'image/png';
  }
}

String _kb(int bytes) => '${(bytes / 1024).toStringAsFixed(0)}KB';

String _str(Object? v) => v == null ? '' : v.toString();

class ProfilePage extends StatefulWidget {
  const ProfilePage({super.key, required this.api, required this.config, this.card});

  final SecureChatApi api;
  final AppConfig config;

  /// 可选：上一页已经拿到的名片，用于首帧直接回填，避免闪烁
  final Map<String, dynamic>? card;

  @override
  State<ProfilePage> createState() => _ProfilePageState();
}

class _ProfilePageState extends State<ProfilePage> {
  final _nickname = TextEditingController();
  final _country = TextEditingController();
  final _province = TextEditingController();
  final _city = TextEditingController();
  final _signature = TextEditingController();

  /// extra 全量副本（服务端覆盖写，未知键也要原样带回）
  Map<String, String> _extra = {};
  String _gender = '';
  Uint8List? _avatarBytes;
  String _uid = '';

  bool _loading = true;
  bool _saving = false;
  bool _uploading = false;
  String? _error;

  /// 已成功提交过变更时回传给上一页的最新用户数据
  Map<String, dynamic>? _result;

  AppConfig get _cfg => widget.config;
  AppTheme get _t => _cfg.theme;

  static const _genders = <String, String>{'': '未设置', 'male': '男', 'female': '女'};

  @override
  void initState() {
    super.initState();
    if (widget.card != null) _apply(widget.card!);
    _load();
  }

  @override
  void dispose() {
    _nickname.dispose();
    _country.dispose();
    _province.dispose();
    _city.dispose();
    _signature.dispose();
    super.dispose();
  }

  /// 按键回填。**必须按键存在判断**：`/api/qrcode/mycard` 只返回
  /// `{uid,name,nickname,username,avatar,email}`，不含 country/province/city/extra，
  /// 若无条件赋值会把已有的地区/签名冲成空值。
  /// `/api/profile`、`/api/avatar` 的响应是完整 publicUser，字段齐全。
  void _apply(Map<String, dynamic> card) {
    void set(TextEditingController c, List<String> keys) {
      for (final k in keys) {
        if (card.containsKey(k) && card[k] != null) {
          c.text = _str(card[k]);
          return;
        }
      }
    }

    set(_nickname, ['nickname', 'name', 'username']);
    set(_country, ['country']);
    set(_province, ['province']);
    set(_city, ['city']);
    if (card['uid'] != null) _uid = _str(card['uid']);
    final ex = card['extra'];
    if (ex is Map) {
      _extra = {for (final e in ex.entries) '${e.key}': _str(e.value)};
      _signature.text = _extra['signature'] ?? '';
      final g = _extra['gender'] ?? '';
      _gender = _genders.containsKey(g) ? g : '';
    }
    if (card.containsKey('avatar')) _avatarBytes = decodeAvatarDataUri(card['avatar']);
  }

  Future<void> _load() async {
    try {
      final card = await widget.api.myCard();
      if (!mounted) return;
      setState(() {
        _apply(card);
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        // 已有 widget.card 兜底时不把错误挡在整页上
        if (widget.card == null) _error = _msg(e);
      });
      if (widget.card != null) _toast('资料加载失败：${_msg(e)}');
    }
  }

  String _msg(Object e) => e.toString().replaceFirst('Bad state: ', '');

  void _toast(String text) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
  }

  Future<void> _pickAvatar() async {
    if (_uploading) return;
    final FilePickerResult? res;
    try {
      res = await FilePicker.platform.pickFiles(type: FileType.image, withData: true);
    } catch (e) {
      _toast('打开图片选择器失败：${_msg(e)}');
      return;
    }
    if (res == null || res.files.isEmpty) return;
    final f = res.files.first;

    Uint8List? bytes = f.bytes;
    if (bytes == null && f.path != null) {
      try {
        bytes = await File(f.path!).readAsBytes();
      } catch (e) {
        _toast('读取图片失败：${_msg(e)}');
        return;
      }
    }
    if (bytes == null || bytes.isEmpty) {
      _toast('读取图片失败，请换一张试试');
      return;
    }

    final dataUri = 'data:${_sniffImageMime(bytes, f.name)};base64,${base64Encode(bytes)}';
    if (dataUri.length > kAvatarDataUriLimit) {
      // base64 会放大约 1/3，256KB 的 data URI 大致对应 190KB 原图
      _toast('图片过大（编码后 ${_kb(dataUri.length)}，上限 ${_kb(kAvatarDataUriLimit)}），请选择小于 190KB 的图片');
      return;
    }

    setState(() => _uploading = true);
    try {
      final r = await widget.api.setAvatar(dataUri);
      if (!mounted) return;
      final user = r['user'];
      setState(() {
        _avatarBytes = bytes;
        _uploading = false;
        if (user is Map) _result = user.cast<String, dynamic>();
      });
      _toast('头像已更新');
    } catch (e) {
      if (!mounted) return;
      setState(() => _uploading = false);
      _toast('头像上传失败：${_msg(e)}');
    }
  }

  Future<void> _pickGender() async {
    final picked = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: Color.alphaBlend(_t.card, _t.bg),
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(Ux.cardRadius)),
      ),
      builder: (ctx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text('性别', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: _t.text)),
            ),
          ),
          for (final e in _genders.entries)
            ListTile(
              title: Text(e.value, style: TextStyle(fontSize: 15, color: _t.text)),
              trailing: _gender == e.key ? const Icon(Icons.check_rounded, size: 20, color: Ux.green) : null,
              onTap: () => Navigator.pop(ctx, e.key),
            ),
          const SizedBox(height: 8),
        ]),
      ),
    );
    if (picked == null || !mounted) return;
    setState(() => _gender = picked);
  }

  Future<void> _save() async {
    if (_saving) return;
    final nick = _nickname.text.trim();
    if (nick.isEmpty) {
      _toast('昵称不能为空');
      return;
    }
    final extra = Map<String, String>.from(_extra)
      ..['signature'] = _signature.text.trim()
      ..['gender'] = _gender;

    setState(() => _saving = true);
    try {
      final r = await widget.api.updateProfile(
        nickname: nick,
        country: _country.text.trim(),
        province: _province.text.trim(),
        city: _city.text.trim(),
        extra: extra,
      );
      if (!mounted) return;
      final user = r['user'];
      _extra = extra;
      _result = user is Map ? user.cast<String, dynamic>() : _result;
      setState(() => _saving = false);
      _toast('资料已保存');
      Navigator.pop(context, _result ?? const <String, dynamic>{});
    } catch (e) {
      if (!mounted) return;
      setState(() => _saving = false);
      _toast('保存失败：${_msg(e)}');
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = _t;
    return Scaffold(
      backgroundColor: t.bg,
      body: Column(children: [
        PageHeader(
          title: '个人资料',
          config: _cfg,
          onBack: () => Navigator.pop(context, _result),
        ),
        Expanded(
          child: _loading
              ? const Center(child: CircularProgressIndicator())
              : _error != null
                  ? Center(child: Text(_error!, style: TextStyle(color: t.subText)))
                  : ListView(
                      padding: const EdgeInsets.only(bottom: 32),
                      children: [
                        const SizedBox(height: 12),
                        _avatarCard(),
                        SectionTitle(config: _cfg, title: '基本信息'),
                        SectionCard(config: _cfg, children: [
                          _field(label: '昵称', controller: _nickname, hint: '你的昵称', maxLength: 24),
                          CellDivider(config: _cfg, indent: 14),
                          _pickerRow(label: '性别', value: _genders[_gender] ?? '未设置', onTap: _pickGender),
                          CellDivider(config: _cfg, indent: 14),
                          _field(
                            label: '个性签名',
                            controller: _signature,
                            hint: '介绍一下自己',
                            maxLines: 3,
                            maxLength: 60,
                          ),
                        ]),
                        SectionTitle(config: _cfg, title: '所在地区'),
                        SectionCard(config: _cfg, children: [
                          _field(label: '国家', controller: _country, hint: '如 中国'),
                          CellDivider(config: _cfg, indent: 14),
                          _field(label: '省份', controller: _province, hint: '如 广东'),
                          CellDivider(config: _cfg, indent: 14),
                          _field(label: '城市', controller: _city, hint: '如 深圳'),
                        ]),
                        if (_uid.isNotEmpty) ...[
                          SectionTitle(config: _cfg, title: '账号'),
                          SectionCard(config: _cfg, children: [
                            ListCell(
                              config: _cfg,
                              icon: Icons.badge_outlined,
                              title: '聊天号',
                              subtitle: _uid,
                              showArrow: false,
                              trailing: Text('不可修改', style: TextStyle(fontSize: 12, color: t.subText)),
                            ),
                          ]),
                        ],
                        const SizedBox(height: 24),
                        Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 12),
                          child: SizedBox(
                            height: 46,
                            child: FilledButton(
                              onPressed: _saving ? null : _save,
                              style: FilledButton.styleFrom(
                                backgroundColor: Ux.green,
                                foregroundColor: Colors.white,
                                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Ux.radius)),
                              ),
                              child: _saving
                                  ? const SizedBox(
                                      width: 18,
                                      height: 18,
                                      child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                                    )
                                  : const Text('保存', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
                            ),
                          ),
                        ),
                      ],
                    ),
        ),
      ]),
    );
  }

  Widget _avatarCard() {
    final t = _t;
    return SectionCard(
      config: _cfg,
      children: [
        Material(
          color: Colors.transparent,
          child: InkWell(
            onTap: _uploading ? null : _pickAvatar,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 16),
              child: Row(children: [
                _avatarView(64),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text('头像', style: TextStyle(fontSize: 15, color: t.text, fontWeight: FontWeight.w500)),
                    const SizedBox(height: 4),
                    Text(
                      _uploading ? '上传中…' : '点击更换，图片编码后不超过 ${_kb(kAvatarDataUriLimit)}',
                      style: TextStyle(fontSize: 12, color: t.subText),
                    ),
                  ]),
                ),
                if (_uploading)
                  SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2, color: t.subText),
                  )
                else
                  Icon(Icons.chevron_right_rounded, color: t.subText.withValues(alpha: 0.7), size: 20),
              ]),
            ),
          ),
        ),
      ],
    );
  }

  Widget _avatarView(double size) {
    final bytes = _avatarBytes;
    if (bytes != null) {
      return ClipOval(
        child: Image.memory(bytes, width: size, height: size, fit: BoxFit.cover, gaplessPlayback: true),
      );
    }
    final name = _nickname.text.trim();
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: const BoxDecoration(color: Ux.green, shape: BoxShape.circle),
      child: Text(
        name.isNotEmpty ? name[0].toUpperCase() : 'S',
        style: TextStyle(color: Colors.white, fontSize: size * 0.4, fontWeight: FontWeight.bold),
      ),
    );
  }

  Widget _field({
    required String label,
    required TextEditingController controller,
    String? hint,
    int maxLines = 1,
    int? maxLength,
  }) {
    final t = _t;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 14),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Padding(
          padding: const EdgeInsets.only(top: 15),
          child: SizedBox(
            width: 72,
            child: Text(label, style: TextStyle(fontSize: 15, color: t.text)),
          ),
        ),
        Expanded(
          child: TextField(
            controller: controller,
            maxLines: maxLines,
            minLines: 1,
            maxLength: maxLength,
            textInputAction: maxLines > 1 ? TextInputAction.newline : TextInputAction.next,
            style: TextStyle(fontSize: 15, color: t.text),
            onChanged: (_) {
              if (controller == _nickname && _avatarBytes == null) setState(() {});
            },
            decoration: InputDecoration(
              hintText: hint,
              hintStyle: TextStyle(fontSize: 14, color: t.subText),
              filled: false,
              isDense: true,
              counterText: '',
              border: InputBorder.none,
              enabledBorder: InputBorder.none,
              focusedBorder: InputBorder.none,
              contentPadding: const EdgeInsets.symmetric(vertical: 14),
            ),
          ),
        ),
      ]),
    );
  }

  Widget _pickerRow({required String label, required String value, required VoidCallback onTap}) {
    final t = _t;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        child: Container(
          constraints: const BoxConstraints(minHeight: Ux.cellHeight),
          padding: const EdgeInsets.symmetric(horizontal: 14),
          child: Row(children: [
            SizedBox(width: 72, child: Text(label, style: TextStyle(fontSize: 15, color: t.text))),
            Expanded(child: Text(value, style: TextStyle(fontSize: 15, color: t.text))),
            Icon(Icons.chevron_right_rounded, color: t.subText.withValues(alpha: 0.7), size: 20),
          ]),
        ),
      ),
    );
  }
}
