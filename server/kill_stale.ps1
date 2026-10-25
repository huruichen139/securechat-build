# 列出属于本项目的 index.js node 进程 PID（供 watchdog 清理使用）。
# 必须锚定路径：原实现只要命令行含 index.js 就输出，会误杀其它项目的 node index.js
# （例如 pandown 等），导致无关服务被 watchdog 反复杀掉。
$serverDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$absIndex = Join-Path $serverDir 'index.js'
$absPattern = [regex]::Escape($absIndex)
$procs = @(Get-CimInstance -ClassName Win32_Process -Filter "Name='node.exe'")
foreach ($p in $procs) {
  $cmd = [string]$p.CommandLine
  if (-not $cmd) { continue }
  if ($cmd -notmatch 'index\.js') { continue }
  if ($cmd -match 'pandown') { continue }
  # 只认两种形态：绝对路径 D:\chat\server\index.js，或守护脚本使用的相对路径 server\index.js
  $isOurs = ($cmd -match $absPattern) -or ($cmd -match '(^|[\\/"\s])server\\index\.js("|\s|$)')
  if ($isOurs) {
    Write-Output $p.ProcessId
  }
}
