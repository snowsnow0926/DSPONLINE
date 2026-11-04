import { AlertTriangle, BookOpen, BookMarked, CheckCircle2, ChevronLeft, ChevronRight, List, Monitor, RotateCcw, Search, Smartphone, Target, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import "../styles/tutorial.css";
import { StableTextInput } from "./CompositionSafeInput";
import { WorkspaceFrame } from "./WorkspaceFrame";
import { readTutorialProgress, writeTutorialProgress } from "../game/tutorialProgress";

type TutorialSection = {
  id: string;
  title: string;
  goal: string;
  prerequisites: string;
  steps: string[];
  success: string;
  mistakes: string[];
  recovery: string;
};

const SECTIONS: TutorialSection[] = [
  { id: "canvas", title: "认识画布", goal: "学会移动、缩放和选择工厂。", prerequisites: "进入任意工厂星球。", steps: ["鼠标左键拖动画布；手机用一根手指拖动。", "滚轮或双指捏合缩放，双击可聚焦画布（如果设置中开启）。", "点击建筑、传送带或空白处查看选择状态；再次点击顶部工作区按钮可关闭工作区。"], success: "你能把工厂移动到屏幕中央，并打开一个建筑检查器。", mistakes: ["拖动建筑而不是画布。", "手机第二根手指加入后仍继续拖建筑。"], recovery: "松开所有手指后点击空白处，再用画布边缘拖动；双指会接管缩放。" },
  { id: "gather-craft", title: "采集与手搓", goal: "从资源点拿到第一批矿石并制作建筑。", prerequisites: "找到矿脉或原油涌泉，施工托盘中有对应设备。", steps: ["点击资源节点，按住采集或使用采集按钮拿取物品。", "在建造面板打开物品手工制造，选择铁块等中间材料。", "选择建筑并输入数量；材料链会先完整规划，确认后一次扣料。", "把做好的建筑放入光标，再点击画布空白处放置。"], success: "新建筑出现在画布上，施工托盘数量准确减少。", mistakes: ["只看到了钢材，却没有铁矿石。", "输入了小数或负数。"], recovery: "查看锤子详情中的真实缺料链；原矿不足时回到资源节点采集。" },
  { id: "build-stack", title: "放置与堆叠建筑", goal: "让多台相同设备共享一个节点。", prerequisites: "施工托盘中至少有两台相同建筑。", steps: ["选择建筑后点击画布放置第一台。", "选中节点，使用 +1 堆叠或直接输入目标数量。", "需要减少时使用 -1、-10 或输入数量；最低保留一台，完整拆除有单独确认。", "观察输入、输出、燃料、物流槽和缓存随堆叠变化。"], success: "节点显示新的数量，已有库存与线路物品没有丢失。", mistakes: ["把货物堆叠误认为建筑数量。", "调低数量时以为超额库存会消失。"], recovery: "超额库存会暂时保留并停止新输入；库存降到上限以下后自动恢复。" },
  { id: "belts", title: "连接传送带", goal: "把生产建筑的输出接到下一个建筑的输入。", prerequisites: "至少有两个兼容端口和对应等级的传送带。", steps: ["从输出端口拖到输入端口；端口吸附范围在手机上更大。", "线路等级、形状、并联数、货物堆叠和优先级可在检查器调整。", "同一物品可以有多条线路；普通、高优先级先供给，配送枢纽默认为低优先级溢出。", "选择线路后可直接输入并联数量，材料不足会显示缺口。"], success: "线路变为已连接状态，货物沿线路到达输入缓存。", mistakes: ["把输出接到输出，或方向反了。", "没有解锁线路等级或施工库存不足。"], recovery: "查看端口提示；删除错误线路会返还施工件，已经在途的货物会安全处理。" },
  { id: "recipes", title: "选择与切换配方", goal: "让熔炉和制造台执行正确配方。", prerequisites: "放置熔炉、制造台或其他生产设备。", steps: ["点击建筑后打开选择配方；手机不会自动弹出键盘。", "搜索配方名称或物品名称，点击配方查看耗时和产量。", "确认输入线路与输出空间，再选择配方。", "切换配方前先检查现有输入、输出和生产进度。"], success: "节点显示配方，绿色进度条开始按真实快照推进。", mistakes: ["移动端直接出现输入法。", "科技未解锁或输入物品不兼容。"], recovery: "先关闭配方列表再主动点击搜索框；查看配方详情中的前置科技和缺料原因。" },
  { id: "tray", title: "物品与物资托盘", goal: "在建筑缓存、手上物品和行星托盘之间安全移动物资。", prerequisites: "身上或建筑里有一件物品。", steps: ["从建筑输入/输出槽点击取出，或拖动物品到光标。", "点击物资托盘图标，把手持物品放回当前行星托盘。", "主动放下手持物品时允许超过托盘单种上限，自动入库仍遵守上限。", "在物资面板可设置托盘上限、删除一半或全部，并进行二次确认。"], success: "物品数量守恒，光标清空，托盘显示实际数量。", mistakes: ["把自动输入当成玩家主动放下。", "在错误星球查看托盘。"], recovery: "先确认顶部当前行星，再从光标主动放下；失败时不要重复点击，查看提示。" },
  { id: "research", title: "打开科技并开始研究", goal: "用矩阵解锁下一阶段设施。", prerequisites: "有科研站和对应颜色矩阵。", steps: ["打开顶部科技入口；再次点击科技按钮可关闭并回到画布。", "选择满足前置条件的科技，确认矩阵输入和研究队列。", "可以暂停、取消或切换研究；已经投入的矩阵和进度会保留。", "无限科技位于同一目录；空结果页可以清除筛选。"], success: "科技状态变为研究中，进度随模拟时间增加。", mistakes: ["只看到了当前筛选下的空列表。", "矩阵不足或前置科技未完成。"], recovery: "点击清除筛选，打开前置科技；在科技页确认真实缺少哪种矩阵。" },
  { id: "logistics", title: "储物仓、储液罐与配送枢纽", goal: "建立稳定的本地存储和溢出收集。", prerequisites: "已解锁仓储或物资配送枢纽。", steps: ["储物仓和储液罐的输入、输出端口位于卡片边界内；字号变大时会自动换行。", "配送枢纽的三个输入接口可指定物资、恢复自动识别或清空。", "清空有旧线路的接口前先确认断开；缓存和在途货物会安全返还。", "把普通生产线设为高优先级，把配送枢纽留作低优先级溢出。"], success: "正常产物进入生产线，剩余产物进入当前星球托盘。", mistakes: ["文字遮住端口。", "误以为低优先级限制最大输送量。"], recovery: "调整字体或窗口宽度；检查托盘真实上限，低优先级只改变竞争顺序。" },
  { id: "stations", title: "行星与星际物流", goal: "让运输机和运输船自动往返。", prerequisites: "完成对应物流科技并放置物流塔。", steps: ["为供给端和需求端配置相同物品槽，设置供需方向和起送比例。", "在塔内输入运输机或运输船目标数量，也可以一键补满。", "跨恒星系航线只由实际派船的一侧检查并预留翘曲器；同一恒星系不消耗。", "观察供电、空闲载具、在途数量和真实阻塞原因。"], success: "载具从正确的所属站点出发，货物抵达后返回并归还库存。", mistakes: ["目标端没有翘曲器却误报缺少。", "把执行中的载具直接卸载。"], recovery: "按派遣方向检查翘曲器；等待返航后再调整目标数量。" },
  { id: "warp", title: "翘曲器与跨星系运输", goal: "准备空间翘曲器并理解消耗规则。", prerequisites: "解锁空间翘曲科技和星际物流站。", steps: ["基础配方或重力矩阵绿糖精简配方都可以制造翘曲器。", "把翘曲器装入星际物流站，或打开自动补充并设置目标库存。", "自动补充只读取所在行星托盘；不会跨行星直接取货。", "跨星系每艘往返运输船预留两个翘曲器，取消任务会正确退款。"], success: "站内库存达到目标，跨星系航线显示可派遣。", mistakes: ["把同恒星系路线也当成跨星系。", "托盘为空却期待从别的星球补充。"], recovery: "切换到物流站所在星球补充托盘，检查路线的星系边界和派遣方向。" },
  { id: "dyson", title: "戴森工程", goal: "从太阳帆和火箭建立持续能源。", prerequisites: "解锁戴森云、弹射器或发射井。", steps: ["在戴森规划中建立轨道和球壳层，记录每层容量。", "电磁轨道弹射器可以指定当前恒星系的目标轨道。", "输入太阳帆、火箭并观察发射、吸附、寿命和接收功率。", "射线接收站会分别显示理论接收率、实际利用率和功率瓶颈。"], success: "轨道与球壳进度增加，接收站输出按 kW 显示。", mistakes: ["目标轨道被删除或属于其他恒星系。", "接收站输出堵塞却以为是随机效率。"], recovery: "重新选择有效轨道，检查输出线路、供电和接收站缓存。" },
  { id: "construction-center", title: "建筑制造中心", goal: "自动递归制造复杂建筑并持续补给。", prerequisites: "解锁并放置建筑制造中心，准备原矿和电力。", steps: ["设定建筑目标和数量；高级、稀有和精简配方会优先尝试。", "系统先完整规划多级材料链，再一次性扣除可用原矿和中间材料。", "必要中间材料 WIP 永远保留；额外副产物进托盘，托盘满时记录销毁量。", "检查当前阶段、进度、WIP、缺料、供电和预计时间。"], success: "铁矿石能自动加工为铁块、钢材再进入目标建筑，不会停在直接材料提示。", mistakes: ["高级配方未解锁仍强制使用。", "氢等副产物填满缓存后任务停止。"], recovery: "系统会回退可完成的基础配方；查看销毁计数和真实阻塞原因，不要手动重启任务。" },
  { id: "time-warp", title: "时间扭曲纯挂机", goal: "在不操作工厂的情况下提高真实模拟倍率。", prerequisites: "放置时间扭曲装置并接入足够电力。", steps: ["选中装置并设为主控，选择请求倍率。", "点击“开始纯挂机”，进入独立挂机页面；画布、建造和选择会被冻结。", "挂机页只显示实际倍率、挂机时间、终局指标和保存状态。", "点击“停止并结算”后等待候选状态验证，再返回工厂。"], success: "停止后返回同一工厂，暂停期间没有补算，进度从最后有效快照恢复。", mistakes: ["把挂机页面关闭当成停止。", "供电不足却期待请求倍率完全生效。"], recovery: "刷新会恢复最后有效存档；重新进入后查看实际倍率和降档原因，确认后再开始。" },
  { id: "blueprint", title: "蓝图与生产区域", goal: "复制布局而不复制矿脉、库存或载具。", prerequisites: "至少有一条线路或一组建筑。", steps: ["框选建筑和线路，保存蓝图并设置名称。", "矿脉只作为资源定位锚点，粘贴时必须落在已有兼容矿脉上。", "部署前确认总需求；库存不足时只部分施工或拒绝，不会复制物资。", "生产区域可拖动四边和四角调整，内部建筑和线路不随区域移动。"], success: "蓝图部署后线路关系、矿机相对位置和物资守恒保持不变。", mistakes: ["期待蓝图自动创建矿脉。", "导入区域被蓝图列表遮挡。"], recovery: "选择已有资源点再部署；窄窗口请滚动蓝图工作区，导入区与列表独立滚动。" },
  { id: "troubleshooting", title: "常见故障排查", goal: "快速判断为什么产线不动。", prerequisites: "任意生产或物流设备。", steps: ["先看设备状态：缺料、堵塞、供电不足、暂停、缺载具和缺翘曲器是不同原因。", "再看输入输出缓存、线路方向、端口物品和托盘容量。", "打开运营中心 → 性能，按需采样 Worker、传送带、物流和渲染阶段。", "保存前观察主存档校验；失败时使用“立即导出当前进度”。"], success: "你能说出具体阻塞原因并找到对应教程章节。", mistakes: ["只看到灰色锤子就重复点击。", "把画面刷新慢误认为产量变慢。"], recovery: "查看诊断面板和本教程搜索；真实模拟与视觉刷新是分离的，先确认库存和状态数字。" },
  { id: "save-performance", title: "性能与存档", goal: "让大型工厂稳定运行并保护进度。", prerequisites: "已进入游戏。", steps: ["设置中的生产画面刷新频率只改变界面发布，不改变产量。", "性能模式只减少粒子、阴影和线路动画；需要时再开启。", "主存档会读回校验，自动快照失败不能阻止主进度保存。", "本地存档、手动槽位和云存档互相独立；导入前先看摘要和校验。"], success: "切换刷新档位后状态哈希一致，保存失败时界面不会显示假成功。", mistakes: ["把三秒视觉刷新当成三秒模拟。", "容量不足时反复保存而不导出。"], recovery: "先导出当前进度，再管理自动快照；降低视觉效果不会改变存档内容。" },
];

const GLOSSARY: Array<[string, string]> = [
  ["物资托盘", "当前行星玩家可直接取放的公共库存。"],
  ["WIP", "建筑制造中心正在加工、且后续步骤仍需要的中间材料。"],
  ["并联数", "一条传送带线路同时运行的平行带数量，直接影响吞吐。"],
  ["起送比例", "物流塔达到该比例后才派遣载具，避免小批量频繁出发。"],
  ["实际倍率", "供电和设备允许的真实模拟倍率，可能低于请求倍率。"],
];

function TutorialVisual({ mobile }: { mobile: boolean }) {
  return <figure className={`tutorial-visual${mobile ? " tutorial-visual--mobile" : ""}`} aria-label={mobile ? "手机界面示意" : "桌面界面示意"}>
    <div className="tutorial-visual-toolbar"><i /><i /><i /><span>{mobile ? "工厂 · 建造 · 物资 · 科研 · 更多" : "当前行星 · 供电 100% · 暂停 · 警报"}</span></div>
    <div className="tutorial-visual-canvas"><b /><b /><b /><em /><em /></div>
    <figcaption>{mobile ? "手机：底部导航和抽屉保证入口始终可达" : "桌面：画布、检查器和工作区同时可见"}</figcaption>
  </figure>;
}

export function TutorialWorkspace({ open, mobile, initialSectionId, onClose }: { open: boolean; mobile?: boolean; initialSectionId?: string; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState(initialSectionId && SECTIONS.some((section) => section.id === initialSectionId) ? initialSectionId : SECTIONS[0].id);
  const [completed, setCompleted] = useState<Set<string>>(() => readTutorialProgress());
  useEffect(() => {
    writeTutorialProgress(undefined, completed);
  }, [completed]);
  useEffect(() => {
    if (initialSectionId && SECTIONS.some((section) => section.id === initialSectionId)) setActiveId(initialSectionId);
  }, [initialSectionId]);
  if (!open) return null;
  const visible = SECTIONS.filter((section) => !query.trim() || `${section.title} ${section.goal} ${section.steps.join(" ")} ${section.mistakes.join(" ")}`.toLowerCase().includes(query.trim().toLowerCase()));
  const active = SECTIONS.find((section) => section.id === activeId) ?? visible[0] ?? SECTIONS[0];
  const mark = () => setCompleted((current) => new Set(current).add(active.id));
  const reset = () => { setCompleted(new Set()); setActiveId(SECTIONS[0].id); };
  return <WorkspaceFrame className={`tutorial-workspace${mobile ? " tutorial-workspace--mobile" : ""}`} ariaLabel="新手教程" onRequestClose={onClose}>
    <header className="tutorial-header"><div><span>DSP极简网络 · v{__APP_VERSION__}</span><strong>从零开始的完整教程</strong></div><div className="tutorial-header-actions"><span className="tutorial-progress"><CheckCircle2 size={14} />{completed.size}/{SECTIONS.length}</span><button type="button" onClick={onClose} aria-label="关闭新手教程" title="关闭新手教程"><X size={18} /></button></div></header>
    <div className="tutorial-layout">
      <aside className="tutorial-index"><label className="tutorial-search"><Search size={15} /><StableTextInput draftId="tutorial-search" value={query} onValueChange={setQuery} placeholder="搜索教程" aria-label="搜索教程" /></label><div className="tutorial-index-heading"><span><List size={14} />目录</span><button type="button" onClick={reset} title="重置阅读进度"><RotateCcw size={13} /></button></div><nav>{visible.map((section) => <button className={`${active.id === section.id ? "active " : ""}${completed.has(section.id) ? "complete" : ""}`} type="button" key={section.id} onClick={() => setActiveId(section.id)}><i>{completed.has(section.id) ? <CheckCircle2 size={15} /> : <span>{SECTIONS.indexOf(section) + 1}</span>}</i><span>{section.title}</span></button>)}</nav><section className="tutorial-glossary"><header><BookMarked size={14} />术语表</header>{GLOSSARY.map(([term, definition]) => <details key={term}><summary>{term}</summary><p>{definition}</p></details>)}</section></aside>
      <article className="tutorial-article"><div className="tutorial-article-heading"><div><small>第 {SECTIONS.indexOf(active) + 1} 节 / {SECTIONS.length}</small><h1>{active.title}</h1><p>{active.goal}</p></div><Target size={22} /></div><section className="tutorial-facts"><div><strong>目标</strong><span>{active.goal}</span></div><div><strong>前置条件</strong><span>{active.prerequisites}</span></div></section><div className="tutorial-steps"><h2>具体步骤</h2><ol>{active.steps.map((step) => <li key={step}>{step}</li>)}</ol></div><div className="tutorial-visuals"><TutorialVisual mobile={false} /><TutorialVisual mobile /></div><section className="tutorial-result"><h2><CheckCircle2 size={17} />成功表现</h2><p>{active.success}</p></section><section className="tutorial-errors"><h2><AlertTriangle size={17} />常见错误</h2><ul>{active.mistakes.map((mistake) => <li key={mistake}>{mistake}</li>)}</ul><p><strong>恢复方法：</strong>{active.recovery}</p></section><footer className="tutorial-article-footer"><button type="button" onClick={() => { const index = SECTIONS.indexOf(active); if (index > 0) setActiveId(SECTIONS[index - 1].id); }} disabled={SECTIONS.indexOf(active) <= 0}><ChevronLeft size={16} />上一节</button><button className={completed.has(active.id) ? "complete" : "primary"} type="button" onClick={mark}>{completed.has(active.id) ? <CheckCircle2 size={16} /> : <Target size={16} />}{completed.has(active.id) ? "已完成" : "标记本节完成"}</button><button type="button" onClick={() => { const index = SECTIONS.indexOf(active); if (index < SECTIONS.length - 1) setActiveId(SECTIONS[index + 1].id); }} disabled={SECTIONS.indexOf(active) >= SECTIONS.length - 1}>下一节<ChevronRight size={16} /></button></footer></article>
    </div>
  </WorkspaceFrame>;
}
