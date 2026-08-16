# SecureChat Flutter 客户端 2026 设计指南

本指南用于指导重写 `desktop-build/flutter/securechat/lib/*.dart` 所有页面。
目标：**2026 真实产品风格，反 AI-slop，功能完整**。

## 核心原则（来自 2026 设计趋势调研）
1. **扁平、克制**：不要紫色/蓝色渐变、不要过度毛玻璃、不要悬浮发光阴影、不要弹跳 hover 动画。
2. **单一强调色**：微信绿 `Color(0xff07c160)` 只用于激活/主操作/关键状态。
3. **真正层级**：每屏一个焦点，其余安静；卡片内一条主操作，次级克制。
4. **安静动效**：150-200ms，只做背景/透明度变化，不做位移弹跳。
5. **全页面主题感知**：必须用 `config.theme` 的 `bg/panel/card/text/subText/div/inputBg`，**绝不允许硬编码浅色**（如 `Color(0xffededed)`、`Colors.white` 背景）。这会让暗色模式断裂。
6. **原生窗口质感**：已支持 Mica/Acrylic，保留 AppScaffold 的 BackdropFilter 机制，不要移除。

## 复用组件（lib/widgets/ux.dart）
已经写好，直接用：
- `PageHeader(title, config, trailing?, onBack?)` — 顶栏（标题+返回）
- `SectionCard(config, children, padding?, margin?)` — 扁平分组卡片
- `ListCell(config, icon, title, subtitle?, onTap?, trailing?, iconColor?, showArrow?)` — 列表单元格
- `SectionTitle(config, title)` — 分组标题
- `CellDivider(config, indent?)` — 卡片内分隔线
- `Ux.green` = `Color(0xff07c160)`；`Ux.radius`、`Ux.cardRadius`、`Ux.cellHeight`、`Ux.fast`(Duration)

## 必须做的事
1. **接入 ux.dart**：把页面改成用 `PageHeader`/`SectionCard`/`ListCell` 的扁平结构，去掉硬编码浅色。
2. **主题感知**：页面容器色 `t.bg`，卡片 `t.card.withValues(alpha:0.85)`，文字 `t.text`/`t.subText`，边框 `t.div.withValues(alpha:0.6)`。
3. **功能完整**：补齐"开发中/敬请期待"的占位，接上真实 API（参考 services/ 下对应 service）。
4. 保持现有构造函数签名兼容（`api`、`config` 参数），不要破坏 main.dart 调用。

## 页面清单与负责人
每个页面单独处理。改造时优先保证能编译（`flutter analyze` 无 error）。

### 批次 A（已由主会话处理）
- main.dart（ChatShell 左栏导航、登录、窗口条）
- discover_page.dart、me_page.dart

### 批次 B（你负责的页面，每个页面一个子代理）
- settings_page.dart
- ai_page.dart
- wallet_page.dart / wallet_extra_page.dart
- moments_page.dart
- videos_page.dart / videos_social_page.dart
- accounts_page.dart / oa_page.dart
- mini_apps_page.dart / miniapp_page.dart
- notebook_page.dart
- file_repository_page.dart / filehelper_page.dart
- community_tools_page.dart
- status_page.dart
- nearby_page.dart / shake_page.dart / scan_page.dart / qr_confirm_page.dart
- group_page.dart
- chat_ext_page.dart
- live_page.dart
- favorites_page.dart
- features_center.dart

## 验证
每个页面完成后必须能通过 `flutter analyze --no-pub`（无 error；info/warning 可接受但尽量少）。
