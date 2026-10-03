# SecureChat 统一启动：仅启动 node 服务器
# 重要修复：原脚本用 `Get-Process node | Stop-Process -Force` 会杀掉
# 全机所有 node 进程（服务器、邮件服务、playwright 等），导致服务反复掉线，
# 且与 SecureChatGuard 守护任务重复拉起产生双实例。
# 现改为只清理本项目自身的进程，且不再启动已停用的旧 watchdog.js
# （监督由 Windows 计划任务 SecureChatGuard 负责，每分钟检查端口）。
$ErrorActionPreference = 'SilentlyContinue'
$ServerDir = "D:\chat\server"

Write-Host "=== SecureChat start ==="

# 1. 只清理本项目的 index.js 进程（按命令行匹配，不误伤其他 node 程序）
$all = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'")
$stale = @($all | Where-Object { $_.CommandLine -match 'index\.js' -and $_.CommandLine -notmatch 'pandown' })
foreach ($p in $stale) {
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  Write-Host ("stale index killed: " + $p.ProcessId)
}
Start-Sleep -Seconds 2

# 2. 端口若已被占用且健康，则不重复启动
$listening = @(netstat -ano | Select-String ':8888' | Select-String 'LISTENING')
if ($listening.Count -ge 1) {
  Write-Host "port 8888 already listening, skip start."
} else {
  # 3. 启动服务器（与守护脚本一致用 -FilePath，Start-Process node "index.js" 在
#    非交互 -File 场景下可能静默失败）
Start-Process -FilePath "node" -ArgumentList "index.js" -WorkingDirectory $ServerDir -WindowStyle Hidden

# 4. 就绪校验，最多 40 秒
$ok = $false
for ($i = 0; $i -lt 8; $i++) {
  Start-Sleep -Seconds 5
  $l = @(netstat -ano | Select-String ':8888' | Select-String 'LISTENING')
  if ($l.Count -ge 1) { $ok = $true; break }
}
Write-Host ("server ready = " + $ok)
}

Write-Host "Done. Supervision handled by scheduled task SecureChatGuard."