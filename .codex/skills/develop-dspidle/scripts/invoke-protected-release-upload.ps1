[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('HongKong', 'Shanghai')]
  [string]$Node,

  [Parameter(Mandatory = $true)]
  [string]$ManifestPath,

  [string]$ShaSumsPath = '',

  [string]$WorkspaceRoot = (Get-Location).Path,
  [ValidateSet('Stream', 'Scp', 'Auto')]
  [string]$Transport = 'Stream',
  [string]$RemoteDirectory = '/var/tmp',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

trap {
  $message = $_.Exception.Message
  $safeError = if ($message -match '^[A-Z0-9_.-]{1,160}$') { $message } else { 'PROTECTED_RELEASE_UPLOAD_FAILED' }
  [ordered]@{ ok = $false; node = $Node; error = $safeError; secretsExposed = $false } | ConvertTo-Json -Compress
  exit 1
}

function Read-ProtectedEnvironment([string]$Name) {
  foreach ($scope in @('Process', 'User', 'Machine')) {
    $value = [Environment]::GetEnvironmentVariable($Name, $scope)
    if (-not [string]::IsNullOrWhiteSpace($value)) { return $value }
  }
  return ''
}

function Test-PathWithin([string]$Root, [string]$Candidate) {
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
  $candidateFull = [IO.Path]::GetFullPath($Candidate)
  return $candidateFull.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)
}

function Invoke-LocalReleasePreflight([string]$Root, [string]$Manifest, [string]$Sums) {
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $node) { throw 'LOCAL_NODE_UNAVAILABLE_FOR_PREFLIGHT' }
  $preflight = Join-Path $Root 'scripts\release-preflight.mjs'
  if (-not (Test-Path -LiteralPath $preflight -PathType Leaf)) { throw 'LOCAL_RELEASE_PREFLIGHT_UNAVAILABLE' }
  & $node.Source $preflight --manifest $Manifest --sha-sums $Sums --workspace $Root --require-artifacts web,api *> $null
  if ($LASTEXITCODE -ne 0) { throw 'LOCAL_RELEASE_PREFLIGHT_FAILED' }
}

function Resolve-PhysicalBindAddress([string]$ConfiguredAddress) {
  $assigned = @(Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.AddressState -eq 'Preferred' } |
    ForEach-Object { $_.IPAddress })
  if (-not [string]::IsNullOrWhiteSpace($ConfiguredAddress)) {
    if ($ConfiguredAddress -notin $assigned) { throw 'CONFIGURED_PHYSICAL_EGRESS_UNAVAILABLE' }
    return $ConfiguredAddress
  }
  $physical = @(Get-NetIPConfiguration | Where-Object {
    $_.NetAdapter.Status -eq 'Up' -and $_.IPv4DefaultGateway -and $_.IPv4Address -and
    $_.InterfaceAlias -notmatch '(?i)vpn|tun|tap|wireguard|wintun|clash|v2ray|tailscale|zerotier'
  })
  $preferred = @($physical | Where-Object { $_.InterfaceAlias -match '(?i)ethernet|wi-?fi|wlan|以太网|无线' })
  $selected = if ($preferred.Count -gt 0) { $preferred[0] } elseif ($physical.Count -gt 0) { $physical[0] } else { $null }
  if (-not $selected) { throw 'PHYSICAL_EGRESS_UNAVAILABLE' }
  return @($selected.IPv4Address)[0].IPAddress
}

function New-TransportContext([string]$TargetNode) {
  $prefix = if ($TargetNode -eq 'HongKong') { 'DSP_HK' } else { 'DSP_SH' }
  $hostName = Read-ProtectedEnvironment "${prefix}_HOST"
  $user = Read-ProtectedEnvironment "${prefix}_SSH_USER"
  $key = Read-ProtectedEnvironment "${prefix}_SSH_KEY_PATH"
  $knownHosts = Read-ProtectedEnvironment "${prefix}_KNOWN_HOSTS"
  $port = Read-ProtectedEnvironment "${prefix}_SSH_PORT"
  $configuredBind = Read-ProtectedEnvironment "${prefix}_BIND_ADDRESS"
  if ([string]::IsNullOrWhiteSpace($port)) { $port = '22' }
  if ([string]::IsNullOrWhiteSpace($hostName) -or [string]::IsNullOrWhiteSpace($user) -or [string]::IsNullOrWhiteSpace($key) -or [string]::IsNullOrWhiteSpace($knownHosts)) { throw 'PROTECTED_SSH_TRANSPORT_INCOMPLETE' }
  if (-not (Test-Path -LiteralPath $key -PathType Leaf) -or -not (Test-Path -LiteralPath $knownHosts -PathType Leaf)) { throw 'PROTECTED_SSH_TRANSPORT_PATH_UNAVAILABLE' }
  & ssh-keygen.exe -F $hostName -f $knownHosts *> $null
  $hostKeyOk = $LASTEXITCODE -eq 0
  if (-not $hostKeyOk) { & ssh-keygen.exe -F ("[" + $hostName + "]:" + $port) -f $knownHosts *> $null; $hostKeyOk = $LASTEXITCODE -eq 0 }
  if (-not $hostKeyOk) { throw 'STRICT_HOST_KEY_ENTRY_MISSING' }
  [pscustomobject]@{ Host = $hostName; User = $user; Key = $key; KnownHosts = $knownHosts; Port = $port; Bind = (Resolve-PhysicalBindAddress $configuredBind) }
}

function Invoke-RemoteProcess($Context, [string]$Command, [string]$InputPath = '') {
  $ssh = Get-Command ssh.exe -ErrorAction SilentlyContinue
  if (-not $ssh) { throw 'OPENSSH_CLIENT_UNAVAILABLE' }
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $ssh.Source
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  foreach ($arg in @('-T', '-b', $Context.Bind, '-p', $Context.Port, '-i', $Context.Key, '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', '-o', ('UserKnownHostsFile=' + $Context.KnownHosts), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'ConnectionAttempts=1', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', ("$($Context.User)@$($Context.Host)"), $Command)) { [void]$start.ArgumentList.Add($arg) }
  $process = [Diagnostics.Process]::new(); $process.StartInfo = $start
  try {
    [void]$process.Start()
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    if ($InputPath) {
      $source = [IO.File]::OpenRead($InputPath)
      try { $source.CopyTo($process.StandardInput.BaseStream); $process.StandardInput.Close() } finally { $source.Dispose() }
    } else { $process.StandardInput.Close() }
    $process.WaitForExit()
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    [pscustomobject]@{ ExitCode = $process.ExitCode; Stdout = $stdout; Stderr = $stderr }
  } finally { $process.Dispose() }
}

function Invoke-SshUpload($Context, [string]$LocalPath, [string]$RemoteTemp) {
  $result = Invoke-RemoteProcess $Context "umask 077; cat > $RemoteTemp" $LocalPath
  if ($result.ExitCode -ne 0) {
    $category = if ($result.Stderr -match '(?i)permission denied') { 'AUTH_OR_PERMISSION' } elseif ($result.Stderr -match '(?i)host key|known_hosts') { 'HOST_KEY' } elseif ($result.Stderr -match '(?i)timeout|no route|connection') { 'CONNECTIVITY' } else { 'REMOTE_TRANSFER' }
    throw "PROTECTED_SSH_STREAM_FAILED_$category"
  }
}

function Invoke-ScpUpload($Context, [string]$LocalPath, [string]$RemoteTemp) {
  $scp = Get-Command scp.exe -ErrorAction SilentlyContinue
  if (-not $scp) { throw 'OPENSSH_SCP_UNAVAILABLE' }
  $start = [Diagnostics.ProcessStartInfo]::new(); $start.FileName = $scp.Source; $start.UseShellExecute = $false; $start.CreateNoWindow = $true; $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
  foreach ($arg in @('-q', '-O', '-p', '-P', $Context.Port, '-i', $Context.Key, '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', '-o', ('UserKnownHostsFile=' + $Context.KnownHosts), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'ConnectionAttempts=1', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', $LocalPath, ("$($Context.User)@$($Context.Host):$RemoteTemp"))) { [void]$start.ArgumentList.Add($arg) }
  $process = [Diagnostics.Process]::new(); $process.StartInfo = $start
  try { [void]$process.Start(); $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync(); $process.WaitForExit(); $code = $process.ExitCode; [void]$stdout.GetAwaiter().GetResult(); $errText = $stderr.GetAwaiter().GetResult() } finally { $process.Dispose() }
  if ($code -ne 0) {
    $category = if ($errText -match '(?i)permission denied') { 'AUTH_OR_PERMISSION' } elseif ($errText -match '(?i)host key|known_hosts') { 'HOST_KEY' } elseif ($errText -match '(?i)timeout|no route|connection|closed') { 'CONNECTIVITY' } else { 'REMOTE_TRANSFER' }
    throw "PROTECTED_SCP_UPLOAD_FAILED_$category"
  }
}

function Remove-RemoteExact($Context, [string]$RemotePath) {
  try { [void](Invoke-RemoteProcess $Context "rm -f -- $RemotePath") } catch { }
}

function Promote-RemoteFile($Context, [string]$RemoteTemp, [string]$RemoteFinal, [long]$ExpectedSize, [string]$ExpectedHash) {
  $command = @'
set -eu
test -f '__TEMP__'
size=$(stat -c '%s' '__TEMP__')
hash=$(sha256sum '__TEMP__' | awk '{print $1}')
test "$size" = '__SIZE__'
test "$hash" = '__HASH__'
if test -e '__FINAL__'; then
  old=$(sha256sum '__FINAL__' | awk '{print $1}')
  test "$old" = '__HASH__'
  rm -f -- '__TEMP__'
else
  mv -- '__TEMP__' '__FINAL__'
fi
printf 'verified size=%s sha256=%s\n' "$size" "$hash"
'@
  $command = $command.Replace('__TEMP__', $RemoteTemp).Replace('__FINAL__', $RemoteFinal).Replace('__SIZE__', [string]$ExpectedSize).Replace('__HASH__', $ExpectedHash)
  $result = Invoke-RemoteProcess $Context $command
  if ($result.ExitCode -ne 0) { throw 'REMOTE_UPLOAD_HASH_OR_PROMOTION_FAILED' }
  return $result.Stdout.Trim()
}

function Resolve-ManifestArtifact($Manifest, [string]$Kind) {
  $matches = @($Manifest.files | Where-Object { ([IO.Path]::GetFileName($_.path)).EndsWith("-$Kind.tar.gz") })
  if ($matches.Count -ne 1) { throw "MANIFEST_$Kind_ARCHIVE_MISSING_OR_AMBIGUOUS" }
  return $matches[0]
}

$workspace = [IO.Path]::GetFullPath($WorkspaceRoot)
$manifestFull = [IO.Path]::GetFullPath($ManifestPath)
if (-not (Test-PathWithin $workspace $manifestFull)) { throw 'MANIFEST_OUTSIDE_WORKSPACE' }
$sumsFull = if ([string]::IsNullOrWhiteSpace($ShaSumsPath)) {
  $manifestFull -replace '-candidate\.json$', '-SHA256SUMS.txt'
} else { [IO.Path]::GetFullPath($ShaSumsPath) }
if (-not (Test-PathWithin $workspace $sumsFull) -or -not (Test-Path -LiteralPath $sumsFull -PathType Leaf)) { throw 'SHA256SUMS_PATH_INVALID' }
Invoke-LocalReleasePreflight $workspace $manifestFull $sumsFull
$manifest = Get-Content -LiteralPath $manifestFull -Raw | ConvertFrom-Json
if ($manifest.git.clean -ne $true -or $manifest.releaseId -notmatch '^\d+\.\d+\.\d+-[0-9a-f]{12}$') { throw 'MANIFEST_RELEASE_GATE_FAILED' }
$actualSha = (& git -C $workspace rev-parse HEAD).Trim(); if ($actualSha -ne $manifest.git.sha) { throw 'MANIFEST_GIT_SHA_MISMATCH' }
if ((& git -C $workspace status --porcelain).Trim()) { throw 'WORKTREE_DIRTY' }
if ($RemoteDirectory -notmatch '^/var/tmp(?:/[A-Za-z0-9._+-]+)?$') { throw 'REMOTE_DIRECTORY_UNSAFE' }
$context = New-TransportContext $Node
$artifacts = @((Resolve-ManifestArtifact $manifest 'web'), (Resolve-ManifestArtifact $manifest 'api'))
$results = @()
foreach ($artifact in $artifacts) {
  $relative = $artifact.path.Replace('/', [IO.Path]::DirectorySeparatorChar)
  $local = [IO.Path]::GetFullPath((Join-Path $workspace $relative))
  if (-not (Test-PathWithin $workspace $local) -or -not (Test-Path -LiteralPath $local -PathType Leaf)) { throw 'LOCAL_ARTIFACT_PATH_INVALID' }
  $hash = (Get-FileHash -LiteralPath $local -Algorithm SHA256).Hash.ToLowerInvariant(); $size = (Get-Item -LiteralPath $local).Length
  if ($hash -ne $artifact.sha256 -or $size -ne [long]$artifact.size) { throw 'LOCAL_ARTIFACT_HASH_MISMATCH' }
  $name = [IO.Path]::GetFileName($artifact.path)
  if ($name -notmatch '^[A-Za-z0-9._+-]+$') { throw 'ARTIFACT_NAME_UNSAFE' }
  $remoteFinal = "$RemoteDirectory/dsp-idle-upload-$($manifest.releaseId)-$name"
  $remoteTemp = "$remoteFinal.part-$([Guid]::NewGuid().ToString('N'))"
  if ($DryRun) { $results += [pscustomobject]@{ name = $name; size = $size; sha256 = $hash; transport = 'not-run' }; continue }
  $used = $Transport
  try {
    if ($Transport -eq 'Scp' -or $Transport -eq 'Auto') { Invoke-ScpUpload $context $local $remoteTemp; $used = 'scp' }
    else { throw 'FORCE_STREAM' }
  } catch {
    if ($Transport -eq 'Scp') { Remove-RemoteExact $context $remoteTemp; throw }
    Remove-RemoteExact $context $remoteTemp
    Invoke-SshUpload $context $local $remoteTemp
    $used = 'ssh-stream'
  }
  $verification = Promote-RemoteFile $context $remoteTemp $remoteFinal $size $hash
  $results += [pscustomobject]@{ name = $name; size = $size; sha256 = $hash; transport = $used; verification = $verification }
}
Write-Output (([pscustomobject]@{ ok = $true; node = $Node; releaseId = $manifest.releaseId; artifacts = $results }) | ConvertTo-Json -Compress)
