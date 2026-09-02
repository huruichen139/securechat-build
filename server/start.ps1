# SecureChat 服务器稳定启动脚本 (Windows)
# 关键: 用 Start-Process -WindowStyle Hidden 避免 node 因 stdin 关闭而退出
$ErrorActionPreference = 'Stop'
Set-Location "D:\chat\server"

# 清理可能残留的旧进程
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# 稳定启动
Start-Process node "index.js" -WorkingDirectory "D:\chat\server" -WindowStyle Hidden
Start-Sleep -Seconds 6

# 健康检查
try {
    $r = Invoke-RestMethod -Uri "https://127.0.0.1:8888/api/version" -Method Get -SkipCertificateCheck -TimeoutSec 8
    Write-Host "SecureChat 服务器已启动, 版本: $($r.latest)"
} catch {
    Write-Host "警告: 未能验证服务器状态 - $($_.Exception.Message)"
}
