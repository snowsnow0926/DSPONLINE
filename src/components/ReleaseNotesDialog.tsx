import { Activity, Check, ChevronLeft, ChevronRight, History, Info, Layers, MessageCircle, Route, Shield, X, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAppLocale } from "../i18n/locale";
import { NATIVE_BACK_EVENT } from "../nativeApp";

export const RELEASE_NOTES_SEEN_KEY = "dsp-idle-network.release-notes.seen.v1";

export const CURRENT_RELEASE_NOTES = {
  id: "2026-08-04-v1.0.27",
  date: "2026年8月4日",
  version: "1.0.27",
  title: "连接交互与批量建造更新",
  summary: "1.0.27 增加连接点尺寸偏好、建筑制造批量目标和混合选区原子批量增加，并稳定移动端多选。GameState v46、存档 envelope v2 与云 schema v7 不变。",
  items: [
    {
      id: "connection-point-size",
      title: "连接点尺寸可调",
      description: "设置提供默认、放大 25% 和放大 50%；端口、连线圆圈、吸附半径与点击范围同步变化，并只保存在当前设备。",
    },
    {
      id: "construction-batch-target",
      title: "建筑制造批量目标",
      description: "建筑制造中心可一次为所有已解锁建筑设置库存目标；现有任务和在制品保持不变，并继续受仓储科技上限约束。",
    },
    {
      id: "selection-batch-increase",
      title: "混合选区批量增加",
      description: "建筑和传送带混合选区可使用 +1、+10、+100 或自定义数量；先汇总全部材料，缺料时整批保持不变。",
    },
    {
      id: "mobile-selection",
      title: "移动端多选稳定性",
      description: "逐点多选在模拟刷新和画布事件重派生期间保留选区，持续显示选中轮廓和数量，不再因瞬时空选择被清除。",
    },
    {
      id: "release-compatibility",
      title: "存档与在线协议保持兼容",
      description: "本版新增设置使用安全默认值或设备级偏好，不升级 GameState v46、存档 envelope v2、云 schema v7 或 SQLite layout v2。",
    },
  ],
} as const;

const RELEASE_NOTE_ICONS: Record<(typeof CURRENT_RELEASE_NOTES.items)[number]["id"], LucideIcon> = {
  "connection-point-size": Route,
  "construction-batch-target": Layers,
  "selection-batch-increase": Activity,
  "mobile-selection": Shield,
  "release-compatibility": Check,
};

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
  {
    id: "2026-08-04-v1.0.26", date: "2026年8月4日", version: "1.0.26", title: "亮色主题与设置交互更新",
    summary: "1.0.26 统一亮色与深色语义主题，重构设置分类和版本历史，并优化科技树滚轮与物品悬浮交互。GameState v46、存档 envelope v2 与云 schema v7 不变。",
    items: [
      { id: "semantic-theme", title: "亮色与深色语义主题", description: "工作区、节点、线路、弹窗、表单和移动界面统一使用语义颜色，补齐选中、禁用、危险、悬停和键盘焦点状态。" },
      { id: "settings-navigation", title: "设置分类与二级页面", description: "设置首页改为分类总览，版本历史支持离线分页、详情查看和返回位置保留。" },
      { id: "item-reference", title: "科技树与物品交互", description: "科技树滚轮横向浏览；物品卡支持鼠标、键盘、移动点击与长按，并可定位产线或打开资料库。" },
    ],
  },
  {
    id: "2026-08-03-v1.0.25", date: "2026年8月3日", version: "1.0.25", title: "画布交互与设置体验更新",
    summary: "1.0.25 改进建筑选中、上下游寻线、星球统计、自动保存与侧栏布局，并补齐窄屏和大字号设置体验。GameState v46、存档 envelope v2 与云 schema v7 不变。",
    items: [
      { id: "stable-selection", title: "建筑选中稳定高亮", description: "模拟刷新、性能模式和 Worker 状态发布不再清空当前建筑选择；选中边框、底色和标记在缩小视图中仍保持可见。" },
      { id: "planet-statistics", title: "生产统计按星球筛选", description: "生产统计可查看全部星球或指定星球，库存、生产消耗、异常和用电设备随范围过滤，搜索、排序和时间窗口保持不变。" },
      { id: "independent-sidebars", title: "左右侧栏独立收起", description: "物资侧栏和检查器都可从画布边缘独立收起与展开，画布会回收空间，同时保留选择、标签页、滚动位置和模拟状态。" },
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
  const { locale } = useAppLocale();
  const backdropRef = useRef<HTMLDivElement>(null);
  const releaseScrollRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const historyScrollTopRef = useRef(0);
  const [historyPage, setHistoryPage] = useState(0);
  const [selectedReleaseId, setSelectedReleaseId] = useState<string>(CURRENT_RELEASE_NOTES.id);
  const [historyOpen, setHistoryOpen] = useState(false);
  const selectedRelease = RELEASE_NOTES_HISTORY.find((release) => release.id === selectedReleaseId) ?? CURRENT_RELEASE_NOTES;
  const pageCount = Math.max(1, Math.ceil(RELEASE_NOTES_HISTORY.length / RELEASE_HISTORY_PAGE_SIZE));
  const pageEntries = getReleaseNotesPage(historyPage);

  const showHistory = () => {
    historyScrollTopRef.current = releaseScrollRef.current?.scrollTop ?? 0;
    setHistoryOpen(true);
    window.requestAnimationFrame(() => {
      if (releaseScrollRef.current) releaseScrollRef.current.scrollTop = historyScrollTopRef.current;
    });
  };
  const showRelease = (id: string) => {
    historyScrollTopRef.current = releaseScrollRef.current?.scrollTop ?? 0;
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
        <div className="release-notes-history-toolbar" aria-label="版本历史分页">
          <button type="button" onClick={historyOpen ? () => showRelease(CURRENT_RELEASE_NOTES.id) : showHistory}>{historyOpen ? <><ChevronLeft size={14} />返回当前版本</> : <><History size={14} />查看历史版本</>}</button>
          <span>{locale === "en" ? `Page ${historyPage + 1} / ${pageCount}` : `第 ${historyPage + 1} / ${pageCount} 页`}</span>
          <button type="button" disabled={historyPage <= 0} onClick={() => setHistoryPage((page) => Math.max(0, page - 1))} aria-label="上一页版本"><ChevronLeft size={14} />上一页</button>
          <button type="button" disabled={historyPage >= pageCount - 1} onClick={() => setHistoryPage((page) => Math.min(pageCount - 1, page + 1))} aria-label="下一页版本">下一页<ChevronRight size={14} /></button>
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
        <footer className="release-notes-footer">
          <span><MessageCircle size={15} /><small>QQ 交流群</small><strong>1076757280</strong></span>
          <button type="button" onClick={onClose}><Check size={16} />我知道了</button>
        </footer>
      </section>
    </div>
  );
}
