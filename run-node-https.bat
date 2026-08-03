@echo off
set USE_HTTPS=1
set PORT=8888
"%~dp0portable\runtime\node-v22.11.0-win-x64\node.exe" "%~dp0server\index.js"
