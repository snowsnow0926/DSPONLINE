[CmdletBinding()]
param(
  [ValidateSet("HongKong", "Shanghai")]
  [string]$Node = "HongKong"
)

$ErrorActionPreference = "Stop"
$helper = Join-Path $PSScriptRoot "invoke-protected-ssh-script.ps1"
$remoteScript = Join-Path $PSScriptRoot "remote-leaderboard-review-report.sh"
if (-not (Test-Path -LiteralPath $helper -PathType Leaf) -or
    -not (Test-Path -LiteralPath $remoteScript -PathType Leaf)) {
  throw "LEADERBOARD_REVIEW_REPORT_TOOL_MISSING"
}

# Do not add -MutationAuthorized or -Mode Mutating here.  The helper enforces
# strict host-key/physical-egress checks and streams only the CLI's read-only
# JSON result; no production file is created or changed.
$result = & $helper -Node $Node -ScriptPath $remoteScript -Mode ReadOnly -Run -Sudo
if ($LASTEXITCODE -ne 0) { throw "LEADERBOARD_REVIEW_REPORT_REMOTE_FAILED" }
if ([string]::IsNullOrWhiteSpace(($result -join "`n"))) {
  throw "LEADERBOARD_REVIEW_REPORT_EMPTY"
}
$json = $result -join "`n"
try { $report = $json | ConvertFrom-Json -Depth 50 } catch { throw "LEADERBOARD_REVIEW_REPORT_INVALID_JSON" }
if ($report.policy.automaticRestriction -ne $false -or
    $report.policy.automaticSubmissionRemoval -ne $false -or
    $report.policy.manualActionRequired -ne $true) {
  throw "LEADERBOARD_REVIEW_REPORT_POLICY_INVALID"
}
$report | ConvertTo-Json -Depth 50 -Compress
