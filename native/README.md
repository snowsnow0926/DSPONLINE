# DSP Native Host

`dsp-native-host` is the Windows-only, sandboxed sidecar for the second and
third performance layers. The Electron main process is its only caller. The
renderer never receives a filesystem path or a process handle.

The public compatibility boundary remains GameState v47 / envelope v2. Native
files are private implementation details under Electron's `userData` folder.

The `dsp-native-core` crate is the independent Layer 3 state owner. It loads a
verified Layer 2 generation into bounded Rust indexes, applies revision-bound
commands transactionally, and emits canonical/component hashes for shadow
comparison. Authority promotion remains fail-closed until every simulation
domain and the long-run Gate C matrix report complete.

Development commands:

```powershell
cargo test --manifest-path native/Cargo.toml
cargo build --manifest-path native/Cargo.toml --release --locked
```
