# 列出所有命令行匹配 index.js 的 node 进程 PID（供 watchdog 清理残留）
# 原因：Windows 新版已移除 wmic，改用 PowerShell CIM（实测可用）
$procs = @(Get-CimInstance -ClassName Win32_Process -Filter "Name='node.exe'")
foreach ($p in $procs) {
  if ($p.CommandLine -match 'index\.js') {
    Write-Output $p.ProcessId
  }
}