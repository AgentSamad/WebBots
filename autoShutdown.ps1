# Auto-shutdown watcher — runs in background, shuts down PC when all 100 bots complete.
# Watches for the multi-run aggregate report created after every full round (all batches done).

$startTime   = Get-Date "11/13/2026 01:47:07"
$reportsDir  = "E:\BoomArenaBots\boom-arena-bot\reports"
$shutdownMin = 1   # give 1 minute warning before shutdown

Write-Host "[watcher] Waiting for all 100 bots to complete (started $startTime)..."

while ($true) {
    # multi-run-*.json is written after all batches in a round finish
    $done = Get-ChildItem "$reportsDir\multi-run-*.json" -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTime -gt $startTime }

    if ($done.Count -ge 1) {
        Write-Host "[watcher] All bots completed! Shutting down in $shutdownMin minute(s)..."
        shutdown /s /t ($shutdownMin * 60) /c "Boom Arena bots finished — auto shutdown"
        break
    }

    # Also stop if node exited unexpectedly
    $node = Get-Process -Name "node" -ErrorAction SilentlyContinue
    if (-not $node) {
        Write-Host "[watcher] Node process ended. Checking report count..."
        $allReports = Get-ChildItem "$reportsDir\run-*.json" -ErrorAction SilentlyContinue |
                      Where-Object { $_.LastWriteTime -gt $startTime }
        Write-Host "[watcher] $($allReports.Count) user reports found since run start."
        if ($allReports.Count -ge 95) {
            Write-Host "[watcher] 95+ bots done — shutting down in $shutdownMin minute(s)..."
            shutdown /s /t ($shutdownMin * 60) /c "Boom Arena bots finished — auto shutdown"
        } else {
            Write-Host "[watcher] Node exited early ($($allReports.Count)/100 done). NOT shutting down."
        }
        break
    }

    Start-Sleep -Seconds 60
}
