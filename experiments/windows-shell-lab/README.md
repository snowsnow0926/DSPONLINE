# DSPidle Windows shell A/B lab

This directory is an isolated development experiment for measuring shell fixed
cost. It is not a replacement desktop entry, release candidate, updater, cloud
client, save migrator, or native-authority promotion.

## Current status

| Shell | Status | Meaning |
| --- | --- | --- |
| Thin Electron | Implemented | Local deterministic Canvas fixture plus the existing restricted Rust sidecar |
| Tauri 2 | No-Go placeholder | Machine prerequisites exist; repository-owned scaffold and offline dependency proof do not |
| WinUI 3 | No-Go placeholder | Windows App SDK development packages and Win2D are absent |

The Electron lab does not import `desktop/main.cjs`, the production React app,
cloud transport, `electron-updater`, release-channel code, GameState, or player
saves. It always assigns `app.getPath("userData")` to a newly created child of
the operating-system temporary directory. HTTP(S), WebSocket, FTP, navigation,
new-window, webview, and permission requests are denied.

The existing `dsp-native-host.exe` is started with a private root below that
temporary profile. The lab performs only the bounded `hello` handshake. It does
not open a checkpoint or promote the Rust core; `authorityEligible=false`
remains the product boundary.

## Build prerequisites

No new Windows SDK is needed for the Electron leg. Build the existing sidecar
and ensure the Electron 43 executable is locally available:

```powershell
Set-Location -LiteralPath 'D:\GameDev\DSPidle2-windows-full-native'
$env:CARGO_NET_OFFLINE = 'true'
cargo build --manifest-path native/Cargo.toml --release --locked --offline
Test-Path -LiteralPath 'node_modules\electron\dist\electron.exe'
```

The lab is deliberately not added to the root `package.json`; production build,
version, appId, updater, cloud, and packaging behavior remain untouched.

## Validate without launching

```powershell
node --test experiments/windows-shell-lab/tests/*.test.cjs
pwsh -NoProfile -File experiments/windows-shell-lab/tests/measure-windows-shell-ab.test.ps1

pwsh -NoProfile -File scripts/measure-windows-shell-ab.ps1 `
  -Shell electron `
  -ValidateOnly
```

Tauri and WinUI validation must fail closed:

```powershell
pwsh -NoProfile -File scripts/measure-windows-shell-ab.ps1 -Shell tauri -ValidateOnly
pwsh -NoProfile -File scripts/measure-windows-shell-ab.ps1 -Shell winui -ValidateOnly
```

## Run one measured Electron sample

The measurement window is intentionally visible because hidden/minimized
Chromium rendering is not a valid frame-time comparison.

```powershell
pwsh -NoProfile -File scripts/measure-windows-shell-ab.ps1 `
  -Shell electron `
  -DurationSeconds 15 `
  -InstanceCount 10000 `
  -SampleIntervalMilliseconds 500 `
  -OutputPath artifacts/windows-shell-ab/electron-smoke.json
```

The script creates an exact temporary profile, launches only the lab directory,
samples the root Electron process and all descendants, merges renderer and
sidecar data into the schema in `metrics.schema.json`, and records both raw
samples and main/renderer/GPU/utility/native-host role peaks. It then removes
only that validated temporary profile after a successful run. Use
`-KeepProfile` to retain it for diagnosis. Existing output is never overwritten
unless `-Force` is supplied.

## Interpretation limits

- A single high-end Windows 10 machine does not close Windows 11, low-memory,
  integrated-GPU, AMD-GPU, touch, remote-session, Defender, or 24-hour gates.
- `inputLatencyMs.sampleCount=0` is expected unless a human supplies trusted
  pointer input during the run. The lab does not fabricate input events.
- The current Electron projection path is not shared memory or zero-copy.
- Shell A/B success does not imply native simulation authority, save migration,
  signing, installer, upgrade, or production readiness.
- WinUI should win only with the plan's measured benefit (at least 15% lower
  full-process-tree memory, or materially better frame/long-task evidence).
