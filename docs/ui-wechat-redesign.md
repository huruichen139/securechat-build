# SecureChat Web UI 微信式改版 — 改动清单

> 日期：2026-08-13  
> 目标：Web 端 UI 对齐微信 95%，不改加密/功能逻辑，只改 UI 呈现层。

---

## 一、CSS 变量表（已有，新增补充）

| 变量名 | 值 | 用途 |
|--------|-----|------|
| `--primary` | `#07c160` | 微信绿（主色） |
| `--primary-soft` | `#e9f7ef` | 浅绿背景 |
| `--bubble-mine` | `#95ec69` | 自己气泡底色 |
| `--bubble-other` | `#ffffff` | 对方气泡底色 |
| `--bg` | `#ffffff` | 页面背景 |
| `--side-bg` | `#ededed` | 侧栏/聊天底灰 |
| `--text` | `#191919` | 主文字色 |
| `--muted` | `#888` | 辅助文字色 |
| `--nav-bg` | `#f7f7f7` | 导航栏背景 |
| `--nav-border` | `#d8d8d8` | 导航边框 |

**新增视觉变量（隐性）**：
- 气泡尾巴：`#95ec69`（自己）/ `#ffffff`（对方）
- 深色模式气泡：自己 `#2e7d4f`，对方 `#2c2c2e`

---

## 二、新增 CSS 类（styles.css 追加）

| 类名 | 说明 |
|------|------|
| `.bubble-wrap` | 气泡容器，带定位上下文 |
| `.bubble::before` / `.bubble::after` | 聊天气泡小三角尾巴 |
| `.msg-row.me .bubble::before` | 自己气泡右尖角 |
| `.msg-row.other .bubble::before` | 对方气泡左尖角 |
| `.chat-header` | 微信式移动端聊天顶部导航栏 |
| `.chat-composer` | 微信式移动端输入栏（图标+圆角输入框+发送按钮） |
| `.wechat-page` | 移动端全屏子页面容器 |
| `.page-header` | 子页面顶部导航条（返回+标题） |
| `.discover-list` / `.discover-item` | 发现页列表卡片 |
| `.discover-icon` | 发现项彩色方块图标 |
| `.me-page` / `.me-header` / `.me-avatar` / `.me-services` | 我的页头部 |
| `.me-card` / `.me-card-item` / `.me-card-icon` | 我的页服务清单卡片 |
| `.contact-section` / `.contact-section-header` / `.contact-group-label` | 通讯录字母分组 |
| `.bottom-nav` / `.tab-item` / `.tab-active` | 底部 Tab 导航样式 |
| `.tab-badge` | Tab 红点未读数 |
| `.composer-icon-btn` | 输入栏图标按钮（语音/表情/更多） |
| `.composer-send-btn` | 微信式发送按钮 |

---

## 三、index.html 改动

### 新增元素
1. **微信式移动端聊天头部** `#chatMobileHeader`
   - 返回按钮 `#chatMobileBackBtn`
   - 标题 `#chatMobileTitle`
   - 更多按钮 `#chatMobileMoreBtn`

2. **微信式移动端输入栏** `#chatMobileComposer`
   - 语音图标 `#voiceIconBtn`
   - 表情图标 `#emojiIconBtn`
   - 更多图标 `#plusIconBtn`
   - 发送按钮 `#sendBtn`（复用原 ID）
   - textarea `#input`（与移动端共用，桌面端隐藏）

3. **桌面端输入框保留**
   - `#desktopInput`（桌面 textarea，ID 不与移动端冲突）
   - `#desktopSendBtn`（桌面发送按钮）
   - `#draftStateDesktop`（草稿提示）

4. **三个全新移动端全屏页面**
   - `#discoverPage` — 发现页（列表卡片）
   - `#mePage` — 我的页（头像+昵称+服务清单）
   - `#contactsPage` — 通讯录页（搜索+字母分组）

5. **通讯录页子元素**
   - `#contactsSearch` — 搜索框
   - `#contactsNewFriends` — 新好友请求列表
   - `#contactsLabels` — 标签分组
   - `#contactsGroups` — 朋友群
   - `#contactsOA` — 公众号
   - `#contactsAlphabetSection` — 字母索引好友列表

### 保留不变
- 原 `.header`（桌面端聊天头部）
- 原 `.composer`（桌面端输入栏）
- 原侧边栏结构（sidebar-rail + sidebar-content）

---

## 四、app.js 改动

### 新增函数
| 函数 | 说明 |
|------|------|
| `showMobileChatView()` | 显示移动端聊天视图（切换 header/composer 可见性） |
| `hideMobileChatView()` | 隐藏移动端聊天视图，回到列表态 |
| `hideMobilePages()` | 关闭所有移动端全屏子页面 |
| `showMobilePage(pageId)` | 打开指定移动端全屏页面 |
| `renderDiscoverPage()` | 渲染发现页列表（8 个功能入口） |
| `renderMePage()` | 渲染我的页（头像/昵称/ID + 6 个服务卡片） |
| `renderContactsPage()` | 渲染通讯录页（搜索过滤 + 字母分组） |
| `initWechatMobileNav()` | 绑定移动端 Tab 路由事件 |

### 修改函数
| 函数 | 改动 |
|------|------|
| `saveCurrentDraft()` | 根据 mobile-chat-active 状态选择 `#input` 或 `#desktopInput` |
| `restoreCurrentDraft()` | 同上，同时更新对应 draftState 提示 |
| `sendCurrent()` | 根据当前视图选择正确的 textarea |
| `sendCurrentGroup()` | 同上 |
| 键盘事件绑定 | 同时绑定 `#input` 和 `#desktopInput` 的 keydown/input |
| 发送按钮绑定 | 同时绑定 `#sendBtn`（移动端）和 `#desktopSendBtn`（桌面端） |

### 新增事件绑定
- `#voiceIconBtn.onclick` → 触发原有 `voiceBtn` 录音逻辑
- `#chatMobileBackBtn.onclick` → 返回列表态
- `#chatMobileMoreBtn.onclick` → 打开 feature center
- `#discoverBackBtn` / `#meBackBtn` / `#contactsBackBtn` → 返回对应 tab
- 侧栏 `data-side="ai"` / `"downloads"` / `"groups"` → 打开对应全屏页面

---

## 五、遗留 TODO

| 项目 | 说明 | 优先级 |
|------|------|--------|
| 表情面板 | `#emojiIconBtn` 目前无实际面板，仅占位 | 中 |
| 朋友圈模块 | 发现页「朋友圈」条目点击后 toast，未接入实际数据 | 中 |
| 通讯录字母快速跳 | 侧边字母索引 bar（点击跳转到对应字母位置）未实现 | 低 |
| 我的页二维码展示 | 二维码区域仅文字 ID，未渲染真实二维码图 | 低 |
| 深色模式完整覆盖 | `.wechat-page` 内各组件深色适配已加，但部分动态内容（如 discover-icon 渐变）未做深色变体 | 低 |
| 桌面端气泡尾巴 | 桌面端 `.bubble::before/::after` 尾巴在宽屏上可能位置偏移，需进一步调试 | 中 |
| 移动端侧边栏 rail 隐藏 | 当前 rail 在 `is-mobile` 下 `display:none`，但 `initWechatMobileNav` 通过 `querySelector` 仍能选到（旧 DOM），需确认 rail 在移动端 DOM 中确实不存在或被正确隐藏 | 中 |

---

## 六、文件编码声明

| 文件 | 编码 | BOM | LF? |
|------|------|-----|-----|
| `index.html` | UTF-8 | 无 | 是 |
| `app.js` | UTF-8 | 无 | 是 |
| `styles.css` | GBK | 无 | 是 |
| `i18n.js` | GBK | 无 | 是 |
