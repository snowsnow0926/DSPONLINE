# Tauri 2 shell placeholder — No-Go

Status: **No-Go / not built**.

The machine has Rust/MSVC/WebView2 prerequisites, but this repository has no
`src-tauri`, repository-owned Tauri CLI/API packages, locked Cargo dependency
graph, capability manifest, sidecar bundle rule, or offline build proof.

Do not report Tauri as available from this experiment. It may be added only by
a separate approved task that:

1. pins repository-owned JavaScript and Rust dependencies;
2. keeps `dsp-native-host.exe` as the same isolated sidecar used by Electron;
3. denies network, cloud, updater, arbitrary path, shell, and process access;
4. consumes the same fixture and emits `metrics.schema.json` compatible output;
5. passes an actual `cargo build --locked --offline` and isolated launch.
