param(
  [string]$BaselineUrl = 'http://127.0.0.1:4375',
  [string]$CandidateUrl = 'http://127.0.0.1:4377',
  [Parameter(Mandatory = $true)][string]$OutputDirectory,
  [ValidatePattern('^[a-z0-9-]+$')][string]$Prefix = 'transition',
  [ValidateRange(1, 5)][int]$Repetitions = 2,
  [ValidateRange(5, 120)][int]$ObservationSeconds = 30,
  [switch]$Profile
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
Push-Location -LiteralPath $workspace
try {
  for ($iteration = 1; $iteration -le $Repetitions; $iteration++) {
    $variants = if ($iteration % 2 -eq 0) { @('candidate', 'baseline') } else { @('baseline', 'candidate') }
    foreach ($variant in $variants) {
      $name = '{0}-{1}-{2:D2}' -f $Prefix, $variant, $iteration
      $log = Join-Path $OutputDirectory ($name + '.log')
      if (Test-Path -LiteralPath $log) { throw "Evidence already exists: $log" }
      $url = if ($variant -eq 'baseline') { $BaselineUrl } else { $CandidateUrl }
      Write-Output "Running $name"
      $nodeArguments = @('experiments/web-live-runtime/run.mjs', "--url=$url", '--supply=stock', "--seconds=$ObservationSeconds", "--output=$OutputDirectory", "--name=$name")
      if ($Profile) { $nodeArguments += '--profile=1' }
      & node @nodeArguments *> $log
      if ($LASTEXITCODE -ne 0) { throw "Runtime probe failed; inspect $log" }
      Write-Output "Completed $name"
    }
  }
} finally { Pop-Location }
