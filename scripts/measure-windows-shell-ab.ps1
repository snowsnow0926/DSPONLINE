[CmdletBinding()]
param(
    [ValidateSet('electron', 'tauri', 'winui')]
    [string]$Shell = 'electron',

    [string]$RepositoryRoot = '',

    [string]$ElectronExecutable = '',

    [ValidateRange(1, 600)]
    [int]$DurationSeconds = 15,

    [ValidateRange(100, 100000)]
    [int]$InstanceCount = 10000,

    [ValidateRange(100, 5000)]
    [int]$SampleIntervalMilliseconds = 500,

    [ValidateRange(5, 120)]
    [int]$StartupTimeoutSeconds = 30,

    [string]$OutputPath = '',

    [switch]$KeepProfile,

    [switch]$Force,

    [switch]$ValidateOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-NormalizedPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$BasePath
    )
    $candidate = if ([System.IO.Path]::IsPathRooted($Path)) { $Path } else { Join-Path $BasePath $Path }
    return [System.IO.Path]::GetFullPath($candidate)
}

function Test-DedicatedTempProfile {
    param(
        [Parameter(Mandatory = $true)][string]$TemporaryRoot,
        [Parameter(Mandatory = $true)][string]$ProfilePath
    )
    $resolvedTemporaryRoot = [System.IO.Path]::GetFullPath($TemporaryRoot).TrimEnd('\', '/')
    $resolvedProfile = [System.IO.Path]::GetFullPath($ProfilePath).TrimEnd('\', '/')
    $prefix = "$resolvedTemporaryRoot$([System.IO.Path]::DirectorySeparatorChar)"
    $leaf = Split-Path -Leaf $resolvedProfile
    return $resolvedProfile.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) -and
        $leaf.StartsWith('dsp-shell-lab-electron-', [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-PercentileValue {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][long[]]$Values,
        [Parameter(Mandatory = $true)][double]$Quantile
    )
    if ($Values.Count -eq 0) { return [long]0 }
    $sorted = @($Values | Sort-Object)
    $index = [Math]::Min($sorted.Count - 1, [Math]::Max(0, [Math]::Ceiling($sorted.Count * $Quantile) - 1))
    return [long]$sorted[$index]
}

function Get-ProcessRole {
    param(
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [Parameter(Mandatory = $true)][int]$RootProcessId,
        [AllowNull()][string]$Name,
        [AllowNull()][string]$CommandLine
    )
    if ($ProcessId -eq $RootProcessId) { return 'main' }
    if ($Name -ieq 'dsp-native-host.exe') { return 'native-host' }
    if ($CommandLine -match '--type=renderer') { return 'renderer' }
    if ($CommandLine -match '--type=gpu-process') { return 'gpu' }
    if ($CommandLine -match '--type=utility') { return 'utility' }
    if ($CommandLine -match '--type=crashpad-handler') { return 'crashpad' }
    return 'child'
}

function Get-ProcessTreeSnapshot {
    param(
        [Parameter(Mandatory = $true)][int]$RootProcessId,
        [Parameter(Mandatory = $true)][double]$ElapsedMilliseconds
    )
    $sampler = [System.Diagnostics.Stopwatch]::StartNew()
    $rows = @(Get-CimInstance Win32_Process)
    $childrenByParent = @{}
    foreach ($row in $rows) {
        $parentId = [int]$row.ParentProcessId
        if (-not $childrenByParent.ContainsKey($parentId)) {
            $childrenByParent[$parentId] = [System.Collections.Generic.List[object]]::new()
        }
        $childrenByParent[$parentId].Add($row)
    }

    $processIds = [System.Collections.Generic.HashSet[int]]::new()
    $queue = [System.Collections.Generic.Queue[int]]::new()
    [void]$processIds.Add($RootProcessId)
    $queue.Enqueue($RootProcessId)
    while ($queue.Count -gt 0) {
        $parentId = $queue.Dequeue()
        if (-not $childrenByParent.ContainsKey($parentId)) { continue }
        foreach ($child in $childrenByParent[$parentId]) {
            $childId = [int]$child.ProcessId
            if ($processIds.Add($childId)) { $queue.Enqueue($childId) }
        }
    }

    $records = [System.Collections.Generic.List[object]]::new()
    $totalPrivateBytes = [long]0
    $totalWorkingSetBytes = [long]0
    foreach ($row in $rows) {
        $processId = [int]$row.ProcessId
        if (-not $processIds.Contains($processId)) { continue }
        $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if (-not $process) { continue }
        $privateBytes = [long]$process.PrivateMemorySize64
        $workingSetBytes = [long]$process.WorkingSet64
        $totalPrivateBytes += $privateBytes
        $totalWorkingSetBytes += $workingSetBytes
        $records.Add([pscustomobject]@{
            processId = $processId
            parentProcessId = [int]$row.ParentProcessId
            name = [string]$row.Name
            role = Get-ProcessRole -ProcessId $processId -RootProcessId $RootProcessId -Name $row.Name -CommandLine $row.CommandLine
            privateBytes = $privateBytes
            workingSetBytes = $workingSetBytes
            cpuSeconds = [Math]::Round([double]$process.CPU, 6)
        })
    }
    $sampler.Stop()
    return [pscustomobject]@{
        elapsedMs = [Math]::Round($ElapsedMilliseconds, 3)
        samplerDurationMs = [Math]::Round($sampler.Elapsed.TotalMilliseconds, 3)
        treePrivateBytes = $totalPrivateBytes
        treeWorkingSetBytes = $totalWorkingSetBytes
        processes = @($records | Sort-Object processId)
    }
}

function Stop-ExactProcessTree {
    param([Parameter(Mandatory = $true)][int]$RootProcessId)
    $snapshot = Get-ProcessTreeSnapshot -RootProcessId $RootProcessId -ElapsedMilliseconds 0
    $childIds = @($snapshot.processes | Where-Object processId -ne $RootProcessId | Select-Object -ExpandProperty processId)
    foreach ($processId in $childIds) {
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    }
    Stop-Process -Id $RootProcessId -Force -ErrorAction SilentlyContinue
}

function Get-ProcessTreeSummary {
    param([Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Samples)
    $privateValues = [long[]]@($Samples | ForEach-Object { [long]$_.treePrivateBytes })
    $workingSetValues = [long[]]@($Samples | ForEach-Object { [long]$_.treeWorkingSetBytes })
    $samplerValues = [double[]]@($Samples | ForEach-Object { [double]$_.samplerDurationMs })
    $processCountValues = [long[]]@($Samples | ForEach-Object { [long]@($_.processes).Count })
    $roleSummaries = [ordered]@{}
    foreach ($role in @('main', 'renderer', 'gpu', 'utility', 'native-host', 'crashpad', 'child')) {
        $roleCountValues = [long[]]@($Samples | ForEach-Object {
            [long]@($_.processes | Where-Object role -eq $role).Count
        })
        $rolePrivateValues = [long[]]@($Samples | ForEach-Object {
            $sum = [long]0
            foreach ($record in @($_.processes)) {
                if ($record.role -eq $role) { $sum += [long]$record.privateBytes }
            }
            $sum
        })
        $roleWorkingSetValues = [long[]]@($Samples | ForEach-Object {
            $sum = [long]0
            foreach ($record in @($_.processes)) {
                if ($record.role -eq $role) { $sum += [long]$record.workingSetBytes }
            }
            $sum
        })
        $roleSummaries[$role] = [pscustomobject]@{
            peakCount = if ($roleCountValues.Count -gt 0) { [int](($roleCountValues | Measure-Object -Maximum).Maximum) } else { 0 }
            peakPrivateBytes = if ($rolePrivateValues.Count -gt 0) { [long](($rolePrivateValues | Measure-Object -Maximum).Maximum) } else { [long]0 }
            p95PrivateBytes = Get-PercentileValue -Values $rolePrivateValues -Quantile 0.95
            peakWorkingSetBytes = if ($roleWorkingSetValues.Count -gt 0) { [long](($roleWorkingSetValues | Measure-Object -Maximum).Maximum) } else { [long]0 }
            p95WorkingSetBytes = Get-PercentileValue -Values $roleWorkingSetValues -Quantile 0.95
        }
    }
    return [pscustomobject]@{
        sampleCount = $Samples.Count
        peakProcessCount = if ($processCountValues.Count -gt 0) { [int](($processCountValues | Measure-Object -Maximum).Maximum) } else { 0 }
        peakPrivateBytes = if ($privateValues.Count -gt 0) { [long](($privateValues | Measure-Object -Maximum).Maximum) } else { [long]0 }
        p50PrivateBytes = Get-PercentileValue -Values $privateValues -Quantile 0.50
        p95PrivateBytes = Get-PercentileValue -Values $privateValues -Quantile 0.95
        peakWorkingSetBytes = if ($workingSetValues.Count -gt 0) { [long](($workingSetValues | Measure-Object -Maximum).Maximum) } else { [long]0 }
        p95WorkingSetBytes = Get-PercentileValue -Values $workingSetValues -Quantile 0.95
        samplerOverheadMs = [pscustomobject]@{
            total = if ($samplerValues.Count -gt 0) {
                [Math]::Round([double](($samplerValues | Measure-Object -Sum).Sum), 3)
            } else { 0 }
            p95 = if ($samplerValues.Count -gt 0) {
                $sorted = @($samplerValues | Sort-Object)
                [Math]::Round([double]$sorted[[Math]::Min($sorted.Count - 1, [Math]::Ceiling($sorted.Count * 0.95) - 1)], 3)
            } else { 0 }
        }
        roles = [pscustomobject]$roleSummaries
        samples = $Samples
    }
}

function Write-JsonAtomically {
    param(
        [Parameter(Mandatory = $true)][string]$TargetPath,
        [Parameter(Mandatory = $true)][object]$Value,
        [Parameter(Mandatory = $true)][string]$RunId,
        [switch]$AllowOverwrite
    )
    $parent = Split-Path -Parent $TargetPath
    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    if ((Test-Path -LiteralPath $TargetPath) -and -not $AllowOverwrite) {
        throw "Output already exists: $TargetPath (pass -Force to replace it)"
    }
    $temporaryPath = "$TargetPath.part-$RunId"
    $json = $Value | ConvertTo-Json -Depth 12
    [System.IO.File]::WriteAllText($temporaryPath, "$json`n", [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporaryPath -Destination $TargetPath -Force:$AllowOverwrite
}

if ($Shell -ne 'electron') {
    $reason = if ($Shell -eq 'tauri') {
        'No-Go: this repository has no locked src-tauri scaffold, repository-owned CLI/API packages, capability manifest, sidecar bundle, or offline build proof.'
    } else {
        'No-Go: Windows App SDK development workloads/targets/templates, Microsoft.WindowsAppSDK, and Win2D development packages are not installed.'
    }
    throw $reason
}

$isWindowsHost = [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
    [System.Runtime.InteropServices.OSPlatform]::Windows
)
if (-not $isWindowsHost) { throw 'The Windows shell A/B measurement script requires Windows.' }

$resolvedRepositoryRoot = if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) {
    [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
} else {
    Resolve-NormalizedPath -Path $RepositoryRoot -BasePath (Get-Location).Path
}
$labDirectory = Join-Path $resolvedRepositoryRoot 'experiments\windows-shell-lab\electron'
$labPackage = Join-Path $labDirectory 'package.json'
$nativeHostPath = Join-Path $resolvedRepositoryRoot 'native\target\release\dsp-native-host.exe'
$resolvedElectronExecutable = if ([string]::IsNullOrWhiteSpace($ElectronExecutable)) {
    Join-Path $resolvedRepositoryRoot 'node_modules\electron\dist\electron.exe'
} else {
    Resolve-NormalizedPath -Path $ElectronExecutable -BasePath $resolvedRepositoryRoot
}

foreach ($requiredPath in @($labPackage, $resolvedElectronExecutable, $nativeHostPath)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Required shell lab input is missing: $requiredPath"
    }
}

$runId = [Guid]::NewGuid().ToString('N')
$resolvedOutputPath = if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    Join-Path $resolvedRepositoryRoot "artifacts\windows-shell-ab\electron-$runId.json"
} else {
    Resolve-NormalizedPath -Path $OutputPath -BasePath $resolvedRepositoryRoot
}

$validation = [pscustomobject]@{
    schemaVersion = 1
    kind = 'dsp-windows-shell-ab-validation'
    shell = 'electron'
    ready = $true
    repositoryRoot = $resolvedRepositoryRoot
    labPackage = $labPackage
    electronVersion = (Get-Item -LiteralPath $resolvedElectronExecutable).VersionInfo.ProductVersion
    nativeHostPresent = $true
    cloudEnabled = $false
    updatesEnabled = $false
    outputPath = $resolvedOutputPath
}
if ($ValidateOnly) {
    $validation | ConvertTo-Json -Depth 4
    exit 0
}

$temporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$profilePath = Join-Path $temporaryRoot "dsp-shell-lab-electron-$runId"
if (-not (Test-DedicatedTempProfile -TemporaryRoot $temporaryRoot -ProfilePath $profilePath)) {
    throw 'Refusing to create a shell lab profile outside the validated temporary root.'
}
New-Item -ItemType Directory -Path $profilePath | Out-Null
$rawMetricsPath = Join-Path $profilePath 'renderer-metrics.json'
$durationMilliseconds = $DurationSeconds * 1000
$startedAtUtc = [DateTimeOffset]::UtcNow
$rootProcess = $null
$samples = [System.Collections.Generic.List[object]]::new()
$measurementTimer = [System.Diagnostics.Stopwatch]::StartNew()
$measurementSucceeded = $false
$capturedFailure = $null
$rawLabMetrics = $null

try {
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $resolvedElectronExecutable
    $startInfo.WorkingDirectory = $resolvedRepositoryRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $false
    [void]$startInfo.ArgumentList.Add($labDirectory)
    [void]$startInfo.ArgumentList.Add("--lab-user-data-dir=$profilePath")
    [void]$startInfo.ArgumentList.Add("--lab-duration-ms=$durationMilliseconds")
    [void]$startInfo.ArgumentList.Add("--lab-instance-count=$InstanceCount")
    [void]$startInfo.ArgumentList.Add('--lab-auto-exit')
    $rootProcess = [System.Diagnostics.Process]::Start($startInfo)
    if (-not $rootProcess) { throw 'Electron shell lab process did not start.' }

    $deadlineMilliseconds = ($DurationSeconds + $StartupTimeoutSeconds) * 1000
    while ($measurementTimer.Elapsed.TotalMilliseconds -lt $deadlineMilliseconds) {
        $rootProcess.Refresh()
        $samples.Add((Get-ProcessTreeSnapshot -RootProcessId $rootProcess.Id -ElapsedMilliseconds $measurementTimer.Elapsed.TotalMilliseconds))
        if ($rootProcess.HasExited) { break }
        Start-Sleep -Milliseconds $SampleIntervalMilliseconds
    }

    $rootProcess.Refresh()
    if (-not $rootProcess.HasExited) {
        throw "Electron shell lab exceeded the $deadlineMilliseconds ms measurement deadline."
    }
    $rawMetricsWait = [System.Diagnostics.Stopwatch]::StartNew()
    while (-not (Test-Path -LiteralPath $rawMetricsPath -PathType Leaf) -and $rawMetricsWait.Elapsed.TotalSeconds -lt 3) {
        Start-Sleep -Milliseconds 100
    }
    if (-not (Test-Path -LiteralPath $rawMetricsPath -PathType Leaf)) {
        throw 'Electron shell lab exited without renderer metrics.'
    }
    $rawLabMetrics = Get-Content -Raw -LiteralPath $rawMetricsPath | ConvertFrom-Json -Depth 20
    if ($rawLabMetrics.status -ne 'renderer-complete') {
        $phaseProperty = $rawLabMetrics.PSObject.Properties['phase']
        $phase = if ($phaseProperty -and -not [string]::IsNullOrWhiteSpace([string]$phaseProperty.Value)) {
            [string]$phaseProperty.Value
        } else {
            'unknown'
        }
        throw "Electron shell lab reported failure during $phase."
    }

    $processTree = Get-ProcessTreeSummary -Samples @($samples)
    $operatingSystem = Get-CimInstance Win32_OperatingSystem
    $processor = Get-CimInstance Win32_Processor | Select-Object -First 1
    $electronFile = Get-Item -LiteralPath $resolvedElectronExecutable
    $measurement = [pscustomobject]@{
        schemaVersion = 1
        kind = 'dsp-windows-shell-ab-measurement'
        shell = 'electron'
        status = 'completed'
        runId = $runId
        startedAtUtc = $startedAtUtc.ToString('o')
        completedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
        configuration = [pscustomobject]@{
            durationSeconds = $DurationSeconds
            instanceCount = $InstanceCount
            sampleIntervalMilliseconds = $SampleIntervalMilliseconds
            fixtureId = 'deterministic-canvas-v1'
            isolatedTemporaryUserData = $true
            cloudEnabled = $false
            updatesEnabled = $false
        }
        host = [pscustomobject]@{
            operatingSystem = [string]$operatingSystem.Caption
            osVersion = [string]$operatingSystem.Version
            osBuild = [string]$operatingSystem.BuildNumber
            architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
            processor = [string]$processor.Name
            physicalCores = [int]$processor.NumberOfCores
            logicalProcessors = [int]$processor.NumberOfLogicalProcessors
            totalVisibleMemoryBytes = [long]$operatingSystem.TotalVisibleMemorySize * 1024
        }
        executable = [pscustomobject]@{
            length = [long]$electronFile.Length
            sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $resolvedElectronExecutable).Hash.ToLowerInvariant()
            version = [string]$electronFile.VersionInfo.ProductVersion
        }
        lab = $rawLabMetrics
        processTree = $processTree
        error = $null
    }
    Write-JsonAtomically -TargetPath $resolvedOutputPath -Value $measurement -RunId $runId -AllowOverwrite:$Force
    $measurementSucceeded = $true
    Write-Output $resolvedOutputPath
} catch {
    $capturedFailure = $_
    if ($samples.Count -eq 0 -and $rootProcess) {
        try { $samples.Add((Get-ProcessTreeSnapshot -RootProcessId $rootProcess.Id -ElapsedMilliseconds $measurementTimer.Elapsed.TotalMilliseconds)) } catch { }
    }
    $failedLab = if ($rawLabMetrics) {
        $rawLabMetrics
    } else {
        [pscustomobject]@{
            schemaVersion = 1
            kind = 'dsp-windows-shell-lab'
            shell = 'electron'
            status = 'failed'
            phase = 'measurement'
        }
    }
    $failureMeasurement = [pscustomobject]@{
        schemaVersion = 1
        kind = 'dsp-windows-shell-ab-measurement'
        shell = 'electron'
        status = 'failed'
        runId = $runId
        startedAtUtc = $startedAtUtc.ToString('o')
        completedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
        configuration = [pscustomobject]@{
            durationSeconds = $DurationSeconds
            instanceCount = $InstanceCount
            sampleIntervalMilliseconds = $SampleIntervalMilliseconds
            fixtureId = 'deterministic-canvas-v1'
            isolatedTemporaryUserData = $true
            cloudEnabled = $false
            updatesEnabled = $false
        }
        host = [pscustomobject]@{}
        executable = [pscustomobject]@{
            length = [long](Get-Item -LiteralPath $resolvedElectronExecutable).Length
            sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $resolvedElectronExecutable).Hash.ToLowerInvariant()
            version = [string](Get-Item -LiteralPath $resolvedElectronExecutable).VersionInfo.ProductVersion
        }
        lab = $failedLab
        processTree = Get-ProcessTreeSummary -Samples @($samples)
        error = [pscustomobject]@{
            type = [string]$_.Exception.GetType().FullName
            message = [string]$_.Exception.Message
        }
    }
    try {
        Write-JsonAtomically -TargetPath $resolvedOutputPath -Value $failureMeasurement -RunId $runId -AllowOverwrite:$Force
    } catch {
        Write-Warning "Unable to write failed measurement JSON: $($_.Exception.Message)"
    }
} finally {
    $measurementTimer.Stop()
    if ($rootProcess) {
        $rootProcess.Refresh()
        if (-not $rootProcess.HasExited) {
            Stop-ExactProcessTree -RootProcessId $rootProcess.Id
        }
        $rootProcess.Dispose()
    }
    if ($measurementSucceeded -and -not $KeepProfile -and (Test-Path -LiteralPath $profilePath)) {
        if (Test-DedicatedTempProfile -TemporaryRoot $temporaryRoot -ProfilePath $profilePath) {
            Remove-Item -LiteralPath $profilePath -Recurse -Force
        } else {
            Write-Warning "Refusing to remove unvalidated profile path: $profilePath"
        }
    }
}

if ($capturedFailure) {
    Write-Error $capturedFailure
    exit 1
}
