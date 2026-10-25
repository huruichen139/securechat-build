# SecureChat 守护（由计划任务每分钟执行）
# 判据：8888 端口必须处于 LISTENING。
#   只看"端口是否监听"，不看"进程还活着没有"——僵死进程（端口已释放但进程还在）
#   会被判定为不健康（这是之前反复重启的根因），端口 LISTENING 才是服务真正在接连接的可靠信号。
# 注意：Windows PowerShell 5.1 的 Invoke-WebRequest/HttpClient 对自签名证书报错，
#   且 HTTP 探测会受证书影响，因此只用 netstat 判断。
$ErrorActionPreference = 'SilentlyContinue'

$serverDir = "D:\chat\server"
$lockFile  = "D:\chat\data\watchdog.lock"
$logFile   = "D:\chat\data\scheduled_guard.log"
$missFile  = "D:\chat\data\guard_miss.count"
$nodeExe   = "D:\nodejs\node-v20.18.0-win-x64\node.exe"
$ts        = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'

# 本项目 index.js 的唯一真实路径锚点，避免 -match 'index\.js' 泛匹配
# myindex.js / -e ./index.jsx / 其它项目的 index.js，进而误杀全局 node。
$indexPath = (Join-Path $serverDir 'index.js')
$indexPattern = [regex]::Escape($indexPath)

function Get-IndexProcs {
  # 锚定本项目的两种启动形态：
  #   1) 绝对路径 D:\chat\server\index.js（本脚本/手工启动）
  #   2) 相对路径 server\index.js（旧 watchdog / 批处理启动，工作目录为 D:\chat）
  # 原实现只匹配绝对路径，导致相对路径启动的重复实例永远不会被收敛（双实例）。
  @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object {
      $c = [string]$_.CommandLine
      if (-not $c) { return $false }
      if ($c -match 'pandown') { return $false }
      ($c -match $indexPattern) -or ($c -match '(^|[\\/"\s])server\\index\.js("|\s|$)')
    })
}

function Get-ListenerPids {
  # 端口精确匹配本项目端口 8888，不能用 ':8888' 子串
  #（否则会命中 18888 / 88880 / 28888 等无关端口，被误判为服务正常）
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

# 防抖计数必须跨进程持久化：
#   计划任务每次都是新 PowerShell 进程，进程内的 $global:miss 每轮都从 $null 开始，
#   $null + 1 = 1，永远 "1 -lt 2" 成立，脚本只会写一次 "port down, confirming..." 就退出，
#   下面的重启逻辑变成死代码 —— 服务崩溃后再也不会自愈。
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
  # 端口健康：收敛为单实例。
  #   若存在多个 index.js 进程（如重启窗口期守护与本脚本各拉起一个），
  #   只保留真正持有 8888 端口的那个，其余强制结束。
  $extra = @($idxProcs | Where-Object { $listeners -notcontains $_.ProcessId })
  $msg = "[" + $ts + "] listening ok, listeners=" + $listeners.Count + ", idxProcs=" + $idxProcs.Count
  if ($extra.Count -gt 0) {
    foreach ($e in $extra) {
      Stop-Process -Id $e.ProcessId -Force -ErrorAction SilentlyContinue
      $msg += ", killedExtra=" + $e.ProcessId
    }
    $msg += " (已收敛为单实例)"
  }
  $msg | Out-File $logFile -Append -Encoding utf8
  Set-MissCount 0
  exit 0
}

# 端口没监听：先连续确认两轮再动手，避免瞬时抖动被误杀。
$miss = (Get-MissCount) + 1
Set-MissCount $miss
if ($miss -lt 2) {
  "[" + $ts + "] port down, confirming...(" + $miss + "/2)" | Out-File $logFile -Append -Encoding utf8
  exit 0
}

# 端口没监听：先杀掉本项目的残留 index 进程（占着端口或僵死的），再重启一个。
# 注意：这里只杀本项目锚定路径的进程，绝不误杀其它项目的 node。
$old = @(Get-IndexProcs)
foreach ($p in $old) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 3

# 不要删除 watchdog.lock，它是 watchdog.js 的单实例锁文件；
# 删掉会让刚被本脚本拉起的 watchdog 重启后重建锁，导致双 watchdog 并存。
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

# 失败要返回非 0，否则计划任务历史里"重启成功"与"一次没跑"完全一样。
$line = "[" + $ts + "] DOWN, killed=" + $old.Count + ", restarted=" + $ok
$line | Out-File $logFile -Append -Encoding utf8
if ($ok) { exit 0 } else { exit 1 }
