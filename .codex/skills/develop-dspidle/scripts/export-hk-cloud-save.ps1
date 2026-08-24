param(
  [Parameter(Mandatory = $true)][string]$Username,
  [string]$DisplayName = "",
  [string]$OutputDirectory = ""
)

$ErrorActionPreference = "Stop"
$normalizedUsername = $Username.Trim().TrimStart("@").ToLowerInvariant()
if ([string]::IsNullOrWhiteSpace($normalizedUsername) -or $normalizedUsername.Length -gt 128) {
  throw "USERNAME_INVALID"
}
if ($DisplayName.Length -gt 128) { throw "DISPLAY_NAME_INVALID" }

$toolRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$workspaceCandidate = Get-Item -LiteralPath $toolRoot
while ($workspaceCandidate -and -not (
  (Test-Path -LiteralPath (Join-Path $workspaceCandidate.FullName "package.json") -PathType Leaf) -and
  (Test-Path -LiteralPath (Join-Path $workspaceCandidate.FullName "src") -PathType Container) -and
  (Test-Path -LiteralPath (Join-Path $workspaceCandidate.FullName "server") -PathType Container) -and
  (Test-Path -LiteralPath (Join-Path $workspaceCandidate.FullName "deploy") -PathType Container)
)) {
  $workspaceCandidate = $workspaceCandidate.Parent
}
if (-not $workspaceCandidate) { throw "DSPIDLE_WORKSPACE_NOT_FOUND" }
$workspaceRoot = [IO.Path]::GetFullPath($workspaceCandidate.FullName)
$remoteScript = Join-Path $toolRoot "export-cloud-save-readonly.mjs"
if (-not (Test-Path -LiteralPath $remoteScript -PathType Leaf)) { throw "REMOTE_READER_MISSING" }
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path $workspaceRoot "artifacts\support-exports"
}
$resolvedOutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($resolvedOutputDirectory) | Out-Null

function Read-ProtectedEnvironment([string]$name) {
  foreach ($scope in @("Process", "User", "Machine")) {
    $value = [Environment]::GetEnvironmentVariable($name, $scope)
    if (-not [string]::IsNullOrWhiteSpace($value)) { return $value }
  }
  return ""
}

$hostName = Read-ProtectedEnvironment "DSP_HK_HOST"
$sshUser = Read-ProtectedEnvironment "DSP_HK_SSH_USER"
$keyPath = Read-ProtectedEnvironment "DSP_HK_SSH_KEY_PATH"
$knownHosts = Read-ProtectedEnvironment "DSP_HK_KNOWN_HOSTS"
$port = Read-ProtectedEnvironment "DSP_HK_SSH_PORT"
$bindAddress = Read-ProtectedEnvironment "DSP_HK_BIND_ADDRESS"
if ([string]::IsNullOrWhiteSpace($port)) { $port = "22" }

$transportInput = ""
$transportInputs = @()
if ([string]::IsNullOrWhiteSpace($hostName) -or
    [string]::IsNullOrWhiteSpace($sshUser) -or
    [string]::IsNullOrWhiteSpace($keyPath) -or
    [string]::IsNullOrWhiteSpace($knownHosts)) {
  $sessionRoot = Join-Path $env:USERPROFILE ".codex\sessions"
  if (-not (Test-Path -LiteralPath $sessionRoot -PathType Container)) {
    throw "PROTECTED_HK_TRANSPORT_UNAVAILABLE"
  }
  $sessionFiles = @(Get-ChildItem -LiteralPath $sessionRoot -Recurse -File -Filter "*.jsonl" |
    Sort-Object LastWriteTimeUtc -Descending)
  foreach ($sessionFile in $sessionFiles) {
    $latestMatch = ""
    $sessionTransportInputs = [System.Collections.Generic.List[string]]::new()
    $stream = [IO.File]::Open(
      $sessionFile.FullName,
      [IO.FileMode]::Open,
      [IO.FileAccess]::Read,
      [IO.FileShare]::ReadWrite
    )
    try {
      $reader = [IO.StreamReader]::new($stream)
      while (($line = $reader.ReadLine()) -ne $null) {
        try { $record = $line | ConvertFrom-Json -Depth 50 } catch { continue }
        if ($record.type -ne "response_item" -or
            $record.payload.type -ne "custom_tool_call" -or
            $record.payload.name -ne "exec") { continue }
        $inputText = [string]$record.payload.input
        if ($inputText -match "(?i)\.pem" -and
            $inputText -match "(?i)StrictHostKeyChecking") {
          $sessionTransportInputs.Add($inputText)
          if ($inputText -match "(?i)[A-Za-z0-9._-]+@\d{1,3}(?:\.\d{1,3}){3}") {
            $latestMatch = $inputText
          }
        }
      }
      $reader.Dispose()
    } finally {
      $stream.Dispose()
    }
    if (-not [string]::IsNullOrWhiteSpace($latestMatch)) {
      $transportInput = $latestMatch
      $transportInputs = @($sessionTransportInputs)
      break
    }
  }
  if ([string]::IsNullOrWhiteSpace($transportInput)) { throw "PROTECTED_HK_TRANSPORT_UNAVAILABLE" }

  $targets = @([regex]::Matches(
    $transportInput,
    "(?i)(?<user>[A-Za-z0-9._-]+)@(?<host>\d{1,3}(?:\.\d{1,3}){3})"
  ) | ForEach-Object { $_.Groups["user"].Value + "@" + $_.Groups["host"].Value } |
    Select-Object -Unique)
  if ($targets.Count -ne 1) { throw "PROTECTED_HK_TARGET_AMBIGUOUS" }
  $sshUser, $hostName = $targets[0].Split("@", 2)
  $selectedTransportInputs = @($transportInputs | Where-Object {
    $_ -match [regex]::Escape($targets[0])
  })
  if ($selectedTransportInputs.Count -lt 1) { throw "PROTECTED_HK_TRANSPORT_UNAVAILABLE" }

  $keyCandidates = @([regex]::Matches(
    $transportInput,
    '(?i)[A-Z]:\\(?:[^\s"]*\.pem)'
  ) | ForEach-Object { $_.Value.TrimEnd(")", ",", ";", "\") } |
    Select-Object -Unique | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
  $knownHostCandidates = @($selectedTransportInputs | ForEach-Object { [regex]::Matches(
    $_,
    '(?i)[A-Z]:\\(?:[^\s"]*known_hosts[^\s"]*)'
  ) } | ForEach-Object { $_.Value.TrimEnd(")", ",", ";", "\") } |
    Select-Object -Unique | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
  if ($keyCandidates.Count -ne 1 -or $knownHostCandidates.Count -ne 1) {
    throw "PROTECTED_HK_TRANSPORT_PATHS_AMBIGUOUS"
  }
  $keyPath = $keyCandidates[0]
  $knownHosts = $knownHostCandidates[0]
}

if (-not (Test-Path -LiteralPath $keyPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $knownHosts -PathType Leaf)) {
  throw "PROTECTED_HK_TRANSPORT_PATH_UNAVAILABLE"
}
if ($port -notmatch "^[0-9]{1,5}$" -or [int]$port -lt 1 -or [int]$port -gt 65535) {
  throw "SSH_PORT_INVALID"
}

& ssh-keygen.exe -F $hostName -f $knownHosts *> $null
$known = $LASTEXITCODE -eq 0
if (-not $known) {
  & ssh-keygen.exe -F ("[" + $hostName + "]:" + $port) -f $knownHosts *> $null
  $known = $LASTEXITCODE -eq 0
}
if (-not $known) { throw "STRICT_HOST_KEY_ENTRY_MISSING" }

$assignedAddresses = @(Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.AddressState -eq "Preferred" } | ForEach-Object { $_.IPAddress })
if (-not [string]::IsNullOrWhiteSpace($bindAddress) -and $bindAddress -notin $assignedAddresses) {
  throw "CONFIGURED_PHYSICAL_EGRESS_UNAVAILABLE"
}
if ([string]::IsNullOrWhiteSpace($bindAddress) -and -not [string]::IsNullOrWhiteSpace($transportInput)) {
  $bindCandidates = @([regex]::Matches(
    $transportInput,
    "(?<!\d)(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))(?:\.\d{1,3}){2}(?!\d)"
  ) | ForEach-Object { $_.Value } | Select-Object -Unique |
    Where-Object { $_ -in $assignedAddresses })
  if ($bindCandidates.Count -gt 0) { $bindAddress = $bindCandidates[-1] }
}
if ([string]::IsNullOrWhiteSpace($bindAddress)) {
  $physicalConfigurations = @(Get-NetIPConfiguration | Where-Object {
    $_.NetAdapter.Status -eq "Up" -and $_.IPv4DefaultGateway -and $_.IPv4Address -and
    $_.InterfaceAlias -notmatch "(?i)vpn|tun|tap|wireguard|wintun|clash|v2ray|tailscale|zerotier"
  })
  $preferredConfigurations = @($physicalConfigurations | Where-Object {
    $_.InterfaceAlias -match "(?i)ethernet|wi-?fi|wlan|以太网|无线"
  })
  $configuration = if ($preferredConfigurations.Count -gt 0) {
    $preferredConfigurations[0]
  } elseif ($physicalConfigurations.Count -gt 0) {
    $physicalConfigurations[0]
  } else {
    $null
  }
  if (-not $configuration) { throw "PHYSICAL_EGRESS_UNAVAILABLE" }
  $bindAddress = @($configuration.IPv4Address)[0].IPAddress
}

$safeUsername = [regex]::Replace($normalizedUsername, "[^A-Za-z0-9._-]", "_")
if ([string]::IsNullOrWhiteSpace($safeUsername)) { $safeUsername = "account" }
$timestamp = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssZ")
$outputPath = Join-Path $resolvedOutputDirectory (
  "dsp-idle-cloud-" + $safeUsername + "-normal-main-" + $timestamp + ".json"
)
$usernameArgument = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($normalizedUsername)).TrimEnd("=").Replace("+", "-").Replace("/", "_")
$displayNameArgument = if ([string]::IsNullOrWhiteSpace($DisplayName)) {
  ""
} else {
  [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($DisplayName.Trim())).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}
$remoteCommand = "cd /opt/dsp-idle-cloud/current/server && node --input-type=module - " +
  $usernameArgument + " " + $displayNameArgument

$startInfo = [Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = (Get-Command ssh.exe).Source
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.RedirectStandardInput = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
foreach ($argument in @(
  "-T", "-b", $bindAddress, "-p", $port, "-i", $keyPath,
  "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes",
  "-o", ("UserKnownHostsFile=" + $knownHosts), "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=20", ($sshUser + "@" + $hostName), $remoteCommand
)) { [void]$startInfo.ArgumentList.Add($argument) }

$process = [Diagnostics.Process]::new()
$process.StartInfo = $startInfo
$outputStream = [IO.File]::Open($outputPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
$scriptInput = [IO.File]::OpenRead($remoteScript)
try {
  [void]$process.Start()
  $stdoutTask = $process.StandardOutput.BaseStream.CopyToAsync($outputStream)
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $scriptInput.CopyTo($process.StandardInput.BaseStream)
  $process.StandardInput.Close()
  $process.WaitForExit()
  $stdoutTask.GetAwaiter().GetResult() | Out-Null
  $stderr = $stderrTask.GetAwaiter().GetResult()
} finally {
  $scriptInput.Dispose()
  $outputStream.Dispose()
}

if ($process.ExitCode -ne 0) {
  if (Test-Path -LiteralPath $outputPath -PathType Leaf) { Remove-Item -LiteralPath $outputPath -Force }
  $category = if ($stderr -match "ACCOUNT_MATCH_COUNT_") { "ACCOUNT_MATCH" }
    elseif ($stderr -match "NORMAL_MAIN") { "SAVE_NOT_FOUND" }
    elseif ($stderr -match "CLOUD_METADATA") { "METADATA_MISMATCH" }
    elseif ($stderr -match "CLOUD_PAYLOAD_JSON_INVALID") { "PAYLOAD_JSON" }
    elseif ($stderr -match "Host key verification failed") { "HOST_KEY" }
    elseif ($stderr -match "Permission denied") { "AUTH" }
    elseif ($stderr -match "timed out") { "TIMEOUT" }
    else { "REMOTE_EXPORT" }
  throw ("HK_CLOUD_EXPORT_FAILED_" + $category)
}

$metadataLines = @($stderr -split "`r?`n" |
  Where-Object { $_ -like "DSP_EXPORT_META *" } | Select-Object -Last 1)
if ($metadataLines.Count -ne 1) {
  Remove-Item -LiteralPath $outputPath -Force
  throw "EXPORT_METADATA_MISSING"
}
$metadata = $metadataLines[0].Substring("DSP_EXPORT_META ".Length) | ConvertFrom-Json
$localSize = (Get-Item -LiteralPath $outputPath).Length
$localSha256 = (Get-FileHash -LiteralPath $outputPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($localSize -ne [int64]$metadata.size -or $localSha256 -ne [string]$metadata.sha256) {
  Remove-Item -LiteralPath $outputPath -Force
  throw "LOCAL_EXPORT_VERIFICATION_FAILED"
}

$duration = $null
if ($null -ne $metadata.elapsedSeconds) {
  $seconds = [double]$metadata.elapsedSeconds
  $duration = "{0}:{1:D2}:{2:D2}" -f [int][math]::Floor($seconds / 3600),
    [int][math]::Floor(($seconds % 3600) / 60), [int][math]::Floor($seconds % 60)
}
[pscustomobject]@{
  ok = $true
  file = $outputPath
  revision = [int]$metadata.revision
  size = $localSize
  sha256 = $localSha256
  formatVersion = $metadata.formatVersion
  stateVersion = $metadata.stateVersion
  integrityValid = [bool]$metadata.integrityValid
  hasEntities = [bool]$metadata.hasEntities
  mode = [string]$metadata.mode
  elapsedSeconds = $metadata.elapsedSeconds
  duration = $duration
  remoteTempFile = $false
  productionMutation = $false
} | ConvertTo-Json -Compress
