param(
    [Parameter(Mandatory=$true)][string]$ProcessIds,
    [Parameter(Mandatory=$true)][string]$OutputPath,
    [Parameter(Mandatory=$true)][string]$ReadyPath,
    [Parameter(Mandatory=$true)][string]$StopPath
)
$ErrorActionPreference = 'Stop'
$sampleIds = @($ProcessIds.Split(',') | ForEach-Object { [int]$_ })
$sampleRows = [System.Collections.Generic.List[object]]::new()
$sampleClock = [System.Diagnostics.Stopwatch]::StartNew()
while (-not (Test-Path -LiteralPath $StopPath) -and $sampleClock.Elapsed.TotalSeconds -lt 180) {
    $sampleProcesses = @(Get-Process -Id $sampleIds -ErrorAction SilentlyContinue)
    $sampleRows.Add(@{
        timestampMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        privateBytes = [long](($sampleProcesses | Measure-Object -Property PrivateMemorySize64 -Sum).Sum)
        processIds = @($sampleProcesses.Id)
        priorities = @($sampleProcesses | ForEach-Object { $_.PriorityClass.ToString() })
    })
    if (-not (Test-Path -LiteralPath $ReadyPath)) { [System.IO.File]::WriteAllText($ReadyPath, 'ready') }
    Start-Sleep -Milliseconds 50
}
$sampleRows | ConvertTo-Json -Depth 4 -Compress | Set-Content -LiteralPath $OutputPath -Encoding utf8
