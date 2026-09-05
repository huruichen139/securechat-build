# SecureChat one-click start: kill old -> start server -> start watchdog
$ErrorActionPreference = 'SilentlyContinue'
$ServerDir = "D:\chat\server"

Write-Host "=== SecureChat one-click start ==="

# 1. Kill old node processes
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

# 2. Start server (redirect logs)
$ts = Get-Date -Format 'yyyyMMdd_HHmmss'
$out = "D:\chat\data\server_$ts.out.log"
$err = "D:\chat\data\server_$ts.err.log"
Start-Process node "index.js" -WorkingDirectory $ServerDir -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err
Start-Sleep -Seconds 6

# 3. Health check (raw TCP: reliable on PS 5.1)
try {
  $c = New-Object System.Net.Sockets.TcpClient
  $r = $c.BeginConnect("127.0.0.1", 8888, $null, $null)
  $ok = $r.AsyncWaitHandle.WaitOne(3000)
  if ($ok) { $c.EndConnect($r); Write-Host "Server started (port 8888 open)" } else { Write-Host "WARN: port 8888 not open yet" }
  $c.Close()
} catch {
  Write-Host "WARN: health check failed - $($_.Exception.Message)"
}

# 4. Start watchdog (avoid duplicates)
$wdRunning = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*watchdog.ps1*' }
if (-not $wdRunning) {
  Start-Process powershell -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File D:\chat\server\watchdog.ps1" -WindowStyle Hidden
  Write-Host "Watchdog started"
} else {
  Write-Host "Watchdog already running, skip"
}
