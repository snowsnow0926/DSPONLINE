[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-Equal {
    param(
        [Parameter(Mandatory = $true)]$Actual,
        [Parameter(Mandatory = $true)]$Expected,
        [Parameter(Mandatory = $true)][string]$Label
    )
    if ($Actual -ne $Expected) {
        throw "$Label expected '$Expected', received '$Actual'."
    }
}

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$measurementScript = Join-Path $repositoryRoot 'scripts\measure-windows-shell-ab.ps1'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    $measurementScript,
    [ref]$tokens,
    [ref]$parseErrors
)
Assert-Equal -Actual $parseErrors.Count -Expected 0 -Label 'PowerShell parse error count'

$helperNames = @('Get-PercentileValue', 'Get-ProcessTreeSummary')
$helperDefinitions = @($ast.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $helperNames -contains $node.Name
}, $true) | ForEach-Object { $_.Extent.Text })
Assert-Equal -Actual $helperDefinitions.Count -Expected $helperNames.Count -Label 'Process summary helper count'
Invoke-Expression ($helperDefinitions -join "`n")

$empty = Get-ProcessTreeSummary -Samples @()
Assert-Equal -Actual $empty.sampleCount -Expected 0 -Label 'Empty sample count'
Assert-Equal -Actual $empty.peakProcessCount -Expected 0 -Label 'Empty peak process count'
Assert-Equal -Actual $empty.samplerOverheadMs.total -Expected 0 -Label 'Empty sampler overhead'
Assert-Equal -Actual @($empty.roles.PSObject.Properties).Count -Expected 7 -Label 'Empty role summary count'
Assert-Equal -Actual $empty.roles.renderer.peakCount -Expected 0 -Label 'Empty renderer peak count'

$sample = [pscustomobject]@{
    treePrivateBytes = [long]300
    treeWorkingSetBytes = [long]500
    samplerDurationMs = 1.5
    processes = @(
        [pscustomobject]@{ role = 'main'; privateBytes = [long]100; workingSetBytes = [long]200 },
        [pscustomobject]@{ role = 'renderer'; privateBytes = [long]200; workingSetBytes = [long]300 }
    )
}
$summary = Get-ProcessTreeSummary -Samples @($sample)
Assert-Equal -Actual $summary.sampleCount -Expected 1 -Label 'Sample count'
Assert-Equal -Actual $summary.peakProcessCount -Expected 2 -Label 'Peak process count'
Assert-Equal -Actual $summary.peakPrivateBytes -Expected 300 -Label 'Peak private bytes'
Assert-Equal -Actual $summary.roles.main.peakCount -Expected 1 -Label 'Main peak count'
Assert-Equal -Actual $summary.roles.renderer.peakPrivateBytes -Expected 200 -Label 'Renderer peak private bytes'
Assert-Equal -Actual $summary.roles.'native-host'.peakCount -Expected 0 -Label 'Native host zero peak count'

Write-Output 'measure-windows-shell-ab helper tests passed'
