# TEST_ONLY. Never use this script on a developer or player's Windows machine.
# It creates and removes its own short-lived certificate on a disposable runner.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows' -or $env:GITHUB_REPOSITORY -ne 'snowsnow0926/DSPONLINE') {
    throw 'CATALOG_TEST_CI_ONLY: disposable GitHub-hosted Windows runner required.'
}
if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP) -or -not (Test-Path -LiteralPath $env:RUNNER_TEMP -PathType Container)) {
    throw 'CATALOG_TEST_CI_ONLY: existing runner-owned temporary root required.'
}
[Diagnostics.Process]::GetCurrentProcess().PriorityClass = 'BelowNormal'
$taskRepo = Split-Path -Parent $PSScriptRoot
$taskEvidence = Join-Path $taskRepo 'artifacts/native-windows-validation/catalog-authentication'
if (Test-Path -LiteralPath $taskEvidence) { throw 'Fresh catalog evidence directory required.' }
$taskSdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/bin'
$taskSdk = Get-ChildItem -LiteralPath $taskSdkRoot -Directory | Where-Object { $_.Name -match '^10\.0\.\d+\.0$' -and (Test-Path -LiteralPath (Join-Path $_.FullName 'x64/makecat.exe')) -and (Test-Path -LiteralPath (Join-Path $_.FullName 'x64/signtool.exe')) } | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
if (-not $taskSdk) { throw 'Runner Windows SDK catalog tools unavailable.' }
$taskMakeCat = Join-Path $taskSdk.FullName 'x64/makecat.exe'
$taskSignTool = Join-Path $taskSdk.FullName 'x64/signtool.exe'
$taskCertUtil = Join-Path $env:SystemRoot 'System32/certutil.exe'
$taskTempBase = [IO.Path]::GetFullPath($env:RUNNER_TEMP)
$taskFixture = Join-Path $taskTempBase ('dsp-catalog-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskEvidence | Out-Null
New-Item -ItemType Directory -Path $taskFixture | Out-Null
$taskReport = [ordered]@{ status = 'FAILED'; evidenceClass = 'TEST_ONLY'; authorityEligible = $false; sourceSha = (git -C $taskRepo rev-parse HEAD); sdkVersion = $taskSdk.Name; steps = @(); fixtures = @{}; cleanup = @{} }
$taskCertificate = $null
$taskThumbprint = $null
$taskKeyName = $null
$taskKeyProvider = $null
$taskFailure = $null
$taskPriorRoot = $env:DSP_CATALOG_TEST_ROOT
$taskPriorPin = $env:DSP_CATALOG_TEST_PUBLISHER_SHA256

function Invoke-CatalogTestProcess([string]$Name, [string]$Program, [string[]]$Arguments, [string]$Directory) {
    $taskStart = [Diagnostics.ProcessStartInfo]::new()
    $taskStart.FileName = $Program
    $taskStart.WorkingDirectory = $Directory
    $taskStart.UseShellExecute = $false
    $taskStart.CreateNoWindow = $true
    $taskStart.RedirectStandardOutput = $true
    $taskStart.RedirectStandardError = $true
    foreach ($taskArgument in $Arguments) { $taskStart.ArgumentList.Add($taskArgument) }
    $taskChild = [Diagnostics.Process]::Start($taskStart)
    try {
        $taskChild.PriorityClass = 'BelowNormal'
        $taskOut = $taskChild.StandardOutput.ReadToEndAsync()
        $taskErr = $taskChild.StandardError.ReadToEndAsync()
        if (-not $taskChild.WaitForExit(180000)) { $taskChild.Kill($true); $taskChild.WaitForExit(); throw "Catalog subprocess deadline: $Name" }
        $taskText = $taskOut.GetAwaiter().GetResult() + "`n" + $taskErr.GetAwaiter().GetResult()
        [IO.File]::WriteAllText((Join-Path $taskEvidence ($Name + '.log')), $taskText)
        $taskReport.steps += @{ name = $Name; exitCode = $taskChild.ExitCode }
        if ($taskChild.ExitCode -ne 0) { throw "Catalog subprocess failed: $Name" }
        if ($Name.StartsWith('rust-') -and $taskText -notmatch 'test result: ok\. 1 passed; 0 failed; 0 ignored;') { throw "Exact Rust fixture did not execute: $Name" }
        return $taskText
    } finally {
        if (-not $taskChild.HasExited) { $taskChild.Kill($true); $taskChild.WaitForExit() }
        $taskChild.Dispose()
    }
}

function Invoke-SignedCatalogRustCase([string]$Name, [string]$Test) {
    $taskArgs = @('test', '--release', '--manifest-path', 'native/Cargo.toml', '--locked', '-p', 'dsp-native-host', '--lib', ('qualification_catalog::windows::tests::' + $Test), '--', '--exact', '--ignored', '--nocapture', '--test-threads=1')
    return Invoke-CatalogTestProcess $Name (Get-Command cargo.exe -ErrorAction Stop).Source $taskArgs $taskRepo
}

try {
    $taskCertificate = New-SelfSignedCertificate -Type CodeSigningCert -Subject ('CN=DSP-Catalog-TEST-ONLY-' + [Guid]::NewGuid().ToString('N')) -CertStoreLocation 'Cert:\CurrentUser\My' -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyExportPolicy NonExportable -Provider 'Microsoft Software Key Storage Provider' -NotBefore (Get-Date).AddMinutes(-5) -NotAfter (Get-Date).AddDays(1)
    $taskThumbprint = $taskCertificate.Thumbprint
    if ($taskThumbprint -notmatch '^[A-Fa-f0-9]{40}$') { throw 'Unexpected test certificate identity.' }
    $taskRsa = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($taskCertificate)
    try { $taskKeyName = $taskRsa.Key.KeyName; $taskKeyProvider = $taskRsa.Key.Provider } finally { $taskRsa.Dispose() }
    $taskPin = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($taskCertificate.RawData)).ToLowerInvariant()
    $taskReport.publisherCertificateSha256 = $taskPin
    $taskPublicCertificate = Join-Path $taskFixture 'publisher.cer'
    [IO.File]::WriteAllBytes($taskPublicCertificate, $taskCertificate.RawData)
    foreach ($taskCase in @('valid', 'unrelated')) {
        $taskCarrier = Join-Path $taskFixture ($taskCase + '/native-qualification')
        New-Item -ItemType Directory -Path $taskCarrier | Out-Null
        $taskBody = if ($taskCase -eq 'valid') { '{"kind":"dsp-catalog-TEST_ONLY","version":1}' } else { '{"kind":"unrelated-TEST_ONLY","version":1}' }
        [IO.File]::WriteAllText((Join-Path $taskCarrier 'qualification.json'), $taskBody, [Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText((Join-Path $taskCarrier 'fixture.cdf'), "[CatalogHeader]`nName=qualification.cat`nCatalogVersion=2`nHashAlgorithms=SHA256`n[CatalogFiles]`n<HASH>qualification.json=qualification.json`n", [Text.UTF8Encoding]::new($false))
        Invoke-CatalogTestProcess ('makecat-' + $taskCase) $taskMakeCat @('-r', 'fixture.cdf') $taskCarrier | Out-Null
        Invoke-CatalogTestProcess ('sign-' + $taskCase) $taskSignTool @('sign', '/fd', 'SHA256', '/sha1', $taskThumbprint, '/s', 'My', 'qualification.cat') $taskCarrier | Out-Null
        $taskReport.fixtures[$taskCase] = @{
            memberSha256 = (Get-FileHash -LiteralPath (Join-Path $taskCarrier 'qualification.json') -Algorithm SHA256).Hash.ToLowerInvariant()
            catalogSha256 = (Get-FileHash -LiteralPath (Join-Path $taskCarrier 'qualification.cat') -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }
    $env:DSP_CATALOG_TEST_ROOT = $taskFixture
    $env:DSP_CATALOG_TEST_PUBLISHER_SHA256 = $taskPin
    Invoke-SignedCatalogRustCase 'rust-before-trust' 'signed_fixture_without_root_trust_is_rejected' | Out-Null
    Invoke-CatalogTestProcess 'install-owned-test-root' $taskCertUtil @('-user', '-f', '-addstore', 'Root', $taskPublicCertificate) $taskRepo | Out-Null
    $taskAccepted = Invoke-SignedCatalogRustCase 'rust-signed-member' 'signed_fixture_member_publisher_and_tamper_validation'
    if ($taskAccepted -notmatch 'DSP_CATALOG_SIGNED_FIXTURE accepted=true') { throw 'Missing actual signed fixture receipt.' }
    Remove-Item -Path ('Cert:\CurrentUser\Root\' + $taskThumbprint) -Confirm:$false
    Invoke-SignedCatalogRustCase 'rust-after-trust-removal' 'signed_fixture_without_root_trust_is_rejected' | Out-Null
    $taskReport.status = 'PASS'
} catch {
    $taskFailure = $_
    $taskReport.failureType = $_.Exception.GetType().FullName
    $taskReport.failureMessage = $_.Exception.Message
} finally {
    $env:DSP_CATALOG_TEST_ROOT = $taskPriorRoot
    $env:DSP_CATALOG_TEST_PUBLISHER_SHA256 = $taskPriorPin
    try {
        if ($taskThumbprint) {
            $taskRootPath = 'Cert:\CurrentUser\Root\' + $taskThumbprint
            $taskMyPath = 'Cert:\CurrentUser\My\' + $taskThumbprint
            if (Test-Path -Path $taskRootPath) { Remove-Item -Path $taskRootPath -Confirm:$false }
            if (Test-Path -Path $taskMyPath) { Remove-Item -Path $taskMyPath -DeleteKey -Confirm:$false }
            $taskReport.cleanup.rootCertificateAbsent = -not (Test-Path -Path $taskRootPath)
            $taskReport.cleanup.personalCertificateAbsent = -not (Test-Path -Path $taskMyPath)
            if ($taskKeyName) { $taskReport.cleanup.privateKeyAbsent = -not [Security.Cryptography.CngKey]::Exists($taskKeyName, $taskKeyProvider) }
            if ($taskReport.cleanup.Values -contains $false) { throw 'Owned test certificate cleanup incomplete.' }
        }
        if ($taskCertificate) { $taskCertificate.Dispose() }
        # Verify the exact resolved target before any recursive filesystem delete.
        $taskResolvedFixture = (Resolve-Path -LiteralPath $taskFixture).Path
        if ([IO.Path]::GetDirectoryName($taskResolvedFixture) -ne $taskTempBase.TrimEnd('\') -or [IO.Path]::GetFileName($taskResolvedFixture) -notmatch '^dsp-catalog-test-[a-f0-9]{32}$') { throw 'Unsafe fixture cleanup target.' }
        Remove-Item -LiteralPath $taskResolvedFixture -Recurse -Force
        $taskReport.cleanup.fixtureAbsent = -not (Test-Path -LiteralPath $taskFixture)
    } catch {
        $taskReport.status = 'FAILED'
        $taskReport.cleanupErrorType = $_.Exception.GetType().FullName
        if (-not $taskFailure) { $taskFailure = $_ }
    }
    $taskReport.finishedAtUtc = [DateTime]::UtcNow.ToString('o')
    $taskReport | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $taskEvidence 'result.json') -Encoding utf8
}
if ($taskFailure) { throw $taskFailure }
Write-Output 'TEST_ONLY catalog authentication checks passed; no gameplay authority granted.'
