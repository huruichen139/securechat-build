param(
  [string]$Api = "https://mc.32768.top:5432",
  [string]$Token = ""
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$stage = Join-Path $env:TEMP ("SecureChat-update-" + [guid]::NewGuid().ToString('N'))
$zip = Join-Path $env:TEMP ("SecureChat-update-" + [guid]::NewGuid().ToString('N') + '.zip')
try {
  New-Item -ItemType Directory -Path $stage | Out-Null
  foreach ($name in @('web','server','portable')) {
    $source = Join-Path $root $name
    if (Test-Path $source) { Copy-Item $source (Join-Path $stage $name) -Recurse -Force }
  }
  $version = Join-Path $root 'data\version.json'
  if (Test-Path $version) {
    New-Item -ItemType Directory -Path (Join-Path $stage 'data') -Force | Out-Null
    Copy-Item $version (Join-Path $stage 'data\version.json') -Force
  }
  Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Fastest
  if (-not $Token) { $Token = Read-Host '请输入管理员 Token' }
  if (-not $Token) { throw '没有提供管理员 Token' }
  $uri = $Api.TrimEnd('/') + '/api/admin/update-package?apply=true'
  Write-Host "正在上传更新包到 $uri ..."
  $result = curl.exe --fail-with-body --silent --show-error -X POST $uri -H "Authorization: Bearer $Token" -H 'Content-Type: application/octet-stream' --data-binary "@$zip"
  Write-Host $result
  Write-Host '服务器将自动备份、替换并重启。'
} finally {
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
}
Read-Host '按回车退出'
