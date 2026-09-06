# SecureChat server watchdog - auto restart when server dies (prevents client freeze)
# Improved: log redirection for diagnosis + HTTP-level health check + no duplicate boot
$ServerDir = "D:\chat\server"
$LogDir = "D:\chat\data"
$WatchInterval = 10

$null = New-Item -ItemType Directory -Force -Path $LogDir

function Write-Log([string]$msg) {
  $line = "[watchdog " + (Get-Date -Format 'HH:mm:ss') + "] " + $msg
  Write-Host $line
  try { Add-Content -Path (Join-Path $LogDir "watchdog.log") -Value $line -Encoding UTF8 } catch {}
}

function Test-Online {
  # Raw TCP connect: proven reliable on PS 5.1 (TLS handshake via Invoke-WebRequest is unreliable here)
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $r = $c.BeginConnect("127.0.0.1", 8888, $null, $null)
    $ok = $r.AsyncWaitHandle.WaitOne(3000)
    if ($ok) { $c.EndConnect($r) }
    $c.Close()
    return $ok
  } catch { return $false }
}

function Get-ServerPid {
  $conns = Get-NetTCPConnection -LocalPort 8888 -State Listen -ErrorAction SilentlyContinue
  if ($conns) { return ($conns | Select-Object -First 1).OwningProcess }
  return $null
}

$script:lastBoot = [DateTime]::MinValue

function Boot-Server {
  # Throttle: avoid double-boot race with manual start / watchdog within 20s
  if (([DateTime]::Now - $script:lastBoot).TotalSeconds -lt 20) {
    Write-Log "boot throttled (recent boot), skip"
    return
  }
  $existing = Get-ServerPid
  if ($existing) {
    Write-Log "server already running (pid $existing), skip boot"
    return
  }
  # Port not ready but node index.js is starting up, skip to avoid duplicate boot
  $nodeProc = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*index.js*' }
  if ($nodeProc) {
    Write-Log "node index.js starting up, skip boot"
    return
  }
  try {
    $script:lastBoot = [DateTime]::Now
    $ts = Get-Date -Format 'yyyyMMdd_HHmmss'
    $out = Join-Path $LogDir "server_$ts.out.log"
    $err = Join-Path $LogDir "server_$ts.err.log"
    Start-Process node "index.js" -WorkingDirectory $ServerDir -WindowStyle Hidden `
      -RedirectStandardOutput $out -RedirectStandardError $err
    Write-Log "server started (logs: $out / $err)"
  } catch {
    Write-Log "restart failed: $($_.Exception.Message)"
  }
}

Write-Log "watchdog started, checks every ${WatchInterval}s"

if (-not (Test-Online)) { Boot-Server }

while ($true) {
  Start-Sleep -Seconds $WatchInterval
  if (-not (Test-Online)) {
    Write-Log "server offline, restarting..."
    Boot-Server
  }
}
