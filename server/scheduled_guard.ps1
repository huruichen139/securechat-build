# SecureChat 全守护
# 判据：8888 端口必须处于 LISTENING。
#   只看"进程是否存在"会把"进程活着但没监听"的僵尸误判为健康（这是之前服务反复
#   不可用的根因）；端口 LISTENING 才是服务真正在接收连接的可靠信号。
#   注：Windows PowerShell 5.1 的 Invoke-WebRequest/HttpClient 对本机自签证书
#   握手会失败，故不使用 HTTP 探测。
$ErrorActionPreference = 'SilentlyContinue'

$serverDir = "D:\chat\server"
$lockFile  = "D:\chat\data\watchdog.lock"
$logFile   = "D:\chat\data\scheduled_guard.log"
$ts        = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'

function Get-IndexProcs {
  # 只匹配本项目的 index.js（排除其他项目如 pandown 的同名文件）
  @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'index\.js' -and $_.CommandLine -notmatch 'pandown' })
}

function Test-Listening {
  $l = @(netstat -ano | Select-String ':8888' | Select-String 'LISTENING')
  return ($l.Count -ge 1)
}

if (Test-Listening) {
  "[" + $ts + "] listening ok, idxProcs=" + (Get-IndexProcs).Count | Out-File $logFile -Append -Encoding utf8
  $global:miss = 0
  exit 0
}

# 防抖：连续两次确认端口确实没在听，才动手，避免瞬时抖动误杀健康进程
$global:miss = $global:miss + 1
if ($global:miss -lt 2) {
  "[" + $ts + "] port down, confirming...(" + $global:miss + "/2)" | Out-File $logFile -Append -Encoding utf8
  exit 0
}

# 端口没在听：清掉本项目残留 index 进程（含占端口的僵尸），再拉起一个干净的
$old = Get-IndexProcs
foreach ($p in $old) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 3
Remove-Item $lockFile -Force -ErrorAction SilentlyContinue

Start-Process -FilePath "node" -ArgumentList "index.js" -WorkingDirectory $serverDir -WindowStyle Hidden

# 等待端口就绪，最多 60 秒
$ok = $false
for ($i = 0; $i -lt 12; $i++) {
  Start-Sleep -Seconds 5
  if (Test-Listening) { $ok = $true; break }
}

"[" + $ts + "] DOWN, killed=" + $old.Count + ", restarted=" + $ok | Out-File $logFile -Append -Encoding utf8
$global:miss = 0