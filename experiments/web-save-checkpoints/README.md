# Production-page checkpoint save probe

This opt-in Windows/Chrome experiment measures the real settings → saves UI with
a private prepared `{ state: GameState }` fixture. It is not an automated release
gate and does not connect to the public game or production storage.

Build the source to measure, then start the loopback-only server:

```powershell
$env:DSP_SAVE_PROBE_FIXTURE='D:/path/to/private-prepared.json'
$env:DSP_SAVE_PROBE_DIST='D:/path/to/immutable-web-dist'
$env:DSP_API_PROXY_TARGET='http://127.0.0.1:65534'
node node_modules/vite/bin/vite.js --config experiments/web-save-checkpoints/vite.config.ts --port 4375
```

Run each action sequentially, without builds or test suites competing for CPU:

```powershell
node experiments/web-save-checkpoints/run.mjs --url=http://127.0.0.1:4375 --production=1 --diagnostic=1 --action=slot --output=D:/path/to/evidence --name=slot-1
node experiments/web-save-checkpoints/run.mjs --url=http://127.0.0.1:4375 --production=1 --diagnostic=1 --action=snapshot --output=D:/path/to/evidence --name=snapshot-1
```

`--production=1` serves the built index and assets; other routes provide only the
development modules needed to prepare IndexedDB. Without it, React development
overhead makes this a diagnostic run, not a production performance comparison.
The runner uses a fresh temporary browser context, blocks all API requests and
Service Workers, and transfers the normal same-tab writer-continuation marker
before destroying the preparation page. It does not force a lease takeover.

The source file remains read-only. Its in-memory test copy is paused, disables
time warp and automatic saves, and clears pending time-warp debt. Thus results
measure these save actions, not running-factory frame rates or offline settlement.
Existing backup settings and the public game are untouched.

Evidence records click-to-visible-completion time, maximum animation-frame gap,
long tasks, outgoing Worker message durations, durable catalog identity, primary
preservation and loaded production asset names. `--diagnostic=1` adds Windows
renderer working-set/private-memory samples and a Chrome diagnostic log. The
operating-system lifetime peak includes startup; it is not a save-only peak.

`--hash=1` additionally closes the game page, opens a clean page in the same
temporary context and computes SHA-256 over the entire persisted `state` JSON.
It also hashes each top-level field after recursively sorting object keys,
preserving every array position and value. This distinguishes real state
differences from the property order introduced by reassembling streamed entity
and belt arrays. The combined field digest binds all field names and hashes.
That verification happens after recording timing and memory, so its parse and
allocation cannot improve or worsen the measured result. Run it separately from
`--profile=1`, which captures a CPU profile. A failed profiling run may interrupt
only its disposable page's JavaScript to retrieve diagnostic information.

Keep private fixtures, raw browser profiles, logs and results outside version
control. Use at least three completed runs per action and compare the same input,
browser and build mode; do not count failed preparation or read-only-page runs.
`summarize.mjs <evidence-directory>` validates and summarizes the specifically
named 110,042-entity / 233,300-belt runs recorded for this optimization.

The follow-up verification experiment uses `run-series.ps1` with `-BaseUrl`,
`-OutputDirectory` and `-Variant baseline` or `candidate`. It records Worker
phase timings as well as the full-page measurements; summarize it with
`save-verification-summary.mjs <evidence-directory>`. `--worker-timings=1` can
also be passed directly to the JavaScript runner.

`--transport=raw` and `--transport=gzip` are diagnostic-only wrapper Workers
used to isolate compression cost while loading the same production modules.
They must not be mistaken for the final application implementation, which uses
a typed transfer preference and keeps Blob/native paths compressed. Omit the
transport override when measuring the actual candidate.

The separate `web-construction-wasm/run.mjs --entry=save-inspection` harness
compares the frozen original scanner, the measured substring variant, and the
production scanner on the same serialized payload. It performs no save writes.
