# Changelog

All notable player-facing changes are recorded here. Game-state migration versions are tracked separately from product versions.

## [Unreleased]

### 1.2.6（已发布，2026-08-31）

- 产率复制挂机不再复制物品或向量子仓库、行星托盘、机器缓存和施工缓存写入虚构库存；统计窗口只直接推进真实白矩阵科研与逐恒星系戴森结构/壳面进度。
- 没有当前科研或匹配戴森计划的通道会舍弃本段额度，不生成可延期库存；建筑制造继续只消耗玩家真实物资。
- 星图为已殖民星球新增“一键重置星球工厂”，依次确认删除范围、不可撤销后果并精确输入当前星球名称。
- 重置永久删除目标星球的建筑、采集器、传送带、本地物资、队列和相关物流航线，不返料且不可撤销；天然矿脉当前储量、殖民资料、科研、戴森工程、量子仓库、全局施工库存、随身舰队和蓝图保持不变。
- GameState v47、存档 envelope v2、cloud schema v8 与 SQLite layout v3 不变；香港/上海 Web/API、下载页、Windows stable 和 Android stable 已完成全量发布，完整证据见 [1.2.6 正式发布记录](./docs/releases/1.2.6.md)。

### 1.2.5（已发布，2026-08-30）

- 守恒纯挂机只放行符号不变且在精确样本中持续收敛的既有戴森账本差额；新出现、扩大或跨符号的差额仍会停止结算。
- 建筑制造巨构按三个精确窗口的实测最低供电与有限燃料/储能时长继续施工；科研完成不再无条件清空施工供电证明。
- 产率复制挂机会在复制终局成果前，以真实库存和锁定供电倍率递归推进建筑制造，不凭空生成施工材料。
- 模拟 Worker 的运行故障、超时和 durable 恢复异常会退还未提交时间、自动重建并继续；内容包校验错误与运行故障分离。
- 内存保护、Worker 恢复和纯挂机修复不再自动安装历史检查点；旧状态只允许玩家明确执行恢复时采用。
- 蓝图详细卡片改用自然高度行布局与有界溢出，修复密集桌面、超大数量、长参数/端口和放大字号下的信息错位。
- GameState v47、存档 envelope v2、cloud schema v8 与 SQLite layout v3 不变；完整证据见 [1.2.5 正式发布记录](./docs/releases/1.2.5.md)。

### 1.2.4（已发布，2026-08-29）

- 云存档单修订硬上限提高到 256 MiB，Web、Windows、Android、API 与活动 Nginx 共用有界压缩、解压、并发、响应和十分钟传输合同；96 MiB 保证线及 30 MiB 明文兼容兜底不变。
- 设置页和跨标签页只读提示新增明确的“强制接管本页”；接管先推进防覆盖令牌，再保存并读回本页状态，旧页立即只读且未提交纯挂机尾段不发收益。
- 内容包建筑可声明熔炉、制造台或化工设备族并复用同族通用配方，黑雾熔炉和制造台无需复制整套核心配方目录。
- 时间扭曲产率复制的物料白名单只包含宇宙矩阵、小型运载火箭和太阳帆；科研及逐恒星系戴森事件继续结算，矿石、燃料和普通中间件不再复制。
- 内存与模拟积压自动暂停改为设备默认关闭；缺失或损坏的偏好按关闭处理，玩家曾明确保存的开启/关闭选择继续保留，Worker、检查点与分配失败保护不变。
- GameState v47、存档 envelope v2、cloud schema v8 与 SQLite layout v3 不变；完整证据见 [1.2.4 正式发布记录](./docs/releases/1.2.4.md)。

### 1.1.5（已发布）

- 终局大存档保存改为 Worker 内精确稀疏投影、gzip 传输与有界校验，支持 `.json.gz` 导入/导出并降低主线程峰值。
- 超大终局档在内存风险过高时进入可取消的保守纯挂机宏观结算，不把不确定尾段伪装为精确收益。
- 银河综合榜采用五个公开指标等权的 `balanced-log-v2` 对数计分，移除隐藏探索/殖民加分。
- 香港/上海 Web/API、上海下载页、Windows 与 Android stable 已完成 1.1.5 发布；Android 实体设备门禁按用户授权豁免，Windows 按策略保持 `NotSigned`。
- 完整备份、健康、下载、PWA、回滚和观察证据见 [1.1.5 正式发布记录](./docs/releases/1.1.5.md)。

### 1.1.4（发布候选）

- 建筑制造巨构改为有界批处理并在多个制造中心间公平轮转，提升终局吞吐且保持库存、在制品、副产物和退款守恒。
- 蓝图预览、排队和部署保留模板显式传送带并联数；设备默认值只影响新绘制线路。
- 普通离线与纯挂机缺少可靠校准时先执行最多 1 秒隔离精确前缀，冻结不确定尾段且不提交半成品。
- 服务端账号查找使用权威复核的运行时索引，不改变数据库、会话、云存档或排行榜协议。
- 终局自动/手动保存直接使用可转移权威检查点，并只省略 v47 可精确恢复的非活动默认字段，降低大存档内存峰值。
- 云端保证档位提高到 64 MiB，单修订硬上限为 `96 MiB - 1024 B`；同步扩展 gzip、解压、并发、响应、超时和 Nginx 防线，30 MiB raw fallback 不变。
- Android 版本更新为 `1.1.4 / 1001004`。

### 1.0.46（本地候选，未发布）

- 修复 durable finalize/Worker 故障后只能刷新恢复的问题：当前页面会从 T0 recovery 精确回放、验证 T1 并原子重建模拟 Worker，暂停后可继续模拟。
- 修复新 Worker 沿用旧 `disabled` 标志导致的“durable 模拟 Worker 不可用”假失败。
- 默认保存保护模式下 revision 与 recovery head 的竞态改为安全重查，不再以截图中的阻断错误卡住会话。
- 保存期间允许继续操作（实验性）开启时，已接受编辑会在 recovery head 重建前一起保留；纯挂机恢复日志、宏观进度和导出保护不变。
- 更新 Android 版本为 `1.0.46 / 1000046`；不执行线上发布。

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
