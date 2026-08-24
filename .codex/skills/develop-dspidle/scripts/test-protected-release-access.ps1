[CmdletBinding()]
param(
  [ValidateSet("All", "Android", "HongKong", "Shanghai")]
  [string]$Capability = "All"
)

$ErrorActionPreference = "Stop"

function Read-ScopedEnvironment([string]$Name) {
  foreach ($scope in @("Process", "User", "Machine")) {
    $value = [Environment]::GetEnvironmentVariable($Name, $scope)
    if (-not [string]::IsNullOrWhiteSpace($value)) {
      return [pscustomobject]@{ Value = $value; Scope = $scope }
    }
  }
  return [pscustomobject]@{ Value = ""; Scope = "" }
}

function Test-RestrictedAcl([string]$Path) {
  try {
    $acl = Get-Acl -LiteralPath $Path
    $broadAllow = @($acl.Access | Where-Object {
      $_.AccessControlType -eq "Allow" -and
      $_.IdentityReference.Value -match "(?i)Everyone|Authenticated Users|BUILTIN\\Users|所有人|用户"
    })
    return $broadAllow.Count -eq 0
  } catch {
    return $false
  }
}

function Read-PropertyNames([string]$Path) {
  $names = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  foreach ($line in [IO.File]::ReadLines($Path)) {
    if ([string]::IsNullOrWhiteSpace($line) -or $line -match "^\s*[#!]") { continue }
    if ($line -match "^\s*([^:=\s]+)\s*[:=]") { [void]$names.Add($matches[1]) }
  }
  return @($names)
}

function Read-ProtectedProperties([string]$Path) {
  $properties = @{}
  foreach ($line in [IO.File]::ReadLines($Path)) {
    if ([string]::IsNullOrWhiteSpace($line) -or $line -match "^\s*[#!]") { continue }
    if ($line -match "^\s*([^:=\s]+)\s*[:=]\s*(.*)$") {
      $properties[$matches[1]] = $matches[2]
    }
  }
  return $properties
}

function Resolve-AndroidSigningConfig {
  $registered = Read-ScopedEnvironment "DSP_ANDROID_SIGNING_CONFIG"
  if (-not [string]::IsNullOrWhiteSpace($registered.Value)) {
    if (-not (Test-Path -LiteralPath $registered.Value -PathType Leaf)) {
      throw "PROTECTED_ANDROID_CONFIG_REGISTERED_BUT_UNREADABLE"
    }
    return [pscustomobject]@{ Path = [IO.Path]::GetFullPath($registered.Value); Source = "registered-locator" }
  }

  $searchRoots = [System.Collections.Generic.List[string]]::new()
  if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE) -and
      (Test-Path -LiteralPath $env:USERPROFILE -PathType Container)) {
    $searchRoots.Add([IO.Path]::GetFullPath($env:USERPROFILE))
  }
  if (Test-Path -LiteralPath "D:\GameDev" -PathType Container) {
    $searchRoots.Add("D:\GameDev")
  }

  $candidates = @()
  $rg = Get-Command rg.exe -ErrorAction SilentlyContinue
  if ($rg -and $searchRoots.Count -gt 0) {
    $candidates = @(& $rg.Source --files --hidden -g "android-release-v1.properties" @($searchRoots) 2>$null |
      Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
      ForEach-Object { [IO.Path]::GetFullPath($_) } |
      Select-Object -Unique)
  }
  if ($candidates.Count -eq 0) { throw "PROTECTED_ANDROID_CONFIG_UNAVAILABLE" }
  if ($candidates.Count -ne 1) { throw "PROTECTED_ANDROID_CONFIG_AMBIGUOUS" }
  return [pscustomobject]@{ Path = $candidates[0]; Source = "unique-protected-vault" }
}

function Get-AndroidCapability {
  try {
    $resolved = Resolve-AndroidSigningConfig
    $required = @("keystorePath", "storePassword", "keyAlias", "keyPassword", "certificateSha256")
    $propertyNames = @(Read-PropertyNames $resolved.Path)
    $missing = @($required | Where-Object { $_ -notin $propertyNames })
    $properties = Read-ProtectedProperties $resolved.Path
    $keystorePath = [string]$properties["keystorePath"]
    if (-not [IO.Path]::IsPathRooted($keystorePath)) {
      $keystorePath = Join-Path (Split-Path -Parent $resolved.Path) $keystorePath
    }
    $fingerprint = ([string]$properties["certificateSha256"]) -replace "[^A-Fa-f0-9]", ""
    $directory = Split-Path -Parent $resolved.Path
    $ready = $missing.Count -eq 0 -and
      (Test-Path -LiteralPath $keystorePath -PathType Leaf) -and
      (Test-RestrictedAcl $resolved.Path) -and
      (Test-RestrictedAcl $directory) -and
      $fingerprint.Length -eq 64
    return [ordered]@{
      status = if ($ready) { "ready" } else { "blocked" }
      source = $resolved.Source
      configReadable = $true
      configAclRestricted = Test-RestrictedAcl $resolved.Path
      directoryAclRestricted = Test-RestrictedAcl $directory
      keystoreReadable = Test-Path -LiteralPath $keystorePath -PathType Leaf
      requiredFieldsComplete = $missing.Count -eq 0
      approvedFingerprintConfigured = $fingerprint.Length -eq 64
      requiredProcessVariables = @(
        "DSP_ANDROID_KEYSTORE",
        "DSP_ANDROID_KEYSTORE_PASSWORD",
        "DSP_ANDROID_KEY_ALIAS",
        "DSP_ANDROID_KEY_PASSWORD"
      )
      secretValuesReturned = $false
    }
  } catch {
    return [ordered]@{
      status = "blocked"
      reason = $_.Exception.Message
      requiredProcessVariables = @(
        "DSP_ANDROID_KEYSTORE",
        "DSP_ANDROID_KEYSTORE_PASSWORD",
        "DSP_ANDROID_KEY_ALIAS",
        "DSP_ANDROID_KEY_PASSWORD"
      )
      secretValuesReturned = $false
    }
  }
}

function Get-SshCapability([ValidateSet("HK", "SH")][string]$Node) {
  $prefix = if ($Node -eq "HK") { "DSP_HK" } else { "DSP_SH" }
  $requiredNames = @(
    "${prefix}_HOST",
    "${prefix}_SSH_USER",
    "${prefix}_SSH_KEY_PATH",
    "${prefix}_KNOWN_HOSTS"
  )
  $optionalNames = @("${prefix}_SSH_PORT", "${prefix}_BIND_ADDRESS")
  $values = @{}
  $scopes = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  foreach ($name in $requiredNames + $optionalNames) {
    $entry = Read-ScopedEnvironment $name
    $values[$name] = $entry.Value
    if (-not [string]::IsNullOrWhiteSpace($entry.Scope)) { [void]$scopes.Add($entry.Scope) }
  }
  $missing = @($requiredNames | Where-Object { [string]::IsNullOrWhiteSpace([string]$values[$_]) })
  $keyReadable = $false
  $knownHostsReadable = $false
  $hostKeyRecorded = $false
  if ($missing.Count -eq 0) {
    $keyReadable = Test-Path -LiteralPath ([string]$values["${prefix}_SSH_KEY_PATH"]) -PathType Leaf
    $knownHostsPath = [string]$values["${prefix}_KNOWN_HOSTS"]
    $knownHostsReadable = Test-Path -LiteralPath $knownHostsPath -PathType Leaf
    if ($knownHostsReadable) {
      $targetHost = [string]$values["${prefix}_HOST"]
      $port = [string]$values["${prefix}_SSH_PORT"]
      if ([string]::IsNullOrWhiteSpace($port)) { $port = "22" }
      & ssh-keygen.exe -F $targetHost -f $knownHostsPath *> $null
      $hostKeyRecorded = $LASTEXITCODE -eq 0
      if (-not $hostKeyRecorded) {
        & ssh-keygen.exe -F ("[" + $targetHost + "]:" + $port) -f $knownHostsPath *> $null
        $hostKeyRecorded = $LASTEXITCODE -eq 0
      }
    }
  }
  $taskHelper = if ($Node -eq "HK") {
    Test-Path -LiteralPath (Join-Path $PSScriptRoot "export-hk-cloud-save.ps1") -PathType Leaf
  } else {
    $false
  }
  $ready = $missing.Count -eq 0 -and $keyReadable -and $knownHostsReadable -and $hostKeyRecorded
  return [ordered]@{
    status = if ($ready) { "ready" } elseif ($taskHelper) { "task-helper-managed" } else { "blocked" }
    protectedEnvironmentComplete = $missing.Count -eq 0
    keyReadable = $keyReadable
    knownHostsReadable = $knownHostsReadable
    strictHostKeyEntryPresent = $hostKeyRecorded
    configuredScopes = @($scopes)
    taskSpecificHelperAvailable = $taskHelper
    requiredVariables = $requiredNames
    optionalVariables = $optionalNames
    secretValuesReturned = $false
  }
}

$result = [ordered]@{
  schemaVersion = 1
  checkOnly = $true
  productionConnectionAttempted = $false
  signingAttempted = $false
  secretValuesReturned = $false
}
if ($Capability -in @("All", "Android")) { $result.androidSigning = Get-AndroidCapability }
if ($Capability -in @("All", "HongKong")) { $result.hongKongSsh = Get-SshCapability "HK" }
if ($Capability -in @("All", "Shanghai")) { $result.shanghaiSsh = Get-SshCapability "SH" }

[pscustomobject]$result | ConvertTo-Json -Depth 8 -Compress
