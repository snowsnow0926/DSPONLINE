[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$PackageDirectory,
  [ValidateRange(3, 120)]
  [int]$DurationSeconds = 12,
  [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"
$ExecutableName = "dsp-idle-performance-edition.exe"
$SmokePrefix = "dspidle-performance-smoke-"
$UserDataDirectoryName = "DSPidle2-Performance-Edition"

function Get-ProcessTreeRows {
  param([int]$RootProcessId)
  $Rows = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath)
  $SelectedIds = [System.Collections.Generic.HashSet[int]]::new()
  [void]$SelectedIds.Add($RootProcessId)
  do {
    $Changed = $false
    foreach ($Row in $Rows) {
      if ($SelectedIds.Contains([int]$Row.ParentProcessId) -and $SelectedIds.Add([int]$Row.ProcessId)) {
        $Changed = $true
      }
    }
  } while ($Changed)
  return @($Rows | Where-Object { $SelectedIds.Contains([int]$_.ProcessId) })
}

$ResolvedPackage = (Resolve-Path -LiteralPath $PackageDirectory).Path
if (-not (Test-Path -LiteralPath $ResolvedPackage -PathType Container)) {
  throw "Windows 性能包目录不存在"
}
$ExecutablePath = Join-Path $ResolvedPackage $ExecutableName
if (-not (Test-Path -LiteralPath $ExecutablePath -PathType Leaf)) {
  throw "Windows 性能包缺少 $ExecutableName"
}

$TemporaryParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
$SmokeRoot = Join-Path $TemporaryParent ($SmokePrefix + [Guid]::NewGuid().ToString("N"))
$ResolvedSmokeRoot = [IO.Path]::GetFullPath($SmokeRoot)
if (
  [IO.Path]::GetDirectoryName($ResolvedSmokeRoot).TrimEnd('\', '/') -ne $TemporaryParent -or
  -not [IO.Path]::GetFileName($ResolvedSmokeRoot).StartsWith($SmokePrefix, [StringComparison]::Ordinal)
) {
  throw "smoke 临时目录越界"
}
[void](New-Item -ItemType Directory -Path $ResolvedSmokeRoot)

$PreviousIsolation = [Environment]::GetEnvironmentVariable("DSP_PERFORMANCE_SMOKE_ISOLATION", "Process")
$PreviousRoot = [Environment]::GetEnvironmentVariable("DSP_PERFORMANCE_SMOKE_APP_DATA_ROOT", "Process")
$StartedProcess = $null
$ObservedProcessIds = [System.Collections.Generic.HashSet[int]]::new()
$ObservedNativeHost = $false
$MainAlive = $false
$MainResponding = $false
$StartedAt = [DateTimeOffset]::UtcNow
$Failure = $null

try {
  [Environment]::SetEnvironmentVariable("DSP_PERFORMANCE_SMOKE_ISOLATION", "1", "Process")
  [Environment]::SetEnvironmentVariable("DSP_PERFORMANCE_SMOKE_APP_DATA_ROOT", $ResolvedSmokeRoot, "Process")
  $StartedProcess = Start-Process -FilePath $ExecutablePath -WorkingDirectory $ResolvedPackage -WindowStyle Hidden -PassThru
  $Deadline = [DateTimeOffset]::UtcNow.AddSeconds($DurationSeconds)
  while ([DateTimeOffset]::UtcNow -lt $Deadline) {
    Start-Sleep -Milliseconds 250
    foreach ($Row in Get-ProcessTreeRows -RootProcessId $StartedProcess.Id) {
      [void]$ObservedProcessIds.Add([int]$Row.ProcessId)
      if ($Row.Name -eq "dsp-native-host.exe") {
        $ObservedNativeHost = $true
      }
    }
  }
  $Main = Get-Process -Id $StartedProcess.Id -ErrorAction SilentlyContinue
  $MainAlive = $null -ne $Main
  $MainResponding = $MainAlive -and $Main.Responding
} catch {
  $Failure = $_.Exception.Message
} finally {
  if ($null -ne $StartedProcess) {
    $Tree = @(Get-ProcessTreeRows -RootProcessId $StartedProcess.Id | Sort-Object ProcessId -Descending)
    foreach ($Row in $Tree) {
      Stop-Process -Id ([int]$Row.ProcessId) -Force -ErrorAction SilentlyContinue
    }
  }
  [Environment]::SetEnvironmentVariable("DSP_PERFORMANCE_SMOKE_ISOLATION", $PreviousIsolation, "Process")
  [Environment]::SetEnvironmentVariable("DSP_PERFORMANCE_SMOKE_APP_DATA_ROOT", $PreviousRoot, "Process")
}

Start-Sleep -Milliseconds 750
$ResidualProcessIds = @(if ($null -ne $StartedProcess) {
  Get-ProcessTreeRows -RootProcessId $StartedProcess.Id | ForEach-Object { [int]$_.ProcessId }
})
$IsolatedUserData = Join-Path $ResolvedSmokeRoot $UserDataDirectoryName
$TemporaryProfileIsolation = Test-Path -LiteralPath $IsolatedUserData -PathType Container
$Result = [ordered]@{
  schemaVersion = 1
  packageDirectory = $ResolvedPackage
  executablePath = $ExecutablePath
  startedAtUtc = $StartedAt.ToString("o")
  durationSeconds = $DurationSeconds
  smokeRoot = $ResolvedSmokeRoot
  temporaryProfileIsolation = $TemporaryProfileIsolation
  mainAlive = $MainAlive
  mainResponding = $MainResponding
  nativeHostObserved = $ObservedNativeHost
  observedProcessIds = @($ObservedProcessIds | Sort-Object)
  residualProcessIds = $ResidualProcessIds
  failure = $Failure
}
$Result["smokePassed"] = (
  $null -eq $Failure -and
  $TemporaryProfileIsolation -and
  $MainAlive -and
  $MainResponding -and
  $ObservedNativeHost -and
  $ResidualProcessIds.Count -eq 0
)
$Json = $Result | ConvertTo-Json -Depth 5

if ($OutputPath) {
  $ResolvedOutput = [IO.Path]::GetFullPath($OutputPath)
  $OutputParent = [IO.Path]::GetDirectoryName($ResolvedOutput)
  if (-not (Test-Path -LiteralPath $OutputParent -PathType Container)) {
    [void](New-Item -ItemType Directory -Path $OutputParent)
  }
  Set-Content -LiteralPath $ResolvedOutput -Value $Json -Encoding UTF8
}
Write-Output $Json

if (Test-Path -LiteralPath $ResolvedSmokeRoot) {
  $FinalSmokeRoot = (Resolve-Path -LiteralPath $ResolvedSmokeRoot).Path
  if (
    [IO.Path]::GetDirectoryName($FinalSmokeRoot).TrimEnd('\', '/') -ne $TemporaryParent -or
    -not [IO.Path]::GetFileName($FinalSmokeRoot).StartsWith($SmokePrefix, [StringComparison]::Ordinal)
  ) {
    throw "拒绝清理越界的 smoke 临时目录"
  }
  Remove-Item -LiteralPath $FinalSmokeRoot -Recurse -Force
}

if (-not $Result.smokePassed) {
  exit 1
}
