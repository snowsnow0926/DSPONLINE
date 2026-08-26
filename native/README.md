# DSP Native Host

`dsp-native-host` is the Windows-only, sandboxed sidecar for the second and
third performance layers. The Electron main process is its only caller. The
renderer never receives a filesystem path or a process handle.

The public compatibility boundary remains GameState v47 / envelope v2. Native
files are private implementation details under Electron's `userData` folder.

Development commands:

```powershell
cargo test --manifest-path native/Cargo.toml
cargo build --manifest-path native/Cargo.toml --release --locked
```

