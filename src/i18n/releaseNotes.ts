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

const release120Copy = {
  date: { "zh-CN": "2026年8月27日", en: "August 27, 2026" },
  title: { "zh-CN": "Windows 原生性能底座与戴森守恒修复", en: "Windows Native Performance Foundation and Dyson Conservation" },
  summary: {
    "zh-CN": "1.2.0 为 Windows 应用加入私有增量存档底座和可选的 Rust 影子核心，并修复保守时间扭曲结算，禁止火箭、太阳帆和戴森结构在没有物料来源时被复制。邀请测试期间 JavaScript 仍是权威；GameState v47、存档 envelope v2、cloud schema v8 与 SQLite layout v3 保持兼容。",
    en: "Version 1.2.0 adds a private incremental-save foundation and an opt-in Rust shadow core to the Windows app, while fixing conservative time-warp settlement so rockets, sails, and Dyson structures can never be copied without material. JavaScript remains authoritative during the invitation Beta; GameState v47, save envelope v2, cloud schema v8, and SQLite layout v3 remain compatible.",
  },
  nativeSaveTitle: { "zh-CN": "Windows 大型存档增加私有增量镜像", en: "Windows large saves gain a private incremental mirror" },
  nativeSaveDescription: {
    "zh-CN": "受限桌面 Host 在应用数据目录写入不可变校验区块、追加式 revision 日志和原子代际指针；可移植的 v47 存档继续作为回退边界。",
    en: "The sandboxed desktop host writes immutable checked chunks, an append-only revision log, and atomic generation pointers under the app data directory while the portable v47 save remains the rollback boundary.",
  },
  nativeCoreTitle: { "zh-CN": "独立 Rust 模拟核心开放影子校验", en: "Independent Rust simulation is available in shadow mode" },
  nativeCoreDescription: {
    "zh-CN": "邀请测试玩家可以让原生核心与 JavaScript 权威对照有界检查点和操作；一旦不一致会安全停止校验，不会替换当前工厂或安装旧检查点。",
    en: "Invitation-Beta players can compare bounded native checkpoints and operations against the JavaScript authority. A mismatch fails closed and never replaces the visible factory or installs an older checkpoint.",
  },
  dysonTitle: { "zh-CN": "保守时间扭曲不再复制戴森产物", en: "Conservative time warp can no longer copy Dyson output" },
  dysonDescription: {
    "zh-CN": "结算只提交有界精确前缀；无法证明守恒的尾段生产、发射、出口、合同和科研会冻结，不再放大已经消耗缓存物料的一秒探针。",
    en: "Only a bounded exact prefix is committed. Unproven tail production, launches, exports, contracts, and research freeze instead of multiplying a one-second probe that consumed cached material.",
  },
  gateTitle: { "zh-CN": "火箭与太阳帆流量加入事务守恒门禁", en: "Rocket and sail flows are checked transactionally" },
  gateDescription: {
    "zh-CN": "客户端提交前会核对库存来源、全局与各恒星系统计数以及重新派生的戴森功率；候选失败时源检查点保持不变。",
    en: "Client settlement validates inventory sources, global and per-system counters, and derived Dyson power before committing; failed candidates leave the source checkpoint unchanged.",
  },
  leaderboardTitle: { "zh-CN": "排行榜异常只进入人工复核", en: "Leaderboard anomalies enter manual review" },
  leaderboardDescription: {
    "zh-CN": "服务端会检查相邻 v46/v47 revision 是否出现不可能的火箭或太阳帆增长；无法验证或异常时保留上一份有效成绩，不会自动封禁或删除云档。",
    en: "Adjacent v46/v47 revisions are checked for impossible rocket or sail growth. Unverifiable or abnormal revisions preserve the previous valid score and never trigger an automatic ban or save deletion.",
  },
  compatibilityTitle: { "zh-CN": "旧存档与云端协议保持兼容", en: "Existing saves and cloud protocols remain compatible" },
  compatibilityDescription: {
    "zh-CN": "GameState v47、存档 envelope v2、cloud schema v8 和 SQLite layout v3 保持不变；历史戴森数据不会被自动改写。",
    en: "GameState v47, save envelope v2, cloud schema v8, and SQLite layout v3 remain unchanged; historical Dyson values are not rewritten automatically.",
  },
} as const;

const release119Copy = {
  date: { "zh-CN": "2026年8月26日", en: "August 26, 2026" },
  title: { "zh-CN": "大型工厂 JavaScript 架构优化", en: "Large-factory JavaScript Architecture Optimization" },
  summary: {
    "zh-CN": "1.1.9 完成 Windows 高性能架构第一层：常见建造、拆除、线路和蓝图命令改用写时复制，撤销历史保存有界差异而不是完整工厂；大型 UI 投影合并发布，分块自动保存从权威 Worker 流式提交。GameState v47、存档 envelope v2、cloud schema v8 与 SQLite layout v3 保持兼容。",
    en: "Version 1.1.9 delivers the first Windows performance layer: common factory commands use copy-on-write, bounded deltas replace full-factory undo snapshots, large UI projections are coalesced, and chunked autosaves stream from the authority Worker. GameState v47, save envelope v2, cloud schema v8, and SQLite layout v3 remain compatible.",
  },
  editTitle: { "zh-CN": "工厂编辑不再深拷贝全部记录", en: "Factory edits no longer deep-clone every record" },
  editDescription: {
    "zh-CN": "放置建筑、回收空建筑、拆除/重连单条线路和创建蓝图只复制实际变化的集合与记录；未变化的实体和线路保持稳定引用。",
    en: "Building placement, empty-building removal, single-belt removal/reconnection, and blueprint creation copy only changed collections and records while unchanged entities and belts retain stable references.",
  },
  historyTitle: { "zh-CN": "撤销/重做改为有界差异日志", en: "Undo/redo uses a bounded delta log" },
  historyDescription: {
    "zh-CN": "历史按条目数和估算字节双重限制；撤销只反转该次操作的字段，保留之后已经结算的模拟时间，不再用旧完整状态造成体感回档。",
    en: "History is bounded by entry count and estimated bytes. Undo reverses only the edited leaves and preserves simulation time settled afterward instead of reinstalling an old full state.",
  },
  saveTitle: { "zh-CN": "大型自动保存流式提交有界数据页", en: "Large autosaves stream bounded pages" },
  saveDescription: {
    "zh-CN": "权威 Worker 只构造一次顶层投影，再以有界实体/线路页和 ACK 回压交给页面持有租约的 IndexedDB writer；普通大档自动保存不再传输第二份完整检查点。",
    en: "The authority Worker projects the top level once, then sends bounded entity/belt pages with ACK backpressure to the page-owned IndexedDB writer; ordinary large autosaves no longer transfer a second full checkpoint.",
  },
  projectionTitle: { "zh-CN": "大型工厂界面复制合并处理", en: "Large-factory UI copies are coalesced" },
  projectionDescription: {
    "zh-CN": "Worker 继续按原精确步长提交模拟 revision；没有活动编辑时，每两个大工厂回执发布一次累计记录投影，命令、选中、放置和连线仍立即刷新。",
    en: "The Worker continues committing exact simulation revisions at the original step size. Without active editing, every two large-factory responses publish one cumulative record projection; commands, selection, placement, and connections still refresh immediately.",
  },
  runtimeTitle: { "zh-CN": "模拟命令使用脏索引和稳定运行时记录", en: "Simulation commands use dirty indexes and stable runtime records" },
  runtimeDescription: {
    "zh-CN": "仅运行时字段在 Worker 内原地应用并标记实体、线路和行星脏集合；配方、拓扑等索引敏感变化继续走确定性的完整重建回退。",
    en: "Runtime-only leaves apply in place and mark entity, belt, and planet dirty sets. Recipe and topology changes still use the deterministic full-index rebuild fallback.",
  },
  pauseTitle: { "zh-CN": "内存保护暂停不再安装旧检查点", en: "Memory protection no longer installs an older checkpoint" },
  pauseDescription: {
    "zh-CN": "达到内存或积压保护线时暂停当前可见进度并保留未结算时间；关闭保护时继续运行，两种模式都不会由内存闸门主动回档。",
    en: "At a memory/backlog watermark the current visible progress and unsettled time are preserved. With protection disabled the game keeps running; neither mode lets the memory governor actively rewind state.",
  },
  compatibilityTitle: { "zh-CN": "存档与云端格式不升级", en: "Save and cloud formats remain unchanged" },
  compatibilityDescription: {
    "zh-CN": "继续读写 GameState v47 / envelope v2；1.1.8 存档、云存档和分块 sidecar 无需转换即可进入 1.1.9。",
    en: "GameState v47 and envelope v2 remain the read/write boundary; 1.1.8 local saves, cloud saves, and chunked sidecars enter 1.1.9 without format conversion.",
  },
} as const;

const release118Copy = {
  date: { "zh-CN": "2026年8月25日", en: "August 25, 2026" },
  title: { "zh-CN": "内存安全暂停与分块增量存档", en: "Memory Safety Pausing and Chunked Incremental Saves" },
  summary: {
    "zh-CN": "1.1.8 为大型工厂加入内存预算、模拟与保存互斥、分块增量检查点和自动安全暂停。设置页现在可以在“自动 90%”与固定 JS 堆内存阈值之间选择，也可以关闭内存与积压自动暂停；设置只保存在本机，不写入存档或云同步。关闭后不会因堆水位或模拟积压把状态切回旧检查点，但 Worker/检查点失败和内存分配失败保护仍然保留。GameState v47、存档 envelope v2、cloud schema v8 与 SQLite layout v3 继续兼容。",
    en: "Version 1.1.8 adds a memory budget, save/simulation fencing, chunked incremental checkpoints, and an automatic safety pause for large factories. Settings can use the automatic 90% browser-heap watermark, choose a fixed JS-heap threshold, or disable memory/backlog auto-pausing; the preference is device-only and never enters saves or cloud sync. With it disabled, heap or simulation backlog pressure no longer rewinds to an older checkpoint, while Worker/checkpoint and allocation-failure safeguards remain. GameState v47, save envelope v2, cloud schema v8, and SQLite layout v3 remain compatible.",
  },
  guardTitle: { "zh-CN": "内存超限自动暂停可配置", en: "Configurable memory-pressure auto-pause" },
  guardDescription: {
    "zh-CN": "默认使用浏览器 JS 堆上限的 90% 作为保护线；高级玩家可以选择 512 MiB、768 MiB、1/1.5/2/3/4 GiB 固定水位，或关闭内存与积压自动暂停。关闭后超过水位或 24 秒积压不会回档或清空未提交时间；Worker/检查点和分配失败仍可能停止运行以保护存档。",
    en: "The default uses 90% of the browser JS-heap limit. Advanced players can choose 512 MiB, 768 MiB, 1/1.5/2/3/4 GiB watermarks or disable memory/backlog auto-pausing. With it disabled, crossing a watermark or the 24-second backlog does not rewind or clear unsubmitted time; Worker/checkpoint and allocation failures may still stop the run to protect saves.",
  },
  saveTitle: { "zh-CN": "大型存档改为分块增量检查点", en: "Large saves use chunked incremental checkpoints" },
  saveDescription: {
    "zh-CN": "首次保存仍保留完整 v2 主存档；后续自动保存只写变化的实体/线路区块，手动保存和不支持 IndexedDB 的环境继续走经过验证的完整保存回退。内存闸门拒绝保存时也会正确结束保存状态并保留最近检查点。",
    en: "The first save remains a complete v2 primary save. Later autosaves write only changed entity/belt chunks; manual saves and environments without IndexedDB use the verified full-save fallback. If the memory governor rejects a save, the save state now terminates cleanly while the latest checkpoint is retained.",
  },
  benchmarkTitle: { "zh-CN": "真实终局存档长时回归", en: "Long-run regression on a real endgame save" },
  benchmarkDescription: {
    "zh-CN": "对 80,674 个建筑、155,746 条线路的玩家存档完成挂机、建造、拉线、蓝图和自动保存压力测试；纯挂机 180 秒时 1.1.8 在约 21 秒安全暂停并停止继续涨内存，组合建造/保存峰值较 1.1.7 低约 14.7%。",
    en: "A player save with 80,674 entities and 155,746 belts was tested through idle, building, belt edits, blueprints, and autosaves. During 180 seconds of pure idle, 1.1.8 safely paused at about 21 seconds instead of continuing to grow; the combined building/save peak was about 14.7% lower than 1.1.7.",
  },
  compatibilityTitle: { "zh-CN": "旧存档与云端协议保持兼容", en: "Existing saves and cloud protocols remain compatible" },
  compatibilityDescription: {
    "zh-CN": "不升级 GameState v47、存档 envelope v2、cloud schema v8 或 SQLite layout v3；内存设置是设备级偏好，不参与确定性模拟、上传或云端合并。",
    en: "GameState v47, save envelope v2, cloud schema v8, and SQLite layout v3 remain unchanged. The memory policy is a device-only preference and does not participate in deterministic simulation, upload, or cloud merge.",
  },
  regressionTitle: { "zh-CN": "内存策略与发布门禁加入回归", en: "Memory policy and release gates are regression-covered" },
  regressionDescription: {
    "zh-CN": "新增固定阈值、关闭内存保护后积压不回档、偏好损坏回退、设置页面可访问性、保存失败终态、类型检查、生产构建和真实存档长时证据。",
    en: "Regression coverage adds fixed-threshold behavior, no rollback when memory/backlog protection is disabled, corrupted-preference fallbacks, settings accessibility, save-failure terminal state, typecheck, production build, and real-save long-run evidence.",
  },
} as const;

const release117Copy = {
  date: { "zh-CN": "2026年8月24日", en: "August 24, 2026" },
  title: { "zh-CN": "云存档合同修复与 Mod 建筑托盘", en: "Cloud Contract Repair and Mod Building Trays" },
  summary: {
    "zh-CN": "1.1.7 修复空间站合同在同一任务日重复生成、导致历史合同与活动合同使用同一 ID 并被云端判定 SAVE_FORMAT_INVALID 的问题；迁移时保留已结算奖励并清除不可再次领取的重复项。内容包注册的自定义建筑现在进入桌面和移动端部署托盘，按通用建筑类型归类；GameState v47、存档 envelope v2、cloud schema v8、SQLite layout v3 不变。",
    en: "Version 1.1.7 repairs same-task-day orbital station contract reoffers that reused IDs across history and active entries and were rejected by cloud validation as SAVE_FORMAT_INVALID. Migration preserves settled rewards and removes only entries that can no longer be claimed. Content-pack buildings now appear in desktop and mobile deployment trays with generic kind-based categories. GameState v47, save envelope v2, cloud schema v8, and SQLite layout v3 remain unchanged.",
  },
  contractTitle: { "zh-CN": "空间站合同 ID 冲突可自愈", en: "Orbital contract ID collisions self-heal" },
  contractDescription: {
    "zh-CN": "加载旧版存档时，已结算历史和 settledIds 组成奖励围栏；重复的 offer、accepted 和 history 条目只保留可验证的权威记录，已领取奖励不会丢失，也不会被再次领取。",
    en: "When an older save is loaded, settled history and settledIds form a reward fence. Duplicate offer, accepted, and history entries keep only an authoritative verifiable record, so claimed rewards are preserved and cannot be claimed again.",
  },
  serverTitle: { "zh-CN": "云端校验保留兼容边界", en: "Cloud validation keeps a narrow compatibility boundary" },
  serverDescription: {
    "zh-CN": "服务端继续拒绝活动合同之间的伪造碰撞；仅对带 settledIds 且正文身份完全一致的旧版 offer/history 重叠保留兼容，奖励字段被篡改仍会被拒绝。",
    en: "The server continues to reject forged collisions between active contracts. It accepts only a legacy offer/history overlap with settledIds and an exact identity match; altered reward fields remain invalid.",
  },
  modTrayTitle: { "zh-CN": "自定义建筑进入部署托盘", en: "Custom buildings appear in deployment trays" },
  modTrayDescription: {
    "zh-CN": "拥有有效成本的内容包建筑会按核心建筑之后的稳定顺序加入桌面和移动端托盘；machine/miner、power、storage/splitter/station 等通用 kind 会映射到对应分类，旧建筑顺序不变。",
    en: "Content-pack buildings with valid costs are appended after core buildings in a stable order on desktop and mobile trays. Generic kinds such as machine/miner, power, and storage/splitter/station map to their corresponding categories without changing core order.",
  },
  modContractTitle: { "zh-CN": "Mod 扩展边界保持可验证", en: "Mod extension boundaries stay verifiable" },
  modContractDescription: {
    "zh-CN": "内容包仍使用声明式 JSON，不开放脚本注入；自定义建筑复用已有生产、物流和电力行为。真正的传送带等级应使用 belts 条目，建筑 kind 为 splitter 的条目不会自动获得传送带全部语义，建筑 ID 与 belt ID 冲突会在校验阶段拒绝。",
    en: "Content packs remain declarative JSON with no script injection; custom buildings reuse existing production, logistics, and power behavior. True conveyor tiers should use belts entries; a building with kind splitter does not automatically gain all conveyor semantics, and building/belt ID collisions fail validation.",
  },
  compatibilityTitle: { "zh-CN": "旧存档与 1.1.6 可继续读取", en: "Existing saves and 1.1.6 remain readable" },
  compatibilityDescription: {
    "zh-CN": "本版不升级 GameState、存档封装、云 schema、SQLite layout 或 Mod JSON 格式；1.1.6 的保存、云修订、蓝图和核心建筑顺序保持兼容，未安装内容包时仍按缺少内容包规则处理。",
    en: "This release does not upgrade GameState, the save envelope, cloud schema, SQLite layout, or Mod JSON format. 1.1.6 saves, cloud revisions, blueprints, and core building order remain compatible; missing packs still follow the existing missing-content rules.",
  },
  regressionTitle: { "zh-CN": "合同、托盘和服务端加入回归门禁", en: "Contracts, trays, and server validation are regression-gated" },
  regressionDescription: {
    "zh-CN": "回归覆盖实际重复 ID 形状、奖励围栏、服务端伪造碰撞、自定义 splitter 托盘分类，以及桌面/移动端动态目录；发布前仍需完成完整单元、服务端、原生和构建门禁。",
    en: "Regression coverage includes the affected duplicate-ID shape, reward fences, forged server collisions, custom splitter tray classification, and dynamic desktop/mobile catalogs. Full unit, server, native, and build gates remain required before release.",
  },
} as const;

const release116Copy = {
  date: { "zh-CN": "2026年8月24日", en: "August 24, 2026" },
  title: { "zh-CN": "传送带端口对齐与纯挂机高倍率修复", en: "Belt Port Alignment and Productive Pure Idle" },
  summary: {
    "zh-CN": "1.1.6 修复高密度画布中传送带线按卡片中心推算、导致多输入/多输出建筑端口错位的问题；批量 Canvas 线路现在复用 React Flow 已测量的真实端口几何，并在拓扑稳定时避免被运行时流量刷新反复重建。1.1.5 的终局纯挂机保守模式修复继续保留：合法高倍率存档按有界累计合同推进生产和科研，不绕过有限资源与安全边界。GameState v47、存档 envelope v2、cloud schema v8、SQLite layout v3 不变。",
    en: "Version 1.1.6 fixes dense-canvas belt lines that were inferred from card centres and therefore missed multi-input and multi-output ports. Batched Canvas belts now reuse React Flow's measured handle geometry and avoid rebuilding the topology when runtime flow observations refresh. The 1.1.5 endgame pure-idle fix remains included: eligible high-multiplier saves advance production and research through a bounded cumulative contract without bypassing finite-resource or safety boundaries. GameState v47, save envelope v2, cloud schema v8, and SQLite layout v3 remain unchanged.",
  },
  beltTitle: { "zh-CN": "传送带线精确连接真实端口", en: "Belt lines connect to measured ports" },
  beltDescription: {
    "zh-CN": "多输入、多输出和特殊物流端口使用 React Flow 实际测量的 handle 坐标，缩放、平移、低细节卡片与批量 Canvas 渲染保持同一端点；未挂载端口只安全回退到卡片边缘，不写入或改变线路数据。",
    en: "Multi-input, multi-output, and special logistics ports use React Flow's measured handle coordinates. Zoom, pan, low-detail cards, and batched Canvas rendering share the same endpoints; an unmounted handle safely falls back to the card edge without changing belt data.",
  },
  performanceTitle: { "zh-CN": "高密度线路拓扑不随流量重建", en: "Dense belt topology stays stable across flow refreshes" },
  performanceDescription: {
    "zh-CN": "线路批次只在拓扑、节点布局或端口几何变化时重新打包；生产流量、悬停和运行时诊断刷新不会反复创建整张线路索引，保留命中测试与交互边界。",
    en: "The packed line batch rebuilds only when topology, node layout, or handle geometry changes. Production flow, hover, and runtime diagnostics no longer recreate the full line index while hit testing and interaction boundaries remain intact.",
  },
  idleTitle: { "zh-CN": "终局纯挂机继续按高倍率结算", en: "Endgame pure idle remains productive at high multipliers" },
  idleDescription: {
    "zh-CN": "超大终局存档先做有界精确前缀，再以 80% 安全折扣应用白名单累计速率并推进科研；有限资源、瞬时物流和安全整数边界继续 fail-closed。",
    en: "Large endgame saves run a bounded exact prefix, then apply whitelisted cumulative rates with an 80% safety haircut while research advances. Finite resources, transient logistics, and unsafe integer boundaries remain fail-closed.",
  },
  compatibilityTitle: { "zh-CN": "存档与服务端协议保持兼容", en: "Save and server protocols remain compatible" },
  compatibilityDescription: {
    "zh-CN": "本版不升级 GameState、存档封装、云 schema、SQLite layout 或线路数据格式；旧存档、云修订、备份和原生应用继续按既有合同读取。",
    en: "This release does not upgrade GameState, the save envelope, cloud schema, SQLite layout, or belt data format. Existing saves, cloud revisions, backups, and native apps continue to use the established contracts.",
  },
  regressionTitle: { "zh-CN": "多端口与密集画布加入回归门禁", en: "Multi-port dense canvases are regression-gated" },
  regressionDescription: {
    "zh-CN": "新增 200 条线路、多输入目标、缩放/平移和低细节渲染回归；纯挂机终局夹具继续验证 15x 长窗口、可重载和源存档不变。",
    en: "Regression coverage adds a 200-belt multi-input target plus zoom, pan, and low-detail rendering checks; the endgame pure-idle fixture continues to verify a 15x long window, reloadability, and an unchanged source save.",
  },
} as const;

const release115Copy = {
  date: { "zh-CN": "2026年8月24日", en: "August 24, 2026" },
  title: { "zh-CN": "超大存档低内存保存与压缩导出", en: "Low-memory Large Saves and Compressed Exports" },
  summary: {
    "zh-CN": "1.1.5 修复 70 MiB 以上终局存档在自动或手动保存时可能触发 OUT OF MEMORY 的问题：权威存档在序列化 Worker 内压缩后才跨线程传输，持久化 Worker 不再完整解析或反复回读巨型 JSON。导出默认生成可直接重新导入的 .json.gz，并继续稀疏化可精确恢复的 v47 默认字段；超大存档纯挂机停止与重载加入实测门禁。银河综合榜改为五项公开指标等权的对数工程等级，补上白糖产量且取消隐藏加分。GameState v47、存档 envelope v2、cloud schema v8、SQLite layout v3 与云端容量合同不变。",
    en: "Version 1.1.5 fixes possible OUT OF MEMORY crashes while automatically or manually saving 70+ MiB endgame factories. The authoritative save is compressed inside the serialization Worker before crossing threads, and the persistence Worker no longer fully parses or repeatedly reads back the giant JSON. Exports now default to directly importable .json.gz files, with additional exact v47 default-field compaction; large-save pure-idle stop and reload are now acceptance-gated. The Galaxy composite uses equally weighted logarithmic engineering levels for all five visible metrics, adding white-matrix rate and removing hidden bonuses. GameState v47, save envelope v2, cloud schema v8, SQLite layout v3, and cloud size contracts remain unchanged.",
  },
  memoryTitle: { "zh-CN": "保存链路不再搬运多份巨型正文", en: "Save transport avoids duplicate giant payloads" },
  memoryDescription: {
    "zh-CN": "序列化 Worker 对完整权威 envelope 先做 gzip，再把约 2～3 MiB 的载荷交给持久化 Worker；后者以范围扫描核对摘要和 checksum，移除事务内巨型正文重复回读，同时保留解压后 FNV、SHA-256、catalog、revision、备份和独立事务读回验证。",
    en: "The serialization Worker gzip-compresses the complete authoritative envelope before transferring roughly 2–3 MiB to the persistence Worker. A range scanner verifies summary fields and checksum without a full parse, duplicate in-transaction payload reads are removed, and raw FNV/SHA-256, catalog, revision, backup, and independent transaction read-back proofs remain enforced.",
  },
  exportTitle: { "zh-CN": "存档默认导出为 .json.gz", en: "Saves export as .json.gz by default" },
  exportDescription: {
    "zh-CN": "当前进度先完成一次权威手动保存，再从已验证主存档生成 gzip；Web、Windows 与 Android 均可导出，开始菜单和运营中心可直接导入 .json.gz，也继续兼容旧 .json。解压设置 256 MiB 上限并拒绝损坏正文。",
    en: "Current progress first completes an authoritative manual save, then gzip-compresses the verified primary. Web, Windows, and Android can export it; the start menu and operations center import .json.gz directly while retaining legacy .json support. Expansion is bounded to 256 MiB and corrupt payloads are rejected.",
  },
  sparseTitle: { "zh-CN": "v47 默认字段进一步精确瘦身", en: "More exact v47 default-field compaction" },
  sparseDescription: {
    "zh-CN": "生产利用率、速率、物流载具、塔等级与模式、增产剂配置等只有在等于迁移器可无损恢复的 v47 默认值时才省略；非默认值和显式非法值仍保留给权威校验拒绝，不改变旧 v46 存档含义。",
    en: "Utilization, rates, logistics vehicles, station tiers and modes, and proliferator configuration are omitted only when equal to exact v47 defaults reconstructed by migration. Non-default and explicitly invalid values remain available for authoritative validation, and v46 semantics are unchanged.",
  },
  compatibilityTitle: { "zh-CN": "存档与服务端协议保持兼容", en: "Save and server protocols remain compatible" },
  compatibilityDescription: {
    "zh-CN": "本版只改变本地保存的内存运输方式和文件导出容器；IndexedDB 最终仍保存标准 JSON，云上传仍使用既有 envelope 与容量边界，旧 JSON、备份、槽位和云端修订可继续读取。",
    en: "This release changes only local save memory transport and the export-file container. IndexedDB still stores standard JSON, cloud uploads retain the existing envelope and limits, and legacy JSON, backups, slots, and cloud revisions remain readable.",
  },
  pureIdleTitle: { "zh-CN": "超大存档纯挂机纳入完整验收", en: "Large-save pure idle is acceptance-gated" },
  pureIdleDescription: {
    "zh-CN": "使用真实 70 MiB 级终局工厂的只读派生副本验证纯挂机 Worker 初始化、长窗口推进、停止终态校验、持久化与重新载入；测试不会覆盖玩家原文件。",
    en: "A read-only derived copy of a real 70+ MiB endgame factory verifies pure-idle Worker initialization, long-window advancement, terminal validation, persistence, and reload without overwriting the player's source file.",
  },
  leaderboardTitle: { "zh-CN": "银河综合榜使用五项等权对数评分", en: "Galaxy composite balances five logarithmic metrics" },
  leaderboardDescription: {
    "zh-CN": "累计发电、白矩阵上传、白糖产量、戴森功率和实际结算吞吐各占同等工程等级；每项每翻倍增加一百万分。累计量不再按单位位数线性压过速率，也不再加入未公开的探索或殖民分。",
    en: "Cumulative generation, uploaded white matrices, white-matrix rate, Dyson power, and settled throughput contribute equal engineering levels; every doubling adds one million points. Cumulative units can no longer dominate rates through digit count, and exploration or colonization no longer add hidden points.",
  },
} as const;

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

function release118Message(locale: AppLocale, key: keyof typeof release118Copy): string {
  return release118Copy[key][locale];
}

function release119Message(locale: AppLocale, key: keyof typeof release119Copy): string {
  return release119Copy[key][locale];
}

function release120Message(locale: AppLocale, key: keyof typeof release120Copy): string {
  return release120Copy[key][locale];
}

function release117Message(locale: AppLocale, key: keyof typeof release117Copy): string {
  return release117Copy[key][locale];
}

function release116Message(locale: AppLocale, key: keyof typeof release116Copy): string {
  return release116Copy[key][locale];
}

function release115Message(locale: AppLocale, key: keyof typeof release115Copy): string {
  return release115Copy[key][locale];
}

function release114Message(locale: AppLocale, key: keyof typeof release114Copy): string {
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
    id: "2026-08-27-v1.2.0",
    date: release120Message(locale, "date"),
    version: "1.2.0",
    title: release120Message(locale, "title"),
    summary: release120Message(locale, "summary"),
    items: [
      { id: "windows-native-incremental-save", title: release120Message(locale, "nativeSaveTitle"), description: release120Message(locale, "nativeSaveDescription") },
      { id: "windows-native-shadow-core", title: release120Message(locale, "nativeCoreTitle"), description: release120Message(locale, "nativeCoreDescription") },
      { id: "dyson-material-conservation", title: release120Message(locale, "dysonTitle"), description: release120Message(locale, "dysonDescription") },
      { id: "dyson-conservation-gates", title: release120Message(locale, "gateTitle"), description: release120Message(locale, "gateDescription") },
      { id: "leaderboard-conservation-review", title: release120Message(locale, "leaderboardTitle"), description: release120Message(locale, "leaderboardDescription") },
      { id: "version-compatibility", title: release120Message(locale, "compatibilityTitle"), description: release120Message(locale, "compatibilityDescription") },
    ],
  };
}

export function getReleaseNotes119(locale: AppLocale): LocalizedReleaseNoteRecord {
  return {
    id: "2026-08-26-v1.1.9",
    date: release119Message(locale, "date"),
    version: "1.1.9",
    title: release119Message(locale, "title"),
    summary: release119Message(locale, "summary"),
    items: [
      { id: "copy-on-write-factory-edits", title: release119Message(locale, "editTitle"), description: release119Message(locale, "editDescription") },
      { id: "bounded-delta-history", title: release119Message(locale, "historyTitle"), description: release119Message(locale, "historyDescription") },
      { id: "single-owner-chunk-save", title: release119Message(locale, "saveTitle"), description: release119Message(locale, "saveDescription") },
      { id: "cumulative-large-factory-projection", title: release119Message(locale, "projectionTitle"), description: release119Message(locale, "projectionDescription") },
      { id: "dirty-runtime-index", title: release119Message(locale, "runtimeTitle"), description: release119Message(locale, "runtimeDescription") },
      { id: "memory-pause-no-rollback", title: release119Message(locale, "pauseTitle"), description: release119Message(locale, "pauseDescription") },
      { id: "version-compatibility", title: release119Message(locale, "compatibilityTitle"), description: release119Message(locale, "compatibilityDescription") },
    ],
  };
}

export function getReleaseNotes118(locale: AppLocale): LocalizedReleaseNoteRecord {
  return {
    id: "2026-08-25-v1.1.8",
    date: release118Message(locale, "date"),
    version: "1.1.8",
    title: release118Message(locale, "title"),
    summary: release118Message(locale, "summary"),
    items: [
      { id: "memory-auto-pause-policy", title: release118Message(locale, "guardTitle"), description: release118Message(locale, "guardDescription") },
      { id: "chunked-incremental-save", title: release118Message(locale, "saveTitle"), description: release118Message(locale, "saveDescription") },
      { id: "real-save-memory-benchmark", title: release118Message(locale, "benchmarkTitle"), description: release118Message(locale, "benchmarkDescription") },
      { id: "version-upgrade", title: release118Message(locale, "compatibilityTitle"), description: release118Message(locale, "compatibilityDescription") },
      { id: "memory-regression-gates", title: release118Message(locale, "regressionTitle"), description: release118Message(locale, "regressionDescription") },
    ],
  };
}

export function getReleaseNotes117(locale: AppLocale): LocalizedReleaseNoteRecord {
  return {
    id: "2026-08-24-v1.1.7",
    date: release117Message(locale, "date"),
    version: "1.1.7",
    title: release117Message(locale, "title"),
    summary: release117Message(locale, "summary"),
    items: [
      { id: "station-contract-id-repair", title: release117Message(locale, "contractTitle"), description: release117Message(locale, "contractDescription") },
      { id: "station-contract-server-validation", title: release117Message(locale, "serverTitle"), description: release117Message(locale, "serverDescription") },
      { id: "custom-building-trays", title: release117Message(locale, "modTrayTitle"), description: release117Message(locale, "modTrayDescription") },
      { id: "declarative-mod-contract", title: release117Message(locale, "modContractTitle"), description: release117Message(locale, "modContractDescription") },
      { id: "version-upgrade", title: release117Message(locale, "compatibilityTitle"), description: release117Message(locale, "compatibilityDescription") },
      { id: "contract-mod-regression", title: release117Message(locale, "regressionTitle"), description: release117Message(locale, "regressionDescription") },
    ],
  };
}

export function getReleaseNotes116(locale: AppLocale): LocalizedReleaseNoteRecord {
  return {
    id: "2026-08-24-v1.1.6",
    date: release116Message(locale, "date"),
    version: "1.1.6",
    title: release116Message(locale, "title"),
    summary: release116Message(locale, "summary"),
    items: [
      { id: "measured-belt-endpoints", title: release116Message(locale, "beltTitle"), description: release116Message(locale, "beltDescription") },
      { id: "stable-dense-belt-topology", title: release116Message(locale, "performanceTitle"), description: release116Message(locale, "performanceDescription") },
      { id: "productive-pure-idle", title: release116Message(locale, "idleTitle"), description: release116Message(locale, "idleDescription") },
      { id: "dense-belt-regression", title: release116Message(locale, "regressionTitle"), description: release116Message(locale, "regressionDescription") },
      { id: "version-upgrade", title: release116Message(locale, "compatibilityTitle"), description: release116Message(locale, "compatibilityDescription") },
    ],
  };
}

export function getReleaseNotes115(locale: AppLocale): LocalizedReleaseNoteRecord {
  return {
    id: "2026-08-24-v1.1.5",
    date: release115Message(locale, "date"),
    version: "1.1.5",
    title: release115Message(locale, "title"),
    summary: release115Message(locale, "summary"),
    items: [
      { id: "compressed-worker-save-transport", title: release115Message(locale, "memoryTitle"), description: release115Message(locale, "memoryDescription") },
      { id: "gzip-save-export", title: release115Message(locale, "exportTitle"), description: release115Message(locale, "exportDescription") },
      { id: "v47-default-compaction", title: release115Message(locale, "sparseTitle"), description: release115Message(locale, "sparseDescription") },
      { id: "version-upgrade", title: release115Message(locale, "compatibilityTitle"), description: release115Message(locale, "compatibilityDescription") },
      { id: "large-save-pure-idle", title: release115Message(locale, "pureIdleTitle"), description: release115Message(locale, "pureIdleDescription") },
      { id: "balanced-galaxy-score", title: release115Message(locale, "leaderboardTitle"), description: release115Message(locale, "leaderboardDescription") },
    ],
  };
}

export function getReleaseNotes114(locale: AppLocale): LocalizedReleaseNoteRecord {
  return {
    id: "2026-08-23-v1.1.4",
    date: release114Message(locale, "date"),
    version: "1.1.4",
    title: release114Message(locale, "title"),
    summary: release114Message(locale, "summary"),
    items: [
      { id: "construction-megastructure-fairness", title: release114Message(locale, "constructionTitle"), description: release114Message(locale, "constructionDescription") },
      { id: "blueprint-belt-lanes", title: release114Message(locale, "blueprintTitle"), description: release114Message(locale, "blueprintDescription") },
      { id: "bounded-offline-prefix", title: release114Message(locale, "offlineTitle"), description: release114Message(locale, "offlineDescription") },
      { id: "large-save-low-memory", title: release114Message(locale, "largeSaveTitle"), description: release114Message(locale, "largeSaveDescription") },
      { id: "large-cloud-save", title: release114Message(locale, "cloudTitle"), description: release114Message(locale, "cloudDescription") },
      { id: "authority-checked-user-index", title: release114Message(locale, "serverTitle"), description: release114Message(locale, "serverDescription") },
      { id: "version-upgrade", title: release114Message(locale, "compatibilityTitle"), description: release114Message(locale, "compatibilityDescription") },
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
