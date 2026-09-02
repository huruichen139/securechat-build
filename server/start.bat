@echo off
REM SecureChat 服务器启动脚本 - 稳定后台运行
REM 关键：必须重定向 stdin，否则 node 检测到 stdin 关闭会退出
cd /d D:\chat\server
echo [start-securechat] 正在启动 SecureChat 服务器...
start "SecureChatServer" /B node index.js < nul > D:\chat\data\server.out 2> D:\chat\data\server.err
echo [start-securechat] 服务器已在后台启动 (日志: D:\chat\data\server.out / server.err)
