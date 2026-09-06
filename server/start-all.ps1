# SecureChat unified start: node server + node watchdog (reliable pattern)
$ErrorActionPreference = 'SilentlyContinue'
$ServerDir = "D:\chat\server"

Write-Host "=== SecureChat start ==="

# 1. Kill old node processes
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

# 2. Start server (documented reliable pattern)
Start-Process node "index.js" -WorkingDirectory $ServerDir -WindowStyle Hidden
Start-Sleep -Seconds 6

# 3. Start node watchdog
Start-Process node "watchdog.js" -WorkingDirectory $ServerDir -WindowStyle Hidden

Write-Host "Server + watchdog launched."
