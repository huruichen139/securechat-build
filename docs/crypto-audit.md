# 加密审计：同账号 Web(JS) ↔ Flutter(Dart) E2E 互发对端解不开

## 1 实现位置清单

| 端 | 文件 | 类/函数 | 职责 |
|---|---|---|---|
| Flutter | `desktop-build/flutter/securechat/lib/services/x3dh.dart` | `x3dhKdf` / `deriveSk` / `ecdhShare` | X3DH identity-only：`sk=HKDF(DH(priv,peerPub))[:32]` |
| Flutter | `desktop-build/flutter/securechat/lib/services/ratchet.dart` | `_kdfRk`/`_kdfChain`/`_aesGcmEncrypt`/`initAsSender`/`initAsReceiver`/`encryptMessage`/`decryptMessage` | 双棘轮 + packet 封包 |
| Flutter | `desktop-build/flutter/securechat/lib/services/chat_crypto.dart` | `e2eeEncrypt`/`e2eeDecrypt`/`x3dhInitSender`/`x3dhInitReceiver`/`looksLikeRatchetCipher` | 会话初始化/入口 + 密文识别 |
| Flutter | `desktop-build/flutter/securechat/lib/main.dart` | 1090/1097/1201/1205 `e2eeEncrypt`；454/476/523/543 `e2eeDecrypt` | 发包前加密 / 收包后解密 |
| Web | `web/e2ee.js` | `SCE2EE.encryptOut`/`decryptIn`/`ensureKeyPair` | 静态 ECDH + AES-GCM（iv+ct，无 packet） |
| Web | `web/send-controller.js` | `sendPlainMessage` (25) | 文本发送路径：直接 `POST /api/messages` 明文 |
| Web(镜像) | `desktop-build/capacitor/www/e2ee.js`, `desktop-build/electron/www/e2ee.js` | 同 `web/e2ee.js` | 是 web/e2ee.js 的拷本 |
| Server | `server/index.js` | `/api/keys`(562) `/api/keys/bundle/:userId`(620) `/api/keys/signed-prekey`(577) `/api/keys/prekeys`(596) | 存/取公钥 bundle；不改动密文 |

## 2 两端参数对比矩阵

| 项 | Web (e2ee.js) | Flutter (ratchet.dart/x3dh.dart) | 一致? | 影响 |
|---|---|---|---|---|
| 协商协议 | 静态 ECDH，一次 derive shared secred 即 AES-256 key（无棘轮、无 X3DH） | X3DH(仅 identity) + Double Ratchet | **否** | 完全不同密钥 |
| 加密封包 | `iv(12)||ct+tag`，无 version/无 dhPub/无计数器 | `version(0x02)||dhPub(91)||pn(4)||n(4)||iv(12)||ct+tag`（ratchet.dart:242） | **否** | 封包长度/解析完全不同 |
| AES 长度 | 256（deriveKey length:256，e2ee.js:43） | 256（pointycastle AESEngine，ratchet.dart:60） | 是 | — |
| IV 长度 | 12（e2ee.js:48/58） | 12（ratchet.dart:237/260） | 是 | — |
| GCM tag | 由 WebCrypto `encrypt` 追加 16B，`decrypt` 自动校验 | pointycastle `process` 追加/截取 16B，自动校验（ratchet.dart:60,128） | 是 | tag 字节数一致 |
| 密钥派生 | `deriveKey(ECDH)→AES-GCM`，无 HKDF | `HKDF-SHA256`（salt/info/len，ratchet.dart:44/181/188） | **否** | 协商结果不同 |
| P-256 公钥格式 | SPKI base64（e2ee.js:31） | SPKI base64（ratchet.dart:118-122） | 是 | bundle 能互通 |
| base64 变体 | 标准 base64 `bufToB64`（e2ee.js:14-18），非 url-safe | 标准 base64 `base64.encode`（ratchet.dart:118） | 是 | — |
| 中文编码 | `TextEncoder` = UTF-8（e2ee.js:50） | `utf8.encode`（ratchet.dart:238） | 是 | — |
| 服务端改动密文 | 仅存/转发，不改（server/index.js stores content as-is） | 仅存/转发 | 是 | — |
| 会话状态 | 无（静态 key 缓存 `_cache`，e2ee.js:88） | 双棘轮持久化状态 rootKey/chain/n（ratchet.dart:149-159） | **否** | 无法恢复方向棘轮 |
| 消息发送是否加密 | **否**：明文 `POST /api/messages`（send-controller.js:25；groups.js:52） | **是**：`e2eeEncrypt`（main.dart:1097 等） | **否** | Web 从未落密 |

## 3 根因排序（按可能性）

**根因 1【最重】两端根本不是同一协议。**
Web 的 `SCE2EE` 用「静态 ECDH → 单次 deriveKey」+ `iv||ct` 无封包格式；Flutter 用「X3DH identity-only + 双棘轮」+ `version||dhPub||pn||n||iv||ct||tag` 封包。密钥来源、棘轮状态、封包结构全部不同。
- 证据：`web/e2ee.js:40-44`（静态 ECDH derive，无哈希无棘轮）vs `x3dh.dart:52-56`（`sk=HKDF(DH)[:32]`）+ `ratchet.dart:240-248`（封包含 0x02/dhPub/pn/n）
- 影响：即使双方都加密，任何一端收到对端密文都解不开，且封包无法相互识别（Web `isCipher` 正则只匹配纯 base64=`[A-Za-z0-9+/=]`，对 Flutter base64 其实能匹配，但长度/格式不满足其 12B IV 切分）。
- 修复：必须让两端用同一 wire 格式与协商协议。

**根因 2【实际断链】Web 发送路径根本没有加密，是明文；Flutter 用 `looksLikeRatchetCipher` 识别密文。**
- 证据：`send-controller.js:16,25` 直接 `content:text` 明文 POST；`app.js:520` 仅 `SCE2EE._cache={}`，无 encrypt/decrypt 调用（`e2ee.js:98-108` 是死代码）。Flutter 侧 `chat_crypto.dart:187` 要求 `b[0]==0x02` 才解密。
- 影响：Web→Flutter 时，Flutter 端 `looksLikeRatchetCipher` 对明文返回 false 原样显示，方向其实可见（明文）；但 Flutter→Web 时，Web 收到 `0x02` 开头的密文无任何解密，直接渲染乱码。真正「解不开」的典型是该方向。
- 修复（最小）：将 Web 发送/接收接入同一 ratchet 实现（见第 4）。

**根因 3【次重】即使统一协议，Flutter 的棘轮在 Web 静态 ECDH 模型下无会话状态可恢复；且 Flutter 不维护 skipped-key，乱序丢包即解不开。**
- 证据：`ratchet.dart:271` 注释「简化：不维护 skipped-key；假设消息严格按序到达」；`chat_crypto.dart:200-202` 解密失败整体 catch 回退明文。
- 影响：Web 若接入共享棘轮而无持久化状态，远端 ratchet 状态错位即永久解不开。

（补充：HKDF 参数 Web 根本没有；Flutter 的 `_kdfRk` 用 `info=[0x01]`+salt=rootKey（ratchet.dart:182）、`_kdfChain` 用 `info=[0x01]/[0x02]`+salt=空（ratchet.dart:188-189），若未来 Web 复刻需逐一核对。）

## 4 最小修复方案（不动声子、不破坏旧会话）

核心结论：**必须重写 Web 端加密层**，使其复刻 Flutter 的 ratchet/x3dh 语义与封包；这就不是「修一个参数」能完成的，属协议重设计（中等工作量）。要点：

1. Web 侧以现有 `web/e2ee.js` 为壳，改写为「X3DH identity-only + 双棘轮」：
   - X3DH：WebCrypto 无原生 HKDF 门，用 `crypto.subtle.importKey('raw', dhZ, 'HKDF')` + `deriveBits` 走 HKDF-SHA256，对齐 `x3dh.dart:39-45`（`len=64`，先取前 32 作 sk）。
   - 棘轮：WebCrypto 需 `deriveBits` 逐级 HKDF 出 messageKey，再 AES-GCM 加解密；封包严格复刻 `ratchet.dart:242-248`：`0x02 || dhPubSPKI(91) || pn(BE4) || n(BE4) || iv(12) || ct+tag`。
   - 会话状态：把 `RatchetState.toJson`（ratchet.dart:149）落 localStorage，逐字段对齐读写。
2. 发送/接收接线：把 `send-controller.js:16/25`（与 groups.js:52、chat-ext.js:131）改为先 `SCE2EE.encrypt`再 POST；接收渲染处按封包识别解密（对齐 `looksLikeRatchetCipher`）。
3. 保持 `0x02` 版本号与既有 Flutter 数据兼容，双方旧会话因 ratchet 无 skipped-key，建议清空既有 `sc_ratchet_*` 会话重建一次。
4. 若只想「Web 不怪异显示 + 能读 Flutter 消息」的过渡方案：Web 收到 `0x02` 开头串时按 Flutter 协议解密；Web 发出仍明文，Flutter 端照常显示（已能显示明文）。此为最小止血，未真正互通加密。

## 5 5 端互通冒烟脚本骨架（node + dart）

验证原则：同一身份 keypair / 同一封包，在 node(WebCrypto) 与 dart(pointycastle) 之间逐字段往返一致。以下是骨架，仅做协议对拍，不依赖服务器。

```js
// smoke_cross.js（运行时：node，需 WebCrypto globalThis）
const ECDH = 'P-256';
// 1) 生成 identity，与 dart `genEcKeyPair` 对齐：SPKI base64
const kp = await crypto.subtle.generateKey({name:'ECDH',namedCurve:ECDH}, true, ['deriveBits']);
const pubSpki = await crypto.subtle.exportKey('spki', kp.publicKey);
const pubB64 = Buffer.from(pubSpki).toString('base64');
// 2) 接收 dart 侧算出的 sk（dart 端打印 base64 或 hex），断言相等：
//    X3DH: sk = HKDF(ECDH(privA, pubB))[:32]，与 x3dh.dart deriveSk 对拍
// 3) 复刻 ratchet.dart 封包：对同一 (pn,n,iv,messageKey) 用 AES-GCM 加解密，
//    再按 `0x02||spki||pn(4BE)||n(4BE)||iv(12)||ct+tag` 拼装，交由 dart 侧 decryptMessage 解析
// 4) 对比两边 base64 output；逐字节相等即协议一致
```

```dart
// smoke_cross.dart（flutter test 入口，pointycastle）
// 1) 用 ratchet.dart genEcKeyPair() 产生 identity，导出 SPKI base64 供 node 侧 import
// 2) deriveSk(myPriv, peerPub) 输出 base64/hex，供 node 侧断言 HKDF 一致
// 3) encryptMessage() 产出一包，send 给 node 侧按第3步格式解回明文并断言相等
// 4) 反向：node 组包后 feed 进 decryptMessage()，断言逐 byte 相等
//
// 判定：①②③④全部通过 => wire 协议互通，否则即为协议不一致。
```

> 验证重点排序（按影响）：**封包结构(version/dhPub/pn/n) > 协商(HKDF=X3DH vs 静态ECDH) > 棘轮状态机 > GCM 参数(KEY=messageKey/IV 12) > base64(标准) > UTF-8**。GCM、IV、base64、UTF-8 四项经比对已一致，可排除。

## 下一步需验证
- `web/app.js` 中是否另有发送路径未走 `send-controller.js`（如 socket `ws.send` 发文本），逐行确认 Web 端所有发包都未加密。
- `desktop-build/capacitor/www/e2ee.js`、`electron/www/e2ee.js` 是否被相关容器真正调用（若调用，则它也走静态 ECDH，同样与 Flutter 不兼容）。
- WebCrypto HKDF 是否可用（https 环境要求），否则改为引入 SJCL 等，掉点后在 Web 端用同步 fallback。
- X3DH 签名/一次性预钥当前为占位（chat_crypto.dart:150-151），未纳入 sk，暂不影响互通但属待补项。