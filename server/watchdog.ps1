# SecureChat 服务器看门狗 - 服务器挂掉自动重启，防止客户端卡死
$ServerDir = "D:\chat\server"
$WatchInterval = 15

Write-Host "[watchdog] SecureChat watchdog started, checks every ${WatchInterval}s"
function Test-Online {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $r = $c.BeginConnect("127.0.0.1", 8888, $null, $null)
    $ok = $r.AsyncWaitHandle.WaitOne(3000)
    if ($ok) { $c.EndConnect($r) }
    $c.Close()
    return $ok
  } catch { return $false }
}
function Boot-Server {
  try {
    Start-Process node "index.js" -WorkingDirectory $ServerDir -WindowStyle Hidden
    Write-Host ("[watchdog] " + (Get-Date -Format 'HH:mm:ss') + " server restarted")
  } catch {
    Write-Host ("[watchdog] restart failed: " + $_.Exception.Message)
  }
}
if (-not (Test-Online)) { Boot-Server }
while ($true) {
  Start-Sleep -Seconds $WatchInterval
  if (-not (Test-Online)) {
    Write-Host ("[watchdog] " + (Get-Date -Format 'HH:mm:ss') + " server offline, restarting...")
    Boot-Server
  }
}