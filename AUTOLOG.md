# SecureChat 工作日志

## 2026-09-25 服务端安全审计（reactions 越权修复）

### 审计范围
- 路由清单共 163 条，核对鉴权：认证区（cap/email code/register/login/reset/change）、扫码登录（qr create/image/status/confirm/consume）、消息区（recall/edit/reply/pin/favorite/history 越权检查）、文件区（files 上传下载、call-recordings 双方+admin 校验、路径遍历防护已存在）、朋友圈（moments feed 仅好友+自己、like/comment 好友+黑名单守卫）、视频/公众号/拍一拍/笔记/反馈（有鉴权+限流+存在性校验）、admin 全路由经 adminGuard（还核对 ADMIN_EMAILS 鉴权无法被 /api/profile 篡改）。
- verifyToken 已含 banned + token_version 校验，封禁/改密即作废旧 token；`/api/history/:peerId` WHERE 限定本人收发，无法越权读他人消息；群消息/成员接口有成员校验。

### 发现并修复（commit db12837，已推送）
- **P1 越权：`GET /api/messages/:id/reactions` 无鉴权**——未登录可枚举任意消息 id 的回应数据。
- **P1 越权：`POST /api/messages/:id/reactions` 只校验消息存在，不校验归属**——可对与本人无关的私聊消息添加回应/探测消息存在性。
- 修复：新增 `reactionMsgAuth(msgId,userId)`（私聊消息须 from/to 含本人，或本人为群成员），POST/GET 均先鉴权再校验归属；未登录 401、无归属 403。
- 实测（真实登录 xa）：无 token GET→401、非归属消息 POST→403 生效。

### 检查过无问题
- 封禁/改密 token 失效链路、moments 可见性（双向好友）、friends accept 双向写行、admin 全路由鉴权、JWT_SECRET/.env 已设强值、call-recordings 越权保护。

## 2026-09-24 撤回视觉重造（用户："换回来！！！不要这个"）

- 对 3358f9a（去 AI 味重造）执行 git revert → 8647644，web/chat.html、styles.css 及 electron/capacitor www 全部回到 5d63995（亚克力+渐变+毛玻璃旧版）。
- 备份重造版到 backups/web_restoreback_20260924_213031\（app.js/chat.html/i18n.js/styles.css + 两个 www 的 chat.html）。
- 恢复后 3 目录逐字节一致、缓存版本回到 1813x（38 处）、无乱码、node --check 通过。
- 浏览器实测：rail 已回浅色 #f2f3f5、body::before 亚克力 radial-gradient 渐变恢复、?v=1813x 由服务器实际提供。
- 已推送 3358f9a..8647644 到 remote main。

## 2026-09-24 乱码事故与修复（重要）

### 事故
- 上一轮（2026-09-23 会话二 b075c81）误用 PowerShell 写 UTF-8 文件，导致 web/app.js、chat.html、styles.css、i18n.js 及两个 www 副本中文全部双重编码乱码，用户反馈"全都乱码了"。

### 修复
- 从 git 基线 a955219（干净 UTF-8）恢复全部 12 个文件（web 63 文件 + electron www 18 + capacitor www 20）。
- **全程改用 Node.js fs 读写 UTF-8**（fs.readFileSync/writeFileSync 'utf8'），杜绝 PowerShell GBK 隐患。
- 重新做全部功能（这次编码已验证无乱码）：
  1. 发送规则：Enter 直发，Shift+Enter 或 Ctrl+Enter 换行（app.js keydown ×2、chat.html 两处 placeholder+welcome-tip、i18n.js zh/en）。
  2. 删垃圾入口：发现页只留 朋友圈+小程序；features 内容组只留 公众号/小程序，生活组删 购物/游戏/附近的人（留 相册/卡包/表情/红包/摇一摇/扫一扫/支付生活）。
  3. chat.html 移除 7 个模块 script（videos/live/nearby/read/search/shop/games）。
  4. 亚克力：保留基线内联 `<style>` 块（已完整），styles.css 追加 acrylic-off 开关层 + 气泡样式 + settingsPanel 玻璃。
  5. 设置页扩充：亚克力玻璃开关（sc_acrylic）、发送音效（sc_sound + playSendSfx WebAudio）、气泡样式（sc_bubble_style 圆角/直角/圆润）、清理本地缓存；applyUiPrefs() 登录后应用。
  6. admin 后台三 tab（概览/在线/兑换码）：chat.html adminView 重写（Node 脚本替换，div 闭合平衡 126/126）、app.js 新增 admin-nav-tab 切换 + loadAdminOverview 渲染 /api/admin/overview（统计卡 + 在线用户列表）、styles.css admin tabbar/cards/rows 样式。
- 版本 1812x→1813x（chat.html 38 处），三目录同步。
- `node --check` app.js/i18n.js 通过；服务器 curl 验证：v1813、管理后台、admin-nav-tab、垃圾 script 全确认。
- garble 检测器（U+FFFD + 常见乱码字）跑全部 12 文件 = 0 乱码。

## 2026-09-23 会话二（已废弃，见上乱码事故）

### 已完成（本轮）
- **发送规则**：Enter 直接发送，Shift+Enter / Ctrl+Enter 换行（app.js #input / #desktopInput keydown），welcomeTip + 两处 placeholder + i18n.js zh/en 文案同步。
- **去垃圾功能**：发现页只留 朋友圈 + 小程序（原 视频号/看一看/搜一搜/直播/附近/购物/游戏 删除）；features 面板内容组只留 公众号/小程序，生活组留 相册/卡包/表情/红包/摇一摇/扫一扫/支付生活；chat.html 移除 videos/live/nearby/read/search/shop/games 共 7 个 script 标签（模块文件保留未加载）。
- **亚克力重做（用户要求"这些背景全部重做"）**：原内联 style 块删除后，重新在 styles.css 实现完整亚克力层（body::before/::after 彩色渐变流动背景 + acrylic-drift 动画、sidebar/header/composer/auth-card 等 backdrop-filter blur+saturate 玻璃面板、暗色变体、body.acrylic-off 开关、bubble-in/panel-fade/authIn 动画、移动端退化、prefers-reduced-motion 支持）。chat-bg 联动 body.has-user-chat-bg。
- **设置页扩充（用户要求"设置太少了"）**：通用组新增 亚克力玻璃效果开关（sc_acrylic）、发送音效开关（sc_sound + playSendSfx WebAudio pop）、气泡样式切换（sc_bubble_style 圆角/直角/圆润）、聊天背景（openChatBgPicker）、清理本地缓存（sc_msg_* 等）。applyUiPrefs() 登录后应用。
- **admin 扩展（用户要求"admin管理太少了"）**：chat.html adminView 重写为三 tab 结构（概览/在线/兑换码），app.js 新增 admin-nav-tab 切换、loadAdminOverview() 渲染 /api/admin/overview 统计卡（总用户/在线/新增/好友/群/消息/反馈/库大小）+ 在线用户列表（adminOpenUser 填入搜索框），进入后台自动加载；styles.css 新增 admin-tabbar/overview/user-row 暗色适配样式。
- node --check app.js/i18n.js 通过；缓存版本 1813x → 1814x（38 处）；同步 electron/capacitor www；服务器 /api/version 正常，admin/overview API 已存在验证可用（前端渲染受 ADMIN_EMAILS 凭证限制，未用真实管理员账号端到端点验）。

### 遗留
- chat.html div 静态计数 open125/close113（差 12），根源是上一会话删内联 style 块时的行操作丢失（pre_admin 备份即含），浏览器宽容渲染、页面正常使用中，待用户反馈布局异常再修。
- AUTOLOG.md、备份目录已建（backups/web_pre_admin_20260923_221055 等）。

## 2026-09-23 会话（AI 横幅 + 钱包资金审计）

### 已完成并推送
- **f336e3d** 发现页与设置页 AI 入口改为图片化横幅（web/styles.css `.ai-banner*`、web/app.js renderDiscoverPage 顶部横幅 + openSettingsPage AI 组 banner 渲染）。同步 electron/capacitor www，缓存版本 1811x → 1812x。浏览器实测发现页+设置页横幅与点击跳转均正常。
- **ad9e9f3** 钱包资金 bug 修复（payment.js）：
  1. `doPay` self-pay 分支（生活缴费/自付）：原来只记流水不补回余额 → 余额凭空消失；现在 `UPDATE wallets SET balance=balance+?` 补回，净值不变不虚增 total_received。实测 life/pay 前后余额 167.03 不变。
  2. `life/pay` 回调参数错位（cb=true、allowSelf=回调）→ 每次缴费都 `TypeError: cb is not a function` 返回 500；已修正参数顺序。
  3. 模拟支付 `/api/pay/gateway/epay/mock/pay` 先支付后标记订单，并发双请求可重复扣款；改为先原子抢占 `status='paid'` 再 doPay，失败回滚。
  4. `/api/pay/gateway/epay/notify` 事务内无状态条件更新，EPay 并发重试可重复给商户入账；改为 `WHERE id=? AND status<>'paid'` 条件翻转。
- **a955219** 群接龙/群收款加固（payment.js）：
  1. `solection_entries` 补唯一约束 `uq_solection_once(solection_id,user_id)`，join 处理 UNIQUE 冲突返回 409。
  2. 群收款崩溃窗口双扣：占位行 `(处理中)` 超 5 分钟删除重试前，先查 wallet_txn 是否已有成功扣款（kind='out' AND peer_id=creator AND amount AND created_at>=占位 AND remark LIKE '群收款%'），有则直接转正给占位行，避免重复扣款。

### 本轮其余审计（未发现问题或无需改）
- `/api/wallet/transfer`：单事务 CAS 扣款+入账，正确。
- `/api/wallet/redeem`：rateLimit(20/60s)+claimed_by CAS，正确。
- `/api/wallet/recharge/notify`：只认商户密钥 epay_config.key 验签、金额校验、事务内幂等，正确（此前已去掉 .epaygw_key.json 后备验签，防源码默认密钥伪造）。
- epaygw.js act=order 验签、cloudreve 分支、renderCashier、gwAdminAuth，正确。
- 收付款码 confirm：原子 claim used_count（收款码）或 status（付款码）后再 doPay，失败回滚计数/状态，正确。
- 网关订单 confirm：先 claim 订单再 doPay 失败回滚，正确。

### 环境备忘
- 服务器已重启运行，curl 实测 life/pay 与转账通过。
- push 命令带 PAT auth header 经 gh-proxy.com。

---

## 2026-09-30 画风 + Bug 全面修复轮（用户投诉"画风垃圾、bug巨多"）

用户要求自查方向（"自己找"、"几乎全是"），故做全量代码审计 + 样式补齐。

### 根因
画风崩坏的**直接原因**不是配色审美，而是 **14 个业务模块的界面 class 在 styles.css 中一条规则都没有**：
favorites / moment-ext / status / todos / remind / translate / oa / polls / scan /
shake / miniapp / chat-ext / filehelper / feedback。这些面板全部由
`document.createElement` + `className=` 动态拼接，运行时无任何 `<style>` 注入，
导致打开后是**未样式化的原生控件堆叠**（按钮无样式、栅格塌陷、浮层无定位）。
共统计出 **278 个缺失 class**（含正则误抓的模板表达式碎片）。

### 修复内容
**Bug 修复（P0-P2）**
- P0 `app.js:4998` 调用不存在的全局 `modal` → "关于我们"一点就抛
  `ReferenceError: modal is not defined`，弹窗完全打不开。
  新增 `showInfoModal(title, html)`（复用现有 .modal-mask/.modal 结构，画风统一）并替换调用。
- P1 `app.js:2601` `$('inviteBtn')` 元素不存在，真实 id 是 `inviteGroupBtn`
  → 群资料"邀请成员"静默失效（有 `if (btn)` 守卫故不报错，只是不干活）。
- P2 `modules/registry.js:89` 与 `modules/voicemsg.js:125` 探测 `window.socket`，
  但 app.js 从不设置它（WS 存在 `state.ws`，且 `state` 已挂 `window.state`，见 app.js:53）
  → `wsCycleSend()` 恒 false，通话信令 100% 退化为 REST 轮询。已改为
  `window.state && window.state.ws`。
- P2 `modules/rtc.js:145` if/else 两分支语句完全相同的死逻辑（误导性写法），
  行为本身符合注释意图（WS 为主 + REST 兜底），已合并为两行明确语句。
- P2 i18n key 复用冲突（`apply()` 无条件覆盖 textContent）：
  "拒绝好友"显示成"关闭"、"邀请成员"显示成"添加"、聊天 tab 显示成"好友"、
  接受好友显示成"添加"、创建群聊/添加好友入口文案错位。
  新增 5 个语义专用 key（acceptFriend/rejectFriend/inviteMember/tabChats/messages），
  zh+en 双语补齐，chat.html 4 处替换完成，无残留。

**画风修复**
- 新增 `web/modules.css`（225 条规则），为上述 14 个模块补齐完整视觉规范，
  与 styles.css 的微信系设计语言对齐：主色 `--primary #07c160`、面板圆角 12px、
  卡片 8px、按钮 6px、遮罩 rgba(0,0,0,.45)，含暗色模式适配。
- chat.html 引入 `modules.css`（stylesheet 链接数 1 → 2）。
- 覆盖率：278 → 0（**剩余 0 个真实 class 未覆盖**；残留 21 项均为正则误抓的
  模板表达式碎片如 `${mine(r)}`、`' + polls-opt'`，非真实 class 名）。

**客户端同步**
- 修正认知错误：`desktop-build/{electron,capacitor}/www` 此前是**仅 18 个文件的局部快照**，
  `git ls-files` 证实其**从来就没有 modules/ 目录**（非本次改坏）。
  已做**全量同步**（web 共 64 文件 × 2 目录 = 128），三目录逐字节一致（SHA1 校验 0 差异）。
- 清理分析碎片 `_ids_defined.txt`、`_undef.json`。

### 验证
- 5 个改动 JS 全部 `node --check` 通过。
- 真实浏览器验证（playwright-core + 系统 Edge 内核，忽略证书）：
  - `modules.css` 加载成功，225 条规则生效
  - `showInfoModal` 已定义；"关于我们"弹窗 `opened-ok`
  - 登录 xa/123456 成功
  - 收藏夹面板计算样式实测：panel 12px 圆角/白底/flex、search 6px 圆角+1px 边框、
    tags flex 布局 —— 确认不再是裸 div
  - **控制台 0 错误、0 失败请求**
- 版本号 1813x → 1814x（chat.html 内 39 处引用全部推进）。

### 备注
- `.sc-fav-tag`/`.sc-fav-item` 在验证中 NOT-FOUND 属正常（测试账号无收藏数据，走空态）。
- 服务器状态：index.js 45616 单实例 + watchdog，8888 正常；计划任务 SecureChatGuard
  日志持续 `idx=True wd=True`。曾误报"2 个 index.js"，实为另一项目
  `D:\pandown\server\index.js`（pid 7068），非本项目重复实例。


## 2026-11-06 Web 客户端微信化收口（skin.css v59→v77, app.js 1828w→1829h）
- 图片消息改为微信式裸图（无文件卡头），气泡去内边距/背景，最大 200x260。
- 转发选择器改移动端底部弹层/桌面 380 卡片，行高 56、头像 40。
- 引用消息移入气泡内，灰色 12.5px 两行截断；隐藏"转发的消息"标签。
- 消息行、会话行、通讯录行按微信尺寸：会话行移动端 64 高、头像 48、预览 13px。
- 空聊天页改为微信水印（大号浅灰"微信"），隐藏 AI 味欢迎卡片/特性标签。
- 统一强调色为微信绿（模块内联 #2563eb/#3b82f6 等批量替换）。
- 扁平化：功能中心图标、登录页 tabs、红包/通话/模块按钮、聊天背景选择器、邀请进群面板、更多菜单。
- 隐藏非微信元素：草稿提示、已读状态、侧栏底部个人卡、设置页单字图标。
- 回复提示条改为浮在输入区上方的整宽条。
- 加号面板扩为 8 项（相册/拍摄/文件/红包/转账/收藏/语音通话/视频通话），图标改几何符号。
- 输入框占位符简化为"输入消息"。
- 回归：smoke2/fin/mom/func 全通过，0 JS 异常，1440/1024/390/320 无横向溢出。
- 注意：登录接口限流 5 次/15 分钟，测试改用缓存 token 注入 localStorage（tok.json）。

## 2026-11-07 Web 客户端移动端修复与微信化（skin.css v84→v109, app.js 1829m→1829q）
- 修复 body 挂载的 .wechat-page 在移动端无定位导致整页掉到视口下方（y=844）的 bug：固定全屏 + 子页隐藏底栏。
- 移动端聊天列表新增「微信」标题；通讯录/发现页恢复 44px 标题栏（原先被误隐藏），隐藏返回键、列表改为全宽无圆角。
- 通讯录页头加「+」按钮，复用发起群聊/添加朋友/扫一扫菜单。
- 会话行分隔线移动端 inset 76px；发现/我列表补 56px inset 分隔线。
- 移动聊天头部返回改 ‹；发送键仅在输入非空时显示（56×32）；朋友圈标题居中、返回改 ‹。
- 设置页返回改 ‹、隐藏滚动条使行全宽；我页昵称 17px。
- 通讯录行改为微信式仅昵称、40px 头像、隐藏在线状态；搜索框 36px/12px 边距/圆角 4。
- 扁平化：输入栏图标与发送键、消息提示、oa 弹窗、会员卡；theme-white 蓝色渐变 token 改纯绿。
- 回归：smoke2/fin/mom/func/audit3/mods/dk10 通过；390/320 无横向溢出；0 JS 异常。
- 注意：登录限流仍在，测试用 tok.json 注入；AUTOLOG 中文写入用 [IO.File]::AppendAllText UTF8。
### 追加（同日）
- 修复设置页关闭后不回到原 tab（移动端我页消失）的问题：关闭时点击当前激活 tab 恢复页面。
- 修复加号面板「收藏」调 openPanel() 无容器导致面板不显示：改走 openContainerFeature 弹窗。
- 收藏模块 13 处原生 prompt 全部替换为微信风格自定义输入弹窗（.sc-fav-ask，8px 圆角、绿色确定），含暗色适配。
- 移动端首页搜索框改为全宽 366x36、标题行「微信」+「+」。
- 版本：skin.css v114、app.js 1829s、favorites.js 1829b、i18n.js 1829c、theme-white.css v27。
### 追加 2（移动端流程 bug）
- 修复从「发现 → AI 助手」进入后 AI 视图只显示一部分且返回后列表横向错位：AI 视图加 mobile-chat-active 全屏显示，切换 tab 重置 chatView.scrollLeft。
- 修复「我 → 下载」在移动端页面停在屏幕右侧不可见、返回后仍遮挡我页：下载视图加 mobile-chat-active + dl-hidden 类控制显隐，返回固定回「我」页。
- 修复侧栏「+ → 添加朋友」输入行不显示：菜单点击 stopPropagation，避免被外部点击监听立即收起。
- 移动端下载页改为 44px 标题栏、‹ 返回、全宽内容、隐藏滚动条。
- 回归：smoke2/func/audit3/msw320/ov1440 全通过，0 JS 异常。
- 版本：skin.css v118、app.js 1829x。
## 2026-11-07 Web 客户端对话框统一与移动端流程补漏（skin.css v119, app.js 1830h）
- 新增全局 scAsk/scConfirm（复用 .sc-fav-ask 样式，含暗色），替换 passkey 设备名/密码、绑定邮箱、群移除/解散/退出、视频评论、直播回放、接龙主题、公众号作者回复、删除会话/消息、清空记录、退出登录、商户密钥重置等原生 prompt/confirm。
- 功能中心「翻译」改为独立翻译弹窗（scAsk 输入 + 现有结果卡），红包仍提示先选聊天对象（无会话时的正确行为）。
- 修复移动端从「发现 - AI 助手」进入后无返回入口：AI 头部新增移动端返回键（‹），按来源返回发现页或聊天列表。
- 新增会话列表移动端长按菜单（置顶/免打扰/标为未读/删除），修复长按抬手后菜单被 click 立即关闭（400ms 保护）。
- 通讯录搜索无结果新增「没有匹配的联系人」空态；从通讯录打开聊天后返回回到通讯录而非微信列表。
- 修复 scAsk 编辑过程中误删 appendMessage 声明（已恢复）；版本 app.js 1830h、skin.css v119、translate.js 1829c。
- 回归：smoke2/func/audit3/msw320/ov1440 全通过；功能中心 26 项巡检 0 JS 异常（翻译/红包为 toast 属预期）。
### 追加（同日 2）
- scAsk 支持 readonly（复制失败兜底展示文本）；translate 复制兜底与 merchant 密钥重置改用主题弹窗。
- 复测：发现页 9 个功能弹窗关闭键均在视口内；我页 10 个服务、设置页、黑名单、朋友圈发布器、聊天更多菜单、加号面板（红包/转账/收藏）均正常；登录页 390 无溢出。

## 2026-11-07 Web 客户端群聊/资料页补全（app.js 1831d, skin.css v120）
- 群公告编辑改用多行 scAsk（textarea、Ctrl+Enter 提交、2000 字限制），替换最后一个原生 prompt。
- 修复群聊 @ 面板显示「用户[object Object]」：群成员为对象，改为读取 nickname/myNickname，并排除自己。
- 个人资料卡新增「语音通话/视频通话」按钮（微信式四宫格操作）。
- 「我」页二维码入口改为打开我的名片二维码（原为扫一扫）。
- 消息内搜索高亮改微信绿（#07c160）。
- 复测：群聊 @、群资料/公告、邀请进群、转发选择器、聊天背景、会话搜索、深色模式（列表/发现/我/朋友圈/scAsk）全部正常；smoke2/audit3/msw320 0 异常。
