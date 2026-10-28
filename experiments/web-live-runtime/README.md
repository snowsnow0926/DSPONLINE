# Production-page large-save runtime probe

`--macro-mode=stable` selects the real **开始纯挂机（守恒模式）** accessible button;
the default `replication` retains the existing protocol. Both modes keep the
same original-inventory seeding, at-least-40-simulation-second normal warmup,
real start/stop controls and primary/catalog verification. The output records
`macroMode`; process-stage labels use `conservative` or `replication` accordingly.
Give each run an explicit unique `--name` when comparing frozen bundles. Mode
selection does not enable CPU/heap/GC diagnostics or change the game rules.

`--worker-heaps=1 --post-stop-memory-tail=1` adds diagnostic snapshots
10 and 30 seconds after the stop overlay closes, and rechecks the primary
catalog and paused state at each point. `--post-stop-heap-gc=1` additionally
requests GC only after the natural 10-second snapshot; do not combine it with
global `--worker-heap-gc=1`. These modes require Worker heap sampling, are marked
`profiled: true`, and must remain outside normal performance comparisons.
See the [memory-tail investigation](../../docs/reviews/2026-10-28-web-stop-memory-tail.md).
The current [low-impact development policy](../../docs/reviews/2026-10-28-web-resource-policy.md)
defers this large-save/browser work while the user's other project needs the machine.

`--idb-operations=1` optionally records main-page `IDBObjectStore.put` and
`IDBRequest.result` getter durations, phase, database/store names and success.
It records no keys or values and is disabled by default. These synchronous
call durations are not the complete asynchronous transaction/read latency.
See the [startup diagnosis](../../docs/reviews/2026-10-27-web-startup-idb.md).

`--startup-buffer-gc=1` is a separate reachability diagnostic. It holds the
startup owner's serialize message, requests one page GC, records numeric heap
usage, then continues the real save. It is disabled by default. Never compare
its timings or working sets with normal runs; use it only to investigate live
references. See the [buffer experiment](../../docs/reviews/2026-10-27-web-obsolete-checkpoint-buffer.md).

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
`--profile=1 --profile-phase=starting` restricts CPU sampling to the start
transition, after the real rolling-rate warmup and through the ready message.
It records before/after page-clock anchors for both Profiler boundaries in
`*-profile-timeline.json`, then stops and detaches before observing and stopping
replication. The run remains diagnostic (`profiled: true`); its durations and
working sets must not be mixed with the unprofiled qualification cohort.
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

修改源码后，应先重启两端 Vite 夹具服务再开始整组资格测试。热更新残留可能让 `storage.ts` 引用带旧时间戳的 `localSaveStore.ts?t=...`，而直接动态导入另一个模块实例，导致初始化和保存使用不同的本地存储后端。先核对两端的存储依赖 URL 及冻结 `index.html` 字节；准备阶段失败的运行保留诊断，但不得计入性能对照，也不得通过关闭保存校验继续测量。

## CPU 归因

`--macro-mode=stable --macro-worker-cpu=1` 是独立的后台宏 Worker 启动采样入口。
它在真实滚动窗口预热后监听新创建的、同源的 pureIdleMacro Worker，使用
1,000 微秒 CPU 采样，不暂停 Worker、不强制 GC、不启用引擎插桩，也不修改
校准、计时或权威参数。默认关闭；启用时结果始终为 profiled，禁止与自然内存
尾部、主线程采样或其它实验混用。现有 Worker、替换 Worker、空采样、协议超时、
写入和清理失败均不得视为成功；原采样与失败元数据留在私有输出目录。

输出为名字后缀 -macro-worker.cpuprofile 和 -macro-worker-cpu.json。
后者记录采样边界、所有权、完整性与错误；只有与实际采样 Worker 字节一致的
源码映射才可用于函数归因。22 项无浏览器协议/命令行测试已通过；一次真实
冻结宏 Worker 采样取得 18,131 点，所有权、完整性、保存目录和字节一致映射已验证。
所有带采样耗时都不能当作性能提升。

```powershell
node --test --test-concurrency=1 experiments/web-live-runtime/macro-worker-cpu.test.mjs
node experiments/web-live-runtime/run.mjs --url=http://127.0.0.1:4490 --macro-mode=stable --macro-worker-cpu=1 --supply=stock --seconds=5 --post-stop-seconds=3 --output=D:/private/diagnostics --name=macro-start
```

```powershell
node experiments/web-live-runtime/run.mjs --url=http://127.0.0.1:4397 --supply=stock --seconds=5 --profile=1 --profile-phase=stopping --post-stop-seconds=3 --output=D:/private/diagnostics --name=stop-profile
node experiments/web-live-runtime/analyze-profile.mjs --profile=D:/private/diagnostics/stop-profile.cpuprofile --dist=D:/private/diagnostic-dist --output=D:/private/diagnostics/stop-profile-analysis.json
```

解析器使用仓库已安装的 TypeScript 解码源码映射，无需新增依赖。诊断构建可额外输出隐藏映射，但必须先逐字节比对所有 JavaScript 与待采样的冻结包；复现构建身份时仅在该诊断命令内指定已知的 `npm_package_version`、`DSP_GIT_SHA`、`DSP_GIT_DIRTY` 和 `DSP_BUILD_ID`，不能将这个目录当成发布包。

CPU 采样自身可能引入很长的初始化停顿和其它开销。`*-profile-timeline.json` 记录启动边界；采样结果只用于定位函数，性能百分比来自独立、未采样的旧/新对照。`--profile-phase=all` 保留整个转换旅程采样入口。
停止采样同样记录 Profiler.stop 前后页面时钟，可用 profile 总时长与首尾边界求交，
缩小启用采样造成的时钟不确定区间。采样停止或写出失败会另存 `*-profile-error.json`，
在主流程本来成功时让诊断退出失败，不将缺失 CPU 数据当作成功定位。

`--style-read-diagnostics=1` 是独立样式查询诊断：仅在停止和恢复阶段包装
`getComputedStyle`，主动读取 display/visibility 以计入懒求值，保留不少于 1 ms
的最多 200 条查询。只记录标签、焦点资格与样式等结构摘要，不记录元素 ID、
文字或存档内容。该选项将运行标为 `profiled: true`，有探针开销，不能用于
未采样性能资格；用于核对昂贵焦点检查的实际目标是否可聚焦。

`--handoff-progress=1` 另行记录已知保存/终态 Worker 的进度标签、记录数量、
序列化/压缩耗时及提交证明中的 decode/write/readback 等数字；不记录正文、
对象引用、键、校验串或身份。最多 2,000 条，`trace.handoffCapped` 标记截断，
截断、开始/停止缺少序列化或成功持久化计时、阶段失败时拒绝通过。
该选项默认关闭，启用时 `profiled: true`；同名阶段可能嵌套，
Worker 结束还可能包含空闲退役延迟，不能把整个生命周期当作计算耗时。

## 堆占用归因

单独传入 `--worker-heaps=1`，在进程采样点读取页面和同源专用 Worker 的 `Runtime.getHeapUsage`，并保存 `*-heaps.json`。只附着本次隔离浏览器的后台，读取后断开，不强制垃圾回收。`usedSize` 包括尚未回收的对象，不等于存活对象大小，也不等于进程工作集。结束的临时 Worker 可能留下明确的读取错误；必须检查必需样本实际存在，不能用空结果宣称内存改善。此模式的耗时不用于未采样性能资格。

新版页面还会记录命中索引的构建/复用计数；它们是显示缓存诊断，不进入 GameState、保存正文或玩家操作流程。

`startMs` 记录真实启动按钮点击前至宏观 Worker `ready` 后的等待，包含界面操作和异步保存交接，不含随后进程内存采样。它与 `stopMs` 分别报告；同样要用独立、未采样的交替对照，不能以局部函数耗时替代整页收益。

`--startup-worker-heaps=1` 在真实启动主档完成之后、挂机后台收到初始化请求之前暂停该次发送，读取仍在运行的 Worker 堆占用后继续。它只用于定位后台重叠，不强制 GC；诊断延迟可能影响空闲回收时机，该运行不能用于时间或峰值改善百分比。必需样本为 `before-macro-initialize`，必须检查具体 Worker 和错误。
## 系统内存采样完整性

自然退出时序使用 --process-memory-tail=1，并启用 --all-process-memory=1。Windows 下在原退出观察点及停止后约 10/30/60 秒仅查询系统进程内存，记录每次查询相对停止的开始/结束时间，逐次核对主档目录和暂停状态。该模式拒绝堆检查、GC、CPU/引擎剖析及其它诊断实验混用；八个基础/尾段阶段都必须完整，不将强制回收结果当作自然回收。

启用 `--all-process-memory=1` 时，Windows 的五个基础阶段必须各有一条有效渲染进程采样。
采样失败最多尝试三次，失败原因写入独立 `*-process-sampling-errors.json`，成功样本记录 `attempt`；
所有系统进程行的 ID 与内存字段必须有效，辅助进程的空字段同样触发重试，不能以 null 隐式加零形成浏览器总量。
每次尝试结束都会断开诊断会话，缺样会使验收失败。重试仅查询系统进程信息，不执行 GC，也不改游戏状态。
五个时点的浏览器工作集总和与渲染进程整个旅程的 OS 峰值应分别解释。

2026-10-29 首轮两种模式共 12 次测试中，一条旧版守恒样本缺少停止后的内存记录。
保留全部原始时间/存档结果，初轮守恒内存不作新旧比较；使用完整的平衡补验组确认内存，不能以重跑一条样本替换原结果。
