[CmdletBinding()]
param(
  [string]$WorkspaceRoot = "",
  [string]$ExpectedGitSha = "",
  [string]$ExpectedCertificateSha256 = "",
  [switch]$Build
)

$ErrorActionPreference = "Stop"

function Read-ScopedEnvironment([string]$Name) {
  foreach ($scope in @("Process", "User", "Machine")) {
    $value = [Environment]::GetEnvironmentVariable($Name, $scope)
    if (-not [string]::IsNullOrWhiteSpace($value)) { return $value }
  }
  return ""
}

function Test-RestrictedAcl([string]$Path) {
  $acl = Get-Acl -LiteralPath $Path
  $broadAllow = @($acl.Access | Where-Object {
    $_.AccessControlType -eq "Allow" -and
    $_.IdentityReference.Value -match "(?i)Everyone|Authenticated Users|BUILTIN\\Users|所有人|用户"
  })
  return $broadAllow.Count -eq 0
}

function Resolve-Workspace([string]$RequestedRoot) {
  if (-not [string]::IsNullOrWhiteSpace($RequestedRoot)) {
    $candidate = Get-Item -LiteralPath $RequestedRoot -ErrorAction Stop
  } else {
    $candidate = Get-Item -LiteralPath $PWD
  }
  while ($candidate -and -not (
    (Test-Path -LiteralPath (Join-Path $candidate.FullName "package.json") -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $candidate.FullName "android\app\build.gradle") -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $candidate.FullName "scripts\verify-android-signing-env.mjs") -PathType Leaf)
  )) {
    $candidate = $candidate.Parent
  }
  if (-not $candidate) { throw "DSPIDLE_WORKSPACE_NOT_FOUND" }
  return [IO.Path]::GetFullPath($candidate.FullName)
}

function Resolve-AndroidSigningConfig {
  $registered = Read-ScopedEnvironment "DSP_ANDROID_SIGNING_CONFIG"
  if (-not [string]::IsNullOrWhiteSpace($registered)) {
    if (-not (Test-Path -LiteralPath $registered -PathType Leaf)) {
      throw "PROTECTED_ANDROID_CONFIG_REGISTERED_BUT_UNREADABLE"
    }
    return [IO.Path]::GetFullPath($registered)
  }
  $roots = [System.Collections.Generic.List[string]]::new()
  if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE) -and
      (Test-Path -LiteralPath $env:USERPROFILE -PathType Container)) {
    $roots.Add([IO.Path]::GetFullPath($env:USERPROFILE))
  }
  if (Test-Path -LiteralPath "D:\GameDev" -PathType Container) { $roots.Add("D:\GameDev") }
  $rg = Get-Command rg.exe -ErrorAction SilentlyContinue
  if (-not $rg) { throw "PROTECTED_ANDROID_CONFIG_LOCATOR_UNAVAILABLE" }
  $candidates = @(& $rg.Source --files --hidden -g "android-release-v1.properties" @($roots) 2>$null |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
    ForEach-Object { [IO.Path]::GetFullPath($_) } |
    Select-Object -Unique)
  if ($candidates.Count -eq 0) { throw "PROTECTED_ANDROID_CONFIG_UNAVAILABLE" }
  if ($candidates.Count -ne 1) { throw "PROTECTED_ANDROID_CONFIG_AMBIGUOUS" }
  return $candidates[0]
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

function Invoke-CapturedProcess(
  [string]$FileName,
  [string[]]$Arguments,
  [string]$WorkingDirectory,
  [hashtable]$Environment = @{}
) {
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $FileName
  $startInfo.WorkingDirectory = $WorkingDirectory
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  foreach ($argument in $Arguments) { [void]$startInfo.ArgumentList.Add($argument) }
  foreach ($entry in $Environment.GetEnumerator()) { $startInfo.Environment[$entry.Key] = [string]$entry.Value }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  try {
    [void]$process.Start()
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    return [pscustomobject]@{
      ExitCode = $process.ExitCode
      Stdout = $stdoutTask.GetAwaiter().GetResult()
      Stderr = $stderrTask.GetAwaiter().GetResult()
    }
  } finally {
    $process.Dispose()
  }
}

function Get-LatestBuildTools([string]$SdkRoot) {
  $root = Join-Path $SdkRoot "build-tools"
  if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw "ANDROID_BUILD_TOOLS_UNAVAILABLE" }
  $versions = @(Get-ChildItem -LiteralPath $root -Directory | Sort-Object {
    try { [version]$_.Name } catch { [version]"0.0" }
  } -Descending)
  foreach ($version in $versions) {
    $signer = Join-Path $version.FullName "lib\apksigner.jar"
    $zipalign = Join-Path $version.FullName "zipalign.exe"
    $aapt2 = Join-Path $version.FullName "aapt2.exe"
    if ((Test-Path -LiteralPath $signer -PathType Leaf) -and
        (Test-Path -LiteralPath $zipalign -PathType Leaf) -and
        (Test-Path -LiteralPath $aapt2 -PathType Leaf)) {
      return [pscustomobject]@{ Signer = $signer; Zipalign = $zipalign; Aapt2 = $aapt2 }
    }
  }
  throw "ANDROID_BUILD_TOOLS_INCOMPLETE"
}

function Normalize-Fingerprint([string]$Value) {
  return ($Value -replace "[^A-Fa-f0-9]", "").ToLowerInvariant()
}

$workspace = Resolve-Workspace $WorkspaceRoot
$configPath = Resolve-AndroidSigningConfig
$configDirectory = Split-Path -Parent $configPath
if (-not (Test-RestrictedAcl $configPath) -or -not (Test-RestrictedAcl $configDirectory)) {
  throw "PROTECTED_ANDROID_CONFIG_ACL_TOO_BROAD"
}
$properties = Read-ProtectedProperties $configPath
$required = @("keystorePath", "storePassword", "keyAlias", "keyPassword", "certificateSha256")
$missing = @($required | Where-Object { [string]::IsNullOrWhiteSpace([string]$properties[$_]) })
if ($missing.Count -gt 0) { throw "PROTECTED_ANDROID_CONFIG_INCOMPLETE" }

$keystorePath = [string]$properties["keystorePath"]
if (-not [IO.Path]::IsPathRooted($keystorePath)) { $keystorePath = Join-Path $configDirectory $keystorePath }
$keystorePath = [IO.Path]::GetFullPath($keystorePath)
if (-not (Test-Path -LiteralPath $keystorePath -PathType Leaf)) { throw "PROTECTED_ANDROID_KEYSTORE_UNREADABLE" }

$configuredFingerprint = Normalize-Fingerprint ([string]$properties["certificateSha256"])
if ($configuredFingerprint.Length -ne 64) { throw "PROTECTED_ANDROID_FINGERPRINT_INVALID" }
if (-not [string]::IsNullOrWhiteSpace($ExpectedCertificateSha256) -and
    (Normalize-Fingerprint $ExpectedCertificateSha256) -ne $configuredFingerprint) {
  throw "EXPECTED_ANDROID_CERTIFICATE_MISMATCH"
}

$java = Get-Command java.exe -ErrorAction SilentlyContinue
$keytool = Get-Command keytool.exe -ErrorAction SilentlyContinue
if (-not $java -or -not $keytool) { throw "JDK_RELEASE_TOOLS_UNAVAILABLE" }
$sdkRoot = Read-ScopedEnvironment "ANDROID_HOME"
if ([string]::IsNullOrWhiteSpace($sdkRoot)) { $sdkRoot = Join-Path $env:LOCALAPPDATA "Android\Sdk" }
$buildTools = Get-LatestBuildTools $sdkRoot

$keytoolEnvironment = @{
  DSP_KEYTOOL_STORE_PASSWORD = [string]$properties["storePassword"]
}
$keystoreCheck = Invoke-CapturedProcess $keytool.Source @(
  "-list", "-v", "-keystore", $keystorePath,
  "-alias", [string]$properties["keyAlias"],
  "-storepass:env", "DSP_KEYTOOL_STORE_PASSWORD"
) $workspace $keytoolEnvironment
if ($keystoreCheck.ExitCode -ne 0) { throw "PROTECTED_ANDROID_KEYSTORE_VERIFICATION_FAILED" }
$keystoreFingerprintMatch = [regex]::Match($keystoreCheck.Stdout + "`n" + $keystoreCheck.Stderr, "(?im)^\s*SHA256:\s*([0-9A-F:]{64,95})\s*$")
if (-not $keystoreFingerprintMatch.Success -or
    (Normalize-Fingerprint $keystoreFingerprintMatch.Groups[1].Value) -ne $configuredFingerprint) {
  throw "PROTECTED_ANDROID_CERTIFICATE_CONTINUITY_FAILED"
}

if (-not $Build) {
  [pscustomobject]@{
    ok = $true
    mode = "check-only"
    configAclRestricted = $true
    keystoreReadable = $true
    certificateContinuity = $true
    signingAttempted = $false
    productionConnectionAttempted = $false
    secretsExposed = $false
  } | ConvertTo-Json -Compress
  exit 0
}

if ($ExpectedGitSha -notmatch "^[0-9a-fA-F]{40}$") { throw "EXPECTED_GIT_SHA_REQUIRED" }
$head = (& git -C $workspace rev-parse HEAD 2>$null).Trim()
if ($LASTEXITCODE -ne 0 -or $head -ne $ExpectedGitSha.ToLowerInvariant()) { throw "ANDROID_RELEASE_GIT_SHA_MISMATCH" }
$status = @(& git -C $workspace status --porcelain=v1 --untracked-files=all 2>$null)
if ($LASTEXITCODE -ne 0 -or $status.Count -ne 0) { throw "ANDROID_RELEASE_WORKTREE_NOT_CLEAN" }

$childEnvironment = @{
  DSP_ANDROID_BUILD_PROFILE = 'official'
  DSP_ANDROID_KEYSTORE = $keystorePath
  DSP_ANDROID_KEYSTORE_PASSWORD = [string]$properties["storePassword"]
  DSP_ANDROID_KEY_ALIAS = [string]$properties["keyAlias"]
  DSP_ANDROID_KEY_PASSWORD = [string]$properties["keyPassword"]
  ANDROID_HOME = $sdkRoot
}
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) { throw "NPM_UNAVAILABLE" }
$buildResult = Invoke-CapturedProcess $npm.Source @("run", "android:release") $workspace $childEnvironment
if ($buildResult.ExitCode -ne 0) { throw "ANDROID_RELEASE_BUILD_FAILED" }

$apk = Join-Path $workspace "android\app\build\outputs\apk\release\app-release.apk"
$aab = Join-Path $workspace "android\app\build\outputs\bundle\release\app-release.aab"
if (-not (Test-Path -LiteralPath $apk -PathType Leaf) -or -not (Test-Path -LiteralPath $aab -PathType Leaf)) {
  throw "ANDROID_RELEASE_ARTIFACTS_MISSING"
}

$apkVerify = Invoke-CapturedProcess $java.Source @(
  "-jar", $buildTools.Signer, "verify", "--verbose", "--print-certs", $apk
) $workspace
if ($apkVerify.ExitCode -ne 0) { throw "ANDROID_APK_SIGNATURE_VERIFY_FAILED" }
$apkOutput = $apkVerify.Stdout + "`n" + $apkVerify.Stderr
$v2 = $apkOutput -match "(?im)Verified using v2 scheme.*:\s*true"
$v3 = $apkOutput -match "(?im)Verified using v3 scheme.*:\s*true"
$apkFingerprint = [regex]::Match($apkOutput, "(?im)Signer #1 certificate SHA-256 digest:\s*([a-f0-9]{64})")
if (-not $v2 -or -not $v3 -or -not $apkFingerprint.Success -or
    (Normalize-Fingerprint $apkFingerprint.Groups[1].Value) -ne $configuredFingerprint) {
  throw "ANDROID_APK_CERTIFICATE_CONTINUITY_FAILED"
}

$zipalignCheck = Invoke-CapturedProcess $buildTools.Zipalign @("-c", "-P", "16", "4", $apk) $workspace
if ($zipalignCheck.ExitCode -ne 0) { throw "ANDROID_APK_ZIPALIGN_FAILED" }

$badging = Invoke-CapturedProcess $buildTools.Aapt2 @("dump", "badging", $apk) $workspace
if ($badging.ExitCode -ne 0) { throw "ANDROID_APK_METADATA_FAILED" }
$packageMatch = [regex]::Match($badging.Stdout, "(?m)^package:\s+name='([^']+)'\s+versionCode='([^']+)'\s+versionName='([^']+)'")
if (-not $packageMatch.Success -or $packageMatch.Groups[1].Value -ne "cn.dsponline.network") {
  throw "ANDROID_APK_PACKAGE_METADATA_MISMATCH"
}

$aabCheck = Invoke-CapturedProcess $keytool.Source @("-printcert", "-jarfile", $aab) $workspace
if ($aabCheck.ExitCode -ne 0) { throw "ANDROID_AAB_SIGNATURE_VERIFY_FAILED" }
$aabFingerprint = [regex]::Match($aabCheck.Stdout + "`n" + $aabCheck.Stderr, "(?im)^\s*SHA256:\s*([0-9A-F:]{64,95})\s*$")
if (-not $aabFingerprint.Success -or
    (Normalize-Fingerprint $aabFingerprint.Groups[1].Value) -ne $configuredFingerprint) {
  throw "ANDROID_AAB_CERTIFICATE_CONTINUITY_FAILED"
}

$apkItem = Get-Item -LiteralPath $apk
$aabItem = Get-Item -LiteralPath $aab
[pscustomobject]@{
  ok = $true
  mode = "build"
  gitSha = $head
  packageName = $packageMatch.Groups[1].Value
  versionCode = $packageMatch.Groups[2].Value
  versionName = $packageMatch.Groups[3].Value
  apk = [ordered]@{
    name = $apkItem.Name
    size = $apkItem.Length
    sha256 = (Get-FileHash -LiteralPath $apk -Algorithm SHA256).Hash.ToLowerInvariant()
    v2 = $true
    v3 = $true
    zipalign = $true
    certificateContinuity = $true
  }
  aab = [ordered]@{
    name = $aabItem.Name
    size = $aabItem.Length
    sha256 = (Get-FileHash -LiteralPath $aab -Algorithm SHA256).Hash.ToLowerInvariant()
    certificateContinuity = $true
  }
  productionConnectionAttempted = $false
  secretsExposed = $false
} | ConvertTo-Json -Depth 6 -Compress
