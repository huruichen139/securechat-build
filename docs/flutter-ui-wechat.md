# SecureChat Flutter UI 微信对齐报告

## 变更概览

将 SecureChat Flutter 桌面端 UI 对齐到微信视觉风格（约 95%），不改加密/业务逻辑，仅改呈现层。

---

## 1. 主题色变更

| 项目 | 旧值 | 新值 |
|------|------|------|
| 主色 (primary) | `#18a66a` | `#07c160`（微信绿） |
| 我方聊天气泡 | `t.primary` 透明叠加 | `#95EC69`（微信绿） |
| 对方聊天气泡 | `t.bubbleOther`（深色模式灰色） | `Colors.white`（白色） |
| 背景底色 | `#f4f6f8`（浅灰蓝） | `#ededed`（微信浅灰） |
| 发送按钮 | `FilledButton` 默认色 | `#07c160` 实心绿 |

**文件**: `lib/services/app_config.dart`

- 默认 primary 改为 `Color(0xff07c160)`
- 预设颜色列表同步更新（去掉 `#ec4899`，保留 `#07c160` 为首选项）

---

## 2. 底部导航栏（4 Tab）

新增微信风格底部 Tab 栏，固定在窗口底部：

| Tab | 图标（未选中/选中） | 内容 |
|-----|---------------------|------|
| 微信 | `chat_bubble_outline` / `chat` | 原有会话列表 + 聊天窗口 |
| 通讯录 | `contacts_outlined` / `contacts` | 联系人列表（好友 + 群聊分组） |
| 发现 | `explore_outlined` / `explore` | 新页面（扫一扫、朋友圈等入口） |
| 我 | `person_outlined` / `person` | 新页面（头像、昵称、服务清单） |

**选中色**: `#07c160`，未选中色: `theme.subText`

**文件**: `lib/main.dart` — `_ChatShellState.build()` 改用 `Column([_WindowDragBar, Expanded(sliver), _bottomNav])`

---

## 3. 聊天气泡（微信风格）

### 我方消息（绿色气泡）
- 背景色: `#95EC69`（微信绿）
- 圆角: 左上 4px / 右上 4px / **右下 14px**（尾巴指右）/ 左下 4px
- 文字色: `#1a1a1a`（深色，确保绿色底可读）
- 阴影: `alpha=0.06`，偏移 `(0, 2)`

### 对方消息（白色气泡）
- 背景色: `Colors.white`
- 圆角: 左上 4px / 右上 14px（尾巴指左）/ 右下 4px / 左下 4px
- 文字色: `theme.text`
- 显示对方头像（灰色 circle）+ 名字（群聊场景）

### 语音气泡
- 同文字气泡的圆角/颜色规则，内嵌播放按钮 + 波形动画

**文件**: `lib/main.dart` — `_textBubble()` 和 `_voiceBubble()` 方法

---

## 4. 发现页（新增）

**文件**: `lib/discover_page.dart`

仿微信发现页卡片列表结构：
- 顶部：扫一扫（带 icon + 箭头）
- 分组标题：朋友 / 附近 / 购物 / 小程序
- 每项：左 icon（灰色）+ 名称 + 右箭头
- 背景色 `#ededed`，卡片白色，分割线 `#e5e5e5`

条目：
| 分组 | 条目 |
|------|------|
| 朋友 | 朋友圈、视频号、看一看、搜一搜、直播 |
| 附近 | 附近的人、附近门店 |
| 购物 | 购物、游戏 |
| 小程序 | 小程序精选、最近使用 |

---

## 5. 我的页（新增）

**文件**: `lib/me_page.dart`

- 顶部：圆形头像（绿色底 + 首字母）+ 昵称 + 微信号
- 服务清单（仿微信"服务"卡片）：
  - 支付（`payments_outlined`）
  - 收藏（`favorite_border`）
  - 相册（`photo_library_outlined`）
  - 卡包（`wallet_giftcard_outlined`）
  - 表情（`emoji_emotions_outlined`）
  - 设置（`settings_outlined` → 跳转 SettingsPage）
- 背景色 `#ededed`，卡片白色，分割线 `#e5e5e5`

---

## 6. 会话列表（微信化）

- 左侧面板宽度固定 280px
- 搜索框：圆角 8px，灰底，带搜索图标
- 会话项：左边 CircleAvatar（绿色 accent）+ 名字 + 状态文字
- 选中项：浅绿色底 `primary.withValues(alpha: 0.12)`
- 底部功能入口：名片 / 朋友圈 / 钱包 / AI / 设置 / 功能中心（灰色小字 + icon）
- 分隔线：`theme.div`，细线 1px

---

## 7. 通讯录页（微信化）

- 分组标题：灰色背景圆角小标签（`#e3e8eb` 浅色模式）
- 联系人项：CircleAvatar（绿色 accent）+ 名字 + 在线绿点
- 两个分组：联系人 / 群聊

---

## 8. 窗口拖拽条

- 左：锁图标（绿色 `#07c160`）+ "SecureChat" 文字
- 右：最小化 / 最大化 / 关闭按钮（保持原样式）

---

## 验证结果

```
flutter analyze lib
→ 0 errors, 0 warnings（main.dart 相关）
→ 全部为 pre-existing info 级别提示（来自 group_page.dart、favorites_page.dart 等未修改文件）
```

---

## 文件清单

| 文件 | 变更类型 |
|------|----------|
| `lib/services/app_config.dart` | 改默认 primary 色 + 预设色列表 |
| `lib/main.dart` | 重构 ChatShell 为 4-Tab 框架；聊天气泡微信化；窗口拖拽条绿标 |
| `lib/discover_page.dart` | **新建** — 发现页 |
| `lib/me_page.dart` | **新建** — 我的页 |
| `lib/services/securechat_api.dart` | 修复缩进（恢复 class 方法层级）+ 新增 `pinMessage` |

---

## 未改动

- 加密逻辑（`chat_crypto.dart`、`x3dh.dart`）
- API 通信（`securechat_api.dart` 业务方法）
- 会话 WebSocket 消息处理
- 语音录制/播放逻辑
- 通话逻辑（`call_service.dart`、`call_page.dart`）
- 朋友圈、钱包、AI 等子页面内部逻辑
- 所有已有 import（保持向后兼容）
