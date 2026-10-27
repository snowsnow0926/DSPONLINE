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

The paired runner alternates pair order (old/new, then new/old). Set
`-ObservationSeconds 5` for a shorter transition smoke comparison; it defaults
to 30 seconds. The paired runner stops at the first failure and preserves its log. An
interrupted pair is a failure reproduction, not a completed timing comparison.

`stock` retains the copied inventory. `tray` and `quantum` are explicit supplied
stress variants: they replace the relevant inventory with one billion units of
every catalog item. Never describe those variants as an untouched player save.
Entity positions, recipes, research, and game rules are unchanged.

Evidence records frame gaps by phase, Worker request/response timings, compact
construction summaries, browser CPU profiles, and bounded process memory samples.
`--profile=1` samples the page CPU. `--engine-profile=1` additionally requests the
existing engine subsystem timers. An earlier comprehensive Worker-attachment
CDP diagnostic timed out during stop; that source and evidence remain in private
artifacts and excluded from timing comparisons. The separate bounded heap-only
checkpoint mode described below has its own scope and evidence.
`--retain-debt=1` tests the separate transition with
unsubmitted normal simulation debt carried into replication. Frame gaps
are not input-latency measurements, and isolated overlay responsiveness is not a
whole-game FPS claim. Real wall-clock runs have different settlement durations;
use deterministic engine replays separately when changing simulation math.

Raw evidence may contain save metadata, session identifiers, inspector text, and
failure screenshots. Keep it under an ignored private artifact directory; only
sanitized aggregates belong in review documentation.

## 补充诊断与当前口径

`run.mjs` 只接受 `http://127.0.0.1`，使用新的隔离 Chrome，以既有私有准备态副本填充真实模拟滚动窗口，再通过界面启动和停止产率复制。`--supply=stock` 保留原库存；准备态是展开后的运行 JSON，不能将其体积当成玩家主档体积。

未采样性能资格用 `run-pairs.ps1`，与构建和其它测试串行。每组旧/新顺序交替，`-PostStopSeconds 3 -AllProcessMemory` 额外记录恢复画布后的帧和浏览器进程时点内存；`stopMs` 仍在弹窗关闭时截断。进程峰值计数器覆盖整个旅程，离散工作集加总还可能重复计算共享页。

## CPU 归因

```powershell
node experiments/web-live-runtime/run.mjs --url=http://127.0.0.1:4397 --supply=stock --seconds=5 --profile=1 --profile-phase=stopping --post-stop-seconds=3 --output=D:/private/diagnostics --name=stop-profile
node experiments/web-live-runtime/analyze-profile.mjs --profile=D:/private/diagnostics/stop-profile.cpuprofile --dist=D:/private/diagnostic-dist --output=D:/private/diagnostics/stop-profile-analysis.json
```

解析器使用仓库已安装的 TypeScript 解码源码映射，无需新增依赖。诊断构建可额外输出隐藏映射，但必须先逐字节比对所有 JavaScript 与待采样的冻结包；复现构建身份时仅在该诊断命令内指定已知的 `npm_package_version`、`DSP_GIT_SHA`、`DSP_GIT_DIRTY` 和 `DSP_BUILD_ID`，不能将这个目录当成发布包。

CPU 采样自身可能引入很长的初始化停顿和其它开销。`*-profile-timeline.json` 记录启动边界；采样结果只用于定位函数，性能百分比来自独立、未采样的旧/新对照。`--profile-phase=all` 保留整个转换旅程采样入口。

## 堆占用归因

单独传入 `--worker-heaps=1`，在进程采样点读取页面和同源专用 Worker 的 `Runtime.getHeapUsage`，并保存 `*-heaps.json`。只附着本次隔离浏览器的后台，读取后断开，不强制垃圾回收。`usedSize` 包括尚未回收的对象，不等于存活对象大小，也不等于进程工作集。结束的临时 Worker 可能留下明确的读取错误；必须检查必需样本实际存在，不能用空结果宣称内存改善。此模式的耗时不用于未采样性能资格。

新版页面还会记录命中索引的构建/复用计数；它们是显示缓存诊断，不进入 GameState、保存正文或玩家操作流程。
