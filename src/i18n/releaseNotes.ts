import type { AppLocale } from "./locale";

export interface LocalizedReleaseNoteRecord {
  id: string;
  date: string;
  version: string;
  title: string;
  summary: string;
  items: readonly { id: string; title: string; description: string }[];
}

export interface LocalizedReleaseNotesUiCopy {
  publicBeta: string;
  close: string;
  historyPagination: string;
  returnCurrent: string;
  viewHistory: string;
  page: (current: number, total: number) => string;
  jumpPageLabel: string;
  jumpPageOption: (page: number) => string;
  previous: string;
  next: string;
  previousAria: string;
  nextAria: string;
  releaseList: string;
  community: string;
  acknowledge: string;
}

const release114Copy = {
  date: { "zh-CN": "2026年8月23日", en: "August 23, 2026" },
  title: { "zh-CN": "终局制造、离线结算与大存档更新", en: "Endgame Construction, Offline Settlement, and Large Saves" },
  summary: {
    "zh-CN": "1.1.4 加速建筑制造巨构并让多个制造中心公平工作，修复蓝图传送带并联数被设备默认值覆盖的问题；离线与纯挂机在缺少可靠校准时先验证有界精确前缀，不再把未知尾段伪装成完整收益。终局保存减少大存档内存峰值并精确压缩可恢复默认字段，云端保证档位提高到 64 MiB、单修订硬上限提高到约 96 MiB；服务端账号查找改用可权威复核的运行时索引。GameState v47、存档 envelope v2、cloud schema v8 与 SQLite layout v3 不变。",
    en: "Version 1.1.4 accelerates construction megastructures, schedules multiple construction centers fairly, and prevents device belt defaults from overwriting blueprint lane counts. Offline and pure-idle fallback now validates a bounded exact prefix when calibration is unavailable instead of presenting an uncertain tail as complete gains. Endgame saving lowers large-save memory peaks and omits only exactly recoverable defaults; cloud support now guarantees 64 MiB saves with an approximately 96 MiB hard revision boundary. Server account lookup uses an authority-checked runtime index. GameState v47, save envelope v2, cloud schema v8, and SQLite layout v3 remain unchanged.",
  },
  constructionTitle: { "zh-CN": "多个建筑制造巨构持续公平施工", en: "Multiple construction megastructures build fairly" },
  constructionDescription: {
    "zh-CN": "制造请求按有界批次处理并在所有可用制造中心间轮转，不再让第一个中心独占工作；吞吐随合法堆叠与供料扩展，同时保持库存、在制品、副产物和取消退款守恒。",
    en: "Construction requests run in bounded batches and rotate across every available construction center, so the first center no longer monopolizes work. Throughput scales with valid stacks and supply while inventory, work in progress, byproducts, and cancellation refunds remain conserved.",
  },
  blueprintTitle: { "zh-CN": "蓝图保留模板传送带数量", en: "Blueprints preserve their belt lane counts" },
  blueprintDescription: {
    "zh-CN": "蓝图预览、排队和直接部署始终使用模板明确保存的并联数；设备级默认值只影响玩家新绘制的传送带，不再改写蓝图拓扑或造成错误扣料。",
    en: "Blueprint preview, queueing, and direct deployment always use the lane count stored by the template. The device default applies only to newly drawn belts and no longer rewrites blueprint topology or consumes the wrong materials.",
  },
  offlineTitle: { "zh-CN": "离线与纯挂机回退先验证精确前缀", en: "Offline fallback validates an exact prefix" },
  offlineDescription: {
    "zh-CN": "没有有效校准候选时，隔离 Worker 最多精确推进 1 个模拟秒并冻结不确定尾段；失败、取消或内存风险不会提交半成品，界面明确区分短窗口未测得、真实未运行和零收益跳过。",
    en: "When no valid calibration candidate exists, an isolated Worker advances at most one exact simulation second and freezes the uncertain tail. Failure, cancellation, or memory risk cannot commit partial state, and the UI distinguishes an unmeasured short window, truly idle production, and an explicit zero-gain skip.",
  },
  largeSaveTitle: { "zh-CN": "终局保存降低内存峰值", en: "Endgame saving lowers peak memory" },
  largeSaveDescription: {
    "zh-CN": "自动和手动保存直接消费模拟 Worker 的可转移权威检查点，不再创建第二份完整状态镜像；v47 只省略迁移器可精确恢复的非活动默认值，checksum、备份、读回和重载验证保持完整。",
    en: "Automatic and manual saves consume a transferable authoritative checkpoint directly from the simulation Worker instead of creating a second complete state mirror. v47 omits only inactive defaults that migration reconstructs exactly, while checksum, backup, read-back, and reload verification remain intact.",
  },
  cloudTitle: { "zh-CN": "云端支持更大的终局存档", en: "Cloud saves support larger endgame factories" },
  cloudDescription: {
    "zh-CN": "Web、Windows 和 Android 的有界传输合同保证 64 MiB 存档，单修订硬上限为 96 MiB 减 1 KiB；压缩、解压、并发、响应、超时与 Nginx 限制同步扩容，30 MiB 明文兼容兜底不变。",
    en: "The bounded Web, Windows, and Android transfer contract guarantees 64 MiB saves with a hard revision limit of 96 MiB minus 1 KiB. Compression, expansion, concurrency, response, timeout, and Nginx limits move together, while the 30 MiB raw compatibility fallback remains unchanged.",
  },
  serverTitle: { "zh-CN": "账号服务使用权威复核索引", en: "Account services use an authority-checked index" },
  serverDescription: {
    "zh-CN": "注册、登录、找回密码与邮箱绑定从运行时索引查找，再回到权威用户记录复核；冷启动、外部变更、删除和重建路径保持一致，不改变数据库结构、会话或玩家数据。",
    en: "Registration, sign-in, password recovery, and email binding use a runtime lookup index followed by verification against the authoritative user record. Cold start, external mutation, deletion, and rebuild paths stay coherent without changing the database layout, sessions, or player data.",
  },
  compatibilityTitle: { "zh-CN": "协议与存档格式保持兼容", en: "Save and online formats remain compatible" },
  compatibilityDescription: {
    "zh-CN": "本版不升级 GameState、存档封装、云 schema、SQLite layout 或 IndexedDB records；确定性、库存守恒、云修订和排行榜边界继续有效。",
    en: "This release does not upgrade GameState, the save envelope, cloud schema, SQLite layout, or IndexedDB records. Determinism, inventory conservation, cloud revision, and leaderboard boundaries remain active.",
  },
} as const;

const release1043Copy = {
  date: { "zh-CN": "2026年8月14日", en: "August 14, 2026" },
  title: { "zh-CN": "超大存档加载与保存紧急修复", en: "Large-save Loading and Saving Hotfix" },
  summary: {
    "zh-CN": "1.0.43 修复实体和传送带很多的超大存档在导入、进入工厂、保存和返回主页时长时间卡顿的问题，并保留原有存档校验、备份与异常线路退款语义。GameState v46、存档 envelope v2、云 schema v7 与 SQLite layout v2 不变。",
    en: "Version 1.0.43 fixes long stalls while importing, entering, saving, and returning to the menu with very large entity-and-belt saves, while preserving existing validation, backup, and invalid-belt refund semantics. GameState v46, save envelope v2, cloud schema v7, and SQLite layout v2 remain unchanged.",
  },
  migrationTitle: { "zh-CN": "超大线路迁移改为线性处理", en: "Large belt migrations now scale linearly" },
  migrationDescription: {
    "zh-CN": "载入迁移使用一次实体索引和按顺序分区，避免每条线路重复扫描全部实体和线路；实体、线路、物流端口与黑洞端口的原始顺序和首条有效线路优先规则保持不变。",
    en: "Load migration now builds one entity index and partitions belts in order instead of repeatedly scanning every entity and belt. Entity and belt order, logistics-port behavior, and first-valid black-hole connection precedence remain unchanged.",
  },
  importTitle: { "zh-CN": "导入与云端恢复不再冻结界面", en: "Imports and cloud restores no longer freeze the interface" },
  importDescription: {
    "zh-CN": "本地文件与云端存档检查移到后台线程，连续选择时只有最后一次请求可以提交结果；后台线程不可用时仍会回退到原有完整检查。",
    en: "Local-file and cloud-save inspection now runs in a background worker, and only the latest selection may commit its result. Environments without worker support retain the original full-validation fallback.",
  },
  saveTitle: { "zh-CN": "立即保存与返回主页避免重复落盘", en: "Manual saves and menu returns avoid duplicate commits" },
  saveDescription: {
    "zh-CN": "立即保存只提交一次验证写入；返回主页只在已提交状态仍覆盖卸载瞬间状态时跳过清理保存，等待期间若游戏继续推进仍会补写最新状态。备份继续要求完整结构校验和逐字持久读回。",
    en: "Save Now performs one verified commit. Returning to the menu skips cleanup persistence only when the committed source still covers the unmount state; if play advances while the save is pending, the latest state is still persisted. Backups continue to require full structural validation and exact durable read-back.",
  },
  compatibilityTitle: { "zh-CN": "存档与在线协议保持兼容", en: "Save and online protocols remain compatible" },
  compatibilityDescription: {
    "zh-CN": "不升级 GameState、存档封装、云服务或 IndexedDB 结构；模式、库存、checksum、原始数据、异常线路退款、物质投递枢纽与黑洞端口语义保持不变。",
    en: "This hotfix does not upgrade GameState, the save envelope, cloud services, or IndexedDB layout. Mode, inventory, checksum, raw data, invalid-belt refunds, material-delivery hubs, and black-hole port semantics remain unchanged.",
  },
} as const;

const release1046Copy = {
  date: { "zh-CN": "2026年8月17日", en: "August 17, 2026" },
  title: { "zh-CN": "存档稳定性与手机连续拉线热修", en: "Save Stability and Mobile Belt Batch Hotfix" },
  summary: {
    "zh-CN": "1.0.46 将普通游戏恢复为 1.0.43-compatible 的验证主存档协调器，修复自动保存后模拟被暂停、暂停后 Worker 无法恢复，以及保存失败污染纯挂机状态的问题；durable WAL 仅保留为显式开发验证路径。手机连续拉线改为不遮挡地图的可折叠底栏，重复或无效点击不会破坏已有候选，6～100 条候选可完整查看和原子提交。画布卡片、重叠处理和交互展开现可分别设置，重叠位置保留紧凑数量入口；交互卡片不会再变淡、消失或阻断画布拖动。纯挂机戴森功率不再显示错误的桶间负增量，普通空间站合同也可由玩家确认后从量子库存交付。GameState v47、存档 envelope v2、cloud schema v8 与 SQLite layout v3 不变。",
    en: "Version 1.0.46 restores the 1.0.43-compatible verified-primary coordinator for normal play, fixing autosaves that paused simulation, Workers that could not resume after a pause, and save failures that polluted pure-idle status. The durable WAL remains an explicit development-only validation path. Mobile continuous connections now use a collapsible non-blocking bottom bar; duplicate or invalid taps preserve valid candidates, and 6-100 candidates remain inspectable and atomically committable. Canvas presentation controls are independent, pure-idle Dyson power no longer shows a false between-bucket negative gain, and confirmed quantum inventory can fulfill ordinary station contracts. GameState v47, save envelope v2, cloud schema v8, and SQLite layout v3 remain unchanged.",
  },
  recoveryTitle: { "zh-CN": "自动保存保持模拟运行", en: "Autosaves keep simulation running" },
  recoveryDescription: {
    "zh-CN": "默认路径从模拟 Worker 取得权威检查点，再由保存 Worker 写入并逐字读回验证；自动保存前正在运行的模拟在保存期间和完成后都保持运行，玩家主动暂停仍原样保留。",
    en: "The default path obtains an authoritative simulation-Worker checkpoint, then has the save Worker write and read it back exactly. A simulation running before autosave stays running throughout and afterward, while an intentional player pause remains intact.",
  },
  workerTitle: { "zh-CN": "Worker 状态自动解锁", en: "Worker state self-heals" },
  workerDescription: {
    "zh-CN": "每次新 Worker 安装都会清除旧实例的 disabled 标志；暂停、恢复、保存和 Worker 重建不再被旧失败状态卡住。",
    en: "Every new Worker installation clears the previous instance's disabled latch, so pause, resume, save, and Worker rebuilds are no longer blocked by stale failure state.",
  },
  saveTitle: { "zh-CN": "默认保护与实验性编辑都安全", en: "Protected and experimental save modes stay safe" },
  saveDescription: {
    "zh-CN": "默认关闭时，保存进行中的编辑会被明确拒绝但模拟不会暂停；开启“保存期间允许继续操作”后，已接受操作会保留，保存失败也不回滚当前进度，并可立即导出。",
    en: "With the default setting off, edits attempted during persistence are explicitly rejected without pausing simulation. When Allow editing while saving is enabled, accepted actions remain intact; a failed save does not roll back progress and can be exported immediately.",
  },
  batchTitle: { "zh-CN": "手机连续拉线不再遮挡地图", en: "Mobile continuous connections no longer block the map" },
  batchDescription: {
    "zh-CN": "手机只挂载一个可折叠底部操作面，展开后可滚动查看全部候选并定位或移除任意一条。重复、已有线路、不兼容或缺料点击只给临时提示，不会禁用此前有效候选；最终确认仍做严格原子复核。",
    en: "Mobile mounts one collapsible bottom action surface. Its expanded list scrolls through every candidate and can locate or remove any entry. Duplicate, existing-line, incompatible, or under-stock taps give temporary feedback without disabling earlier valid candidates; final confirmation still performs strict atomic revalidation.",
  },
  canvasTitle: { "zh-CN": "画布显示可独立控制", en: "Canvas presentation controls are independent" },
  canvasDescription: {
    "zh-CN": "基础卡片、重叠建筑和选择/悬停展开不再混在一个自动档中。重叠组默认留下紧凑的层叠图标与数量；选中或悬停展开的卡片会保持清晰、稳定置顶，不再被网络聚焦误变淡、被附近建筑盖住或瞬间消失，淡化的背景卡也不会卡住画布拖动。一行卡显示配方与产物且不会再被裁成半截；空白视角可用适应全部或小地图恢复，完整卡片与全部重叠在极密集视口下会统一降级以防卡死。",
    en: "Base card detail, overlapping buildings, and selection or hover expansion are no longer mixed into one automatic mode. Overlap groups keep a compact layers-and-count marker by default. Selected or hovered cards stay clear and above nearby buildings instead of being dimmed by network focus, covered, or made to vanish; dimmed context cards no longer trap canvas panning. One-line cards identify their recipe and products without clipping. Blank saved views can recover through Fit View or the minimap, while Full plus All Overlaps uses a uniform safety level in extremely dense views to prevent freezes.",
  },
  idleTitle: { "zh-CN": "纯挂机日志与宏观进度保留", en: "Pure-idle logs and macro progress are preserved" },
  idleDescription: {
    "zh-CN": "纯挂机终态保存仍要求主存档验证、Worker 接管和恢复日志提交全部完成；失败时可继续重试或立即导出，不会清空当前进度。",
    en: "Pure-idle terminal saves still require verified primary persistence, Worker hand-off, and recovery-log commit. Failures remain retryable and exportable without clearing current progress.",
  },
  progressTitle: { "zh-CN": "生产周期按真实时间验证", en: "Production cycles follow measured time" },
  progressDescription: {
    "zh-CN": "经典进度条继续使用同一个值驱动无障碍数值、文字与填充。跨周期回绕按浏览器实测时间、配方周期和权威发布窗口判定，不会再把调度延迟误报为倒退，也不会放过无法由回绕解释的真实回退。",
    en: "Classic progress bars still drive accessibility, text, and fill from one value. Wraps are validated against in-page timestamps, recipe speed, and the authority publication window, preventing scheduler delays from looking like regressions while still rejecting backsteps that no wrap can explain.",
  },
  idleOutputTitle: { "zh-CN": "终局功率使用已结算快照", en: "Endgame power uses committed snapshots" },
  idleOutputDescription: {
    "zh-CN": "戴森功率与在轨数量是可升可降的瞬时状态，不再沿上一结算桶的负斜率外推；界面明确标注 30 秒已结算快照，累计产出计数仍可平滑插值。",
    en: "Dyson power and orbital populations are non-monotonic instantaneous state and are no longer extrapolated from a previous bucket's negative slope. The UI labels the committed 30-second snapshot while cumulative output counters continue to interpolate safely.",
  },
  stationDeliveryTitle: { "zh-CN": "普通合同支持量子库存兜底", en: "Quantum inventory can backstop ordinary contracts" },
  stationDeliveryDescription: {
    "zh-CN": "每日前三份普通合同，包括指定来源行星的订单，都可由玩家预览并确认后从量子共享库存交付；来源行星限制仍只约束自动货运终端，量子专属合同也仍拒绝终端绕过。",
    en: "All three ordinary daily contracts, including source-planet orders, can be previewed and fulfilled from shared quantum inventory after confirmation. Source restrictions still constrain automatic cargo terminals, and quantum-only contracts still reject terminal delivery.",
  },
  compatibilityTitle: { "zh-CN": "协议与存档格式保持兼容", en: "Save and online formats remain compatible" },
  compatibilityDescription: {
    "zh-CN": "本热修不升级 GameState、存档封装、云 schema、SQLite layout 或 IndexedDB records；回放、checksum、writer lease 和跨标签保护继续有效。",
    en: "This hotfix does not upgrade GameState, the save envelope, cloud schema, SQLite layout, or IndexedDB records. Replay, checksums, writer leases, and cross-tab protection remain active.",
  },
} as const;

const release1045Copy = {
  date: { "zh-CN": "2026年8月17日", en: "August 17, 2026" },
  title: { "zh-CN": "全星系空间站扩展", en: "Global Orbital Station Expansion" },
  summary: {
    "zh-CN": "1.0.45 加入全星系唯一空间站：三阶段建设、轨道货运终端、量子手动交付、每日出口合同、徽记与声望、装饰画布，以及脱敏公开主页和轻社交。普通存档升级到 GameState v47，服务端升级到 cloud schema v8 / SQLite layout v3；同时提供 M0 桥接开关，可构建不升级 v46 的兼容版本。",
    en: "Version 1.0.45 adds a single global orbital station: three-stage construction, planetary cargo terminals, manual quantum deliveries, daily export contracts, marks and reputation, a decoration canvas, plus a sanitized public profile and light social features. Normal saves upgrade to GameState v47 and the server moves to cloud schema v8 / SQLite layout v3. An M0 bridge switch is included so a compatible build can keep v46 saves unchanged.",
  },
  stationTitle: { "zh-CN": "全星系唯一空间站", en: "One orbital station for the whole save" },
  stationDescription: {
    "zh-CN": "空间站不属于任何单一行星；普通档首次生产宇宙矩阵后获得建设资格，按轨道核心、物资出口港、展示舱段依次施工。速通模式不开放。",
    en: "The station is not tied to a single planet. Normal saves become eligible after the first universe matrix is produced, then build through core, export dock, and showcase stages. Speedrun mode is excluded.",
  },
  contractsTitle: { "zh-CN": "出口合同与双轨经济", en: "Export contracts and dual-track economy" },
  contractsDescription: {
    "zh-CN": "每日 3 份普通合同和 1 份特殊合同，最多同时接受 3 份；可通过轨道货运终端或量子库存手动交付。轨道徽记用于购买装饰，空间站声望只增不减并决定等级与容量。",
    en: "Each day offers three normal contracts and one special contract with up to three active. Delivery uses cargo terminals or manual quantum inventory. Orbital marks buy decorations, while reputation only grows and drives station level and capacity.",
  },
  publicTitle: { "zh-CN": "脱敏公开主页与轻社交", en: "Sanitized public profile and light social" },
  publicDescription: {
    "zh-CN": "登录玩家可发布只读空间站主页，公开安全聚合指标、布局和精选成就，不暴露完整存档、库存或账号隐私；支持独立隐私开关、幂等收藏和固定通讯信号。",
    en: "Signed-in players can publish a read-only station page with safe aggregate metrics, layout, and featured achievements, without exposing full saves, inventory, or account privacy. Independent privacy, idempotent favorites, and preset signals are included.",
  },
  bridgeTitle: { "zh-CN": "M0 兼容桥接", en: "M0 compatibility bridge" },
  bridgeDescription: {
    "zh-CN": "默认写入 GameState v47；设置 `VITE_SPACE_STATION_ENABLED=false` 可构建桥接版，读取 v46 时继续写 v46，读取 v47 时原样保留。",
    en: "v47 is written by default. Set `VITE_SPACE_STATION_ENABLED=false` to build a bridge version that keeps v46 saves on v46 and preserves existing v47 saves.",
  },
  compatibilityTitle: { "zh-CN": "存档与在线协议版本升级", en: "Save and online protocol versions" },
  compatibilityDescription: {
    "zh-CN": "本版升级 GameState v47、cloud schema v8 与 SQLite layout v3；发布前必须先完成跨端桥接 rollout，回滚目标必须是能读取 v47 的桥接版。",
    en: "This release upgrades GameState to v47, cloud schema to v8, and SQLite layout to v3. Cross-client bridge rollout must complete before stable release, and the rollback target must be a v47-capable bridge build.",
  },
} as const;

const currentCopy = {
  date: { "zh-CN": "2026年8月15日", en: "August 15, 2026" },
  title: { "zh-CN": "超大工厂运行态与保存性能优化", en: "Large-factory Runtime and Save Performance" },
  summary: {
    "zh-CN": "1.0.44 让超大工厂的主动运行不阻塞主线程：模拟、离线、保存与纯挂机使用授权的后台与模拟 Worker，主线程不再解析或序列化大存档，后台纯挂机宽限到期也走同一条 Worker 权威结算与接管。画布密集视口、连线 LOD 与默认工厂警报在超大终局工厂下显著降低渲染和投影开销。GameState v46、存档 envelope v2、云 schema v7 与 SQLite layout v2 不变。",
    en: "Version 1.0.44 keeps large-factory runtime responsive on the main thread: simulation, offline settlement, saving, and pure idle use authoritative background and simulation workers, so the UI thread no longer parses or serializes large saves, and the background grace-expired pure-idle path now follows the same worker-owned terminal settle and hand-off. Dense viewport, connection LOD, and steady factory-alert projections cut rendering and payload overhead on large endgame factories. GameState v46, save envelope v2, cloud schema v7, and SQLite layout v2 remain unchanged.",
  },
  runtimeTitle: { "zh-CN": "大存档全程由 Worker 作为权威", en: "Large saves stay authoritative in Workers" },
  runtimeDescription: {
    "zh-CN": "实时模拟、普通离线、纯挂机和保存均在后台 Worker 内解码、结算与序列化，主线程只收到有界镜像与结果，不再整体解析或重写大存档；即使长时间后台纯挂机宽限到期，也按与主动停止相同的 Worker 权威终止并接管模拟。",
    en: "Realtime simulation, ordinary offline, pure idle, and saving decode, settle, and serialize inside background Workers; the UI thread only receives bounded mirrors and results and never fully parses or rewrites a large save. Even when a long backgrounded pure-idle grace expires, the terminal settle and simulation hand-off follow the same worker-authoritative path as an explicit stop.",
  },
  saveTitle: { "zh-CN": "启动恢复与读取按需投影", en: "Startup recovery and on-demand projection" },
  saveDescription: {
    "zh-CN": "启动恢复日志在 Worker 中压缩与复核，主线程完全不解析大档；运行中的工厂按需投影权威结果，超大工厂的画布与界面只在视口需要时生成完整卡片。",
    en: "Startup recovery journals are compressed and verified inside a Worker with no main-thread large-save parsing, and the running factory projects authoritative results on demand so large factories only build full cards when they enter the viewport.",
  },
  macroTitle: { "zh-CN": "超大工厂命令面板更流畅", en: "Faster command palette in huge factories" },
  macroBroadcastDescription: {
    "zh-CN": "命令面板在超大工厂空搜索时不再构建全部实体命令，输入定位仍保持即时应答。",
    en: "The command palette no longer builds a command per entity on an empty search in huge factories, keeping input and entity-locate responsive.",
  },
  compatibilityTitle: { "zh-CN": "存档与在线协议保持兼容", en: "Save and online protocols remain compatible" },
  compatibilityDescription: {
    "zh-CN": "不升级 GameState、存档封装、云服务或 IndexedDB 结构；模式、库存、checksum、后台宽限、纯挂机恢复日志与排行榜语义保持不变。",
    en: "GameState, the save envelope, cloud services, and IndexedDB layout are unchanged; mode, inventory, checksum, background grace, pure-idle recovery journals, and leaderboard semantics remain intact.",
  },
} as const;

const release1042Copy = {
  date: { "zh-CN": "2026年8月14日", en: "August 14, 2026" },
  title: { "zh-CN": "界面适配、存档恢复与规则更新", en: "Responsive UI, Save Recovery, and Rules Update" },
  summary: {
    "zh-CN": "1.0.42 在界面适配、移动导航、无障碍和中文输入优化之外，修复大存档首存误判跨标签冲突与未提交时间扭曲预算阻塞离线结算；增产剂缓存支持 100 万预设和最高 1 亿自定义值，无限矿物速通成绩可提交并带明确标签。GameState v46、存档 envelope v2、云 schema v7 与 SQLite layout v2 不变。",
    en: "Version 1.0.42 combines responsive UI, mobile navigation, accessibility, and IME improvements with fixes for false cross-tab conflicts during large first saves and orphaned time-warp debt blocking offline settlement. Proliferator buffers gain a one-million preset and custom limits up to 100 million, while infinite-resource speedruns can be submitted with an explicit label. GameState v46, save envelope v2, cloud schema v7, and SQLite layout v2 remain unchanged.",
  },
  shellTitle: { "zh-CN": "工作区跟随真实顶栏与托盘", en: "Workspaces follow the real shell bounds" },
  shellDescription: {
    "zh-CN": "主线、资料库、科技、蓝图、星图、统计、银河、运营和制造中心统一读取壳层动态高度；80%～200% 字号和常见桌面分辨率不再遮住关闭按钮、标签或内容。",
    en: "Campaign, codex, technology, blueprints, star map, statistics, Galaxy, operations, and construction center now read dynamic shell heights, preventing controls and content from being covered at 80%–200% text scale and common desktop resolutions.",
  },
  navigationTitle: { "zh-CN": "手机命令跳转一次完成", en: "Mobile command navigation completes atomically" },
  navigationDescription: {
    "zh-CN": "命令面板切换到工作区、物资抽屉或检查器时使用一次 history 替换；关闭面板不会再追加返回动作，浏览器返回、页面返回和实体定位保持同一导航栈。",
    en: "Moving from the command palette to a workspace, inventory sheet, or inspector now uses one history replacement. Closing the palette no longer adds a second back action, while browser back, UI back, and entity focus share the same stack.",
  },
  accessibilityTitle: { "zh-CN": "背景失活与焦点边界统一", en: "Unified inert background and focus boundaries" },
  accessibilityDescription: {
    "zh-CN": "全屏工作区使用共享模态框架：被覆盖的工厂画布会 inert 并从无障碍树隐藏，Tab 保持在当前工作区，嵌套确认框和悬浮 Portal 可正常使用，关闭后恢复原焦点。",
    en: "Full-screen workspaces use a shared modal frame: the covered factory becomes inert and hidden from assistive technology, Tab stays within the active workspace, nested confirmations and tooltip portals remain usable, and focus returns on close.",
  },
  responsiveTitle: { "zh-CN": "窄屏、高字号和触控操作收口", en: "Narrow, large-text, and touch layouts refined" },
  responsiveDescription: {
    "zh-CN": "统计时间范围、资料库分类、蓝图操作、戴森横屏、更新公告和制造中心在窄屏下改为可滚动或重排；手机主要操作保持至少 44×44px 命中区。",
    en: "Statistics ranges, codex categories, blueprint actions, Dyson landscape layouts, release notes, and construction-center controls now scroll or reflow on narrow screens, with primary mobile targets kept at least 44×44 px.",
  },
  inputTitle: { "zh-CN": "中文输入与页面草稿更稳定", en: "More stable IME input and in-page drafts" },
  inputDescription: {
    "zh-CN": "蓝图名称、统计书签与规划、账号资料和搜索输入在组合输入、失焦、横竖屏与全屏变化期间保留页面内草稿；提交、取消或主动清空后才移除，密码不进入共享草稿或日志。",
    en: "Blueprint names, statistics bookmarks and plans, account details, and search fields retain in-page drafts through IME composition, blur, orientation, and fullscreen changes. Drafts clear only on submit, cancel, or explicit reset; passwords never enter shared drafts or logs.",
  },
  versionTitle: { "zh-CN": "版本信息与回归夹具一致", en: "Version metadata and QA fixtures aligned" },
  versionDescription: {
    "zh-CN": "教程展示真实应用版本，阅读进度按独立内容修订保存；Web version.json、PWA、Android 与 Windows 构建使用同一版本源。预览测试改为一次性正式存储注入，刷新不再制造多写入者冲突。",
    en: "The tutorial displays the real app version while progress uses an independent content revision. Web version.json, PWA, Android, and Windows builds share one version source, and preview fixtures seed official storage once so reloads no longer create false multi-writer conflicts.",
  },
  largeSaveRecoveryTitle: { "zh-CN": "35 MiB 首存不再误判跨标签冲突", en: "35 MiB first saves no longer look like cross-tab conflicts" },
  largeSaveRecoveryDescription: {
    "zh-CN": "同一写入者因解析、结构化复制或 IndexedDB 写入超过 15 秒时可安全续租；真实其他标签页仍会阻止覆盖。冲突恢复按钮显示处理中、成功或具体失败原因，候选只有在逐字读回和 checksum 验证后才提交并清理副本。",
    en: "The same writer can safely renew its lease after parsing, structured cloning, or IndexedDB work exceeds 15 seconds, while a real second tab still blocks overwrites. Recovery actions now show progress, success, or a concrete failure, and candidate copies are removed only after exact read-back and checksum verification.",
  },
  timeWarpRecoveryTitle: { "zh-CN": "未提交时间扭曲预算可安全恢复", en: "Orphaned time-warp debt recovers safely" },
  timeWarpRecoveryDescription: {
    "zh-CN": "有效纯挂机日志继续独占原时间线；日志缺失或失效时回到最后有效主档，只把真实墙钟时间交给一次普通离线结算，未提交高倍率预算不会重复发放。自动核对失败时可明确选择“恢复检查点并快速结算”。",
    en: "A valid pure-idle journal continues to own its timeline. If that journal is missing or stale, the game returns to the last valid main-save checkpoint and submits real wall time to ordinary offline settlement exactly once without replaying uncommitted acceleration. If automatic inspection fails, an explicit Restore Checkpoint and Fast Settle action is offered.",
  },
  proliferatorBufferTitle: { "zh-CN": "增产剂缓存上限扩展", en: "Expanded proliferator buffer limits" },
  proliferatorBufferDescription: {
    "zh-CN": "设置新增 100 万预设，并支持 1～100,000,000 的正整数自定义上限和明确错误提示；只改变已安装增产剂槽的容量，不改变倍率、消耗或补充逻辑。",
    en: "Settings now include a one-million preset and validated positive-integer custom limits from 1 to 100,000,000. Only installed proliferator-slot capacity changes; multipliers, consumption, and refill behavior do not.",
  },
  infiniteSpeedrunTitle: { "zh-CN": "无限矿物速通可进入正式榜", en: "Infinite-resource speedruns can enter the official board" },
  infiniteSpeedrunDescription: {
    "zh-CN": "客户端与服务端取消无限矿物禁入规则，服务器从权威速通主云档读取资源模式并给成绩显示“无限矿物”标签；普通银河榜、普通/速通存档隔离和其他公平性校验保持不变。",
    en: "Client and server no longer reject infinite-resource speedruns. The server derives resource mode from the authoritative speedrun main cloud save and labels those results as Infinite Resources, without changing the normal Galaxy board, mode isolation, or other integrity checks.",
  },
} as const;

const copy = {
  date: {
    "zh-CN": "2026年8月13日",
    en: "August 13, 2026",
  },
  title: {
    "zh-CN": "大存档、离线选择与连续拉线体验更新",
    en: "Large Saves, Offline Choices, and Continuous Connections",
  },
  summary: {
    "zh-CN": "1.0.41 让合法 32 MiB 以上大存档通过有界 gzip 上传并显示完整同步诊断，进入游戏前可明确选择快速、精确或放弃离线收益，同时加入自适应端口命中、原子连续拉线和移动输入草稿保护。纯挂机五分钟后台规则、玩法平衡、GameState v46、存档 envelope v2、云 schema v7 与 SQLite layout v2 不变。",
    en: "Version 1.0.41 adds bounded gzip upload and complete sync diagnostics for valid saves above 32 MiB, an explicit fast/exact/forfeit offline choice before entering the game, adaptive port hit targets, atomic continuous connections, and safer mobile text drafts. The five-minute background rule for time-warp idle, game balance, GameState v46, save envelope v2, cloud schema v7, and SQLite layout v2 remain unchanged.",
  },
  leaderboardTitle: {
    "zh-CN": "云存档状态中心",
    en: "Cloud-save status center",
  },
  leaderboardDescription: {
    "zh-CN": "主菜单和银河网络显示当前模式与槽位、本地/云端修订、最近成功时间、上传/确认/冲突/失败/恢复状态，并可安全重试、取消、分别导出本地和云端副本或复制不含正文与凭据的诊断。",
    en: "The start menu and Galaxy network now show mode and slot, local/cloud revisions, last success, upload/confirmation/conflict/failure/recovery states, safe retry and cancel, separate local/cloud exports, and a redacted diagnostic with no payload or credentials.",
  },
  transferTitle: {
    "zh-CN": "32 MiB 以上大存档可安全上传",
    en: "Saves above 32 MiB upload safely",
  },
  transferDescription: {
    "zh-CN": "Web、Windows 与 Android 共用 48 MiB 保证档位、约 64 MiB 单修订硬边界、gzip 预检和动态超时。服务端按请求数和解压后字节双重限流，失败会列出原始、压缩、解压、上限和差值，旧云修订与本地存档不变。",
    en: "Web, Windows, and Android share a 48 MiB guaranteed tier, an approximately 64 MiB hard revision boundary, gzip preflight, and adaptive timeouts. The server bounds both request count and expanded bytes; failures report original, compressed, expanded, limit, and delta while preserving the local save and previous cloud revision.",
  },
  localSaveTitle: {
    "zh-CN": "离线收益由玩家明确选择",
    en: "Players choose how offline rewards settle",
  },
  localSaveDescription: {
    "zh-CN": "普通模式超过一分钟的离线区间在载入前提供快速（推荐）、精确和放弃收益三种选择。快速失败会说明原因并允许再次快速尝试；取消不消费区间，放弃收益必须二次确认，精确结算可安全取消。",
    en: "Normal-mode offline intervals over one minute offer Fast (recommended), Exact, or Forfeit before loading. A failed fast run explains why and can be retried; cancel preserves the interval, forfeiting requires a second confirmation, and exact settlement remains safely cancellable.",
  },
  persistenceTitle: {
    "zh-CN": "传送带端口更容易点中",
    en: "Belt ports are easier to target",
  },
  persistenceDescription: {
    "zh-CN": "连接点视觉大小和透明命中范围分开设置；自动档随画布缩放扩大，触控至少提供 56px 命中直径。悬停与拉线提示仍按物品和输入/输出类型校验，不遮挡建筑文字。",
    en: "Visible port size and transparent hit targets are separate settings. Auto mode grows with canvas zoom and guarantees a 56 px touch diameter. Hover and connection hints remain item- and direction-aware without covering building labels.",
  },
  securityTitle: {
    "zh-CN": "连续拉线整批原子提交",
    en: "Continuous connections commit atomically",
  },
  securityDescription: {
    "zh-CN": "选择一个输出后可连续点选多个兼容输入，Enter 或按钮统一确认，Esc 取消；预览显示线路与材料。任一候选非法或材料不足时整批不创建、不扣料，也不会改目标配方或物流槽。",
    en: "Choose one output, then select multiple compatible inputs and confirm once with Enter or the button; Escape cancels. The preview reports lines and material. If any candidate is invalid or stock is insufficient, nothing is created or consumed, and target recipes or logistics slots are never rewritten.",
  },
  experienceTitle: {
    "zh-CN": "手机输入不再被重绘清空",
    en: "Mobile text survives responsive redraws",
  },
  experienceDescription: {
    "zh-CN": "搜索、注册和档案输入在中文输入法组合、父组件刷新、横竖屏与新版/经典手机界面切换时保留页面内草稿；只有提交、取消或主动清空才移除。密码始终不进入普通草稿或诊断。",
    en: "Search, registration, and profile fields keep in-page drafts through IME composition, parent refreshes, orientation changes, and classic/new mobile layouts. Drafts clear only on submit, cancel, or explicit reset. Passwords never enter shared drafts or diagnostics.",
  },
  v1039Date: {
    "zh-CN": "2026年8月11日",
    en: "August 11, 2026",
  },
  v1039Title: {
    "zh-CN": "云存档稀疏格式紧急修复",
    en: "Emergency Sparse Cloud-save Fix",
  },
  v1039Summary: {
    "zh-CN": "1.0.39 修复 1.0.38 客户端生成的合法 v46 稀疏云存档被服务端错误拒绝的问题，并让普通/速通排行榜复核 revision 按模式独立。服务端不改写原始正文、checksum、revision 或历史记录；GameState v46、存档 envelope v2、云 schema v7 与 SQLite layout v2 不变。",
    en: "Version 1.0.39 fixed the server incorrectly rejecting valid sparse v46 cloud saves produced by 1.0.38 clients, and separated leaderboard review revisions by normal and speedrun mode. The server does not rewrite payloads, checksums, revisions, or history; GameState v46, save envelope v2, cloud schema v7, and SQLite layout v2 remain unchanged.",
  },
  v1039SparseTitle: {
    "zh-CN": "合法稀疏云存档恢复上传",
    en: "Valid sparse cloud saves upload again",
  },
  v1039SparseDescription: {
    "zh-CN": "v46 线路缺失 lanes/tier/progress 时只在结构校验读取 1/1/0 默认值，实体缺失 interactionLocked 时读取 false；显式 null、字符串、0、负数和越界值仍拒绝。",
    en: "For v46 belts, structural validation reads missing lanes/tier/progress as 1/1/0 and missing entity interactionLocked as false. Explicit nulls, strings, invalid zeroes, negative values, and out-of-range values remain rejected.",
  },
  v1039IdentityTitle: {
    "zh-CN": "上传原文与历史保持不变",
    en: "Uploaded bytes and history stay unchanged",
  },
  v1039IdentityDescription: {
    "zh-CN": "完整性检查仍先于结构校验，服务端不会规范化或重算正文；云 SHA-256、revision、冲突检测、历史恢复和下载正文继续逐字节一致。",
    en: "Integrity checks still run before structural validation, and the server neither normalizes nor recomputes the payload. Cloud SHA-256, revisions, conflict detection, restored history, and downloaded bytes remain identical.",
  },
  v1039ReviewTitle: {
    "zh-CN": "排行榜复核按模式隔离",
    en: "Leaderboard review is mode-isolated",
  },
  v1039ReviewDescription: {
    "zh-CN": "普通与速通 main 使用各自 revision 阈值；一个模式上传或恢复不会提前解除另一模式的复核等待，隐藏和永久冻结规则保持不变。",
    en: "Normal and speedrun main saves use separate revision thresholds. Uploading or restoring one mode cannot clear review for the other; hidden and permanently frozen rules remain unchanged.",
  },
} as const;

type CopyKey = keyof typeof copy;

function message(locale: AppLocale, key: CopyKey): string {
  return copy[key][locale];
}

function release1044Message(locale: AppLocale, key: keyof typeof currentCopy): string {
  return currentCopy[key][locale];
}

function currentMessage(locale: AppLocale, key: keyof typeof release114Copy): string {
  return release114Copy[key][locale];
}

function release1046Message(locale: AppLocale, key: keyof typeof release1046Copy): string {
  return release1046Copy[key][locale];
}

function release1045Message(locale: AppLocale, key: keyof typeof release1045Copy): string {
  return release1045Copy[key][locale];
}

function release1043Message(locale: AppLocale, key: keyof typeof release1043Copy): string {
  return release1043Copy[key][locale];
}

function release1042Message(locale: AppLocale, key: keyof typeof release1042Copy): string {
  return release1042Copy[key][locale];
}

/** Stable-key release copy; current text does not use the legacy DOM translation bridge. */
export function getCurrentReleaseNotes(locale: AppLocale): LocalizedReleaseNoteRecord {
  return {
    id: "2026-08-23-v1.1.4",
    date: currentMessage(locale, "date"),
    version: "1.1.4",
    title: currentMessage(locale, "title"),
    summary: currentMessage(locale, "summary"),
    items: [
      { id: "construction-megastructure-fairness", title: currentMessage(locale, "constructionTitle"), description: currentMessage(locale, "constructionDescription") },
      { id: "blueprint-belt-lanes", title: currentMessage(locale, "blueprintTitle"), description: currentMessage(locale, "blueprintDescription") },
      { id: "bounded-offline-prefix", title: currentMessage(locale, "offlineTitle"), description: currentMessage(locale, "offlineDescription") },
      { id: "large-save-low-memory", title: currentMessage(locale, "largeSaveTitle"), description: currentMessage(locale, "largeSaveDescription") },
      { id: "large-cloud-save", title: currentMessage(locale, "cloudTitle"), description: currentMessage(locale, "cloudDescription") },
      { id: "authority-checked-user-index", title: currentMessage(locale, "serverTitle"), description: currentMessage(locale, "serverDescription") },
      { id: "version-upgrade", title: currentMessage(locale, "compatibilityTitle"), description: currentMessage(locale, "compatibilityDescription") },
    ],
  };
}

export function getReleaseNotes1046(locale: AppLocale): LocalizedReleaseNoteRecord {
  return {
    id: "2026-08-17-v1.0.46",
    date: release1046Message(locale, "date"),
    version: "1.0.46",
    title: release1046Message(locale, "title"),
    summary: release1046Message(locale, "summary"),
    items: [
      { id: "in-page-durable-recovery", title: release1046Message(locale, "recoveryTitle"), description: release1046Message(locale, "recoveryDescription") },
      { id: "worker-rebuild", title: release1046Message(locale, "workerTitle"), description: release1046Message(locale, "workerDescription") },
      { id: "save-modes", title: release1046Message(locale, "saveTitle"), description: release1046Message(locale, "saveDescription") },
      { id: "mobile-batch-connections", title: release1046Message(locale, "batchTitle"), description: release1046Message(locale, "batchDescription") },
      { id: "canvas-presentation", title: release1046Message(locale, "canvasTitle"), description: release1046Message(locale, "canvasDescription") },
      { id: "pure-idle-preservation", title: release1046Message(locale, "idleTitle"), description: release1046Message(locale, "idleDescription") },
      { id: "time-aware-cycle-progress", title: release1046Message(locale, "progressTitle"), description: release1046Message(locale, "progressDescription") },
      { id: "committed-terminal-output", title: release1046Message(locale, "idleOutputTitle"), description: release1046Message(locale, "idleOutputDescription") },
      { id: "ordinary-contract-quantum-delivery", title: release1046Message(locale, "stationDeliveryTitle"), description: release1046Message(locale, "stationDeliveryDescription") },
      { id: "version-upgrade", title: release1046Message(locale, "compatibilityTitle"), description: release1046Message(locale, "compatibilityDescription") },
    ],
  };
}

export function getReleaseNotes1045(locale: AppLocale): LocalizedReleaseNoteRecord {
  return {
    id: "2026-08-17-v1.0.45",
    date: release1045Message(locale, "date"),
    version: "1.0.45",
    title: release1045Message(locale, "title"),
    summary: release1045Message(locale, "summary"),
    items: [
      { id: "global-orbital-station", title: release1045Message(locale, "stationTitle"), description: release1045Message(locale, "stationDescription") },
      { id: "contracts-and-economy", title: release1045Message(locale, "contractsTitle"), description: release1045Message(locale, "contractsDescription") },
      { id: "public-profile-and-social", title: release1045Message(locale, "publicTitle"), description: release1045Message(locale, "publicDescription") },
      { id: "m0-bridge", title: release1045Message(locale, "bridgeTitle"), description: release1045Message(locale, "bridgeDescription") },
      { id: "version-upgrade", title: release1045Message(locale, "compatibilityTitle"), description: release1045Message(locale, "compatibilityDescription") },
    ],
  };
}

export function getReleaseNotes1044(locale: AppLocale): LocalizedReleaseNoteRecord {
  return {
    id: "2026-08-15-v1.0.44",
    date: release1044Message(locale, "date"),
    version: "1.0.44",
    title: release1044Message(locale, "title"),
    summary: release1044Message(locale, "summary"),
    items: [
      { id: "worker-owned-large-save-runtime", title: release1044Message(locale, "runtimeTitle"), description: release1044Message(locale, "runtimeDescription") },
      { id: "startup-recovery-and-projection", title: release1044Message(locale, "saveTitle"), description: release1044Message(locale, "saveDescription") },
      { id: "command-palette-large-factory", title: release1044Message(locale, "macroTitle"), description: release1044Message(locale, "macroBroadcastDescription") },
      { id: "save-compatibility", title: release1044Message(locale, "compatibilityTitle"), description: release1044Message(locale, "compatibilityDescription") },
    ],
  };
}

export function getReleaseNotes1043(locale: AppLocale): LocalizedReleaseNoteRecord {
  return {
    id: "2026-08-14-v1.0.43",
    date: release1043Message(locale, "date"),
    version: "1.0.43",
    title: release1043Message(locale, "title"),
    summary: release1043Message(locale, "summary"),
    items: [
      { id: "linear-large-save-migration", title: release1043Message(locale, "migrationTitle"), description: release1043Message(locale, "migrationDescription") },
      { id: "background-save-inspection", title: release1043Message(locale, "importTitle"), description: release1043Message(locale, "importDescription") },
      { id: "single-save-commit", title: release1043Message(locale, "saveTitle"), description: release1043Message(locale, "saveDescription") },
      { id: "save-compatibility", title: release1043Message(locale, "compatibilityTitle"), description: release1043Message(locale, "compatibilityDescription") },
    ],
  };
}

export function getReleaseNotes1042(locale: AppLocale): LocalizedReleaseNoteRecord {
  return {
    id: "2026-08-14-v1.0.42",
    date: release1042Message(locale, "date"),
    version: "1.0.42",
    title: release1042Message(locale, "title"),
    summary: release1042Message(locale, "summary"),
    items: [
      { id: "dynamic-shell-safe-area", title: release1042Message(locale, "shellTitle"), description: release1042Message(locale, "shellDescription") },
      { id: "atomic-mobile-navigation", title: release1042Message(locale, "navigationTitle"), description: release1042Message(locale, "navigationDescription") },
      { id: "workspace-accessibility", title: release1042Message(locale, "accessibilityTitle"), description: release1042Message(locale, "accessibilityDescription") },
      { id: "responsive-large-text", title: release1042Message(locale, "responsiveTitle"), description: release1042Message(locale, "responsiveDescription") },
      { id: "stable-form-drafts", title: release1042Message(locale, "inputTitle"), description: release1042Message(locale, "inputDescription") },
      { id: "version-and-preview-integrity", title: release1042Message(locale, "versionTitle"), description: release1042Message(locale, "versionDescription") },
      { id: "large-local-save-recovery", title: release1042Message(locale, "largeSaveRecoveryTitle"), description: release1042Message(locale, "largeSaveRecoveryDescription") },
      { id: "orphaned-time-warp-recovery", title: release1042Message(locale, "timeWarpRecoveryTitle"), description: release1042Message(locale, "timeWarpRecoveryDescription") },
      { id: "proliferator-buffer-limit", title: release1042Message(locale, "proliferatorBufferTitle"), description: release1042Message(locale, "proliferatorBufferDescription") },
      { id: "infinite-resource-speedrun", title: release1042Message(locale, "infiniteSpeedrunTitle"), description: release1042Message(locale, "infiniteSpeedrunDescription") },
    ],
  };
}

export function getReleaseNotes1041(locale: AppLocale): LocalizedReleaseNoteRecord {
  return {
    id: "2026-08-13-v1.0.41",
    date: message(locale, "date"),
    version: "1.0.41",
    title: message(locale, "title"),
    summary: message(locale, "summary"),
    items: [
      { id: "cloud-status-center", title: message(locale, "leaderboardTitle"), description: message(locale, "leaderboardDescription") },
      { id: "large-save-upload", title: message(locale, "transferTitle"), description: message(locale, "transferDescription") },
      { id: "offline-settlement-choice", title: message(locale, "localSaveTitle"), description: message(locale, "localSaveDescription") },
      { id: "adaptive-connection-ports", title: message(locale, "persistenceTitle"), description: message(locale, "persistenceDescription") },
      { id: "atomic-continuous-connections", title: message(locale, "securityTitle"), description: message(locale, "securityDescription") },
      { id: "stable-mobile-input", title: message(locale, "experienceTitle"), description: message(locale, "experienceDescription") },
    ],
  };
}

export function getReleaseNotes1039(locale: AppLocale): LocalizedReleaseNoteRecord {
  return {
    id: "2026-08-11-v1.0.39",
    date: message(locale, "v1039Date"),
    version: "1.0.39",
    title: message(locale, "v1039Title"),
    summary: message(locale, "v1039Summary"),
    items: [
      { id: "sparse-save-validation", title: message(locale, "v1039SparseTitle"), description: message(locale, "v1039SparseDescription") },
      { id: "payload-identity", title: message(locale, "v1039IdentityTitle"), description: message(locale, "v1039IdentityDescription") },
      { id: "review-mode-isolation", title: message(locale, "v1039ReviewTitle"), description: message(locale, "v1039ReviewDescription") },
    ],
  };
}

export function getReleaseNotesUiCopy(locale: AppLocale): LocalizedReleaseNotesUiCopy {
  if (locale === "en") {
    return {
      publicBeta: "Public beta",
      close: "Close release notes",
      historyPagination: "Release history pagination",
      returnCurrent: "Back to current release",
      viewHistory: "View release history",
      page: (current, total) => `Page ${current} of ${total}`,
      jumpPageLabel: "Jump to page",
      jumpPageOption: (page) => `Page ${page}`,
      previous: "Previous",
      next: "Next",
      previousAria: "Previous release page",
      nextAria: "Next release page",
      releaseList: "Release list",
      community: "QQ community",
      acknowledge: "Got it",
    };
  }
  return {
    publicBeta: "公开测试版",
    close: "关闭版本更新记录",
    historyPagination: "版本历史分页",
    returnCurrent: "返回当前版本",
    viewHistory: "查看历史版本",
    page: (current, total) => `第 ${current} / ${total} 页`,
    jumpPageLabel: "跳转页码",
    jumpPageOption: (page) => `第 ${page} 页`,
    previous: "上一页",
    next: "下一页",
    previousAria: "上一页版本",
    nextAria: "下一页版本",
    releaseList: "版本列表",
    community: "QQ 交流群",
    acknowledge: "我知道了",
  };
}
