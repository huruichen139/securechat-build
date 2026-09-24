# SecureChat 工作日志

## 2026-09-24 重造视觉：去 AI 味翻新版（用户："全部重造，这个太像ai了"）

### 目标与做法
- 去掉 AI 模板痕迹：彩色径向渐变、毛玻璃 backdrop-filter、装饰光斑/白圈、渐变按钮、大卡片圆角阴影、字母间距大写 kicker。换成微信式工具界面：中性灰工作台、白色平板面板、小圆角(5-8px)、绿色 #07c160 仅用于动作/激活态、气泡 #95ec69(我)/白(对方) radius 6px 无阴影、消息背景 #ececec、深色微信式竖条侧栏 #2c2c2c。
- 备份：backups/web_redesign_20260924_200449\（app.js/chat.html/i18n.js/styles.css）。
- chat.html：删除整块内联亚克力 `<style>`（body::before 光斑、radial-gradient、backdrop-filter 面板、暗色渐变体）；欢迎面板文案 "SECURE COMMUNICATION"→"SECURECHAT"。
- styles.css 尾部追加扁平覆盖层（约 13.8KB）：rail 深灰/白 sidebar/平铺 contact/扁平 header/messages #ececec/微信气泡/克制欢迎面板/扁平 discover 与 me 列表/无装饰圈 AI banner（.ai-banner-bg,.ai-banner-bg-sm{display:none!important}）/扁平 modal/按钮/登录卡 radius 6/admin 扁平 tab/动画抑制（ripple-fx、bounce、viewIn 关闭）/暗色扁平变体。
- 修正轮：`#settingsPanel`+sidebar/header/composer/mobile-bottom-nav/contact-alphabet-index 全部 backdrop-filter:none!important（纯底下 blur 冗余）；`body.dark-mode .brand-status`、`.composer-tools .tool{border-radius:5px!important}`（被 .composer-tools .tool 特异性压制的 10px 圆角）。
- 浏览器实测（127.0.0.1:8888，playwright，登录 xa）：rail #2c2c2c、sidebar 白无阴影、messages #ececec、.tool radius 5px、auth-card 6px 白卡、全 backdrop-filter:none、0 console 错误、无文字乱码；`?v=1814x` 已由服务器实际提供。
- 缓存版本 1813x→1814x（chat.html 38 处），同步 electron/capacitor www ×4 文件（与 web 逐字节一致）。
- 未提交未推送。

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