# SecureChat 项目约定

## 版本号递增规则（必须自动遵守，勿再询问用户）
- 版本号定义在 `desktop-build/flutter/securechat/pubspec.yaml` 的 `version: X.Y.Z+N`。
- **每次构建发版前，必须自动把版本号 +0.01（即 minor 递增一位）**：
  - `1.42.0` → `1.43.0` → `1.44.0` …（build 号 `+N` 同步 +1）。
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
- GitHub artifacts 下载：资产必须 api.github.com 直连，`curl.exe -L -C - ... --retry 3 --retry-delay 2` 断点续传；多次 `Start-Process` 后台 curl 会挂起无增长，前台续传是最可靠方式。
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
