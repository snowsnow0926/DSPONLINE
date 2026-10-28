param(
 [Parameter(Mandatory=$true)][string]$ManifestPath,
 [Parameter(Mandatory=$true)][string]$OutputPath,
 [ValidateRange(1,4)][int]$Trial=1,
 [ValidateSet('diagnostic','tool-smoke')][string]$Purpose='diagnostic'
)
$ErrorActionPreference='Stop'
$root=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
Set-Location -LiteralPath $root
$self=[Diagnostics.Process]::GetCurrentProcess()
$mask=$self.ProcessorAffinity.ToInt64()
$one=$mask -band (-$mask)
if($one -le 0){throw 'No supported allowed processor'}
$self.PriorityClass=[Diagnostics.ProcessPriorityClass]::Idle
$self.ProcessorAffinity=[IntPtr]$one
if($self.PriorityClass -ne 'Idle' -or $self.ProcessorAffinity.ToInt64() -ne $one){throw 'Resource policy not applied'}
$free=(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB
Write-Output ('Low impact helper: Idle, one logical processor; available memory '+[math]::Round($free,2)+' GiB')
if($free -lt 8){Write-Output 'Check deferred: less than 8 GiB available';exit 75}
$out=[IO.Path]::GetFullPath($OutputPath)
if(!$out.StartsWith('D:\',[StringComparison]::OrdinalIgnoreCase)){throw 'Diagnostic output must stay on D:'}
if(Test-Path -LiteralPath $out){throw 'Output exists; retain it and choose another path'}
$manifestFile=(Resolve-Path -LiteralPath $ManifestPath).Path
$manifest=Get-Content -LiteralPath $manifestFile -Raw|ConvertFrom-Json
foreach($item in @(@{Name='probe.ts';Expected=$manifest.probeSha256},@{Name='config.mjs';Expected=$manifest.configSha256})){
 if(!$item.Expected -or (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $item.Name) -Algorithm SHA256).Hash.ToLower() -ne $item.Expected){throw 'Harness differs from the declared manifest'}
}
$variant=$manifest.plan[$Trial-1]
if($variant -notin @('baseline','candidate')){throw 'Invalid trial source variant'}
New-Item -ItemType Directory -Path $out | Out-Null
$env:DSP_SMALL_CPU_PROBE='1'
$env:DSP_SMALL_CPU_MANIFEST=$manifestFile
$env:DSP_SMALL_CPU_VARIANT=$variant
$env:DSP_SMALL_CPU_OUTPUT=$out
$start=[DateTime]::UtcNow
try {
 & node node_modules/vitest/vitest.mjs run experiments/low-impact-engine-cpu/probe.ts --config experiments/low-impact-engine-cpu/config.mjs --maxWorkers=1 --no-file-parallelism --reporter=dot *> (Join-Path $out 'stdout.log')
 $code=$LASTEXITCODE
 @{purpose=$Purpose;trial=$Trial;variant=$variant;exitCode=$code;startUtc=$start.ToString('o');endUtc=[DateTime]::UtcNow.ToString('o');availableGiBAtStart=$free;priority='Idle';logicalProcessors=1;workers=1;manifest=$manifestFile;formalWebBenchmark=$false;largeSave=$false;webBuild=$false}|ConvertTo-Json -Depth 4|Set-Content -LiteralPath (Join-Path $out 'exit.json') -Encoding utf8
 Get-Content -LiteralPath (Join-Path $out 'stdout.log') -Tail 9
} finally {
 Remove-Item Env:DSP_SMALL_CPU_PROBE,Env:DSP_SMALL_CPU_MANIFEST,Env:DSP_SMALL_CPU_VARIANT,Env:DSP_SMALL_CPU_OUTPUT -ErrorAction SilentlyContinue
}
exit $code
