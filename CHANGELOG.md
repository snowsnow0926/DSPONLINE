# Changelog

All notable player-facing changes are recorded here. Game-state migration versions are tracked separately from product versions.

## [Unreleased]

### 1.1.0（本地候选，未发布）

- 默认启用 RuntimeWorld 2.0：传送带、生产、电力、物流与量子领域使用 Worker 私有编译索引、稳定依赖和精确失效边界，生产构建不运行影子双跑。
- 非拓扑命令复用稳定 slot/generation 与领域 revision；Projection 和画布外层节点只发布实际变化的数据，保留旧引擎领域级 fallback 与诊断原因。
- 模拟 Worker 在权威状态旁准备 canonical 主档/快照，持久化 Worker 独立执行 checksum、CAS、事务提交和精确读回；所有 primary 保存意图共用串行生命周期。
- 两份只读真实大档的 60 秒精确模拟与逐秒 P95 均较冻结基线下降超过 40%，存档格式、物资守恒和确定性输出不变。
- 以已正式发布的 1.0.47（`aab581cf0c78`）为兼容基线：基础卡片新增 1.0.43 风格的“经典”`224×76` 选项；Canvas 传送带在拖动及节点几何重绘后继续使用实时 viewport；连线草稿期间建筑不再受旧任务、生产链、网络或寻线聚焦影响而半透明。
- 继承线上 PWA 子资源解析热修：生成代码中的 `assets/...` 引用始终从当前 release root 解析，根部署与不可变 canary 路由都不会请求错误的 `assets/assets/...` 路径。
- 更新 Android 版本为 `1.1.0 / 1001000`；仅生成未签名诊断候选，不执行线上发布。

### 1.0.47（已发布，2026-08-20）

- “基础卡片”新增位于“中等”和“一行”之前的“经典”选项，恢复 1.0.43 的 `224×76` 紧凑卡片结构；该选择仍仅保存在当前设备。
- 修复高密度工厂拖动画布后，批量 Canvas 传送带被陈旧 viewport 覆盖并与建筑错位的问题。
- 修复任务、生产链、网络或寻线聚焦开启时，开始连线会让非起点建筑偶发半透明的问题；连线结束后原聚焦效果恢复。
- Runtime Git SHA `aab581cf0c78e480e1d10fe4c7f91e6d6d9311b7`；GameState v47、存档 envelope v2、cloud schema v8、SQLite layout v3、IndexedDB records 和玩法数值均不变。

### 1.0.46（已发布，2026-08-19）

- 修复 durable finalize/Worker 故障后只能刷新恢复的问题：当前页面会从 T0 recovery 精确回放、验证 T1 并原子重建模拟 Worker，暂停后可继续模拟。
- 修复新 Worker 沿用旧 `disabled` 标志导致的“durable 模拟 Worker 不可用”假失败。
- 默认保存保护模式下 revision 与 recovery head 的竞态改为安全重查，不再以截图中的阻断错误卡住会话。
- 保存期间允许继续操作（实验性）开启时，已接受编辑会在 recovery head 重建前一起保留；纯挂机恢复日志、宏观进度和导出保护不变。
- Android 版本为 `1.0.46 / 1000046`；后续 PWA release-root 热修已包含在 1.0.47 线上基线中。

### 1.0.45（历史候选）

- 新增全星系唯一空间站：三阶段建设、轨道货运终端、量子手动交付、每日出口合同、轨道徽记/声望、装饰画布、公开只读主页与轻社交。
- 普通存档升级到 GameState v47；服务端升级到 cloud schema v8 / SQLite layout v3。
- 新增 M0 兼容桥接开关：`VITE_SPACE_STATION_ENABLED=false` 可构建不升级 v46 的桥接版。
- 更新 Android 版本为 `1.0.45 / 1000045`。

## [1.0.39] - 2026-08-11

- 服务端接受 1.0.38 合法 v46 稀疏传送带默认值和实体默认交互锁字段，同时继续拒绝显式空值、错误类型、非法范围与损坏 checksum；上传正文、云 revision、历史和下载内容不被规范化或改写。
- 排行榜人工复核分别记录普通与速通主云存档 revision；对应模式的新上传或历史恢复只解除本模式等待，隐藏状态不被改变，永久冻结仍只能由明确的管理员复核动作解除。
- GameState v46、save envelope v2、云 schema v7 与 SQLite layout v2 均不升级；现有 1.0.38 Web、Android 和 Windows 客户端无需重新安装即可在 API 热修后恢复上传。

## [1.0.37] - 2026-08-10

- Fixed legacy resource migration so it only restores stable resource entities declared by the persisted planet profile; legal one-node unipolar-magnet saves remain unchanged, and manual repair requires preview, backup hashes, an explicit token, rollback data, and speedrun review.
- Reworked the desktop technology tree into a horizontal-only viewport with wheel, trackpad, Shift-wheel, drag, and keyboard navigation across standard/compact layouts and 100%–200% font scales; mobile keeps its vertical list.
- Changed unsafe offline fallbacks into a non-committing decision flow. Players can retry exactly from the original state, cancel without changing the source save, or explicitly double-confirm a clock-only zero-reward skip in normal mode; speedrun remains exact-only.
- Compacted star-map batch logistics controls, kept the station upgrade and quantum-switch actions on one row, and added a confirmed global orbital-collector quantum-network action with success, skip, and grouped-reason reporting.
- Kept GameState v46, save envelope v2, cloud schema v7, and SQLite layout v2 unchanged; no leaderboard history, production deployment, or player save is modified by this candidate.

## [1.0.36] - 2026-08-10

- Added a device-level default for 1, 2, 4, or custom 1–4,096 parallel lanes on newly created belts, including direct, touch, and blueprint placement, with atomic construction-inventory checks.
- Added fire ice to the existing thermal-power fuel path at 4.8 MJ per item without changing generator efficiency, fuel conservation, power statistics, offline settlement, or time-warp rules.
- Added reconstructable per-planet belt, production, cache, and logistics indexes, deterministic dormant-route wake-up, and stable dispatch planning; authoritative save fields and exact simulation results remain unchanged.
- Switched dense planets automatically to Canvas belt drawing plus spatial hit testing while retaining React Flow detail edges for active interactions and a safe full-edge fallback when Canvas is unavailable.
- Kept GameState v46, save envelope v2, cloud schema v7, and SQLite layout v2 unchanged; no runtime performance index is serialized.

## [1.0.35] - 2026-08-09

- Separated normal and speedrun saves across primary saves, backups, manual slots, snapshots, imports/exports, cloud revisions, restore/delete operations, and leaderboard validation. Legacy saves without a mode remain ordinary saves; speedrun saves can only be copied one way into a new ordinary slot.
- Made pure-idle wall-clock settlement cursor-based and idempotent, with separate current-run and historical time/production fields. Finite veins now deplete only for traceable output, including full caches, blocked belts, full quantum inventory, and long time-warp boundaries.
- Preserved GameState v46, save envelope v2, cloud schema v7, and SQLite payload layout v2; added a one-time raw pre-migration backup for the legacy ordinary primary save.

## [1.0.21] - 2026-08-02

- Raised the cloud-save raw request boundary from 8 MiB to 32 MiB, bounded compressed and expanded payloads, and separated format, integrity, compression, and size errors without replacing the last valid cloud save.
- Added the device-only Endgame Extreme Mode and reduced current-planet belt observation, while preserving simulation time, production, logistics, inventory, and save results.
- Fixed the PWA response-clone race and added incremental canvas topology/runtime updates to reduce redundant React Flow work.
- Added compact and detailed blueprint views with stable deployment actions, plus blueprint memory for micro black hole connector operation intent with a danger confirmation.
- Added repeated-save short-circuiting for an unchanged verified state; state changes and failures still use the complete save path.
- Added guarded experimental incremental Worker, batched belt-renderer, and multi-Worker safety-gate paths. Full-state transport and one authoritative Worker remain the defaults.
- Preserved GameState v46, save envelope v2, cloud schema v7, old saves, inventories, belts, routes, and in-transit cargo.

## [1.0.20] - 2026-08-02

- 量子供应端在物资实际送达时直接写入共享库存；容量不足时只把精确余量保留在本地缓存或源端，不受五秒上传带宽和塔槽位缓存限制。
- 量子直接入库覆盖传送带、本地运输机和已有本地溢出缓存，并保持 `minStock`、在途货物、五秒统计和 GameState v46 守恒。
- 云存档兼容普通建筑遗留的 `quantumTarget: false`；普通建筑和普通蓝图在下一次保存时清理该字段，星际物流站字段继续保留。
- 服务端把存档格式错误、内部完整性错误、存档过大和请求体过大分开报告，并补充读取、重存、云上传回归测试。

## [1.0.19] - 2026-08-01

- Synchronized declarative content-pack registries with real-time, idle, and offline simulation Workers using a versioned snapshot/fingerprint boundary; stale Worker responses cannot overwrite a newer registry state.
- Raised the shared quantum upload and download base to `5,000 items/minute × Galactic Logistics infinite multiplier² × all attached quantum-tower stacks`; orbital collectors share the upload budget without creating a second warehouse or bandwidth source.
- Unified blueprint stack validation at `100,000,000`, preserving large blueprint counts without truncation; added alignment guides, quantum-mode blueprint intent, grey pending construction, repeated material/vehicle top-ups, and atomic cancellation refunds.
- Recursive hand-crafting now keeps required work-in-progress and allows excess byproducts such as hydrogen to remain usable instead of blocking the task; added visible overflow accounting.
- Replaced blocking browser dialogs with in-game asynchronous confirmations that restore focus and text input on both confirm and cancel paths.
- Added stable production-statistics ordering, selectable time windows, large-number formatting, and regression coverage for desktop/mobile layouts.
- Migrated GameState v45 saves to v46 conservatively; old saves, blueprints, inventories, routes, vehicles, and in-transit cargo remain compatible and conserved.
- Published matching Windows and same-certificate Android application packages with Android versionCode `1000019`.

## [1.0.18] - 2026-08-01

- Added a dedicated quantum-space inventory view with exact, scientific, compact, recent upload/download, and net-flow values per item.
- Replaced per-tower quantum throughput with independent save-wide upload and download budgets derived from all attached tower stacks and the squared Galactic Logistics multiplier.
- Added explicit per-collector and galaxy-wide orbital-collector attachment controls; collectors are supply-only endpoints and never switch silently during migration.
- Kept local logistics-drone dispatch active for attached quantum towers while quantum mode replaces only interstellar vessels and warpers.
- Added independent per-item quantum inventory limits from 10,000 to 10,000,000,000; lowering a limit preserves existing excess stock and blocks only further uploads.
- Migrated GameState v44 saves to v45 without rebuilding or deleting station buffers, slots, belts, routes, vehicles, or production progress.
- Published matching Windows and same-certificate Android application packages with Android versionCode `1000018`.

## [1.0.17] - 2026-08-01

- Removed the deprecated "空间站与太空电梯" entry from the star map while retaining legacy save fields and compatibility code.
- Made interstellar logistics station Mk.II and quantum-network attachment upgrades zero-cost; existing inventories are preserved.
- Fixed quantum attachment transitions that could wait forever on stale legacy-route cargo; transition checks now use the global route ledger, including routes stored on a demand tower for a supply tower.
- Completed paused-canvas P1-P5: pointer/placement visuals use an isolated overlay, port hit testing uses a spatial index, drag-time geometry is frozen, mobile pinch updates only at LOD boundaries, and dense belt graphs participate in viewport culling.
- Added regression coverage for a 60-building/600-belt paused canvas and for legacy route tails completing through the normal simulation engine.
- Published matching Windows and Android application packages with Android versionCode `1000017`.

- Local `1.1.0-dev`: added the GameState v42→v43 space-station migration, four-phase system-space-station domain, Mk.I→Mk.II station upgrade, legacy/elevator transition boundary, five-output blueprint fields and deterministic five-second shared-hub settlement. This is not published or deployed yet.
- Added explicit interstellar-station upgrade diagnostics, atomic per-station Mk.II upgrades, stable-order batch upgrades from the star map, and direct desktop/mobile inspector controls. Technology, material and invalid-stack blockers are shown instead of silently returning the unchanged state; existing routes and in-transit cargo remain untouched.
- Corrected Mk.II upgrade pricing so a stacked logistics-station entity consumes one upgrade package instead of multiplying the package by its internal machine stack count.
- Added a local-only (`127.0.0.1`/`localhost` Vite DEV) free-build switch for system-space-station construction testing; production builds retain the full phase material requirements.
- Added the space-station construction launcher to both desktop and mobile construction trays; the unlocked building can now be selected, crafted and placed from the logistics category.
- Fixed coarse-pointer multi-select mode so tapping another node does not clear the existing selection.
- Added deterministic build identity and release manifest tooling.
- Added atomic code release switching with a last-release rollback command that never restores the database.
- Added privacy-safe PV, UV, sessions, active-time and allowlisted event aggregation on the Asia/Shanghai calendar.

## [1.0.16] - 2026-07-31

- Reused the runtime logistics ledger until an active route is created, completed, or invalidated; the full scan remains a deterministic oracle.
- Kept canvas topology and belt geometry separate from production telemetry, and added conservative offline critical-event boundaries without changing exact settlement.
- Added a 75 ms offline Worker yield budget so long offline calculations report progress and respond to cancellation sooner.
- Added a formal desktop release gate for the official cloud API and update URLs, with package metadata verification inside `app.asar`.
- Desktop updates now request a final local save flush before Electron exits; GameState v42, cloud schema v7, and existing saves remain unchanged.
- Added a protected `/admin` operations dashboard and reduced the public status endpoint to anonymous player counts.
- Stopped the hidden 5-second save-slot and snapshot scan that caused periodic freezes in small new games; save summaries now refresh when the save workspace is open or after an explicit save operation.
- Cached unchanged save summaries, merged overlapping autosaves, moved first-time historical validation to a Worker, and batched long-task diagnostics to avoid storage feedback stalls.

## [1.0.14] - 2026-07-31

- Added persistent planet/system display names, notes, tags and search without changing internal galaxy IDs or logistics relationships.
- Extended infinite collection speed to solid, oil, liquid, sulfuric-acid and orbital collection while preserving solid vein depletion rules.
- Made large blueprint placement validate all requirements atomically and preserve construction inventory on shortage or failure.
- Clarified logistics dispatch direction and charged warpers only at the station that actually dispatches vessels.
- Reused logistics and belt indexes without changing persisted belt order; the real late-game fixture now matches the legacy state hash with 6,105 candidate checks.
- Migrated GameState v41 to v42; save envelope, cloud schema, SQLite layout and existing player data remain compatible.

## [1.0.13] - 2026-07-30

- Cached stable factory topology, port occupancy, belt bundles, route geometry, and unchanged React Flow objects to reduce large-factory rendering work.
- Added viewport rendering for planets with at least 300 entities while preserving full node access for smaller desktop and mobile factories.
- Fixed buildings remaining in a grey compact state after zooming back in; building detail now follows actual zoom instead of performance mode.
- Reused interstellar path plans by planet pair, route policy, warper budget, and route environment without changing deterministic state hashes.
- Removed the leaderboard's artificial `10^15` metric cap, added saturating arithmetic for extreme finite values, and expanded quantity and power units through 载 and QW before scientific notation.
- Kept GameState v41, save envelope v2, cloud schema v7, SQLite layout v2, simulation rates, refresh preferences, and existing player saves unchanged.

## [1.0.11] - 2026-07-30

- Reused stable logistics matching, route economics, active vehicle loads, and dispatch summaries within each simulation session to reduce endgame Worker latency.
- Replaced per-item fuel, Energy Exchanger, and recursive Construction Center loops with deterministic batch settlement while preserving state hashes and material conservation.
- Added server-side leaderboard data-integrity restrictions that survive uploads, restores, visibility changes, and startup backfills without disabling account or cloud-save access.
- Published matching `1.0.11 / 1000011` Windows and Android packages, with Android signature continuity and save-preserving upgrade verification.
- Kept GameState v40, save envelope v2, cloud schema v7, SQLite layout v2, production rates, refresh settings, and existing player saves unchanged.

## [1.0.3] - 2026-07-26

- Added a shared atomic recursive-manufacturing planner that prefers unlocked advanced recipes, falls back to complete base chains, and reports the true raw-resource, technology, or capacity blocker.
- Added recursive quick-crafting and Construction Center stock targets for logistics vessels, with completed craft output stored in the portable fleet.
- Added item-codex production-line location, upstream network highlighting, multi-target cycling, cross-planet jumps, and explicit highlight clearing.
- Corrected orbital-collector power diagnostics, saturated-fleet reporting, time-warp multiplier evidence, and finite-resource depletion persistence.
- Added spray-module removal with protected refunds and depleted-resource recovery shortcuts.
- Fixed HarmonyOS composition input persistence, storage/tank port geometry, mobile tray deletion controls, and collapsed materials-sidebar residue.
- Migrated GameState v35 to v36 without changing save envelope v2, cloud schema v7, or SQLite layout v2.

## [1.0.2] - 2026-07-25

- Added a device-local Simplified Chinese / English switch to the start menu and in-game settings, plus the direct `?lang=en` entry point.
- Added English names and descriptions for the gameplay catalog, technology effects, planetary ecologies, star systems, campaign, and primary desktop/mobile workflows.
- Completed the Light theme across start, account, cloud-save, leaderboard, full-screen workspace, modal, and classic/next mobile surfaces.
- Updated the Windows and Android applications to `1.0.2` without changing GameState v35, save envelope v2, cloud schema v7, or existing player data.
- Added separate Simplified Chinese and English README entry points.

## [0.4.0] - 2026-07-22

- Corrected power-efficiency reporting, automatic belt-tier selection, splitter priority fallback and research pausing.
- Added persistent production regions and independent per-planet inventory limits.
- Improved 80%-200% layouts, storage ports, workspace switching, mobile canvas release and update-dialog handling.
- Added legacy-account email binding and password-recovery protocols, with unavailable mail actions explicitly marked as in development.
- Added independent main and three manual cloud-save slots, revision history, conflict selection and ten-minute verified-account sync.
- Migrated both production nodes to game state v28 and cloud schema v6 with verified backups and record-preservation checks.

## [0.1.0] - 2026-07-21

- Published the first public beta of DSP极简网络.
- Completed the production loop from manual mining through universe matrices, Dyson structures and galactic exports.
- Added local and cloud saves, rankings, PWA and Windows desktop packaging.
- Added desktop/mobile canvas interaction, production diagnostics, blueprints, content packs and the campaign flow.
- Deployed independent Hong Kong production and Shanghai fallback nodes.

[Unreleased]: ./docs/ROADMAP.md
[1.0.14]: ./docs/releases/1.0.14.md
[1.0.13]: ./docs/releases/1.0.13.md
[1.0.11]: ./docs/releases/1.0.11.md
[1.0.3]: ./docs/releases/1.0.3.md
[1.0.2]: ./docs/releases/1.0.2.md
[0.4.0]: ./docs/releases/0.4.0.md
[0.1.0]: ./docs/releases/0.1.0.md
