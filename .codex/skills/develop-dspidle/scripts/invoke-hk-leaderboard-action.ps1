param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Username", "DisplayName", "GuardId")]
  [string]$MatchBy,

  [Parameter(Mandatory = $true)]
  [string]$Identifier,

  [ValidateSet("Inspect", "Restrict", "Restore", "RepublishNormal")]
  [string]$Action = "Inspect",

  [switch]$Apply,
  [switch]$Force,
  [string]$Reason = "",
  [switch]$DeepWhiteRateAudit,
  [Nullable[double]]$ExpectedWhiteRate = $null,
  [switch]$CurrentOnly,
  [switch]$FullBackupVerified
)

$ErrorActionPreference = "Stop"

$trimmedIdentifier = $Identifier.Trim()
if ([string]::IsNullOrWhiteSpace($trimmedIdentifier) -or $trimmedIdentifier.Length -gt 128) {
  throw "IDENTIFIER_INVALID"
}
if ($Reason.Length -gt 120) { throw "REASON_INVALID" }
if ($Force -and ($Action -ne "Restrict" -or [string]::IsNullOrWhiteSpace($Reason))) {
  throw "FORCE_REQUIRES_RESTRICT_REASON"
}
if ($Apply -and $Action -eq "Inspect") { throw "INSPECT_CANNOT_APPLY" }
if ($Action -eq "RepublishNormal" -and $Apply -and -not $FullBackupVerified) {
  throw "REPUBLISH_NORMAL_REQUIRES_FULL_BACKUP"
}
if ($MatchBy -eq "GuardId" -and $Action -notin @("Inspect", "Restore")) { throw "GUARD_MATCH_RESTORE_ONLY" }
if ($DeepWhiteRateAudit -and $Action -notin @("Inspect", "Restrict")) { throw "DEEP_AUDIT_RESTORE_UNSUPPORTED" }
if ($CurrentOnly -and (-not $DeepWhiteRateAudit -or $Action -ne "Inspect")) { throw "CURRENT_ONLY_REQUIRES_DEEP_INSPECT" }
if ($null -ne $ExpectedWhiteRate -and (-not $DeepWhiteRateAudit -or $ExpectedWhiteRate -le 0 -or
    [double]::IsNaN($ExpectedWhiteRate) -or [double]::IsInfinity($ExpectedWhiteRate))) {
  throw "EXPECTED_WHITE_RATE_INVALID"
}

$toolRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$remoteScript = Join-Path $toolRoot "safe-leaderboard-account-action.mjs"
if (-not (Test-Path -LiteralPath $remoteScript -PathType Leaf)) {
  throw "REMOTE_ACTION_SCRIPT_MISSING"
}

function Read-ProtectedEnvironment([string]$name) {
  foreach ($scope in @("Process", "User", "Machine")) {
    $value = [Environment]::GetEnvironmentVariable($name, $scope)
    if (-not [string]::IsNullOrWhiteSpace($value)) { return $value }
  }
  return ""
}

function ConvertTo-Base64Url([string]$value) {
  return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($value)).TrimEnd("=").Replace("+", "-").Replace("/", "_")
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
  $sessionFiles = @(& rg --files $sessionRoot -g "*.jsonl" 2>$null |
    ForEach-Object { Get-Item -LiteralPath $_ } |
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
  if ([string]::IsNullOrWhiteSpace($transportInput)) {
    throw "PROTECTED_HK_TRANSPORT_UNAVAILABLE"
  }

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

  $keyCandidates = @()
  $knownHostCandidates = @()
  for ($transportIndex = $selectedTransportInputs.Count - 1; $transportIndex -ge 0; $transportIndex--) {
    $candidateInput = $selectedTransportInputs[$transportIndex]
    $candidateKeys = @([regex]::Matches(
      $candidateInput,
      '(?i)[A-Z]:\\(?:[^\s"''()]*\.pem)'
    ) | ForEach-Object { $_.Value -replace '\\\\', '\' } |
      Select-Object -Unique | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
    $candidateKnownHosts = @([regex]::Matches(
      $candidateInput,
      '(?i)[A-Z]:\\(?:[^\s"''()]*known_hosts[^\s"''()]*)'
    ) | ForEach-Object { $_.Value -replace '\\\\', '\' } |
      Select-Object -Unique | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
    if ($candidateKeys.Count -eq 1 -and $candidateKnownHosts.Count -eq 1) {
      $keyCandidates = $candidateKeys
      $knownHostCandidates = $candidateKnownHosts
      break
    }
  }
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
  Where-Object { $_.AddressState -eq "Preferred" } |
  ForEach-Object { $_.IPAddress })
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

$remoteMatchBy = if ($MatchBy -eq "Username") {
  "username"
} elseif ($MatchBy -eq "DisplayName") {
  "display-name"
} else {
  "guard-id"
}
$remoteAction = $Action.ToLowerInvariant()
$identifierArgument = ConvertTo-Base64Url $trimmedIdentifier
$reasonArgument = if ([string]::IsNullOrWhiteSpace($Reason)) { "none" } else { ConvertTo-Base64Url $Reason.Trim() }
$expectedWhiteRateArgument = if ($null -eq $ExpectedWhiteRate) {
  "none"
} else {
  ([double]$ExpectedWhiteRate).ToString("R", [Globalization.CultureInfo]::InvariantCulture)
}
$remoteCommand = "cd /opt/dsp-idle-cloud/current/server && sudo -n node --input-type=module - " +
  $remoteMatchBy + " " + $identifierArgument + " " + $remoteAction + " " +
  $Apply.IsPresent.ToString().ToLowerInvariant() + " " +
  $Force.IsPresent.ToString().ToLowerInvariant() + " " + $reasonArgument + " " +
  $DeepWhiteRateAudit.IsPresent.ToString().ToLowerInvariant() + " " + $expectedWhiteRateArgument + " " +
  $CurrentOnly.IsPresent.ToString().ToLowerInvariant() + " " +
  $FullBackupVerified.IsPresent.ToString().ToLowerInvariant()

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
  "-o", "ConnectTimeout=20", "-o", "ConnectionAttempts=1",
  ($sshUser + "@" + $hostName), $remoteCommand
)) { [void]$startInfo.ArgumentList.Add($argument) }

$process = [Diagnostics.Process]::new()
$process.StartInfo = $startInfo
$scriptInput = [IO.File]::OpenRead($remoteScript)
try {
  [void]$process.Start()
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $scriptInput.CopyTo($process.StandardInput.BaseStream)
  $process.StandardInput.Close()
  $process.WaitForExit()
  $stdout = $stdoutTask.GetAwaiter().GetResult()
  $stderr = $stderrTask.GetAwaiter().GetResult()
} finally {
  $scriptInput.Dispose()
}

if ($process.ExitCode -ne 0) {
  $knownCodes = @(
    "ACCOUNT_MATCH_COUNT_", "NO_HIGH_CONFIDENCE_ANOMALY", "PRODUCTION_BASELINE_CHANGED",
    "GUARD_", "DEEP_", "EXPECTED_WHITE_RATE_", "CURRENT_ONLY_", "MATCH_MODE_", "BOOLEAN_ARGUMENT_",
    "PROTECTED_ACCOUNT_DATA_CHANGED", "CLOUD_PAYLOAD_COUNTS_CHANGED",
    "LEADERBOARD_RESTRICTION_MISMATCH", "LOGIN_CONTROL_CHANGED",
    "NORMAL_SUBMISSION_NOT_CLEARED", "NORMAL_PUBLIC_FILTER_FAILED",
    "SPEEDRUN_PUBLIC_FILTER_FAILED", "SERVICE_HEALTH_DEGRADED", "ACTIVE_API_CHANGED",
    "ADMIN_", "CURRENT_NORMAL_", "REPUBLISH_NORMAL_", "OFFLINE_REPUBLISH_"
  )
  $category = "REMOTE_ACTION"
  foreach ($code in $knownCodes) {
    if ($stderr -match [regex]::Escape($code)) { $category = $code.TrimEnd("_"); break }
  }
  if ($stderr -match "Host key verification failed") { $category = "HOST_KEY" }
  elseif ($stderr -match "Permission denied") { $category = "AUTH" }
  elseif ($stderr -match "timed out") { $category = "TIMEOUT" }
  throw ("HK_LEADERBOARD_ACTION_FAILED_" + $category)
}

try { $result = $stdout | ConvertFrom-Json -Depth 50 } catch {
  throw "HK_LEADERBOARD_ACTION_RESULT_INVALID"
}
$result | Add-Member -NotePropertyName transportVerified -NotePropertyValue $true
$result | ConvertTo-Json -Depth 50 -Compress
