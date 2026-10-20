# Stop the Kujiale-lite dev server started by server-launcher.ps1.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File docs/intents/server-stop.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$pidFile = Join-Path $root 'data\server.pid'

if (-not (Test-Path $pidFile)) {
  Write-Output "NOT_RUNNING (no pid file)"
  exit 0
}

$serverPid = 0
[void][int]::TryParse((Get-Content $pidFile -Raw).Trim(), [ref]$serverPid)
if ($serverPid -le 0) {
  Remove-Item $pidFile -Force
  Write-Output "NOT_RUNNING (invalid pid file removed)"
  exit 0
}

$proc = Get-Process -Id $serverPid -ErrorAction SilentlyContinue
if (-not $proc) {
  Remove-Item $pidFile -Force
  Write-Output "NOT_RUNNING (pid $serverPid already exited; pid file removed)"
  exit 0
}

Stop-Process -Id $serverPid -Force
Remove-Item $pidFile -Force
Write-Output "STOPPED pid=$serverPid"
