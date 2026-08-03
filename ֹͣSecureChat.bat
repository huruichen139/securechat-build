@echo off
setlocal
cd /d "%~dp0"
echo 正在停止 SecureChat 全部服务（Node + Caddy）...
taskkill /f /im caddy.exe >nul 2>&1
taskkill /f /im cloudflared.exe >nul 2>&1
taskkill /fi "WINDOWTITLE eq SecureChat Node" /f >nul 2>&1
taskkill /fi "WINDOWTITLE eq SecureChat Caddy" /f >nul 2>&1
taskkill /fi "WINDOWTITLE eq SecureChat 一键启动" /f >nul 2>&1
echo 已停止。
pause
