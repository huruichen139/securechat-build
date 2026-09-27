# SecureChat 全守护：确保 index.js 与 watchdog.js 至少各一个存活
# 由 Windows 计划任务每5分钟触发（自杀任务保障兜底）
$ErrorActionPreference = 'SilentlyContinue'

function IsRunning($needle) {
  $info = Get-CimInstance Win32_Process -Filter "Name='node.exe'"
  foreach ($p in $info) {
    if ($p.CommandLine -match $needle) { return $true }
  }
  return $false
}

$wd = "D:\chat\server"

$idxAlive = IsRunning 'index\.js'
$wdAlive  = IsRunning 'watchdog\.js'

if (-not $idxAlive) {
  Remove-Item "D:\chat\data\watchdog.lock" -Force -ErrorAction SilentlyContinue
  Start-Process -FilePath "node" -ArgumentList "index.js" -WorkingDirectory $wd -WindowStyle Hidden
  Start-Sleep -Seconds 5
}

if (-not $wdAlive) {
  Remove-Item "D:\chat\data\watchdog.lock" -Force -ErrorAction SilentlyContinue
  Start-Process -FilePath "node" -ArgumentList "watchdog.js" -WorkingDirectory $wd -WindowStyle Hidden
}

# 输出状态供日志
$ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
"[$ts] idx=$idxAlive wd=$wdAlive checks=done" | Out-File "D:\chat\data\scheduled_guard.log" -Append -Encoding utf8