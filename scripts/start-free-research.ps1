param([switch]$Restart)
$ErrorActionPreference = 'Stop'
$repoDir = Split-Path -Parent $PSScriptRoot
$feedDir = Join-Path $repoDir 'data/research/free-feed'
New-Item -ItemType Directory -Path $feedDir -Force | Out-Null
$lockPath = Join-Path $feedDir 'recorder.pid'
if (Test-Path -LiteralPath $lockPath) {
    $recorderPid = [int](Get-Content -LiteralPath $lockPath -Raw)
    $running = Get-Process -Id $recorderPid -ErrorAction SilentlyContinue
    if ($running) {
        if (-not $Restart) { Write-Output "Recorder already running: $recorderPid"; exit 0 }
        $lockTime = (Get-Item -LiteralPath $lockPath).LastWriteTime
        if ($running.ProcessName -ne 'node' -or [Math]::Abs(($lockTime - $running.StartTime).TotalSeconds) -gt 60) {
            throw 'Recorder PID identity could not be verified; refusing to stop an unrelated process.'
        }
        Stop-Process -Id $recorderPid
        Wait-Process -Id $recorderPid -Timeout 10 -ErrorAction SilentlyContinue
    }
}
$scriptPath = Join-Path $repoDir 'scripts/record-coinbase.js'
$child = Start-Process -FilePath (Get-Command node).Source -ArgumentList ('"' + $scriptPath + '"') -WorkingDirectory $repoDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $feedDir 'recorder.out.log') -RedirectStandardError (Join-Path $feedDir 'recorder.err.log') -PassThru
Write-Output "Started Coinbase shadow recorder: $($child.Id)"
