# Production-page large-save runtime probe

This opt-in local experiment uses a private prepared save through the existing
`web-save-checkpoints/vite.config.ts` fixture server. It launches a fresh Chrome
context with service workers blocked and all `/api/**` requests intercepted.
Only loopback HTTP origins are accepted. No real browser profile, remote service,
or original save is written.

The copy is paused, automatic saving is disabled for the measurement, and a
time-warp controller is brought into view. Because persisted saves intentionally
omit live production history, the probe first runs the actual authoritative
simulation for at least 40 simulated seconds. It then starts 8x replication
through the real inspector after letting manual pause clear normal simulation
debt, observes the overlay, stops through its real button,
and waits for the verified checkpoint and resumed factory UI.

```powershell
$env:DSP_SAVE_PROBE_FIXTURE = 'D:/private/prepared.json'
$env:DSP_SAVE_PROBE_DIST = 'D:/private/frozen-web-dist'
node node_modules/vite/bin/vite.js --config experiments/web-save-checkpoints/vite.config.ts --port 4375
# In another terminal, in this worktree:
node experiments/web-live-runtime/run.mjs --url=http://127.0.0.1:4375 --supply=stock --seconds=30 --profile=1 --output=D:/private/results --name=baseline
node experiments/web-live-runtime/summarize.mjs D:/private/results/baseline.json
# For an alternating two-pair comparison against another frozen bundle:
powershell -File experiments/web-live-runtime/run-pairs.ps1 -OutputDirectory D:/private/results
```

The paired runner stops at the first failure and preserves its log. An
interrupted pair is a failure reproduction, not a completed timing comparison.

`stock` retains the copied inventory. `tray` and `quantum` are explicit supplied
stress variants: they replace the relevant inventory with one billion units of
every catalog item. Never describe those variants as an untouched player save.
Entity positions, recipes, research, and game rules are unchanged.

Evidence records frame gaps by phase, Worker request/response timings, compact
construction summaries, browser CPU profiles, and bounded process memory samples.
`--profile=1` samples the page CPU. `--engine-profile=1` additionally requests the
existing engine subsystem timers. An experimental CDP diagnostic with Worker
attachment timed out during stop; its source and results remain in private
artifacts, are excluded from comparisons, and are not part of this runner.
`--retain-debt=1` tests the separate transition with
unsubmitted normal simulation debt carried into replication. Frame gaps
are not input-latency measurements, and isolated overlay responsiveness is not a
whole-game FPS claim. Real wall-clock runs have different settlement durations;
use deterministic engine replays separately when changing simulation math.

Raw evidence may contain save metadata, session identifiers, inspector text, and
failure screenshots. Keep it under an ignored private artifact directory; only
sanitized aggregates belong in review documentation.
