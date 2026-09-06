@echo off
REM SecureChat unified start: server + node watchdog (true detachment via cmd start)
setlocal
set SERVER_DIR=D:\chat\server
set LOG_DIR=D:\chat\data

echo [SecureChat] starting server + watchdog...

REM Kill existing node processes
taskkill /F /IM node.exe >nul 2>&1
timeout /t 2 /nobreak >nul

REM Start server (detached)
cd /d "%SERVER_DIR%"
start "" /B cmd /c "node index.js > "%LOG_DIR%\server.out.log" 2> "%LOG_DIR%\server.err.log""

REM Start watchdog (detached)
start "" /B cmd /c "node watchdog.js > "%LOG_DIR%\watchdog.out.log" 2> "%LOG_DIR%\watchdog.err.log""

echo [SecureChat] server + watchdog launched.
endlocal
