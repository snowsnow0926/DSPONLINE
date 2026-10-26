param(
  [Parameter(Mandatory=$true)][string]$BaseUrl,
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [Parameter(Mandatory=$true)][string]$Variant,
  [int]$Iterations = 3
)

$ErrorActionPreference = 'Stop'
if ($Iterations -lt 1 -or $Iterations -gt 10) { throw 'Iterations must be between 1 and 10' }
if ($Variant -notmatch '^[a-z0-9-]+$') { throw 'Invalid evidence variant' }
$null = New-Item -ItemType Directory -Path $OutputDirectory -Force
foreach ($action in @('slot', 'snapshot')) {
  foreach ($iteration in 1..$Iterations) {
    $sampleName = "save-verify-$action-$Variant-$iteration"
    $arguments = @(
      (Join-Path $PSScriptRoot 'run.mjs'), "--url=$BaseUrl", '--production=1',
      '--diagnostic=1', '--worker-timings=1', '--timeout=60000',
      "--action=$action", "--output=$OutputDirectory", "--name=$sampleName"
    )
    if ($iteration -eq 1) { $arguments += '--hash=1' }
    $logPath = Join-Path $OutputDirectory "$sampleName.log"
    & node @arguments *> $logPath
    $runExitCode = $LASTEXITCODE
    if ($runExitCode -ne 0) {
      Get-Content -LiteralPath $logPath -Tail 25
      exit $runExitCode
    }
    Write-Output "Completed $sampleName"
  }
}
