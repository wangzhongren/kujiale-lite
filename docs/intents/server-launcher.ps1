# Launch the Kujiale-lite dev server in the background with PID + logs.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File docs/intents/server-launcher.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$data = Join-Path $root 'data'
New-Item -ItemType Directory -Force -Path $data | Out-Null
$outLog = Join-Path $data 'server.out.log'
$errLog = Join-Path $data 'server.err.log'
$pidFile = Join-Path $data 'server.pid'

if (Test-Path $pidFile) {
  $oldPid = 0
  [void][int]::TryParse((Get-Content $pidFile -Raw).Trim(), [ref]$oldPid)
  if ($oldPid -gt 0 -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) {
    Write-Output "ALREADY_RUNNING pid=$oldPid url=http://127.0.0.1:8080"
    exit 0
  }
}

$p = Start-Process -FilePath 'python' -ArgumentList @('-m','app','--port','8080') `
  -WorkingDirectory $root -PassThru -WindowStyle Hidden `
  -RedirectStandardOutput $outLog -RedirectStandardError $errLog
Set-Content -Path $pidFile -Value $p.Id -Encoding ascii

$ok = $false
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 250
  if ($p.HasExited) { break }
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8080/api/v1/catalog' -TimeoutSec 2
    if ($r.StatusCode -eq 200) { $ok = $true; break }
  } catch { }
}

if ($ok) {
  Write-Output "STARTED pid=$($p.Id) url=http://127.0.0.1:8080 pidFile=$pidFile"
  exit 0
}

Write-Output "FAILED pid=$($p.Id) exited=$($p.HasExited) pidFile=$pidFile"
if (Test-Path $errLog) { Get-Content $errLog -Tail 30 }
if (Test-Path $outLog) { Get-Content $outLog -Tail 10 }
exit 1
