// module: favorites_page (worker batch7) —— Flutter 收藏页：收藏夹管理、标签、批量整理、搜索、转发入聊
import 'package:flutter/material.dart';

import 'services/moment_collar_service.dart';
import 'services/securechat_api.dart';

class FavoritesPage extends StatefulWidget {
  const FavoritesPage({super.key, required this.api, required this.config, this.config2});
  final SecureChatApi api;
  final dynamic config;
  final dynamic config2;
  @override
  State<FavoritesPage> createState() => _FavoritesPageState();
}

class _FavoritesPageState extends State<FavoritesPage> {
  late final MomentCollarService _svc = MomentCollarService(widget.api);
  List<Map<String, dynamic>> _classifiers = [];
  List<Map<String, dynamic>> _items = [];
  List<String> _tags = [];
  int? _curClassifier;
  String _curTag = '';
  bool _loading = true;
  String? _error;
  final _search = TextEditingController();

  static const kindLabel = {'text': '文字', 'image': '图片', 'file': '文件', 'message': '聊天记录', 'link': '链接', 'moment': '朋友圈'};

  @override
  void initState() {
    super.initState();
    _reload();
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  Future<void> _reload() async {
    setState(() { _loading = true; _error = null; });
    try {
      final cf = await _svc.classifiers();
      final items = await _svc.favoriteItems(classifierId: _curClassifier, tag: _curTag, q: _search.text.trim());
      final tags = await _svc.favoriteTags();
      _classifiers = cf;
      _items = items;
      _tags = tags;
    } catch (e) {
      _error = e.toString().replaceFirst('Bad state: ', '');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _createClassifier() async {
    final c = TextEditingController();
    final name = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('新建收藏夹'),
        content: TextField(controller: c, autofocus: true, decoration: const InputDecoration(hintText: '收藏夹名称')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, c.text.trim()), child: const Text('创建')),
        ],
      ),
    );
    if (name == null || name.isEmpty) return;
    try {
      await _svc.createClassifier(name, icon: '📁');
      _curClassifier = null;
      await _reload();
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('创建失败：$e')));
    }
  }

  Future<void> _addItem() async {
    final kind = await showDialog<String>(
      context: context,
      builder: (ctx) => SimpleDialog(
        title: const Text('选择收藏类型'),
        children: [
          for (final e in kindLabel.entries)
            SimpleDialogOption(onPressed: () => Navigator.pop(ctx, e.key), child: Text(e.value)),
        ],
      ),
    );
    if (kind == null) return;
    final data = <String, dynamic>{};
    if (kind == 'text' || kind == 'message' || kind == 'moment') {
      final c = TextEditingController();
      final content = await showDialog<String>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('内容'),
          content: TextField(controller: c, autofocus: true),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
            FilledButton(onPressed: () => Navigator.pop(ctx, c.text.trim()), child: const Text('保存')),
          ],
        ),
      );
      if (content == null || content.isEmpty) return;
      data['text'] = content;
      data['content'] = content;
    } else if (kind == 'link') {
      final url = await _prompt('链接 URL');
      if (url == null || url.isEmpty) return;
      final title = await _prompt('标题', url);
      data['url'] = url;
      data['title'] = title ?? url;
    } else if (kind == 'image') {
      final url = await _prompt('图片地址');
      if (url == null || url.isEmpty) return;
      data['url'] = url;
    } else if (kind == 'file') {
      final name = await _prompt('文件名称');
      if (name == null || name.isEmpty) return;
      data['name'] = name;
      data['url'] = '';
    }
    final tagsStr = await _prompt('标签(逗号分隔)');
    final tags = (tagsStr ?? '').split(RegExp(r'[,，]')).map((t) => t.trim()).where((t) => t.isNotEmpty).toList();
    try {
      await _svc.addFavoriteItem(kind, data, classifierId: _curClassifier, tags: tags);
      await _reload();
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已收藏')));
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('收藏失败：$e')));
    }
  }

  Future<String?> _prompt(String title, [String initial = '']) async {
    final c = TextEditingController(text: initial);
    return showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(title),
        content: TextField(controller: c, autofocus: true),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, c.text.trim()), child: const Text('确定')),
        ],
      ),
    );
  }

  Future<void> _organize(Map<String, dynamic> item) async {
    final id = (item['id'] as num).toInt();
    final curTags = ((item['tags'] as List?) ?? const []).map((t) => t.toString()).join(',');
    final tagsStr = await _prompt('编辑标签(逗号分隔)', curTags);
    if (tagsStr == null) return;
    final tags = tagsStr.split(RegExp(r'[,，]')).map((t) => t.trim()).where((t) => t.isNotEmpty).toList();
    int? classifierId;
    if (_classifiers.isNotEmpty) {
      classifierId = await showDialog<int?>(
        context: context,
        builder: (ctx) => SimpleDialog(
          title: const Text('选择收藏夹'),
          children: [
            SimpleDialogOption(onPressed: () => Navigator.pop(ctx, null), child: const Text('（不移动）')),
            for (final c in _classifiers)
              SimpleDialogOption(
                onPressed: () => Navigator.pop(ctx, (c['id'] as num).toInt()),
                child: Text('${c['icon']} ${c['name']}'),
              ),
          ],
        ),
      );
    }
    try {
      await _svc.organizeFavoriteItem(id, classifierId: classifierId, tags: tags);
      await _reload();
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('整理失败：$e')));
    }
  }

  Future<void> _delete(int id) async {
    try {
      await _svc.deleteFavoriteItem(id);
      await _reload();
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('删除失败：$e')));
    }
  }

  Future<void> _forward(int id) async {
    try {
      final f = await _svc.friends();
      if (f.isEmpty) {
        if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('暂无可转发的好友')));
        return;
      }
      final names = f.map((u) => '${u['nickname'] ?? u['username']}').toList();
      final numbered = <String>[];
      for (var i = 0; i < names.length; i++) {
        numbered.add('${i + 1}.${names[i]}');
      }
      final choice = await _prompt('转发给（可填序号,从1开始）：\n${numbered.join('\n')}', '1');
      if (choice == null || choice.isEmpty) return;
      int? targetId;
      final asInt = int.tryParse(choice);
      if (asInt != null && asInt >= 1 && asInt <= f.length) targetId = (f[asInt - 1]['id'] as num).toInt();
      if (targetId == null) {
        final hit = f.where((u) => '${u['nickname'] ?? u['username']}' == choice).toList();
        if (hit.isNotEmpty) targetId = (hit.first['id'] as num).toInt();
      }
      if (targetId == null) {
        if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('未找到该好友')));
        return;
      }
      await _svc.forwardFavoriteItem(id, targetId);
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已转发')));
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('转发失败：$e')));
    }
  }

  String _contentOf(Map<String, dynamic> item) {
    final data = item['data'] as Map<String, dynamic>? ?? const {};
    final kind = item['kind'].toString();
    switch (kind) {
      case 'link': return '🔗 ${data['title'] ?? data['url'] ?? ''}';
      case 'file': return '📄 ${data['name'] ?? ''}';
      case 'moment': return '${data['content'] ?? ''}';
      case 'message': return '💬 ${data['content'] ?? ''}';
      default: return data['text']?.toString() ?? data['content']?.toString() ?? '';
    }
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Scaffold(
      backgroundColor: cs.surface,
      appBar: AppBar(
        backgroundColor: cs.surface,
        elevation: 0,
        title: Text('我的收藏', style: TextStyle(color: cs.onSurface, fontWeight: FontWeight.w700)),
        leading: IconButton(icon: Icon(Icons.arrow_back, color: cs.onSurface), onPressed: () => Navigator.of(context).maybePop()),
        actions: [
          IconButton(icon: Icon(Icons.add, color: cs.primary), tooltip: '新增收藏', onPressed: _addItem),
          IconButton(icon: Icon(Icons.create_new_folder, color: cs.primary), tooltip: '新建收藏夹', onPressed: _createClassifier),
        ],
      ),
      body: Column(children: [
        // 收藏夹横向切换 + 标签 + 搜索
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
          child: Column(children: [
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(children: [
                ChoiceChip(
                  label: const Text('全部'),
                  selected: _curClassifier == null,
                  onSelected: (_) { setState(() => _curClassifier = null); _reload(); },
                ),
                const SizedBox(width: 6),
                for (final c in _classifiers)
                  Padding(
                    padding: const EdgeInsets.only(right: 6),
                    child: ChoiceChip(
                      label: Text('${c['icon']} ${c['name']}'),
                      selected: _curClassifier == (c['id'] as num).toInt(),
                      onSelected: (_) { setState(() => _curClassifier = (c['id'] as num).toInt()); _reload(); },
                    ),
                  ),
              ]),
            ),
            const SizedBox(height: 6),
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(children: [
                for (final t in _tags)
                  Padding(
                    padding: const EdgeInsets.only(right: 6),
                    child: ChoiceChip(
                      label: Text('#$t'),
                      selected: _curTag == t,
                      onSelected: (sel) { setState(() => _curTag = sel ? t : ''); _reload(); },
                    ),
                  ),
              ]),
            ),
            const SizedBox(height: 6),
            TextField(
              controller: _search,
              decoration: const InputDecoration(hintText: '搜索收藏...', isDense: true, prefixIcon: Icon(Icons.search)),
              onSubmitted: (_) => _reload(),
            ),
          ]),
        ),
        const Divider(height: 1),
        Expanded(
          child: _loading
              ? const Center(child: CircularProgressIndicator())
              : _error != null
                  ? Center(child: Text(_error!, style: TextStyle(color: cs.error)))
                  : _items.isEmpty
                      ? Center(child: Text('暂无收藏，点右上角 + 添加', style: TextStyle(color: cs.onSurfaceVariant)))
                      : ListView.builder(
                          padding: const EdgeInsets.all(12),
                          itemCount: _items.length,
                          itemBuilder: (_, i) {
                            final item = _items[i];
                            final id = (item['id'] as num).toInt();
                            final tags = ((item['tags'] as List?) ?? const []).map((t) => t.toString()).toList();
                            final kind = item['kind'].toString();
                            return Card(
                              elevation: 0,
                              color: cs.surfaceContainerLow,
                              margin: const EdgeInsets.only(bottom: 10),
                              child: Padding(
                                padding: const EdgeInsets.all(12),
                                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                  Text(_contentOf(item), style: TextStyle(color: cs.onSurface, fontSize: 14)),
                                  const SizedBox(height: 6),
                                  Row(children: [
                                    Text(kindLabel[kind] ?? kind, style: TextStyle(color: cs.primary, fontSize: 11)),
                                    if (item['classifierName'] != null) ...[
                                      const SizedBox(width: 8),
                                      Text('${item['classifierIcon']} ${item['classifierName']}', style: TextStyle(color: cs.onSurfaceVariant, fontSize: 11)),
                                    ],
                                  ]),
                                  if (tags.isNotEmpty) ...[
                                    const SizedBox(height: 4),
                                    Wrap(spacing: 4, children: [for (final t in tags) Chip(label: Text('#$t'), labelStyle: const TextStyle(fontSize: 10), visualDensity: VisualDensity.compact, padding: EdgeInsets.zero)]),
                                  ],
                                  const SizedBox(height: 6),
                                  Row(children: [
                                    TextButton.icon(onPressed: () => _forward(id), icon: const Icon(Icons.send, size: 15), label: const Text('转发')),
                                    TextButton.icon(onPressed: () => _organize(item), icon: const Icon(Icons.manage_search, size: 15), label: const Text('整理')),
                                    const Spacer(),
                                    IconButton(icon: Icon(Icons.delete_outline, color: cs.error), onPressed: () => _delete(id), tooltip: '删除'),
                                  ]),
                                ]),
                              ),
                            );
                          },
                        ),
        ),
      ]),
    );
  }
}