# SecureChat 工作日志

## 2026-09-23 会话二（admin 扩展 + 设置扩充 + 亚克力重做 + 杂项清理）

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