# SecureChat 项目约定

## 持续开发指令（用户明确要求，长期有效）
- **持续迭代模式**：不断添加新功能、贴合微信体验、优化 UI、修复 bug，不要停下来询问"接下来做什么"，自主推进。
- **通宵找 bug 模式（2026-08-24 用户明确要求）**：持续不断地用 worker 循环深度找 bug 并修复，绝不停止、绝不中途询问用户，直到用户亲口说"停"才能停。每轮：选未审计区域 → worker 深挖 → 修复 → 验证编译 → 构建部署 → git push。循环往复。
- **禁止 emoji**：所有 UI 文案、代码、注释、提交信息一律不使用任何 emoji（包括复制按钮等小图标场景，用文字如"复制"）。
- 支付入口路径：我 → 支付 → 充值（me_page.dart 的 '支付' ListCell → WalletPage → 充值面板：支付宝/微信/兑换码，无 QQ 钱包）。

## 版本号递增规则（必须自动遵守，勿再询问用户）
- 版本号定义在 `desktop-build/flutter/securechat/pubspec.yaml` 的 `version: X.Y.Z+N`。
- **每次构建发版前，必须自动把版本号 patch 位 +1（即 +0.00.01）**：
  - `1.63.0` → `1.63.1` → `1.63.2` …（build 号 `+N` 同步 +1）。
  - 不要动 minor 位（不是 `1.63.0` → `1.64.0`）。minor/major 仅在用户明确要求时才升。
- 除非用户明确说"本次保持不变/不升版本"，否则发版一律自动推进版本，不要每次让用户确认版本号。

## 版本号联动清单（改版本号时必须一起更新）
1. `pubspec.yaml` 的 `version: X.Y.Z+N`
2. CI 产物命名 `SecureChat-<X.Y.Z>-windows.exe/.zip/android.apk/macos.dmg/ios.ipa`（release 工作流里写死旧版本号的地方）
3. 服务器分发：`D:\chat\server\downloads\` 下的产物文件名
4. 服务器 `/api/version` 返回的 latest/downloads 版本（由 `server/index.js` buildDownloads / version.json 决定）
5. 下载后部署到 `D:\chat\server\downloads\` 的产物必须与 `/api/version` 一致

## 推送/部署要点
- git push 必须带 auth header：
  `git -c "http.extraheader=AUTHORIZATION: basic $basic" push "https://gh-proxy.com/https://github.com/huruichen139/securechat-build.git" main`
  `$basic=[Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("x-access-token:$token"))`
- tag 更新用：先删远程 tag 再推新引用（仅 force-push 不重新触发 CI）。
- **GitHub 文件下载一律走 gh-proxy.com 代理**（用户多次强调，直连会慢/断/损坏）：URL 前缀 `https://gh-proxy.com/`，例如 `https://gh-proxy.com/https://github.com/huruichen139/securechat-build/releases/download/<tag>/<file>`。
- GitHub artifacts 下载：优先用 gh-proxy 代理 release 资产；`curl.exe -L -C - --retry 3 --retry-delay 2` 断点续传；多次 `Start-Process` 后台 curl 会挂起无增长，前台续传是最可靠方式。
- 服务器下载中心分发的文件若损坏（如 Inno Setup 报 "setup files are corrupted"），先对比 SHA256 确认服务器文件完好，多为用户端下载中断，引导用 curl/代理重新完整下载。
- 触发新 CI 后轮询 `api.github.com/repos/huruichen139/securechat-build/actions/runs` 的 head_sha。

## 本地构建（GitHub Actions 不可用 / 余额不足时）
- 当前策略：Windows + Android 产物在本机 `desktop-build/flutter/securechat/` 构建后部署。macOS/iOS 需 Mac/Xcode，本机无法构建（保留旧产物）。
- **Windows 工具链**：Flutter 3.44.8 支持 VS 2026 Insiders（vcvars 指向 18）。向 VS 实例加 NativeDesktop 工作负载后必须等安装完全结束（vswhere 的 `isComplete:true`）再构建，否则 Flutter 报 "Unable to find suitable Visual Studio toolchain"。
- **Windows 构建必须注入** `$env:CL='/utf-8'`：中文系统代码页 936 会把 flutter_webrtc 源里的非 ASCII 注释当作 C4819 警告并因 /WX 转成错误。CI（en-US）无此问题。
- **libwebrtc 下载会挂死**（GitHub 直连不通）：flutter_webrtc 的 `third_party/CMakeLists.txt` 会 `file(DOWNLOAD)` 到 pub 缓存 `flutter_webrtc-<v>\third_party\downloads\libwebrtc-win-x64-release.zip`。手动用 gh-proxy 前台续传：
  `curl.exe -L -C - --retry 3 --retry-delay 2 -o <pub-cache>\...\libwebrtc-win-x64-release.zip https://gh-proxy.com/https://github.com/webrtc-sdk/libwebrtc/releases/download/<版本>/libwebrtc-win-x64-release.zip`，CMake 检测到 zip 存在即自动解压。
- **Gradle**：`gradle-wrapper.properties` 用腾讯镜像 `https://mirrors.cloud.tencent.com/gradle/`；`gradle.properties` 需 `kotlin.incremental=false`（pub 缓存 C:、工程 D: 跨盘增量缓存崩溃）。
- **安装器 exe**：用 Inno Setup，`ISCC.exe desktop-build/flutter/securechat/tools/installer.iss /dAppVer=<ver>` → 产物 `dist\SecureChat-<ver>-windows.exe`。本机 ISCC 位于 `C:\Program Files (x86)\Inno Setup 6\ISCC.exe`。
- **便携 zip**：`Compress-Archive -Path <Release>\* -DestinationPath dist\SecureChat-<ver>-windows.zip`。
- **Android**：JAVA_HOME=Adoptium JDK17，ANDROID_HOME/ANDROID_SDK_ROOT=`C:\Users\huruichen\AppData\Local\Android\sdk`，licenses 已接受；APK 在 `build\app\outputs\flutter-apk\app-release.apk`。

## 环境
- Flutter：`D:\chat\tools\flutter`。pub get/analyze/test 加 `PUB_HOSTED_URL='https://pub.flutter-io.cn'`、`FLUTTER_STORAGE_BASE_URL='https://storage.flutter-io.cn'`。
- 服务器：`D:\chat\server\index.js`（sql.js），HTTPS 0.0.0.0:8888，数据在 `D:\chat\data\`。
- 勿提交运行时目录：`backups/`、`*.sqlite.bak*`、`server/call-recordings/`、`server/files/`、`tools/`。
