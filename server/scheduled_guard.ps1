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
$missFile  = "D:\chat\data\guard_miss.count"
$nodeExe   = "D:\nodejs\node-v20.18.0-win-x64\node.exe"
$ts        = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'

# 本项目 index.js 的唯一真实路径锚点：避免 -match 'index\.js' 命中
# myindex.js / -e ./index.jsx / 别的项目的 index.js（曾误杀全机 node）
$indexPath = (Join-Path $serverDir 'index.js')

function Get-IndexProcs {
  # 锚定到本项目的绝对路径，而不是模糊匹配命令行里的 index.js 子串
  @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -and ($_.CommandLine -like "*$indexPath*") })
}

function Get-ListenerPids {
  # 必须精确匹配本机端口 8888，而不是 ':8888' 子串
  #（后者会命中 18888 / 88880 / 28888 等无关端口，导致误判为健康）
  $pids = @()
  foreach ($line in @(netstat -ano)) {
    if ($line -notmatch 'LISTENING') { continue }
    if ($line -notmatch '^\s*TCP\s+(\S+):8888\s+(\S+)\s+LISTENING\s+(\d+)') { continue }
    $pids += [int]$Matches[3]
  }
  @($pids | Sort-Object -Unique)
}

function Test-Listening {
  return ((Get-ListenerPids).Count -ge 1)
}

# 防抖计数器必须跨进程持久化：
#   计划任务每分钟启动一个新 PowerShell 进程，进程内变量（$global:miss）
#   每次都从 $null 开始，$null + 1 = 1，导致 "1 -lt 2" 恒真，
#   脚本永远只写一行 "port down, confirming..." 就退出，
#   下面的重启逻辑是死代码 —— 服务器崩溃后永久不会自愈。
function Get-MissCount {
  if (Test-Path $missFile) {
    $v = 0
    if ([int]::TryParse((Get-Content $missFile -Raw -ErrorAction SilentlyContinue).Trim(), [ref]$v)) { return $v }
  }
  return 0
}
function Set-MissCount([int]$n) {
  Set-Content -Path $missFile -Value $n -Encoding ascii -Force -ErrorAction SilentlyContinue
}

$listeners = @(Get-ListenerPids)
$idxProcs = @(Get-IndexProcs)

if ($listeners.Count -ge 1) {
  # 端口健康：收敛到单实例。
  #   多余的 index.js 会持有旧内存态、可能与真正监听者争抢写库，
  #   且会让"服务是否在线"的判断失真（僵尸进程长期共存）。
  $extra = @($idxProcs | Where-Object { $listeners -notcontains $_.ProcessId })
  $msg = "[" + $ts + "] listening ok, listeners=" + $listeners.Count + ", idxProcs=" + $idxProcs.Count
  if ($extra.Count -gt 0) {
    foreach ($e in $extra) {
      Stop-Process -Id $e.ProcessId -Force -ErrorAction SilentlyContinue
      $msg += ", killedExtra=" + $e.ProcessId
    }
    $msg += " (多余实例已清理)"
  }
  $msg | Out-File $logFile -Append -Encoding utf8
  Set-MissCount 0
  exit 0
}

# 端口没在听：连续两次确认才动手，避免瞬时抖动误杀健康进程
$miss = (Get-MissCount) + 1
Set-MissCount $miss
if ($miss -lt 2) {
  "[" + $ts + "] port down, confirming...(" + $miss + "/2)" | Out-File $logFile -Append -Encoding utf8
  exit 0
}

# 端口没在听：清掉本项目残留 index 进程（含占端口的僵尸），再拉起一个干净的
# 注意：这里只杀本项目锚定路径的进程，不会误杀其他项目的 node
$old = @(Get-IndexProcs)
foreach ($p in $old) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 3

# 不要删除 watchdog.lock：那是 watchdog.js 自身的单实例互斥文件，
# 删掉它会让刚被拉起的 watchdog 绕过互斥检查，出现双 watchdog 并存。
Set-MissCount 0

if (-not (Test-Path $nodeExe)) {
  "[" + $ts + "] DOWN, node not found: $nodeExe" | Out-File $logFile -Append -Encoding utf8
  exit 1
}

Start-Process -FilePath $nodeExe -ArgumentList $indexPath -WorkingDirectory $serverDir -WindowStyle Hidden

# 等待端口就绪，最多 60 秒
$ok = $false
for ($i = 0; $i -lt 12; $i++) {
  Start-Sleep -Seconds 5
  if (Test-Listening) { $ok = $true; break }
}

# 失败要返回非 0，否则计划任务历史里"服务已死"与"一切正常"完全一样
$line = "[" + $ts + "] DOWN, killed=" + $old.Count + ", restarted=" + $ok
$line | Out-File $logFile -Append -Encoding utf8
if ($ok) { exit 0 } else { exit 1 }
