[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("HongKong", "Shanghai")]
  [string]$Node,

  [string]$ScriptPath = "",

  [ValidateSet("ReadOnly", "Mutating")]
  [string]$Mode = "ReadOnly",

  [switch]$Run,
  [switch]$MutationAuthorized,
  [switch]$Sudo,
  [string]$ExpectedReleaseId = ""
)

$ErrorActionPreference = "Stop"

function Read-ScopedEnvironment([string]$Name) {
  foreach ($scope in @("Process", "User", "Machine")) {
    $value = [Environment]::GetEnvironmentVariable($Name, $scope)
    if (-not [string]::IsNullOrWhiteSpace($value)) { return $value }
  }
  return ""
}

function Resolve-PhysicalBindAddress([string]$ConfiguredAddress) {
  $assigned = @(Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.AddressState -eq "Preferred" } |
    ForEach-Object { $_.IPAddress })
  if (-not [string]::IsNullOrWhiteSpace($ConfiguredAddress)) {
    if ($ConfiguredAddress -notin $assigned) { throw "CONFIGURED_PHYSICAL_EGRESS_UNAVAILABLE" }
    return $ConfiguredAddress
  }
  $physical = @(Get-NetIPConfiguration | Where-Object {
    $_.NetAdapter.Status -eq "Up" -and $_.IPv4DefaultGateway -and $_.IPv4Address -and
    $_.InterfaceAlias -notmatch "(?i)vpn|tun|tap|wireguard|wintun|clash|v2ray|tailscale|zerotier"
  })
  $preferred = @($physical | Where-Object {
    $_.InterfaceAlias -match "(?i)ethernet|wi-?fi|wlan|以太网|无线"
  })
  $selected = if ($preferred.Count -gt 0) { $preferred[0] }
    elseif ($physical.Count -gt 0) { $physical[0] }
    else { $null }
  if (-not $selected) { throw "PHYSICAL_EGRESS_UNAVAILABLE" }
  return @($selected.IPv4Address)[0].IPAddress
}

$prefix = if ($Node -eq "HongKong") { "DSP_HK" } else { "DSP_SH" }
$targetHost = Read-ScopedEnvironment "${prefix}_HOST"
$sshUser = Read-ScopedEnvironment "${prefix}_SSH_USER"
$keyPath = Read-ScopedEnvironment "${prefix}_SSH_KEY_PATH"
$knownHosts = Read-ScopedEnvironment "${prefix}_KNOWN_HOSTS"
$port = Read-ScopedEnvironment "${prefix}_SSH_PORT"
$configuredBindAddress = Read-ScopedEnvironment "${prefix}_BIND_ADDRESS"
if ([string]::IsNullOrWhiteSpace($port)) { $port = "22" }

if ([string]::IsNullOrWhiteSpace($targetHost) -or
    [string]::IsNullOrWhiteSpace($sshUser) -or
    [string]::IsNullOrWhiteSpace($keyPath) -or
    [string]::IsNullOrWhiteSpace($knownHosts)) {
  throw "PROTECTED_SSH_TRANSPORT_INCOMPLETE"
}
if (-not (Test-Path -LiteralPath $keyPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $knownHosts -PathType Leaf)) {
  throw "PROTECTED_SSH_TRANSPORT_PATH_UNAVAILABLE"
}
if ($port -notmatch "^[0-9]{1,5}$" -or [int]$port -lt 1 -or [int]$port -gt 65535) {
  throw "PROTECTED_SSH_PORT_INVALID"
}

& ssh-keygen.exe -F $targetHost -f $knownHosts *> $null
$hostKeyRecorded = $LASTEXITCODE -eq 0
if (-not $hostKeyRecorded) {
  & ssh-keygen.exe -F ("[" + $targetHost + "]:" + $port) -f $knownHosts *> $null
  $hostKeyRecorded = $LASTEXITCODE -eq 0
}
if (-not $hostKeyRecorded) { throw "STRICT_HOST_KEY_ENTRY_MISSING" }
$bindAddress = Resolve-PhysicalBindAddress $configuredBindAddress

if (-not $Run) {
  [pscustomobject]@{
    ok = $true
    mode = "check-only"
    node = $Node
    transportComplete = $true
    keyReadable = $true
    strictHostKeyEntryPresent = $true
    physicalEgressAvailable = $true
    productionConnectionAttempted = $false
    secretsExposed = $false
  } | ConvertTo-Json -Compress
  exit 0
}

if ([string]::IsNullOrWhiteSpace($ScriptPath) -or
    -not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) {
  throw "LOCAL_REMOTE_SCRIPT_REQUIRED"
}
if ($Mode -eq "Mutating") {
  if (-not $MutationAuthorized) { throw "MUTATING_SSH_REQUIRES_EXPLICIT_AUTHORIZATION" }
  if ($ExpectedReleaseId -notmatch "^[0-9]+\.[0-9]+\.[0-9]+-[0-9a-f]{12}$") {
    throw "MUTATING_SSH_REQUIRES_RELEASE_ID"
  }
} elseif ($MutationAuthorized) {
  throw "MUTATION_AUTHORIZATION_WITH_READ_ONLY_MODE"
}

$scriptText = [IO.File]::ReadAllText([IO.Path]::GetFullPath($ScriptPath))
if ($scriptText.IndexOf([char]0) -ge 0) { throw "REMOTE_SCRIPT_CONTAINS_NUL" }
$scriptText = $scriptText.Replace("`r`n", "`n").Replace("`r", "`n")
if (-not $scriptText.EndsWith("`n")) { $scriptText += "`n" }

$remoteCommand = if ($Sudo) { "sudo -n bash -s --" } else { "bash -s --" }
$ssh = Get-Command ssh.exe -ErrorAction SilentlyContinue
if (-not $ssh) { throw "OPENSSH_CLIENT_UNAVAILABLE" }
$startInfo = [Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $ssh.Source
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
  ($sshUser + "@" + $targetHost), $remoteCommand
)) { [void]$startInfo.ArgumentList.Add($argument) }

$process = [Diagnostics.Process]::new()
$process.StartInfo = $startInfo
try {
  [void]$process.Start()
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $process.StandardInput.Write($scriptText)
  $process.StandardInput.Close()
  $process.WaitForExit()
  $exitCode = $process.ExitCode
  $stdout = $stdoutTask.GetAwaiter().GetResult()
  $stderr = $stderrTask.GetAwaiter().GetResult()
} finally {
  $process.Dispose()
}

if ($exitCode -ne 0) {
  $category = if ($stderr -match "Host key verification failed") { "HOST_KEY" }
    elseif ($stderr -match "Permission denied") { "AUTH" }
    elseif ($stderr -match "timed out|Connection timed out") { "TIMEOUT" }
    elseif ($stderr -match "sudo:.*password|not allowed to run sudo") { "SUDO" }
    else { "REMOTE_SCRIPT" }
  throw ("PROTECTED_SSH_EXECUTION_FAILED_" + $category)
}

# The streamed script is responsible for emitting privacy-safe output only.
# stderr is intentionally discarded on success so SSH transport metadata cannot leak.
Write-Output $stdout.TrimEnd()
