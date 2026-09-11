import { Check, ChevronLeft, ChevronRight, CloudUpload, Gauge, History, Info, Link2, MessageCircle, X, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { NATIVE_BACK_EVENT } from "../nativeApp";

export const RELEASE_NOTES_SEEN_KEY = "dsp-idle-network.release-notes.seen.v1";

export const CURRENT_RELEASE_NOTES = {
  id: "2026-08-11-v1.0.38",
  date: "2026年8月11日",
  version: "1.0.38",
  title: "终局性能、存档瘦身与矿脉扩容更新",
  summary: "1.0.38 减少大存档在主线程与 Worker 间的重复复制，复用传送带、生产、电力和量子物流批处理，并安全压缩可重建的默认存档字段；普通模式中仅有一个单极磁石矿脉的存档可在备份与双重确认后补到硬上限两个。GameState v46、存档 envelope v2、云 schema v7 与 SQLite layout v2 不变。",
  items: [
    {
      id: "worker-transfer",
      title: "大存档只做一次权威序列化",
      description: "保存、云上传、离线和纯挂机 Worker 返回带长度、哈希与状态校验的可转移缓冲区；槽位和快照也走后台序列化，失败仍保留原始状态和精确重试能力。",
    },
    {
      id: "exact-batching",
      title: "终局结算复用稳定批次",
      description: "传送带候选与容量账本、配方静态量、戴森接收与电网拓扑、量子供需索引在结构未变化时复用；完整状态、缓存、在途物资和稳定排序继续与既有 oracle 对照。",
    },
    {
      id: "save-compaction",
      title: "存档默认字段可安全瘦身",
      description: "仅省略 v46 迁移可精确重建的实体和传送带零值默认字段，运行时拓扑与历史诊断不落盘；旧版未压缩 v46 存档仍可直接读取并保留失败回滚路径。",
    },
    {
      id: "second-unipolar-vein",
      title: "单矿脉存档可受控补到两个",
      description: "仅普通模式、恰好一个健康单极磁石矿脉且暂停时可操作；先创建持久快照并双重确认，只新增零缓存、零矿机的有限矿脉，不增加库存、产量或既有矿脉储量，重复执行会被硬上限阻止。",
    },
    {
      id: "canvas-compatibility",
      title: "高密度画布减少无效刷新",
      description: "线路颜色与物品映射只在拓扑变化时重建，并新增暂停/运行拖动、缩放、建筑/线路选择、检查器、200% 字号和移动窗口的有界矩阵；不会承诺未经真机验证的统一 60 FPS。",
    },
  ],
} as const;

const RELEASE_NOTE_ICONS: Record<(typeof CURRENT_RELEASE_NOTES.items)[number]["id"], LucideIcon> = {
  "worker-transfer": CloudUpload,
  "exact-batching": Gauge,
  "save-compaction": History,
  "second-unipolar-vein": Link2,
  "canvas-compatibility": Check,
};

const RELEASE_NOTES_1_0_37 = {
  id: "2026-08-10-v1.0.37",
  date: "2026年8月10日",
  version: "1.0.37",
  title: "单极磁石、离线决策与星图批量操作更新",
  summary: "1.0.37 修复旧存档资源目录迁移边界，重排横向科技树导航，并让不可靠的离线近似先由玩家决策；星图批量物流操作同步收紧布局并支持轨道收集器一键接入量子网络。GameState v46、存档 envelope v2、云 schema v7 与 SQLite layout v2 不变。",
  items: [
    { id: "unipolar-integrity", title: "单极磁石资源边界可审计", description: "旧存档迁移只恢复其星球资源目录明确声明的稳定资源点，不再从重新生成的目录引入幽灵矿脉；人工修复工具提供预览、备份摘要、确认令牌、回滚和速通复核门禁。" },
    { id: "technology-navigation", title: "科技树横向浏览更稳定", description: "桌面科技树按层级横向排列，滚轮、触控板、Shift 滚轮、拖动与键盘均只移动科技区域；100%～200% 字号和紧凑布局不会带动页面纵向跳动，手机仍使用纵向列表。" },
    { id: "offline-decision", title: "不可靠离线近似不再自动落盘", description: "零校准、Worker 异常、内存风险和边界失败会保留原存档并进入决策界面；可从原状态精确重试、返回菜单，或在普通模式双重确认后按零收益推进时钟，速通模式只允许精确结算。" },
    { id: "star-map-batch", title: "星图批量物流操作更集中", description: "升级全部星际物流站与切换全部量子物流站保持同排，并新增轨道收集器一键接入量子网络；批量操作会确认影响范围并显示成功数、跳过数和分组原因。" },
    { id: "save-compatibility", title: "存档与在线协议保持兼容", description: "本批不升级 GameState、存档封装、云服务或 SQLite 版本；不会自动修改排行榜历史、批量增加资源或提交未确认的离线候选状态。" },
  ],
} as const;

const RELEASE_NOTES_1_0_36 = {
  id: "2026-08-10-v1.0.36",
  date: "2026年8月10日",
  version: "1.0.36",
  title: "传送带、燃料与终局性能更新",
  summary: "1.0.36 增加新建传送带默认并联数量与可燃冰火力发电支持，并以可重建运行时索引优化传送带、物流、生产缓存和高密度画布。GameState v46、存档 envelope v2、云 schema v7 与 SQLite layout v2 不变。",
  items: [
    { id: "belt-lane-default", title: "新建线路可预设并联数量", description: "设置中可选择 1、2、4 或自定义 1～4096 条并联线路；桌面、触摸和蓝图新建线路按实际数量原子扣除施工托盘，既有线路和货物堆叠不变。" },
    { id: "fire-ice-fuel", title: "火力发电站支持可燃冰", description: "可燃冰按 4.8 MJ/个接入既有火电燃料、耗尽提示、供电和统计路径；煤、石墨、氢、氘与燃料棒规则不变。" },
    { id: "active-belt-runtime", title: "终局线路按运行状态调度", description: "星球级线路、源端、目标端和物品索引复用稳定容量与路由计划；已证明休眠的线路只在库存、配方、供电或拓扑变化时唤醒，结算顺序与状态哈希保持一致。" },
    { id: "dense-canvas", title: "高密度星球画布更轻量", description: "普通线路由 Canvas 批量绘制并通过空间索引命中，React Flow 只保留选中、悬浮、寻线和生产相关细节；Canvas 不可用时自动回退完整线路。" },
    { id: "production-logistics-runtime", title: "生产缓存与物流调度复用", description: "配方静态量、矿脉列表、物流容量和稳定槽位排序改为运行时缓存；每座建筑缓存、量子库存、运输载荷和翘曲器仍独立守恒。" },
    { id: "save-compatibility", title: "存档与在线协议保持兼容", description: "本批不升级 GameState、存档封装、云服务或 SQLite 版本；候选宏观状态必须序列化、重载和安全校验通过后才会写入主存档。" },
  ],
} as const;

export interface ReleaseNotesRecord {
  id: string;
  date: string;
  version: string;
  title: string;
  summary: string;
  items: readonly { id: string; title: string; description: string }[];
}

/** Static, offline-readable history. Keep entries small; only one page is rendered. */
export const RELEASE_NOTES_HISTORY: readonly ReleaseNotesRecord[] = [
  CURRENT_RELEASE_NOTES,
  RELEASE_NOTES_1_0_37,
  RELEASE_NOTES_1_0_36,
  {
    id: "2026-08-09-v1.0.35", date: "2026年8月9日", version: "1.0.35", title: "终局结算、云端安全与速通恢复更新",
    summary: "1.0.35 为终局离线和纯挂机增加设备感知分级与内存预警，补齐大存档上传诊断、云数据库治理、匿名新设备登录提醒和排行榜复核；历史百万白糖里程碑可安全自愈，建筑堆叠快捷档扩展到 ±10000 与 ±100000。GameState v46、存档 envelope v2、云 schema v7 与 SQLite layout v2 不变。",
    items: [
      { id: "offline-device-budget", title: "终局离线按存档与设备分级", description: "结算前评估实体、线路、物流、缓存、流体、戴森和施工边界，并结合设备内存与核心数选择精确、快速或保守宏观路径；高内存风险会提前提示，取消仍保留原存档。" },
      { id: "large-save-governance", title: "大存档保存与上传可诊断", description: "1、7、20、28 和 30 MiB 档位会给出明确体积提示；上传记录准备、压缩、网络、回退和取消阶段耗时，30 MiB 原始回退与 32 MiB 服务端展开边界保持不变。" },
      { id: "cloud-security", title: "云端治理与账号安全增强", description: "后台增加 SQLite/WAL、修订增长、备份窗口、写队列和磁盘水位指标；新设备或匿名区域登录会提醒，管理员动作要求精确账号、二次确认并写入最小化审计。" },
      { id: "speedrun-recovery", title: "百万白糖里程碑可自愈", description: "合法 v46 速通存档按累计生产事实补齐漏写里程碑；服务端使用当前有效计时保守验榜，并提供要求最新主云修订、匹配备份和停服确认的一次性恢复工具。" },
      { id: "stack-shortcuts", title: "终局建筑堆叠快捷调整", description: "桌面与移动检查器增加 ±10000、±100000，继续使用既有原子增减、施工件守恒和 1～100,000,000 上下限。" },
      { id: "save-compatibility", title: "存档与在线协议保持兼容", description: "本批不升级 GameState、存档封装、云服务或 SQLite 版本；候选宏观状态必须序列化、重载和安全校验通过后才会写入主存档。" },
    ],
  },
  {
    id: "2026-08-08-v1.0.34", date: "2026年8月8日", version: "1.0.34", title: "云存档、纯挂机与排行榜可信度更新",
    summary: "1.0.34 修复历史唯一巨构堆叠和 Android 云上传，纯挂机停止复用已校准 Worker 并保留可恢复冻结边界；排行榜拆分实际结算吞吐、当前星球和全星区理论速率，同时增加拉线候选建筑高亮。GameState v46、存档 envelope v2、云 schema v7 与 SQLite layout v2 不变。",
    items: [
      { id: "cloud-stack", title: "历史唯一巨构可安全上传", description: "正式版本曾产生的时间扭曲装置或微型黑洞历史堆叠会原样保留并通过云端校验；新的批量增加会明确跳过唯一巨构且不扣施工库存。" },
      { id: "android-cloud", title: "Android 云上传绕过损坏压缩桥接", description: "Android 原生应用改用有大小上限的原始 JSON 上传；Web 遇到服务端明确拒绝 gzip 时只安全回退一次，取消、冲突和未知状态继续保护本地主存档。" },
      { id: "pure-idle-stop", title: "纯挂机停止与恢复更清晰", description: "停止时复用当前已校准 Worker，冻结结算边界直到主存档验证写入成功；失败会保留检查点，并提供明确的原因、重试和放弃未结算操作。" },
      { id: "throughput", title: "排行榜吞吐口径跨星球一致", description: "相邻主云修订按累计生产增量形成实际吞吐窗口；当前星球与全星区理论速率分开显示，全星区速率按所有行星指标饱和求和，不再把当前星球快照误当全局。" },
      { id: "connection-highlight", title: "拉线候选建筑同步高亮", description: "鼠标、点击和触摸拉线时，起点建筑与拥有兼容端口的目标卡片会显示静态边框；成功、取消、Escape 或切换页面后立即清除。" },
      { id: "save-compatibility", title: "存档与在线协议保持兼容", description: "本批不升级 GameState、存档封装、云服务或 SQLite 版本；候选宏观状态必须序列化、重载和安全校验通过后才会写入主存档。" },
    ],
  },
  {
    id: "2026-08-07-v1.0.33", date: "2026年8月7日", version: "1.0.33", title: "离线与时间扭曲终局快速结算更新",
    summary: "1.0.33 让有限与无限科研继续参与快速离线和时间扭曲纯挂机，修复陈旧供电倍率，并在普通合同不可用或 Worker 失败时改用有界的保守宏观结算。GameState v46、存档 envelope v2、云 schema v7 与 SQLite layout v2 不变。",
    items: [
      { id: "offline-research", title: "科研不再阻断快速结算", description: "有限科技和无限科技使用共享的整数科研账本，离线与纯挂机可跨越科研边界；成本、奖励、队列和等级仍按原有领域规则结算。" },
      { id: "power-multiplier", title: "供电倍率使用权威快照", description: "纯挂机启动和恢复时重新计算时间扭曲供电，界面同时显示请求倍率、供电允许倍率和实际结算倍率，不再继承陈旧的 1x 状态。" },
      { id: "bounded-settlement", title: "有界保守宏观回退", description: "普通宏观合同、尾验或校准未满足条件时，结算会在现实时间预算内降级为保守宏观，不再对整段离线时间执行无上限精确重放。" },
      { id: "worker-recovery", title: "Worker 失败与恢复有界", description: "取消、迟到消息和重复 Worker 会话相互隔离；普通离线只进行一次有界保守重试，纯挂机连续失败后从原始合法检查点进入零校准保守模式。" },
      { id: "save-compatibility", title: "存档与在线协议保持兼容", description: "本批不升级 GameState、存档封装、云服务或 SQLite 版本；候选宏观状态必须序列化、重载和安全校验通过后才会写入主存档。" },
    ],
  },
  {
    id: "2026-08-07-v1.0.32", date: "2026年8月7日", version: "1.0.32", title: "速通与宏观纯挂机稳定性更新",
    summary: "1.0.32 补齐速通状态面板、递归制造与科研边界自愈，并增加带检查点恢复的宏观纯挂机；后台高倍率最多宽限 5 分钟，剩余时间自动按普通离线规则结算。GameState v46、存档 envelope v2、云 schema v7 与 SQLite layout v2 不变。",
    items: [
      { id: "speedrun-panel", title: "速通面板可折叠", description: "速通工厂的计时和三个目标保持可见，目标详情可以折叠；折叠状态只保存为设备级 UI 偏好，不进入存档或排行榜数据。" },
      { id: "recursive-research", title: "递归制造与科研自愈", description: "原油上游和净产出规划遵循统一的递归策略；离线、纯挂机或旧存档跨过科研完成边界时，奖励和队列只会幂等修复一次。" },
      { id: "pure-idle-background", title: "纯挂机检查点与后台宽限", description: "宏观纯挂机在 Worker 中运行并持续写入检查点、心跳和租约；页面进入后台后最多保留 5 分钟高倍率，超出部分使用普通离线 Worker，保存失败时保留原主存档。" },
      { id: "release-history", title: "公告历史完整可查", description: "公告详情支持直接跳转历史页，历史版本使用离线静态数据并保留完整条目；列表分页不会一次挂载全部正文。" },
      { id: "save-compatibility", title: "存档与在线协议保持兼容", description: "本批不升级 GameState、存档封装、云服务或 SQLite 版本；候选宏观状态必须序列化、重载和安全校验通过后才会写入主存档。" },
    ],
  },
  {
    id: "2026-08-06-v1.0.31", date: "2026年8月6日", version: "1.0.31", title: "离线结算与高倍率挂机稳定性更新",
    summary: "1.0.31 修复快速离线结算崩溃，补齐统计历史曲线、施工库存删除、锁定配方拓扑保护、移动滚动和高倍率纯挂机治理。GameState v46、存档 envelope v2、云 schema v7 与 SQLite layout v2 不变。",
    items: [
      { id: "offline-settlement", title: "快速离线安全回退", description: "循环游标统一归一化，快速路径遇到异常或校验失败时回到精确结算，不会提交半成品状态。" },
      { id: "production-history", title: "生产历史曲线", description: "统计页支持多个时间窗口，历史数据有界压缩并可按星球、物品和状态筛选。" },
      { id: "time-warp", title: "高倍率纯挂机治理", description: "Worker 使用短校准和有界近似，区分供电限制与计算限制，停止时丢弃未提交预算。" },
    ],
  },
  {
    id: "2026-08-05-v1.0.30", date: "2026年8月5日", version: "1.0.30", title: "速通与快速离线实验",
    summary: "新增独立速通工厂、服务端校验榜和带严格回退的快速离线结算实验。",
    items: [
      { id: "speedrun", title: "独立速通工厂", description: "普通工厂与速通工厂从创建时隔离，三个目标分别进入独立榜单，服务端按赛季和规则版本校验成绩。" },
      { id: "speedrun-targets", title: "三项挑战目标", description: "提供全科技、实际发射一万枚戴森火箭、累计生产一百万白矩阵三个目标，完成时间固定且重复提交幂等。" },
      { id: "fast-offline", title: "快速离线实验", description: "30 秒精确校准后才允许批量外推；候选状态只在 Worker 副本中生成，任何安全门禁失败都会回退精确结算。" },
    ],
  },
  {
    id: "2026-08-05-v1.0.29", date: "2026年8月5日", version: "1.0.29", title: "稳定性与空间维护",
    summary: "补齐高倍率挂机、云存档和生产运行稳定性，并完成下载节点保留策略。",
    items: [
      { id: "recursive-simulation", title: "递归制造阻塞修复", description: "建筑制造中心递归任务遇到边界时分块处理并保留 WIP、材料和副产物，避免全局数字长时间不刷新。" },
      { id: "time-warp-stop", title: "时间扭曲停止保护", description: "停止或 Worker 异常时保留最后有效状态和待结算预算，安全暂停并显示可恢复提示，不静默清空收益。" },
      { id: "release-storage", title: "节点空间维护", description: "发布归档和数据库备份按保留策略整理，生产数据、回滚目标和云存档协议保持不变。" },
    ],
  },
  {
    id: "2026-08-05-v1.0.28", date: "2026年8月5日", version: "1.0.28", title: "物流、科研与统计体验",
    summary: "改进物流槽位、科研喷涂、白糖统计和重整精炼配方路径。",
    items: [
      { id: "logistics-density", title: "物流塔紧凑管理", description: "槽位、供需模式、优先级、库存上下限和载具设置在桌面与移动端保持清晰可编辑。" },
      { id: "research-spraying", title: "科研喷涂约束", description: "矩阵研究只支持速度增产，输入、缓存和研究奖励继续走统一科研结算。" },
      { id: "statistics-ranking", title: "统计与白糖榜", description: "生产统计按星球筛选，白糖每分钟口径由服务端校验，避免把不同星球或旧修订混入榜单。" },
    ],
  },
  {
    id: "2026-08-04-v1.0.27", date: "2026年8月4日", version: "1.0.27", title: "批量建造与连接点偏好",
    summary: "增加连接点大小偏好、建筑批量目标和移动多选操作。",
    items: [
      { id: "connection-points", title: "连接点尺寸", description: "建筑端口、连线圆圈和实际命中区域提供默认、放大 25% 与放大 50% 的设备级偏好。" },
      { id: "batch-targets", title: "制造中心批量目标", description: "建筑制造中心可一次设置全部已解锁建筑的目标库存，最高一亿且不改变现有任务和材料扣除。" },
      { id: "multi-select", title: "批量增加与移动多选", description: "建筑、传送带支持原子批量增加；手机选择 5～50 个对象时保持高亮、选择列表和触摸命中稳定。" },
    ],
  },
  {
    id: "2026-08-04-v1.0.26", date: "2026年8月4日", version: "1.0.26", title: "主题与设置分类",
    summary: "统一亮色/深色主题、设置分类、版本历史分页、科技树横向滚轮和物品悬浮交互。",
    items: [
      { id: "theme", title: "亮色模式全面修复", description: "设置、存档、检查器、施工托盘、提示和弹窗统一浅色语义状态，深色主题和高字号布局保持兼容。" },
      { id: "settings", title: "设置分类与运行记录", description: "设置按类别进入二级页面，运行记录显示可永久关闭，所有选择仍是设备级 UI 偏好。" },
      { id: "technology-wheel", title: "科技树滚轮", description: "桌面滚轮在科技树区域转换为横向移动，阻止页面穿透，纵向滚动仍可由滚动条和键盘完成。" },
      { id: "item-hover", title: "物品悬浮交互", description: "触发范围缩小到图标、名称和数量，移动到悬浮卡后可继续点击定位与图鉴按钮。" },
    ],
  },
  {
    id: "2026-08-03-v1.0.25", date: "2026年8月3日", version: "1.0.25", title: "画布交互与设置体验更新",
    summary: "改进建筑选中、上下游寻线、星球统计、自动保存与侧栏布局，并补齐窄屏和大字号设置体验。",
    items: [
      { id: "selection", title: "稳定选中与寻线", description: "建筑选中反馈保持稳定，新增上下游寻线高亮和远程线路提示，画布刷新不会清空选择。" },
      { id: "planet-statistics", title: "按星球生产统计", description: "生产量、消耗量、净产量和时间窗口可按星球筛选，切换不重置搜索、排序和范围。" },
      { id: "autosave", title: "自动保存策略", description: "本地自动保存增加 10 分钟和关闭选项，并与云同步开关分离；手动保存、导出和上传继续可用。" },
      { id: "sidebars", title: "左右侧栏收起", description: "左右面板可分别滑出画布，收起后只保留稳定箭头按钮，状态保存为设备级偏好。" },
    ],
  },
  {
    id: "2026-08-03-v1.0.24", date: "2026年8月3日", version: "1.0.24", title: "工厂管理与画布性能更新",
    summary: "新增物流管理、精确线路选择、批量回收、物品快捷操作和手机蓝图导入；保留 GameState v46 与存档兼容。",
    items: [
      { id: "logistics", title: "物流管理", description: "按星系、星球和物流塔管理远程槽位、载具、量子模式与缓存设置。" },
      { id: "canvas", title: "终局画布优化", description: "新增轻量快照、拓扑缓存、节点 LOD、视口裁剪和独立回退开关。" },
      { id: "blueprint", title: "蓝图与回收", description: "手机导入入口可见，建筑与传送带批量回收保持库存守恒。" },
    ],
  },
  {
    id: "2026-08-03-v1.0.23", date: "2026年8月3日", version: "1.0.23", title: "云存档上传热修",
    summary: "流式 gzip、取消和网络超时核验，避免大存档上传卡死、误报成功或重复修订。",
    items: [
      { id: "gzip", title: "流式压缩", description: "压缩流持续消费并提供超时保护；不支持压缩时使用有大小上限的原始 JSON 回退。" },
      { id: "cloud", title: "安全重试", description: "网络超时先核对云端修订和摘要，expectedRevision 始终保护重试。" },
    ],
  },
  {
    id: "2026-08-02-v1.0.22", date: "2026年8月2日", version: "1.0.22", title: "大存档上传响应性",
    summary: "上传准备、离线结算和保存校验移入 Worker，减少主线程重复解析和序列化。",
    items: [
      { id: "worker", title: "Worker 上传准备", description: "复用一次验证过的 payload，并支持阶段进度和取消。" },
      { id: "offline", title: "离线结算可取消", description: "进入游戏或上传前可放弃长时间离线结算，原存档保持不变。" },
    ],
  },
  {
    id: "2026-08-02-v1.0.21", date: "2026年8月2日", version: "1.0.21", title: "量子物流与终局稳定性",
    summary: "量子网络、终局性能开关和云存档兼容修复继续沿用 v46 存档格式。",
    items: [
      { id: "quantum", title: "量子网络", description: "共享库存、上传下载边界和兼容迁移保持守恒。" },
      { id: "stability", title: "稳定性修复", description: "保存、Worker 和移动端输入路径增加确定性回归测试。" },
    ],
  },
  {
    id: "2026-08-02-v1.0.20", date: "2026年8月2日", version: "1.0.20", title: "量子即时入库与云存档兼容",
    summary: "量子供应塔在物资实际送达时优先进入共享库存，并修复云存档与旧蓝图字段的兼容边界。",
    items: [
      { id: "quantum-deposit", title: "量子即时入库", description: "传送带、运输机和供应塔溢出缓存共用直接入库路径，容量不足时按整数回落本地缓存或源端，不重复上传。" },
      { id: "legacy-blueprint", title: "旧蓝图兼容", description: "服务端兼容普通建筑遗留的 quantumTarget 字段，客户端保存时只为星际物流站保留目标状态。" },
      { id: "cloud-errors", title: "云端错误分类", description: "格式无效、完整性失败、存档过大和请求体积过大分别提示；GameState v46 与云协议不变。" },
    ],
  },
  {
    id: "2026-08-01-v1.0.19", date: "2026年8月1日", version: "1.0.19", title: "量子网络与内容包 Worker 同步",
    summary: "GameState v45 守恒迁移到 v46，量子网络、内容包注册表同步和终局生产工具完成稳定性修复。",
    items: [
      { id: "v46", title: "守恒迁移", description: "旧存档迁移到 v46，保留库存、线路、物流槽、载具、在途物资和生产进度。" },
      { id: "registry", title: "Worker 注册表协议", description: "实时、纯挂机和离线 Worker 使用带 fingerprint 的可序列化内容包快照，注册表变化建立模拟边界。" },
      { id: "blueprint-stack", title: "蓝图与终局工具", description: "统一一亿建筑堆叠上限，补齐蓝图对齐、量子目标、待建补料、递归 WIP 和统计时间窗口。" },
    ],
  },
  {
    id: "2026-08-01-v1.0.18", date: "2026年8月1日", version: "1.0.18", title: "量子空间库存",
    summary: "量子上传与下载拆分为独立预算，轨道采集器可接入量子采集网络，逐物品容量和库存面板保持兼容。",
    items: [
      { id: "quantum-budget", title: "独立量子预算", description: "量子上传和下载使用独立全星区额度；传统运输机、槽位模式、优先级和在途航线继续生效。" },
      { id: "collector", title: "轨道采集网络", description: "轨道采集器只上传、不下载、不额外生成带宽，接入前后的尾货与缓存保持守恒。" },
      { id: "quantum-inventory", title: "逐物品容量", description: "每种量子物品可独立设置容量并在星图查看精确值、五秒流量和净变化。" },
    ],
  },
  {
    id: "2026-08-01-v1.0.17", date: "2026年8月1日", version: "1.0.17", title: "量子接入与暂停画布",
    summary: "量子物流站安全接入扫描全局航线账本，画布交互与端口命中在暂停和移动端保持稳定。",
    items: [
      { id: "quantum-attach", title: "安全接入", description: "旧星际航线与在途尾货完成后再切换量子模式，不提前删除路线或物资。" },
      { id: "canvas-input", title: "画布交互", description: "暂停、拖动、连接虚影、端口吸附和手机缩放使用独立瞬时状态，不改写模拟状态。" },
    ],
  },
  {
    id: "2026-07-31-v1.0.16", date: "2026年7月31日", version: "1.0.16", title: "终局批处理与缓存稳定性",
    summary: "运行时账本、画布拓扑缓存和离线事件调度继续保持非持久化，长时间模拟避免重复扫描。",
    items: [
      { id: "runtime-cache", title: "运行时缓存", description: "物流账本、线路拓扑和离线边界只在 Worker 会话内缓存，legacy 全扫描仍作为确定性校验路径。" },
      { id: "autosave-polling", title: "保存轮询修复", description: "移除无条件轮询所有槽位和快照，保存仍由明确的生命周期和设置间隔触发。" },
    ],
  },
  {
    id: "2026-07-31-v1.0.15", date: "2026年7月31日", version: "1.0.15", title: "纯挂机与自然语言教程",
    summary: "时间扭曲统一为可停止的纯挂机流程，新增覆盖桌面和手机的完整教程。",
    items: [
      { id: "pure-idle", title: "纯挂机模式", description: "生产、采集、物流、电力、科研、戴森和建筑制造按实际倍率推进，暂停不累积墙钟预算。" },
      { id: "tutorial", title: "完整教程", description: "从画布、采集、传送带、物流到戴森和存档排障提供可搜索的自然语言说明。" },
    ],
  },
  {
    id: "2026-07-31-v1.0.14", date: "2026年7月31日", version: "1.0.14", title: "星区资料与物流索引",
    summary: "星球元数据、无限采集倍率、十万级蓝图部署和物流诊断索引加入守恒回归。",
    items: [
      { id: "galaxy-metadata", title: "星球资料", description: "星球和恒星系支持名称、备注、标签和搜索，显示元数据不改变内部 ID 或生产引用。" },
      { id: "blueprint-atomic", title: "原子蓝图", description: "蓝图先规划建筑、矿脉锚点、线路和材料，一次性扣料；不足或非法数量保持原状态。" },
      { id: "logistics-index", title: "物流索引", description: "候选站点和跨星系路径复用运行时索引，仍保留存档线路顺序和 legacy 回退。" },
    ],
  },
  {
    id: "2026-07-30-v1.0.13", date: "2026年7月30日", version: "1.0.13", title: "画布拓扑与大数显示",
    summary: "大型工厂画布缓存拓扑和端口占用，视口裁剪与大数格式覆盖终局数据。",
    items: [
      { id: "canvas-topology", title: "画布缓存", description: "稳定拓扑、端口占用和线路束避免每次状态发布重复派生，缩放后可恢复完整节点信息。" },
      { id: "large-number", title: "大数格式", description: "排行榜和功率显示支持更大的单位与科学计数法，并提供精确值提示。" },
    ],
  },
  {
    id: "2026-07-30-v1.0.12", date: "2026年7月30日", version: "1.0.12", title: "轨道目标与线路模板",
    summary: "弹射器支持独立太阳帆轨道目标，线路模板同步和物流枢纽大字卡片保持几何稳定。",
    items: [
      { id: "dyson-orbit", title: "独立轨道目标", description: "每台弹射器可选择所在恒星系轨道，失效目标暂停但不丢失太阳帆和发射进度。" },
      { id: "belt-template", title: "线路模板", description: "同步线路明确模板顺序，保留并联、优先级、形态、监测、路由和在途物资。" },
      { id: "logistics-ui", title: "大字卡片", description: "物流枢纽端口与状态在桌面、手机、平板和 80%～200% 字号下保持可达。" },
    ],
  },
  {
    id: "2026-07-30-v1.0.11", date: "2026年7月30日", version: "1.0.11", title: "终局批处理与排行榜完整性",
    summary: "物流、燃料、递归制造批处理和服务器排行榜完整性约束完成确定性回归。",
    items: [
      { id: "endgame-batch", title: "终局批处理", description: "物流匹配、燃料消耗、能量枢纽和复杂递归制造复用会话级索引与确定性事务。" },
      { id: "leaderboard-integrity", title: "排行榜保护", description: "服务器从主云存档重算指标，受限提交不会被上传、恢复或启动回填重建。" },
    ],
  },
  {
    id: "2026-07-29-v1.0.10", date: "2026年7月29日", version: "1.0.10", title: "终局工厂性能基础",
    summary: "为多星球终局工厂加入会话级只读运行时索引，在不改变玩法数据的前提下降低模拟扫描。",
    items: [
      { id: "simulation-index", title: "模拟索引", description: "供电、生产、线路转运和物流阶段复用实体 ID、行星集合和线路端点索引。" },
      { id: "deterministic-baseline", title: "确定性基线", description: "legacy 与索引路径逐状态哈希一致，模拟秒数、产量、物流、离线收益和存档格式不变。" },
    ],
  },
  {
    id: "2026-07-29-v1.0.9", date: "2026年7月29日", version: "1.0.9", title: "存档后台化与内容包 v2",
    summary: "本地存档迁入 IndexedDB，动态模块加载可恢复，内容包升级为 v2 并保留旧存档安全边界。",
    items: [
      { id: "indexeddb", title: "可靠存档", description: "主档、备份、快照和槽位使用 IndexedDB 写入读回校验，旧 localStorage 副本验证后才清理。" },
      { id: "content-pack-v2", title: "内容包 v2", description: "支持白名单物品、建筑、配方、科技、覆盖和高等级传送带；缺包存档会阻止载入。" },
      { id: "mobile-input", title: "移动输入", description: "修复中文输入法组合态、亮色主页和移动布局模糊问题。" },
    ],
  },
  {
    id: "2026-07-28-v1.0.8", date: "2026年7月28日", version: "1.0.8", title: "存档完整性与性能诊断",
    summary: "保存、导出和云上传增加客户端与服务端校验，结构完整的异常存档可受控救援。",
    items: [
      { id: "save-integrity", title: "存档自检", description: "校验失败不再显示虚假摘要；救援前保留原始文件并连续确认，结构损坏的文件不会被强行导入。" },
      { id: "performance-panel", title: "按需性能页", description: "性能监控默认关闭，打开后显示 FPS、Worker、积压、内存、存档和阶段耗时。" },
      { id: "hub-ports", title: "物流端口", description: "配送枢纽三个输入端口可分别配置，重置连接会返还线路、缓存和在途物资。" },
    ],
  },
  {
    id: "2026-07-28-v1.0.7", date: "2026年7月28日", version: "1.0.7", title: "递归制造与副产物安全",
    summary: "建筑制造中心按后续步骤保留必要 WIP，托盘副产物溢出不再永久阻塞任务。",
    items: [
      { id: "recursive-wip", title: "必要 WIP", description: "任务按真实净需求保留中间材料，暂停、断电和缺料只等待，不取消任务或隐藏半成品。" },
      { id: "byproduct-safety", title: "副产物安全", description: "非必要副产物可按规则处理并累计记录，必要材料、玩家库存和最终成品不被删除。" },
    ],
  },
  {
    id: "2026-07-28-v1.0.6", date: "2026年7月28日", version: "1.0.6", title: "传送带并联与采矿蓝图",
    summary: "传送带并联上限、建筑减堆、采矿锚点蓝图和制造中心 WIP 规则统一到同一守恒边界。",
    items: [
      { id: "belt-lanes", title: "高并联线路", description: "并联数量、蓝图、同步、存档和服务端校验使用同一边界，增减继续扣返施工库存。" },
      { id: "mining-blueprint", title: "采矿蓝图", description: "蓝图只记录资源锚点和相对布局，部署时匹配现有矿脉，不复制储量或无限状态。" },
      { id: "stack-control", title: "建筑减堆", description: "检查器支持分步减堆并保留缓存、燃料、进度、物流槽、线路和在途载具。" },
    ],
  },
  {
    id: "2026-07-27-v1.0.5", date: "2026年7月27日", version: "1.0.5", title: "运输载具与量子前置",
    summary: "空间翘曲高级配方、物流载具递归制造、运输机/运输船目标和矿脉极限利用加入游戏。",
    items: [
      { id: "warper-recipe", title: "空间翘曲配方", description: "引力矩阵可制造空间翘曲器，递归制造优先完整可行的材料链。" },
      { id: "fleet-targets", title: "载具目标", description: "物流塔支持运输机和运输船目标、部分补足与蓝图保存，执行中的载具不会被强行返还。" },
      { id: "mining-tech", title: "矿脉极限利用", description: "固体采矿速度和矿脉消耗倍率按科技等级独立结算，有限/无限切换需要确认。" },
    ],
  },
  {
    id: "2026-07-26-v1.0.4", date: "2026年7月26日", version: "1.0.4", title: "传送带设置与科技目录",
    summary: "已建传送带可直接调整并联，手机科技目录补齐无限科技，建筑制造中心目标上限提升。",
    items: [
      { id: "belt-adjust", title: "并联调整", description: "检查器提供加减和直接输入，扣返同级传送带，保持线路等级、端口和在途物资。" },
      { id: "technology-catalog", title: "科技目录", description: "新版手机科技列表包含五项无限科技，未解锁时显示真实前置条件。" },
      { id: "construction-target", title: "自动补足", description: "完成扩容科技后建筑制造中心目标最高可设为 100,000，调低不会删除库存。" },
    ],
  },
  {
    id: "2026-07-26-v1.0.3", date: "2026年7月26日", version: "1.0.3", title: "生产定位与时间扭曲诊断",
    summary: "运输船递归制造、物品定位产线、时间扭曲功率诊断和喷涂模块回收加入统一命令路径。",
    items: [
      { id: "production-locate", title: "定位产线", description: "物品资料可定位当前行星的生产设备和完整上游网络，也可跳转到其他行星来源。" },
      { id: "timewarp-diagnostics", title: "时间扭曲诊断", description: "检查器显示请求倍率、实际倍率、需求功率、获得功率和降档原因，活动时钟仍按真实时间。" },
      { id: "spray-refund", title: "喷涂模块回收", description: "拆卸时返还模块、缓存增产剂和剩余点数折算物，建筑恢复基础生产倍率。" },
    ],
  },
  {
    id: "2026-07-25-v1.0.2", date: "2026年7月25日", version: "1.0.2", title: "中英文与亮色模式",
    summary: "增加设备级中英文切换并完成主页、账号、云存档、工作区和手机界面的亮色主题覆盖。",
    items: [
      { id: "language", title: "中英文界面", description: "物品、配方、建筑、科技、行星、战役、成就及主要工作区提供英文目录和入口。" },
      { id: "light-theme", title: "亮色主题", description: "开始菜单、账号、云存档、排行榜、工作区、模态和两套手机界面统一语义颜色。" },
      { id: "native-sync", title: "原生同步", description: "Windows 与 Android 同步升级并保留既有应用数据目录和 Android 发布证书。" },
    ],
  },
  {
    id: "2026-07-25-v1.0.1", date: "2026年7月25日", version: "1.0.1", title: "Portal 提示与建筑交互锁",
    summary: "统一精确值 Portal 生命周期，补齐主题和仓储响应式节点，并增加建筑交互锁与检查器偏好。",
    items: [
      { id: "portal", title: "精确值 Portal", description: "鼠标、键盘和触摸共用唯一 Portal 层，避免提示卡被父级裁剪或重复挂载。" },
      { id: "interaction-lock", title: "建筑锁定", description: "锁定建筑仍参与模拟，但领域命令会阻止移动、回收、堆叠、升级和配置修改。" },
      { id: "storage-responsive", title: "仓储响应式", description: "储物仓与储液罐共用稳定端口几何，物资托盘单种物品上限提升到 100,000,000。" },
    ],
  },
  {
    id: "2026-07-24-v1.0.0", date: "2026年7月24日", version: "1.0.0", title: "公开测试版首发",
    summary: "戴森壳层、银河物资出口、微型黑洞、时间扭曲主控和多站物流公平调度首次进入公开版本。",
    items: [
      { id: "release-100", title: "终局系统", description: "戴森壳层复制、银河物资出口、三端口微型黑洞和全存档时间扭曲主控使用确定性状态。" },
      { id: "logistics-fairness", title: "物流公平", description: "多个供应塔可部分补足同一需求，并通过持久公平游标避免固定命中首塔。" },
      { id: "cloud-storage", title: "云存储上线", description: "账号、主云存档、手动槽位和服务端存储布局建立稳定协议，存档 envelope 保持 v2。" },
    ],
  },
];

const RELEASE_HISTORY_PAGE_SIZE = 3;

export function getReleaseNotesPage(page: number, pageSize = RELEASE_HISTORY_PAGE_SIZE): ReleaseNotesRecord[] {
  const safePage = Math.max(0, Math.floor(page));
  const safeSize = Math.max(1, Math.floor(pageSize));
  return RELEASE_NOTES_HISTORY.slice(safePage * safeSize, (safePage + 1) * safeSize) as ReleaseNotesRecord[];
}

export function getReleaseNotesPageCount(pageSize = RELEASE_HISTORY_PAGE_SIZE): number {
  const safeSize = Math.max(1, Math.floor(pageSize));
  return Math.max(1, Math.ceil(RELEASE_NOTES_HISTORY.length / safeSize));
}

export function getReleaseNotesPageForRelease(id: string, pageSize = RELEASE_HISTORY_PAGE_SIZE): number | null {
  const index = RELEASE_NOTES_HISTORY.findIndex((release) => release.id === id);
  if (index < 0) return null;
  return Math.floor(index / Math.max(1, Math.floor(pageSize)));
}

export function hasSeenCurrentReleaseNotes(): boolean {
  try {
    if (window.localStorage.getItem(RELEASE_NOTES_SEEN_KEY) === CURRENT_RELEASE_NOTES.id) return true;
    // Isolated browser fixtures intentionally bypass first-run chrome. This
    // keeps older release fixtures deterministic without hiding new notes for
    // real players who have already seen a previous version.
    const isReleaseNotesTest = new URLSearchParams(window.location.search).get("releaseNotesTest") === "1";
    return !isReleaseNotesTest && window.sessionStorage.getItem("dsp-idle-network.test-bypass-menu") === "1";
  } catch {
    try { return window.sessionStorage.getItem(RELEASE_NOTES_SEEN_KEY) === CURRENT_RELEASE_NOTES.id; } catch { return false; }
  }
}

export function markCurrentReleaseNotesSeen(): void {
  try {
    window.localStorage.setItem(RELEASE_NOTES_SEEN_KEY, CURRENT_RELEASE_NOTES.id);
  } catch {
    try { window.sessionStorage.setItem(RELEASE_NOTES_SEEN_KEY, CURRENT_RELEASE_NOTES.id); } catch { /* optional preference */ }
  }
}

export function ReleaseNotesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const releaseScrollRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const historyScrollTopRef = useRef(0);
  const [historyPage, setHistoryPage] = useState(0);
  const [selectedReleaseId, setSelectedReleaseId] = useState<string>(CURRENT_RELEASE_NOTES.id);
  const [historyOpen, setHistoryOpen] = useState(false);
  const selectedRelease = RELEASE_NOTES_HISTORY.find((release) => release.id === selectedReleaseId) ?? CURRENT_RELEASE_NOTES;
  const pageCount = getReleaseNotesPageCount();
  const pageEntries = getReleaseNotesPage(historyPage);

  const openHistoryPage = (page: number) => {
    const safePage = Math.max(0, Math.min(pageCount - 1, Math.floor(page)));
    const entries = getReleaseNotesPage(safePage);
    setHistoryPage(safePage);
    // A direct page jump from detail must visibly change the preview instead
    // of leaving the previous release selected behind a newly opened list.
    if (entries.length > 0 && !entries.some((entry) => entry.id === selectedReleaseId)) {
      setSelectedReleaseId(entries[0].id);
    }
    setHistoryOpen(true);
  };

  const showHistory = () => {
    historyScrollTopRef.current = releaseScrollRef.current?.scrollTop ?? 0;
    openHistoryPage(historyPage);
    window.requestAnimationFrame(() => {
      if (releaseScrollRef.current) releaseScrollRef.current.scrollTop = historyScrollTopRef.current;
    });
  };
  const showRelease = (id: string) => {
    historyScrollTopRef.current = releaseScrollRef.current?.scrollTop ?? 0;
    const page = getReleaseNotesPageForRelease(id);
    if (page === null) {
      setSelectedReleaseId(CURRENT_RELEASE_NOTES.id);
      setHistoryPage(0);
      setHistoryOpen(false);
      return;
    }
    setHistoryPage(page);
    setSelectedReleaseId(id);
    setHistoryOpen(false);
    window.requestAnimationFrame(() => {
      if (releaseScrollRef.current) releaseScrollRef.current.scrollTop = historyScrollTopRef.current;
    });
  };

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousBodyOverflow = document.body.style.overflow;
    const previousRootOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";

    const syncVisualViewport = () => {
      const viewport = window.visualViewport;
      const height = Math.max(240, viewport?.height ?? window.innerHeight);
      backdropRef.current?.style.setProperty("--release-notes-viewport-height", `${Math.round(height)}px`);
    };
    syncVisualViewport();
    window.addEventListener("resize", syncVisualViewport);
    window.visualViewport?.addEventListener("resize", syncVisualViewport);
    window.visualViewport?.addEventListener("scroll", syncVisualViewport);
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus({ preventScroll: true }));
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    const onNativeBack = (event: Event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener(NATIVE_BACK_EVENT, onNativeBack, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener(NATIVE_BACK_EVENT, onNativeBack, true);
      window.removeEventListener("resize", syncVisualViewport);
      window.visualViewport?.removeEventListener("resize", syncVisualViewport);
      window.visualViewport?.removeEventListener("scroll", syncVisualViewport);
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousRootOverflow;
      previousFocusRef.current?.focus({ preventScroll: true });
    };
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div ref={backdropRef} className="release-notes-backdrop" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="release-notes-dialog" role="dialog" aria-modal="true" aria-labelledby="release-notes-title">
        <header className="release-notes-header">
          <span className="release-notes-version"><small>VERSION</small><strong>{selectedRelease.version}</strong></span>
          <div><small>{selectedRelease.date} · 公开测试版</small><h2 id="release-notes-title">{selectedRelease.title}</h2></div>
          <button ref={closeButtonRef} type="button" onClick={onClose} title="关闭版本更新记录" aria-label="关闭版本更新记录"><X size={18} /></button>
        </header>
        <div className="release-notes-body">
          <div className="release-notes-history-toolbar" aria-label="版本历史分页">
            <button type="button" onClick={historyOpen ? () => showRelease(CURRENT_RELEASE_NOTES.id) : showHistory}>{historyOpen ? <><ChevronLeft size={14} />返回当前版本</> : <><History size={14} />查看历史版本</>}</button>
            <span>第 {historyPage + 1} / {pageCount} 页</span>
            <label>
              <span>跳转页码</span>
            <select aria-label="跳转版本页" value={historyPage} onChange={(event) => openHistoryPage(Number(event.currentTarget.value))}>
                {Array.from({ length: pageCount }, (_, page) => <option value={page} key={page}>第 {page + 1} 页</option>)}
              </select>
            </label>
            <button type="button" disabled={historyPage <= 0} onClick={() => openHistoryPage(historyPage - 1)} aria-label="上一页版本"><ChevronLeft size={14} />上一页</button>
            <button type="button" disabled={historyPage >= pageCount - 1} onClick={() => openHistoryPage(historyPage + 1)} aria-label="下一页版本">下一页<ChevronRight size={14} /></button>
          </div>
          {historyOpen ? <nav className="release-notes-history-list" aria-label="版本列表">
            {pageEntries.map((release) => <button type="button" className={release.id === selectedRelease.id ? "active" : ""} key={release.id} onClick={() => showRelease(release.id)}><span><strong>{release.version} · {release.title}</strong><small>{release.date}</small></span><ChevronRight size={15} /></button>)}
          </nav> : null}
          <div className="release-notes-scroll" ref={releaseScrollRef} onScroll={(event) => { historyScrollTopRef.current = event.currentTarget.scrollTop; }}>
            <p className="release-notes-summary"><Info size={16} /><span>{selectedRelease.summary}</span></p>
            <ol>
              {selectedRelease.items.map((item, index) => {
                const Icon = RELEASE_NOTE_ICONS[item.id as keyof typeof RELEASE_NOTE_ICONS] ?? Info;
                return (
                  <li key={item.id}>
                    <i><Icon size={18} /><em>{String(index + 1).padStart(2, "0")}</em></i>
                    <span><strong>{item.title}</strong><p>{item.description}</p></span>
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
        <footer className="release-notes-footer">
          <span><MessageCircle size={15} /><small>QQ 交流群</small><strong>1076757280</strong></span>
          <button type="button" onClick={onClose}><Check size={16} />我知道了</button>
        </footer>
      </section>
    </div>
  );
}
