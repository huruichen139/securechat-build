@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title SecureChat Start

set "ROOT=%~dp0"
set "NODE=%ROOT%portable\runtime\node-v22.11.0-win-x64\node.exe"
set "SERVER=%ROOT%server\index.js"
set "CADDY=%ROOT%portable\caddy\caddy.exe"
set "CADDYFILE=%ROOT%portable\Caddyfile"
set "LOGDIR=%ROOT%logs"

set "NODE_PORT=8080"
set "PUBLIC_PORT=8888"

if not exist "%LOGDIR%" mkdir "%LOGDIR%"
echo ========================================
echo   SecureChat One-Click Start
echo   Node   : http://127.0.0.1:%NODE_PORT%
echo   Caddy  : https://mc.32768.top:%PUBLIC_PORT% (HTTPS)
echo ========================================
echo.

if not exist "%NODE%" (
  echo [ERROR] Node not found: %NODE%
  pause
  exit /b 1
)
if not exist "%SERVER%" (
  echo [ERROR] Server file not found: %SERVER%
  pause
  exit /b 1
)
if not exist "%CADDY%" (
  echo [ERROR] caddy.exe not found: %CADDY%
  pause
  exit /b 1
)
if not exist "%CADDYFILE%" (
  echo [ERROR] Caddyfile not found: %CADDYFILE%
  pause
  exit /b 1
)

echo [1/2] Starting Node backend http://localhost:%NODE_PORT% ...
start "SecureChat Node" /min cmd /c "set PORT=%NODE_PORT% && "%NODE%" "%SERVER%" >> "%LOGDIR%\server.log" 2>&1"

echo Waiting for Node backend...
set "READY="
for /l %%i in (1,1,30) do (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; try { $r=Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:%NODE_PORT%/api/version' -TimeoutSec 1; if ($r.StatusCode -eq 200) { exit 0 } } catch {}; exit 1" >nul 2>&1
  if not errorlevel 1 (
    set "READY=1"
    goto :node_ready
  )
  timeout /t 1 /nobreak >nul
)

:node_ready
if not defined READY (
  echo [ERROR] Node failed to start in 30s. Check: %LOGDIR%\server.log
  pause
  exit /b 1
)

echo [2/2] Starting Caddy HTTPS reverse proxy https://mc.32768.top:%PUBLIC_PORT% ...
echo [SecureChat] Caddy will auto-request Let's Encrypt cert (needs port 80 and %PUBLIC_PORT% open).
echo.
start "SecureChat Caddy" /min cmd /c ""%CADDY%" run --config "%CADDYFILE%" --adapter caddyfile >> "%LOGDIR%\caddy.log" 2>&1"

echo.
echo [SecureChat] Services started:
echo   Local : http://localhost:%NODE_PORT%
echo   Public: https://mc.32768.top:%PUBLIC_PORT%
echo.
echo Press any key to exit this window (services keep running in background).
pause