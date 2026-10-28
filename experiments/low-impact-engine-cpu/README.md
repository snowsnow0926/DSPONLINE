# Bounded owned-engine CPU diagnostic

This opt-in tool compares exact Git copies of `engine.ts` and `recursiveCrafting.ts` on four fixed synthetic factories. It does not load player files, start browsers or build the game. `probe.ts` does not match default unit-test discovery.

The input has 43–162 entities and no belts. Each scenario warms a separate runtime for 40 one-second advances, then measures a fresh runtime for 120 or 960 advances. An idle-only 7,680-step window is also supported. Only `Date` is faked; process user+system CPU and real wall time remain live. Fixture creation, initial indexes, warm-up and final JSON hashing are outside the timing window. The diagnostic also checks caller input and complete warm/final state hashes.

`config.mjs` substitutes the two frozen module bodies at their original module paths and emits hashes when each body actually executes. The probe rejects missing/mismatched loaded hashes. Preparation refuses comparisons with other changed runtime sources; this prevents an incomplete frozen reference.

From the repository root, choose a new D-drive output folder and exact existing refs. Keep preparation at low priority when the machine is busy:

```powershell
$taskProcess = [Diagnostics.Process]::GetCurrentProcess()
$taskMask = $taskProcess.ProcessorAffinity.ToInt64()
$taskProcess.PriorityClass = 'Idle'
$taskProcess.ProcessorAffinity = [IntPtr]($taskMask -band (-$taskMask))
node experiments/low-impact-engine-cpu/prepare.mjs 13e80829361a f50c60e02b62989b388195c30b112ab39499991a D:/GameDev/DSPidle2/artifacts/cpu-probe-new 960
```

Run the four trials separately in the declared baseline/candidate/candidate/baseline order. Use a fresh output directory for each:

```powershell
pwsh -NoProfile -File experiments/low-impact-engine-cpu/run.ps1 -ManifestPath D:/GameDev/DSPidle2/artifacts/cpu-probe-new/manifest.json -OutputPath D:/GameDev/DSPidle2/artifacts/cpu-probe-new/trial-01 -Trial 1
```

Repeat for trials 2–4. The runner verifies the declared harness hashes, applies Idle priority/one logical processor, admits Node only with at least 8 GiB available physical memory, and uses one worker. Exit 75 is a resource deferral; no test has run. It preserves existing directories, and source snapshots are files rather than Git worktrees. The threshold is not a hard memory limit.

Keep every sample, including short exploratory windows. Compare CPU medians within the same declared window, and first require all source/input/full-state hashes to match. Log wall time separately; scheduling, frequency, GC and short-window variation still limit the conclusions. The end RSS field is not peak memory. These small Node results cannot establish real-save, two-mode Worker, Web FPS, startup/stop latency, PWA or release qualification.
