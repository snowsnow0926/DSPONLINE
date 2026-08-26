# DSP极简网络 `1.0` 后续十一项需求开发规格

> 规格日期：2026-07-25
>
> 文档状态：前期审计与实施设计，尚未开始功能开发
>
> 审计代码基线：Git `f4e2a5501435`，分支 `main`，工作树包含其他任务的未提交改动
>
> 当前产品基线：SemVer `1.0.0`、`GameState` v34、存档 envelope v2、云 schema v7、SQLite layout v2
>
> 目标产品版本：尚未指定；本文统一称“`1.0` 后续批次”，不得擅自占用 `1.0.1` 或 `1.1.0`
>
> 文档用途：供后续开发 Agent 直接实施、测试和交接；当前文档本身不代表功能已经完成

## 1. 开发边界与启动要求

后续开发开始前必须重新使用 `develop-dspidle` Skill，并重新读取：

- [PROJECT_STATUS.md](./PROJECT_STATUS.md)
- [GAMEPLAY_SYSTEMS.md](./GAMEPLAY_SYSTEMS.md)
- [ARCHITECTURE.md](./ARCHITECTURE.md)
- [TESTING_RELEASE.md](./TESTING_RELEASE.md)
- 实际 `GameState` 类型、`createInitialState()`、`migrateGame()`、存档 envelope 和服务端云存档校验上限
- `git status --short` 与相关文件的未提交 diff

本文审计时，工作树已有主云存档自动排名、排行榜、下载入口和 Nginx 相关改动。至少包括 `src/App.tsx`、`src/styles.css`、`server/index.mjs`、`server/server.test.mjs`、账号/银河组件、部署配置和多份基线文档。它们全部属于用户或其他开发任务，不得 reset、checkout、clean、覆盖、回退或顺手格式化。实施时若这些改动已经提交或继续变化，以新基线为准，并把本文中的行号和版本建议顺延。

未经用户明确要求，本批不得提交、推送、部署、切换正式 release、修改线上活动配置、写入生产数据库，或使用真实账号和真实云存档执行测试。

## 2. 已确认的产品决定

| 项目 | 本规格采用的决定 |
| --- | --- |
| 建筑锁定持久化 | 随 `GameState`、本地存档和云存档持久化；不是仅当前设备的临时选择状态 |
| 建筑锁定范围 | 阻止玩家对实体本身的移动、回收、堆叠、升级和配置修改；不停止生产、电力、物流或既有线路运行 |
| 锁定线路 | 本批不增加“线路锁定”；锁定建筑不会静默删除或暂停既有线路 |
| 蓝图与锁定 | 可以只读复制锁定建筑；蓝图粘贴得到的新实体默认未锁定，不复制源实体的交互锁 |
| 检查器排序持久化 | 属于设备本地 UI 偏好，不进入 `GameState`、云存档或玩法迁移 |
| 检查器默认顺序 | 配方修改 -> 建筑数量/堆叠 -> 建筑升级 -> 喷涂设置 -> 电力信息 |
| 检查器固定区域 | 身份、运行状态和只读摘要固定在排序区上方；说明文字固定在排序区下方 |
| 翘曲器自动转仓 | 仅在“自动补充”开启且空间翘曲科技有效时执行；先消费塔内未预留的翘曲器，再读取所在行星托盘 |
| 物资托盘预设 | `1万 / 10万 / 100万 / 1亿 / 自定义`；`1亿` 严格等于 `100,000,000` |
| 旧托盘配置 | 旧存档保持原值，不自动提高到 1 亿；降低上限继续保留超额库存 |
| 制造中心结论 | 当前没有足够证据锁定单一根因；必须先用运行轨迹区分模拟变慢、制造规则变慢和 UI 发布变慢，再实施修复 |
| 周期条首要复现 | Windows 桌面端，`经典流畅` 100 ms（每秒 10 次）出现绿条乱跳、与百分比不同步和非完成式回缩；`自动调节`当前 200 ms（每秒 5 次）作为正常对照 |
| 经典档位处理 | 保留固定 100 ms 和“每秒 10 次”语义；不得把 classic 静默改成 200 ms、映射到 high 或在 Windows 上自动降档来掩盖视觉 bug |
| 周期条显示原则 | 绿色填充、数字百分比和 `aria-valuenow` 必须读取同一个展示进度；只有真实周期完成、明确的配方/阶段/运行状态重置或有业务含义的储能下降可以回到更小值 |
| 传送带录屏基准 | Windows 桌面端；硅石采矿节点当前缓存约 500、显示 640/min，单条 Mk.II 传送带连接 11 台高纯硅熔炉；线路标签约每秒在 12.0/s 与 9.6/s 间跳变 |
| 传送带数值口径 | `totalTransferred` 的时间窗口增量是实际吞吐真相；界面显示稳定的近期实际平均值和额定上限，并分别说明上游供给、下游需求与缓存阻塞 |
| 传送带平衡边界 | 本项不调整 Mk.I/Mk.II/Mk.III 的 6/12/30 s^-1 基础容量，也不修改采矿或高纯硅配方；只有累计数量证明真实少送后才修结算逻辑 |

若产品希望锁定仅保存在本机，或希望检查器排序随云存档同步，需要在开发前明确推翻上表，因为这会改变迁移范围和跨设备体验。本规格默认不等待额外确认，按上表实施。

## 3. 当前代码审计结论

### 3.1 版本与迁移链

- `src/game/types.ts` 中 `GameState.version` 的实际类型为字面量 `34`。
- `src/game/storage.ts#migrateGame()` 当前接受 v1-v34，并通过一条连续归一化链输出 v34，不是每一版一个独立迁移函数。
- `createInitialState()` 当前创建 v34；存档 envelope 的 `SAVE_FORMAT_VERSION` 仍为 2。
- `server/index.mjs#validateGameStatePayload()` 当前拒绝高于 v34 的云存档。
- 云 schema 为 v7，SQLite layout 为 v2；本批没有账号表或 SQLite 数据布局需求。
- v33->v34 已占用戴森层分配起点、微型黑洞端口、时间扭曲和物流公平游标。新字段不得塞回或改写 v34 迁移语义。

### 3.2 建筑耗电文字重复

`PowerValue` 同时渲染一个常驻紧凑值和一个默认隐藏的精确值 Tooltip。问题不是引擎重复计算功率，而是 CSS 选择器泄漏：

- `.quantity-value__tooltip` 在 `src/styles.css` 中声明 `display: none`。
- 更靠后的 `.factory-node__footer span` 对所有后代 `span` 声明 `display: flex`，其 specificity 也更高。
- `PowerValue` 放在机器节点 footer 中时，Tooltip 子 `span` 被强制常驻，形成“固定功率 + 悬浮功率”同时显示。
- `PowerValue` 还同时设置原生 `title` 和自定义 Tooltip，悬停时可能出现两套提示。
- 点击后的 `expanded` 状态只在 blur 或 Escape 时关闭；细指针设备上点击后移开鼠标并不保证立即消失。

因此此项应修复组件样式边界和 Tooltip 生命周期，不能通过删除功率数据或隐藏整个 footer 规避。

### 3.3 亮色模式不完整

当前亮色模式主要依赖 `src/theme.css` 中大量 `html[data-theme="light"] :is(...)` 覆盖。审计发现：

- `styles.css` 原始匹配有 1,173 个十六进制颜色和 228 个 `rgb/rgba`；三个移动样式和 `codex.css` 另有大量固定深色。
- 六个主要样式文件合计约 1,857 个颜色字面量匹配。这里包含合法的物品色和状态色，但也包含大量不应硬编码的背景、文字、边框、遮罩与阴影。
- `theme.css` 在主入口加载，但 `mobile-shell.css`、`mobile-factory.css`、`mobile-workspaces.css` 和 `codex.css` 会随运行时或工作区懒加载。后加载规则可以重新覆盖亮色模式。
- 当前用一组高 specificity 和 `!important` 规则补救移动端，只覆盖了列出的组件，新增或漏列组件仍会回到深色。
- `useResolvedTheme()` 在普通 effect 中写 `document.documentElement.dataset.theme`，主题切换存在一帧局部旧样式的可能。

此项不能继续追加零散白名单。应把中性颜色和交互颜色改为语义主题变量，并让懒加载 CSS 只消费变量。

### 3.4 储物箱与储液罐节点

`FactoryNodes.tsx#LogisticsNode` 已为 `storage_mk1` 和 `storage_tank` 添加专用宽度，但当前一行同时包含：

- 跨两列的 `.storage-slot-summary`，重复显示物品名、输入和输出数字；
- 一个完整 `InputSlot`；
- 一个完整 `OutputSlot`。

这与普通工厂节点的“两列标题 + 两个端口”结构不同。长文字和大字号下，summary、物品 badge、端口和两列网格相互竞争空间。端口位置依赖这套额外行结构，字体变化后虽然 React Flow 会重测部分节点，代码没有针对储物节点尺寸变化显式刷新 handle internals。

### 3.5 建筑锁定

当前 `FactoryEntity` 没有交互锁字段。React Flow 节点统一使用：

```ts
draggable: !placement && !blueprintPlacementId
```

桌面、经典手机和新版手机还有不同的全局 `nodesDraggable`/布局模式条件。删除键、选择工具栏、检查器按钮、自动整理、批量生产管理和配方/物流命令均未区分锁定实体。仅在节点上设置 `draggable: false` 不足以满足“从锁定建筑起拖直接平移画布”，也不能阻止回收和配置命令。

### 3.6 检查器顺序

`GamePanels.tsx#EntityInspector` 目前是一个大型条件分支组件。普通生产建筑的控制顺序大致为：

1. 配方；
2. 混合运行指标；
3. 电力网络；
4. 喷涂；
5. 升级；
6. 描述；
7. 增减堆叠和回收。

各类特殊建筑又复制不同排列。当前没有稳定 section ID、折叠状态、拖拽排序模型或本地偏好键。直接对现有 JSX 节点做 DOM 排序会丢失组件内部状态，并且不能可靠处理“该建筑没有喷涂或升级区”的情况。

### 3.7 翘曲器补仓

现有 `refillStationWarpersFromPlanetTrays()` 只从行星托盘补到 `stationWarpers`：

- 调用位置在普通生产后、物流派遣前；
- 不读取塔自身物流槽的 `inputs.space_warper` 或 `outputs.space_warper`；
- 传送带会把翘曲器送进 station input，下一模拟步再由 `transferLogisticsBuffers()` 转进 station output；
- 物流到货直接增加需求塔 output；
- 两种来源都不会自动进入专用翘曲器仓。

现有在途货物与供应预留由 `stationInFlightCargo()` 和 `stationReservedOutgoing()` 维护。新增转仓逻辑必须复用这些语义，不能从已经被出站航线预留的 output 再扣一次。

### 3.8 星际物流调度

v34 当前实现已经包含：

- 按物品、范围和模式建立的会话级候选索引；
- 多供应塔部分补足；
- `stationLastSupplyPeerBySlot` 持久化公平游标；
- `vehicleStationId` 记录载具所属塔；
- 供应塔与需求塔分别按实际派船方槽位读取起送比例；
- 库存预留、在途占用、返航和翘曲退款；
- 安装、忙碌、可用、受阻数量及原因诊断。

代码中没有写死“最多 20 艘”。星际物流塔基础容量为每层 10 艘，堆叠 5 层应为 50 艘。约 20 艘可出发的高概率原因包括：翘曲器数量除以每船预算、库存低于起送量、需求剩余容量、供电、中转路线或已有忙碌航线。当前仍需通过玩家同构场景验证，而不能仅凭代码判断问题已解决。

### 3.9 行星物资托盘上限

当前实际常量为：

```ts
MIN_PLANET_TRAY_ITEM_LIMIT = 1_000;
MAX_PLANET_TRAY_ITEM_LIMIT = 1_000_000;
DEFAULT_PLANET_TRAY_ITEM_LIMIT = 1_000_000;
```

这与 v32 的“生产建筑/仓储物流建筑缓存最高 1 亿”是两套独立设置。托盘 UI 目前只有数字输入框和 `1K-1M` 提示，没有 1 亿预设。服务端会校验两项建筑缓存上限，但尚未逐行星校验 `planetTrayItemLimits`。

### 3.10 建筑制造中心周期性变慢

当前短测只覆盖约 8-10 秒，没有覆盖用户报告的 10 分钟窗口。审计发现四个必须采样的风险点，但尚不能把任一个写成已确认根因：

1. `runConstructionCenters()` 每个实体、每个模拟步最多执行 128 次阶段循环；命中 guard 后未使用的 `remainingWork` 当前会被丢弃。高堆叠、4x 或大量短阶段可能形成真实吞吐上限。
2. Worker 忙碌时主线程继续累积模拟债务；若 Worker 返回前 `game` 被另一命令替换，旧结果会被丢弃并把提交秒数重新加入债务。连续冲突或高 Worker 延迟会表现为整个模拟落后，随后又追赶恢复。
3. 递归任务在规划时验证完整链，但建立 job 时不一次性预留完整原料；多个中心或其他系统可以在阶段之间竞争托盘物资，形成真实等待。状态必须准确显示缺料。
4. 节点视觉插值用 `entity.productionRate` 推导周期，而制造中心的该值只统计最终建筑完成量；材料阶段现在是 0 秒即时边界，最终建筑阶段仍为 5/2.5/1 秒周期，两者并不等价。实际状态正确时仍可能显示错误速度。

修复前必须采集 `elapsedSeconds`、Worker 往返、模拟债务、当前 job/step、阶段耗时、WIP、托盘原料、`powerFactor`、128 guard 命中次数和最终产出，先确定属于哪一层。

### 3.11 生产周期绿条与百分比不同步

用户给出的首要复现条件是 Windows 桌面端使用 `经典流畅` 100 ms；`自动调节`当前解析为 200 ms，同一玩家观察正常。当前代码存在足以解释视觉异常的结构性问题，但在加入逐帧轨迹前，不把它写成唯一根因：

- `FactoryNodes.tsx#WorkCycle` 的文字百分比和 `aria-valuenow` 直接来自最近一次 `entity.progress` 快照。
- 同一组件给填充条写入 `width: ${percent}%`，但 `.work-cycle--interpolated > i` 又启动从 `width: 0` 到 `width: 100%` 的无限 CSS 动画。动画值会覆盖 inline `width`，因此填充条和文字实际使用两套时间源。
- 每次真实快照更新还会重写 `animationDuration` 和负 `animationDelay`。负 delay 以现有 CSS animation timeline 计算，并不天然以“本次快照收到时刻”为新零点；快照发布、速率变化或组件重渲染时可能重复计入已流逝时间并重新定位相位。
- `visualCyclesPerSecond` 由 `productionRate / unitsPerCycle / 60` 反推。`productionRate` 是最近模拟步的物品产量，不是规范的周期速率；增产剂在一个模拟步内耗尽、额外产出比例变化、输入/输出在步内阻塞，以及建筑制造中心的材料阶段/成品阶段都会让该反推值失真。
- 该反推值是“每模拟秒”的周期率，CSS duration 却按真实墙钟秒运行；当前没有乘以 2x/4x 或时间扭曲的有效模拟倍率。高倍率下真实快照与动画相位必然持续漂移，再由下一次快照强行校正。
- `productionRefresh.ts#interpolateProductionProgress()` 已有纯插值 helper 和单元测试，但生产组件没有使用它；当前 E2E 只断言动画名称存在、350 ms 后宽度变化，没有断言宽度与文字一致、没有非法回缩，也没有覆盖 100 ms 档。
- `WorkCycle` 同时承载真正生产周期、制造中心步骤、物流航程、储能电量和用 `networkTime % 1` 生成的活动指示。这些数据并非同一种语义，不能继续共用“无限循环百分比动画”。
- `App.tsx` 的 Worker 约每 1 秒返回一次真实状态，`canvasGame` 再按 100/200/500/1000/1500/3000 ms 档检查并发布最新快照；当前 CSS 动画负责填补真实快照之间的视觉间隔。修复不能让 UI 时钟反向写回 `GameState`，也不能为了绿条把模拟步长改成 100 ms。

现阶段没有证据说明确定性引擎中的 `entity.progress` 会在同一未完成周期内自行倒退。后续实现必须同时记录真实快照和 DOM 展示轨迹，先区分“底层 progress 倒退”“快照发布相位问题”和“纯 CSS 动画相位问题”。

### 3.12 Mk.II 传送带 12.0/9.6 s^-1 抖动

录屏中的两个数字与当前实现可以精确对应。当前已确认至少存在显示/诊断口径错误；是否同时存在真实少送，必须通过累计数量继续判定：

- `BELT_CAPACITY_PER_SECOND` 中 Mk.II 单线、单层容量为 12/s。
- 高纯硅配方每台电弧熔炉每 2 秒消耗 2 个硅石，即基础满电时 1/s；11 台总需求为 11/s。
- 采矿节点显示 640/min 等于 10.6667/s。约 500 个既有缓存可以在一段时间内补足 11/s 需求，但不能让长期供给永久高于 10.6667/s；若其他条件不变，500 个净差额约可维持 25 分钟的 11/s 下游消费。
- `transferBelts()` 在每个内部模拟子步开始时无条件执行 `belt.lastFlow *= 0.8`。因此上一步的 12.0 会精确变成 9.6。
- 只有当前子步至少结算 1 个整数物品时，`lastFlow` 才会被 `moved / seconds` 覆盖。Worker 请求通常不是精确整数秒；例如 1.02 秒会被拆成 1 秒和 0.02 秒两个内部步。最后的短尾步可能不足以结算 1 个物品，于是最终发布值保留 12 x 0.8 = 9.6，即使整段请求的累计吞吐已经跑满。
- `lastFlow` 的固定 0.8 衰减不考虑子步实际持续 0.01、0.2、1、10 或 30 秒。同一累计模拟时间只因请求分块不同，就可能得到不同的显示流量与拥堵指数。
- 桌面线路标签、线路检查器、统计中心、热力图、连续网络、生产管理、教学诊断和物流建筑运行状态都直接读取 `lastFlow`，所以抖动并非单一标签问题。新版手机还把这个本来按秒计算的值错误标成 `/min`。
- `simulateStep()` 先传送带转运、后机器生产。整数配方和目标缓存边界会形成合法的批次波动；不能用某一个内部步的搬运量代表长期吞吐。
- `network.ts#entityItemRatePerSecond()` 对矿脉又把已经包含采矿科技倍率的 `entity.productionRate` 乘了一次 `getMiningSpeedMultiplier()`，连接预测可能重复放大矿机供给。机器需求预测则偏理论值，未完整反映实际供电和行星专长。
- 现有引擎测试只验证一个整 1 秒步可以在 Mk.I 上搬 6 个物品；没有覆盖 11 台熔炉、Mk.II、500 缓存、非整数 Worker 请求、长期累计量或 12/9.6 抖动。

因此不能把“上游有 500 库存”直接等同于“线路必须永远显示 12/s”。下游基础需求只有 11/s 时，稳态有用流量应接近 11/s；真正需要修复的是：显示必须采用诚实稳定的时间窗口，诊断必须解释限制端，且在源、目标都允许 12/s 的专门场景中累计转运必须确实达到 12/s。

## 4. 全局不变量

1. 相同 `GameState`、相同模拟秒数和相同可信墙钟秒数必须得到相同状态哈希。
2. UI 刷新频率、主题、字号、浏览器缩放和设备性能不得改变产量、物流顺序、功耗或科研结果。
3. 旧存档中的库存、超额托盘、施工库存、建筑、线路、载具、翘曲器、物流预留、在途货物、科研、戴森和终局进度不得减少。
4. 降低任何上限只阻止普通后续写入，不裁剪已有库存；保护性返还与已在途到货继续允许形成临时超额。
5. 锁定只限制玩家交互命令。模拟器仍可更新锁定实体的进度、缓存、功率、状态、物流和统计。
6. 任何物流优化和诊断增强都不得改变稳定排序、实际 route owner、起送比例、库存预留、翘曲扣除或离线结果。
7. Tooltip 不得在未悬停、未聚焦或未由粗指针明确展开时占用布局或显示；同一时刻只显示当前目标的一个 Tooltip。
8. 主题切换只改变表现，不改写物品目录中的身份色、状态数据或 `GameState` 玩法字段。
9. 玩家可见库存和物流货物保持非负整数；1 亿仍远低于 `Number.MAX_SAFE_INTEGER`，不得引入浮点截断。
10. 确定式进度条的填充比例、可见百分比和无障碍百分比必须来自同一个展示值。普通运行中禁止从中间百分比缩回更小的中间百分比；`100% -> 0%` 的真实周期换轮或伴随明确状态文案的业务重置不属于异常回缩。
11. 线路实际吞吐以时间窗口内 `totalTransferred` 的整数增量为准。刷新档、Worker 请求尾数、内部子步数量和 UI 动画不得改变累计转运、源/目标库存总和或线路诊断结论。

## 5. 状态、迁移与本地偏好设计

### 5.1 `GameState` 版本策略

按当前基线实施时，本批应从 v34 追加到 v35。唯一必须新增的持久玩法字段是建筑交互锁。若开发开始时其他任务已占用 v35，则整体顺延到实际最终版本的下一版，不能修改已有迁移。

建议在 `FactoryEntity` 增加必填字段：

```ts
interactionLocked: boolean;
```

选择必填而不是可选字段，目的是让所有新实体、蓝图粘贴和迁移路径显式决定锁定状态，避免不同组件对 `undefined` 产生分叉。v34 及更早实体统一迁移为 `false`。

迁移必须同时处理：

- `createInitialState()` 生成 v35；
- `migrateGame()` 接受 v1-v35并输出 v35；
- 每个实体只在 `entity.interactionLocked === true` 时归一化为锁定，其他旧值统一为 `false`；
- 新放置实体、蓝图粘贴实体和内容包实体默认 `false`；
- 已是 v35 的重复加载保持幂等；
- 服务端云存档合法版本上限顺延到 v35；
- 云 payload 对 `interactionLocked` 只接受 boolean，或由客户端迁移后再上传；不得把字符串 `"false"` 当作真值；
- 存档 envelope 保持 v2，云 schema 保持 v7，SQLite layout 保持 v2。

### 5.2 锁定命令

领域层增加纯命令，名称可按现有风格调整：

```ts
setEntitiesInteractionLocked(
  state: GameState,
  entityIds: readonly string[],
  locked: boolean,
): GameState
```

要求：

- 只修改存在的实体；ID 去重并保持实体数组原顺序；
- 没有实际变化时返回原对象；
- 不重置 position、progress、utilization、缓存、线路、WIP 或物流状态；
- 进入 undo/redo、主存档、手动槽、导入导出和云同步；
- 不自动锁定连接线路、生产区域或蓝图定义。

### 5.3 检查器 UI 偏好

新增独立本地键，例如：

```text
dsp-idle-network.inspector-layout.v1
```

建议 schema：

```ts
type InspectorSectionId =
  | "recipe"
  | "stack"
  | "upgrade"
  | "proliferator"
  | "power";

interface InspectorLayoutPreferenceV1 {
  version: 1;
  order: InspectorSectionId[];
  collapsed: InspectorSectionId[];
}
```

读取时必须：去重、过滤未知 ID、把未来新增但缺失的默认 ID 追加到末尾、过滤非法 collapsed ID。解析失败回退默认值，不抛错、不清空其他 localStorage。此偏好不进入 `GameSettings`、`GameState`、云存档或迁移版本。

### 5.4 其他状态

- 亮色模式继续使用现有 `settings.theme`，不新增存档字段。
- 翘曲器自动转仓复用 `stationWarperAutoRefill`、`stationWarperTarget` 和 `stationWarpers`，不新增状态。
- 托盘 1 亿只扩大现有合法范围，不改变 `planetTrayItemLimits` 结构。
- 制造中心只有在确认必须持久化未结算工作额度时才追加字段；若需要，必须与锁定字段一起进入同一最终迁移版本，不能再制造一个临时版本。
- 周期条的快照序号、单调时钟锚点、展示进度和动画状态全部属于瞬时 UI 状态，不进入 `GameState`、存档、云 payload 或迁移。不得为修复纯视觉相位增加持久字段；只有诊断证明引擎缺少真实结算状态时才重新评估。
- 传送带优先复用现有 `progress`、`totalTransferred`、`lastFlow` 和 `congestion`。推荐把 `lastFlow` 改为按实际模拟秒加权的近期平均值，而不是增加纯 UI 存档字段；若最终需要持久化窗口累计秒数/数量以保证保存加载和分块等价，必须与建筑锁一起进入开发时唯一的最终迁移版本，并为旧线路补零，不能覆盖 `totalTransferred` 或货物进度。

## 6. 需求一：修复建筑耗电文字重复显示

### 6.1 实施方案

1. 将 `.factory-node__footer span` 收窄为只作用于 footer 的直接子项，例如 `.factory-node__footer > span`，不得匹配 `PowerValue` 内部 Tooltip。
2. 为 `PowerValue` 和 `QuantityValue` 建立同一 Tooltip 合约，避免两个组件随后再次分叉。
3. 移除承载自定义 Tooltip 元素上的原生 `title`，保留 `aria-label`、`aria-describedby` 和自定义 Tooltip。普通静态文本仍可使用 `title`。
4. 细指针：只在当前根元素 `:hover` 或 `:focus-visible` 时显示；`pointerleave` 立即关闭由点击产生的临时展开状态。
5. 粗指针：点击当前数值可展开精确值；点击外部、切换面板、Escape、失焦或组件卸载时关闭。展开一个数值时不得让其他数值共享状态。
6. Tooltip 使用 absolute 或 portal，不参与 footer 网格尺寸计算；节点、检查器和统计数字宽度保持稳定。
7. 不删除机器 footer 的常驻紧凑耗电值。每个建筑卡片只保留这一处常驻耗电显示；检查器属于独立界面，不算同一卡片重复。

### 6.2 验收

- 未悬停时每个耗电节点只有一个可见功率文本，`.quantity-value__tooltip` 的可见数量为 0。
- 悬停 A 节点功率时仅 A 的一个 Tooltip 可见；移动到空白处后同一 animation frame 后不可见。
- 从 A 移到 B 时 A 关闭、B 打开，不出现共享状态。
- 点击节点本体、拖动画布、打开检查器不应意外把 Tooltip 留在屏幕上。
- 覆盖普通制造机、喷涂机耗电、射线接收、时间扭曲、发电建筑双功率值以及 footer 中的 0 kW。

## 7. 需求二：完整修复亮色模式

### 7.1 主题变量体系

保留物品身份色和少量品牌色，先把所有中性 UI 颜色归并为语义变量。建议至少包括：

```css
--theme-canvas;
--theme-surface;
--theme-surface-raised;
--theme-surface-soft;
--theme-control;
--theme-control-hover;
--theme-control-active;
--theme-overlay;
--theme-text;
--theme-text-soft;
--theme-text-muted;
--theme-text-on-accent;
--theme-border;
--theme-border-strong;
--theme-focus-ring;
--theme-shadow;
--theme-success-bg;
--theme-warning-bg;
--theme-danger-bg;
--theme-tooltip-bg;
--theme-selection-bg;
```

现有 `--bg/--surface/--text` 可以保留为兼容别名，但新规则不得继续写固定黑底、白字或深色 rgba 遮罩。`html[data-theme="dark"]` 与 `html[data-theme="light"]` 只定义变量值，组件规则消费变量。

### 7.2 改造范围

按以下顺序审计，避免只修截图页面：

1. 主菜单、全局壳层、画布、React Flow pane/controls/minimap/selection。
2. 所有工厂节点、端口、线路标签、连接预览、Tooltip 和状态提示。
3. 左侧托盘、右侧检查器、施工栏、菜单、命令面板、确认弹窗和输入控件。
4. 科技、生产资料库、统计、星图、蓝图、戴森、战役、银河、运营和建筑制造中心。
5. 经典手机、新版手机的 topbar、bottom nav、sheet、peek/half/full 检查器、全屏工作区。
6. hover、active、selected、disabled、focus-visible、warning、blocked、success 和 drag preview。

物品自身 `item.color` 可以继续以内联色显示图标或细边，但不能直接作为小字号正文颜色。需要配合主题表面和对比边框，保证文字可读。

### 7.3 加载与刷新

- `useResolvedTheme()` 改为在 layout effect 或等价的首帧同步入口设置根 `data-theme` 和 `color-scheme`。
- system 模式只注册一个 `matchMedia` 监听器；切换模式时及时清理。
- 懒加载的移动和资料库 CSS 不得重新声明固定中性底色，因此加载顺序不再影响主题。
- 不通过持续增加 `!important` 白名单完成本项。只允许对第三方 React Flow 必须覆盖的规则使用限定范围的高 specificity。

### 7.4 对比度门禁

- 普通正文和控件文字目标至少 4.5:1。
- 大字号文字、图标、焦点环和关键边框目标至少 3:1。
- disabled 状态可以降低强调，但标签仍需可辨识，不能变成白底白字或黑底黑字。
- 所有主题截图同时做 computed style 抽查；仅凭“看起来变亮”不算通过。

建议新增只读样式审计脚本，列出背景、正文、边框和遮罩属性中新增的裸颜色字面量。脚本允许物品色/状态色白名单，但 CI 应阻止新的中性硬编码继续增长。

## 8. 需求三：重做储物箱和储液罐 UI

### 8.1 节点结构

储物仓与储液罐改为与生产建筑相同的卡片层级：

1. header：类型、完整建筑名、堆叠数量；
2. 状态/物流周期；
3. 统一 `node-io` 两列；
4. 左列标题“输入”，右列标题“输出”；
5. 两侧各复用一个 `InputSlot`/`OutputSlot`，显示同一缓存物品和各自真实数量；
6. footer：运行状态与容量，不再重复物品名和输入/输出摘要。

删除 `.storage-slot-summary` 这套第三份信息，不在卡片顶部再重复“输入 x、输出 y”。未配置物品时保留明确空状态和合法的自动输入连接提示。

### 8.2 几何规则

- 输入 handle 固定在卡片左侧并与输入 item row 垂直居中；输出 handle 固定在右侧。
- 两列使用 `minmax(0, 1fr)`，物品名允许换行，数量区域使用 tabular 数字和稳定最小宽度。
- 卡片宽度按现有字号档位设置稳定约束，不使用 CSS `scale()` 压缩文字。
- 80%-200% 字号下允许卡片增高；不得只显示物品首字、让端口挤入文字，或用不可读小字适配。
- 给储物节点内容区加尺寸观察，字号、主题、长名称或堆叠数改变布局后调用 `useUpdateNodeInternals(entity.id)`，确保线路端点使用最新几何。
- 移动端 peek/half/full 检查器继续显示完整名称、输入、输出和容量，不能复用桌面节点的裁剪文本。

### 8.3 数据规则

本项只重做呈现，不改变：

- `storedItemId`；
- 输入/输出缓存语义；
- solid/fluid/matrix 兼容规则；
- 堆叠容量；
- 已有线路和线路 ID；
- 拿取、拖放和自动配置行为。

## 9. 需求四：建筑锁定与防误触

### 9.1 玩家交互

桌面选择工具栏和新版手机多选上下文条增加独立“锁定”和“解锁”命令：

- 纯未锁定选区显示“锁定”；
- 纯锁定选区显示“解锁”；
- 混合选区同时提供两个明确命令，不使用含义不清的单一 toggle；
- 框选可以包含锁定和未锁定实体；
- 锁定卡片显示持续可见的 Lock 图标和可访问标签；
- 单个锁定卡片必须有专门解锁入口，至少在锁标记和只读检查器顶部各有一处；
- 移动端解锁按钮触控尺寸至少 44px。

锁定卡片的手势判定：

- 小于点击阈值的 click/tap 可以选中并打开只读检查器；
- 从卡片主体开始、超过拖动阈值后直接平移画布，不移动节点；
- 从锁图标开始只执行选择/解锁，不启动画布拖动；
- 新版手机在 layout 模式也不能拖动锁定节点；在 select 模式仍能选择并批量解锁。

不要仅依赖 `draggable: false`。应为锁定节点建立明确的 pointer gesture 路径，或让卡片主体事件透传给 pane，同时保留独立的锁控件。

### 9.2 必须阻止的命令

锁定实体必须阻止以下玩家命令，并给出“建筑已锁定，请先解锁”的反馈：

- 节点位置提交、自动整理和选区自动布局；
- 回收、Delete 键、减少堆叠、批量回收；
- 增加堆叠、整体升级；
- 配方、燃料、能量模式、物流槽、分流模式、优先级和电网配置；
- 喷涂安装、等级和模式；
- 银河出口、微型黑洞、时间扭曲和建筑制造中心的实体级控制；
- 生产管理中的批量配方/物流槽模板对锁定实体的写操作。

批量命令遇到混合选区时应跳过锁定实体并报告“修改 n 个，跳过 m 个锁定建筑”，不能让整批静默失败，也不能绕过锁。

### 9.3 仍然允许的行为

- 生产周期、电力分配、传送带流动、物流调度、科研和离线模拟；
- 查看检查器、统计和诊断；
- 聚焦、定位、只读复制为蓝图；
- 单独编辑或回收线路，但不得借线路命令移动或删除锁定实体；
- 解锁本身和恢复默认布局偏好。

### 9.4 自动布局与特殊实体

- 自动布局把锁定实体当作固定锚点和障碍，只移动未锁定实体。
- 资源节点本身继续遵守现有固定资源规则；已有采集设备的资源节点若被锁定，回收采集设备和相关配置也必须受锁保护。
- 生产区域不是建筑，不进入本批锁定。
- 拆除最后一台建筑前必须先解锁；不得通过堆叠减一绕过。

## 10. 需求五：右侧检查器排序优化

### 10.1 组件拆分

把当前可交互控制抽成具有稳定 ID 的 section descriptor，而不是对任意 JSX 子节点排序：

```ts
interface InspectorSectionDescriptor {
  id: InspectorSectionId;
  title: string;
  available: boolean;
  content: React.ReactNode;
}
```

每次按持久 order 排序，再过滤当前建筑不支持的 section。切换建筑时，缺失 section 暂时不渲染，但不能从偏好中删除；返回支持该 section 的建筑后恢复原位置和折叠状态。

默认控制顺序严格为：

1. `recipe`：配方、燃料、缓存物品或建筑对应的主要模式；
2. `stack`：增加数量、减少堆叠和回收；
3. `upgrade`：建筑升级；
4. `proliferator`：喷涂安装、等级和模式；
5. `power`：额定/实时功率、电网、优先级和发电调度。

身份、运行状态、当前阶段、库存只读摘要不参与拖拽。锁定实体在固定身份区显示只读状态和解锁入口，下面 section 控件整体 disabled。

### 10.2 排序交互

- 每个 section header 使用 GripVertical 图标作为拖拽把手，标题本身仍可折叠/展开。
- Pointer Events + pointer capture 同时支持鼠标、触控笔和触摸；把手设置 `touch-action: none`，不干扰检查器正常纵向滚动。
- 拖动超过阈值后才进入排序，显示插入位置；pointerup、pointercancel、失焦和组件卸载必须清理 capture 与临时 transform。
- 提供键盘替代：聚焦把手后用 Alt+ArrowUp/Down 或明确的上移/下移菜单调整。
- 排序期间 section 内容不卸载重建；使用稳定 `key={section.id}`，防止输入值、CatalogPicker 和折叠状态丢失。
- “恢复默认排序”放在检查器设置菜单或排序区顶部，执行前无需危险确认，但必须同时恢复默认 order；collapsed 是否清空应明确显示，本规格建议恢复为全部展开。

### 10.3 高度与滚动

- 外层检查器维持单一纵向滚动容器，section 不嵌套第二个无限高度滚动区。
- 折叠时只隐藏 content，不删除 header；展开后使用自然高度，不写死 max-height 动画。
- 排序前后尽量保持拖动 section header 的视觉位置，避免滚动跳顶。
- 80%-200% 字号、经典手机抽屉和新版手机 full inspector 均不得遮挡最后一个 section 或恢复按钮。

## 11. 需求六：物流塔内部翘曲器自动补仓

### 11.1 单一转仓函数

把现有托盘补仓函数扩展为单一确定性流程，伪代码如下：

```ts
for (const station of interstellarStationsInEntityOrder) {
  if (!spaceWarpUnlocked || !station.stationWarperAutoRefill) continue;
  const needed = min(target, capacity) - stationWarpers;
  if (needed <= 0) continue;

  move from station.inputs.space_warper;
  move from max(0, station.outputs.space_warper - reservedOutgoing);
  move remaining need from station planet tray;
}
```

要求：

- 塔内 input 优先于 output，塔内总库存优先于行星托盘；
- output 只能使用未被出站航线预留的数量；
- 不读取尚未到达的 in-flight cargo，也不提前扣除；
- 达到 target 或专用仓 capacity 后停止，超额仍留在原物流槽或托盘；
- 不删除 warper 槽配置，不修改供需模式、优先级、min/max stock 或线路；
- 自动补充关闭时完全不转仓；手动加减仍沿用现有命令；
- 多塔竞争同一托盘时继续按实体稳定顺序，保证离线确定性。

### 11.2 触发时机

至少在以下时点运行同一 helper：

1. 普通传送带完成转移后，使新到 input 的翘曲器可在当前模拟步进入专用仓；
2. 物流航线结算后，使新到 output 的翘曲器立即进入专用仓；
3. 派遣前，以已有塔内缓存和托盘补足本轮可用翘曲器。

同一模拟步可以多次调用，但函数必须幂等，且每次只根据当前真实库存移动，不能重复扣除。

### 11.3 检查器反馈

自动补充状态改为同时显示：

- 专用仓 `当前/目标/容量`；
- 塔内物流槽可用数量；
- 扣除预留后的可转仓数量；
- 所在行星托盘数量；
- 当前阻塞原因：关闭、科技未解锁、目标满足、专用仓满、塔内与托盘均缺货。

原文案“从所在行星物资托盘自动补充”应改为“自动补充专用翘曲器仓”，帮助文字说明“优先塔内物流槽，其次本星球托盘”。

## 12. 需求七：全面复检星际物流调度

### 12.1 不先改平衡

先使用现有 profiler、状态哈希和舰队诊断复现。不得为了让“50 艘看起来都工作”而降低起送比例、提高库存、免费补翘曲器、忽略供电或扩大容量。闲置有合法原因时，正确结果是显示原因；只有满足全部条件仍闲置才属于调度缺陷。

### 12.2 必查流程

逐阶段核对：

1. 候选索引是否包含同物品的全部有效 supply/demand 槽；
2. 优先级、距离、路线策略、公平游标和当前负载排序；
3. 供应库存减 `minStock`、减 outgoing reservation 后的可用量；
4. 需求库存加 in-flight 后的剩余容量；
5. 实际载具所属塔、installed/busy/free；
6. 实际派船方槽位的 minimum load；
7. 两端及中转供电、翘曲开关、每船预算和专用仓；
8. 创建 route 后立即更新 lookup 中的 busy、reserved 和 in-flight；
9. 到货时只扣一次源库存、只加一次需求库存；
10. 返航/完成释放载具；取消时退款翘曲器且不凭空补货；
11. 站点拆除、配方/槽位改变、存档加载和离线结算。

### 12.3 “50 艘只有约 20 艘”验收场景

构造 5 层星际站：

- `stationVessels = 50`，模拟容量也必须为 50；
- 供应库存、需求空间和电力均支持 50 艘；
- 若每船 2 个翘曲器，准备至少 100 个；
- 起送比例对应的货量充足；
- 一次派遣后 route 的 `vehicleCount` 总和和诊断 busy 应达到 50。

对照场景只放 40 个翘曲器、每船 2 个：可出发应为 20，诊断明确显示 20 可用、30 因翘曲器受阻。这个结果不是固定并发上限。

### 12.4 多塔公平与故障切换

- 3 个同优先级供应塔连续完成至少 12 个调度窗口，三者都必须获得任务；允许库存和距离造成合理差异，但不能永远固定第一个 ID。
- 当前供应源缺货、断电、无船、无翘曲、路线不可达或被回收时，同一调度窗口继续尝试其他合法源。
- 多需求塔使用同一供应源时不得超额预留；所有 active route cargo 之和不超过未保留库存。
- 两端都有载具时分别建立 supply-owned 和 demand-owned 路线；每条 route 的 `vehicleStationId`、起送量、翘曲扣除和完成归还一致。
- 高/标准/低优先级严格生效；同级才使用公平轮换。

### 12.5 性能与确定性

保留 `benchmark:logistics` 的旧扫描对照路径。10/50/100/500 塔均比较：

- 最终状态哈希；
- 总物资守恒；
- route owner、预留、busy 和翘曲库存；
- peer candidate checks、route economics calls/cache hits；
- median 与 P95。

本批功能不得让 500 塔索引路径出现无解释的显著回退。建议门禁为同机连续 5 次中位数回退不超过 10%；超出时必须附 profiler 解释，而不是删除基准。

## 13. 需求八：物资托盘上限提高至 1 亿

### 13.1 常量与 UI

将 `MAX_PLANET_TRAY_ITEM_LIMIT` 提高到 `100_000_000`，`DEFAULT_PLANET_TRAY_ITEM_LIMIT` 继续保持 `1_000_000`，从而满足旧存档和新存档都不自动膨胀容量。

当前行星设置改为：

- 1万：10,000；
- 10万：100,000；
- 100万：1,000,000；
- 1亿：100,000,000；
- 自定义：1,000-100,000,000 的十进制正整数。

自定义输入拒绝空值、负数、小数、指数文本、非数字和越界值。错误时保留原配置，不把 clamp 后的另一个值静默写入。

### 13.2 容量入口

复检所有普通自动写入都通过统一 free-capacity 语义：

- 配送枢纽；
- 手工制造输出；
- 建筑制造中心可退回副产物；
- 任务/回归奖励；
- 物流或设备自动转入；
- 行星切换后的非 active tray。

保护性返还继续允许超额，包括玩家主动放下整组 cargo、拆除/配方切换退款、线路取消、在途到货和 WIP 退回。调低至 1 万时已有 1 亿库存保持原数，普通新增 free capacity 为 0。

### 13.3 存档与云校验

- v34 旧存档的每颗行星原值逐字保留。
- 新范围内的 100,000,000 可以本地保存、手动槽往返、导出导入和云上传。
- `migrateGame()` 对非法值归一到 1,000-100,000,000，但不裁剪 tray 实际库存。
- 服务端对 `planetTrayItemLimits` 的每个值验证为安全整数且位于范围内；拒绝 `100_000_001`、小数、字符串和非有限数。
- 服务端不得因为未知内容包行星键误删整个存档；允许键集合的策略必须与客户端内容包加载边界一致。若当前云校验无法识别扩展行星，应只验证值而不擅自过滤键。
- 大数量 UI 使用现有“万/亿/科学计数”格式器，精确值仍可查看，输入框显示完整十进制数字。

## 14. 需求九：建筑制造中心 10 分钟稳定性

### 14.1 诊断轨迹

先增加开发/测试可读的纯诊断快照，不写入生产存档：

```ts
interface ConstructionCenterTraceSample {
  wallSecond: number;
  simulationSecond: number;
  workerLatencyMs: number;
  pendingSimulationSeconds: number;
  entityId: string;
  constructionId: ConstructionId | null;
  stepIndex: number;
  stepKind: "material" | "building" | null;
  stepItemId: ItemId | null;
  stepElapsedSeconds: number;
  stepDurationSeconds: number;
  wipCount: number;
  powerFactor: number;
  statusCode: string;
  completedBuildings: number;
  guardHitCount: number;
}
```

测试报告至少每秒采样一次，并在速率下降时保留前后 30 秒窗口。不要把整份玩家存档、账号 token 或云 payload 写入日志。

### 14.2 三层判定

1. 模拟层变慢：真实墙钟增长 1 秒时，`elapsedSeconds` 未按当前有效倍率增长，且 pending debt/Worker latency 上升。
2. 制造层变慢：`elapsedSeconds` 正确，但在电力、原料和安全上限都满足时，job step 增长低于理论值。
3. 展示层变慢：真实 state/job 正确完成，只有 `canvasGame`、进度动画或状态文案滞后。

最终修复说明必须明确属于哪一层，可以同时修多层，但不能只改进度条掩盖真实欠速。

### 14.3 引擎修复原则

- 若 128 guard 命中，不得丢弃已经分配的 `remainingWork`。优先改为可证明终止的批处理；若保留 guard，未结算工作必须持久保存并在后续模拟继续，保存/加载和离线不能丢失。
- 循环每次必须满足“消耗正 work、推进 step、完成 job 或退出阻塞”之一，避免无限循环。
- 原料不足、安全上限、输出返还受阻或电力不足时，立即停止当前阶段并返回真实 blocker；不得继续显示“正常制造”。
- 多制造中心不能使用同一份托盘原料完成两次结算。若规划不预留全链，阶段消费仍必须原子检查；若新增 reservation，取消任务和拆除中心必须完整退款。
- WIP 和副产物遵守现有 1,000,000 WIP 安全保护与托盘临时超额规则，不删物、不吞原料。
- 1x、4x、不同 Worker chunk 和离线总秒数必须等价。

### 14.4 展示修复原则

- 制造中心进度直接使用 `getConstructionAutomationStatus()` 的当前 step progress/duration，不用“每分钟最终建筑数”伪装中间材料周期。
- 显示当前阶段、当前物品、理论阶段耗时、实际 power factor、预计剩余和 blocker。
- Worker pending debt 较高时，在性能诊断中显示“模拟追赶中”，但建筑状态仍显示真实缺料/低电/堵塞原因，不能互相覆盖。
- 选中制造中心和打开制造中心工作区时继续走优先状态发布路径；未选中节点可以遵守用户刷新档，但不得显示虚假生产速度。

### 14.5 10 分钟门禁

准备固定种子的测试状态，保证：

- 原矿和中间原料足够；
- 托盘/施工目标空间足够；
- power factor 恒为 1；
- 目标队列持续有工作；
- 不触发 WIP 安全上限。

运行以下场景：

| 场景 | 时间 | 断言 |
| --- | ---: | --- |
| 引擎 1x，1 秒 chunk | 600 模拟秒 | 产出与解析理论值一致，任何 30 秒窗口不无故骤降 |
| 引擎 4x 等价 | 2,400 模拟秒 | 与相同总秒数的 1 秒基准逐字段/哈希一致 |
| 后台 chunk | 总计 600 秒，使用 30/60 秒输入 | 与 1 秒 chunk 等价 |
| 保存加载 | 300 秒保存，迁移/加载后再 300 秒 | WIP、step、原料和最终产出与不中断路径一致 |
| Worker 前台 | 至少 10 分钟真实墙钟 | pending debt 不持续发散，状态发布无分钟级停顿 |
| 切后台再返回 | 前后台合计至少 10 分钟 | 不重复结算、不吞秒，回前台后可追赶 |

“理论值一致”允许现有小数进度误差，但最终整数产物必须一致。建议功率和原料均充足时，任意连续 30 秒的有效 work 不低于理论值 99%；若阶段边界造成短窗口波动，应使用累计 work 而不是最终建筑数判定。

## 15. 需求十：生产周期绿条与百分比同步

### 15.1 先建立可复现证据

首要测试平台固定为 Windows 桌面客户端，首要失败档为 `classic=100 ms`，对照档为 `auto=200 ms`。由于“Windows 桌面端”可能同时受到 Electron 壳、Chromium 版本、窗口焦点和系统 DPI 的影响，最低要执行：

1. Windows Electron 目录包复现，作为玩家反馈的主路径。
2. 同一机器、同一 Chromium 内核的 Windows Chrome 页面复现，区分桌面壳与通用 Web 代码。
3. 同一测试存档先让 `auto` 在健康环境稳定解析为 200 ms，再不重载页面切到 100 ms，最后切到固定 `high=200 ms` 对照；设置切换本身不得重置周期相位。若自动档因采样压力主动降级，必须记录实际档位，不能把 500 ms 样本冒充用户报告的 200 ms 对照。
4. 分别在 1x、4x、窗口失焦/恢复、最小化/恢复和选中/未选中节点下采样。

测试或开发诊断应记录以下瞬时数据，不写入存档，也不上传服务端：

```ts
interface WorkCycleVisualTraceSample {
  monotonicTimeMs: number;
  snapshotSequence: number;
  snapshotPublishedAtMs: number;
  simulationElapsedSeconds: number;
  effectiveSimulationMultiplier: number;
  entityId: string;
  semanticKey: string;
  statusCode: string;
  snapshotProgress: number;
  simulationCyclesPerSecond: number;
  displayProgress: number;
  displayedPercent: number;
  ariaValueNow: number;
  fillRatio: number;
}
```

其中 `monotonicTimeMs` 使用 `performance.now()`，只服务视觉诊断；活动墙钟、`Date.now()` 和服务器时间不能参与生产周期插值。`fillRatio` 从填充元素与轨道元素的实际矩形或 transform matrix 计算，不能只读取 inline style，因为当前 bug 正是 CSS animation 覆盖 inline width。

同时对真实 Worker 状态做 30 秒序列检查：同一 `semanticKey` 且 `statusCode` 保持运行时，`entity.progress` 只能向前增长或在周期完成时换轮；若真实状态本身发生非业务回退，先修引擎并增加确定性测试。缺料、堵塞、断电或配方/步骤变化导致的显式重置要单独标记，不能混入“运行中回缩”。只有真实状态正常、DOM 轨迹异常时，才按下面的纯展示方案修复。

### 15.2 单一展示进度模型

新增或扩展纯 UI helper，建议模型如下：

```ts
type WorkProgressMode = "cycle" | "step" | "level" | "route" | "indeterminate";

interface WorkProgressSnapshot {
  mode: WorkProgressMode;
  semanticKey: string;
  snapshotProgress: number;
  snapshotSimulationSeconds: number;
  publishedAtMs: number;
  simulationCyclesPerSecond: number;
  effectiveSimulationMultiplier: number;
  active: boolean;
}
```

实现规则：

1. `displayProgress` 在一个纯函数中计算一次，绿色填充、可见百分比、`aria-valuenow` 和完成闪光全部消费这一值，不得分别计算。
2. 确定式填充不再使用从 `width: 0` 到 `width: 100%` 的独立无限 CSS keyframe。建议使用 `transform: scaleX(displayProgress)` 和固定左侧 transform origin，避免改变布局宽度；装饰性 sheen 可以保留，但不能决定填充比例。
3. 视觉时钟按玩家选择的生产画面刷新档发布：100 ms 档最多每秒更新 10 次，200 ms 档最多每秒更新 5 次。使用一个共享 clock/store，只让当前挂载且可见的活动进度组件订阅，禁止每座建筑各建一个 `setInterval` 或 `requestAnimationFrame`。
4. `productionRefresh.ts#interpolateProductionProgress()` 应成为真实生产路径或由更完整的纯 helper 替代，不能继续处于“只有测试调用”的失效状态。
5. 墙钟展示速率为 `simulationCyclesPerSecond * effectiveSimulationMultiplier`。暂停、活动墙钟、离线时长和状态发布频率都不能偷偷进入模拟结果。
6. 收到新快照时，以新快照、真实模拟秒和单调发布时间重新锚定。只有确认跨过整数周期边界时允许 `100% -> 0%`；普通运行中禁止 `72% -> 41%` 这类中段回缩。
7. 配方、制造步骤、物流 route identity、充放电方向或实体 ID 变化时更换 `semanticKey`，明确开始新语义，不把旧周期相位带入新任务。
8. 暂停、缺料、堵塞、断电或输出已满时立即停止外推并显示最近真实进度。恢复时从最新真实快照继续，不补播页面隐藏期间的视觉动画。
9. 快速设备可以在两个 UI tick 之间完成多个周期。完成计数和换轮判断必须基于连续相位或真实快照，不再依赖当前 `previous > 0.72 && next < 0.28` 的阈值猜测；该猜测会漏掉快周期和大时间步。
10. 若某类设备暂时没有可信周期率，宁可显示与快照同步的确定式进度，也不能继续用物品产量猜周期速度。
11. `classic` 必须继续解析为 100 ms，`high` 必须继续解析为 200 ms。修复目标是让 100 ms 正确工作，不是降低设置精度或改文案。

这套模型属于只读展示层。不得把 `displayProgress` 写回 `entity.progress`，不得改变 Worker 的 1 秒提交节奏，也不得仅为动画增加 `GameState` 版本。

### 15.3 使用规范周期率

普通机器的周期率不能再使用：

```ts
entity.productionRate / unitsPerCycle / 60
```

后续 Agent 应抽取一个只读 selector，复用引擎实际参数计算“每模拟秒周期率”，至少包含：建筑速度、堆叠数量、配方耗时、科研倍率、行星专长、实际供电、戴森发射节流和增产剂加速模式。当前有效模拟倍率作为独立字段交给展示 helper，只在换算墙钟速率时乘一次，禁止在 selector 和组件中重复相乘。额外产出模式只改变每周期产物，不改变周期数；增产剂在一个真实模拟步内耗尽时，快照必须切回基础周期率，不能让动画倒相。

selector 必须与 `runMachines()` 共用计算边界或由引擎导出纯 helper，禁止在 React 组件中复制一份近似公式。输入不足、输出空间不足和科技未解锁时以真实 operating status 停止外推。若设备只在一个模拟步的部分时间工作，使用真实完成 work 派生的周期率并在下一快照冻结，而不是把平均物品产量长期当作理论速度。

建筑制造中心不走普通配方 selector。它使用 `getConstructionAutomationStatus()` 返回的当前 job、step、step duration 和 progress，`semanticKey` 至少包含中心 ID、任务 construction ID、step index 和 step kind。0.1 秒材料阶段切到 5 秒建筑阶段时属于明确换段，不得用最终建筑 `productionRate` 反推中间阶段动画。

### 15.4 拆分不同进度语义

当前 `WorkCycle` 被过度复用。实施时至少按下表区分，组件可以共用轨道样式，但不能共用错误的循环逻辑：

| 模式 | 适用对象 | 显示规则 |
| --- | --- | --- |
| `cycle` | 普通生产、采矿、轨道采集、临界光子、太阳帆/火箭发射、能量枢纽单件充放电 | 0%-100% 周期，完成后换轮；填充、文字和 ARIA 同源 |
| `step` | 建筑制造中心当前递归步骤 | 绑定稳定 step key；阶段切换后从新阶段真实 progress 开始 |
| `level` | 蓄电器总电量等可逆存量 | 可以随真实充放电上升或下降，但下降必须和同一帧数值一致，不播放周期完成闪光 |
| `route` | 物流塔在途航线 | 绑定稳定 route ID；多条航线不得用“当前最大 progress”伪装成一条连续航程，route 完成或切换时明确换项 |
| `indeterminate` | 储物箱、储液罐、分流器、即时配送枢纽、银河物资出口等没有真实单周期的数据流 | 只显示运行/传输活动和吞吐，不显示虚构百分比，不使用 `networkTime % 1` 冒充生产进度 |

移动端摘要目前直接用 `entity.progress` 同时渲染百分比和静态宽度，虽然没有同一个 CSS keyframe bug，仍要接入相同的 mode/semantic key 规则。经典手机、新版手机、桌面节点和完整检查器不得对同一设备显示互相矛盾的周期。

### 15.5 Windows 桌面验收

固定种子准备以下设备：2 秒慢配方、约 1 秒配方、堆叠后的亚 100 ms 快配方、额外产出喷涂、加速喷涂即将耗尽、建筑制造中心材料/成品阶段、发射井、蓄电器和至少两条并发物流航线。每个场景先保证电力、原料和输出空间充足，再单独触发缺料、堵塞和断电。

在 Windows Electron 和 Windows Chrome 中分别执行：

| 场景 | 持续时间 | 必须断言 |
| --- | ---: | --- |
| 自动 200 ms | 30 秒 | 先断言 resolved interval 始终为 200 ms；作为对照，填充/文字/ARIA 差值不超过 1 个百分点，无非法中段回缩 |
| 经典 100 ms | 60 秒 | resolved interval 保持 100 ms且采样密度高于 200 ms；每个视觉 tick 同源，不得出现 `20%-90%` 区间内下降后又恢复 |
| 200 -> 100 -> 200 | 每档 15 秒 | 切档不重建周期、不闪回 0、不改变实体库存或产量 |
| 1x -> 4x -> 1x | 每档 20 秒 | 墙钟动画速度随有效倍率变化，切换只重锚一次且相位连续 |
| 喷涂耗尽/恢复 | 各至少 3 个周期 | 速率切回基础值再恢复；不倒退、不停工、不伪造额外产出 |
| 暂停/继续、缺料、堵塞、断电 | 各至少 5 秒 | 停止时冻结真实值，继续时从最新快照恢复，状态原因优先 |
| 最小化/失焦/恢复 | 各 10 秒 | 隐藏期间不运行无意义视觉 tick；恢复后一次追上真实快照，不回放旧动画 |
| 制造中心阶段切换 | 至少 2 个完整任务 | 每个 step 进度单调，换段明确，和制造中心工作区百分比一致 |
| 多 route 物流塔 | 至少 5 次出发/到达 | route 切换不表现为同一航程倒退，总/可用/执行中数量不受 UI 改动影响 |

逐帧判断规则：相邻样本出现负差值时，只允许以下四类：前一帧不低于 95% 且后一帧不高于 5%的周期换轮；`semanticKey` 改变；运行状态切到明确重置状态且同帧文案同步；`level` 模式有真实同帧数值下降。状态重置必须直接呈现新值，不能播放从较大值倒退到较小值的过渡。任何普通运行中的 `80% -> 55%`、`55% -> 25%` 或填充下降而文字未下降都直接失败。

另覆盖 Windows 显示缩放 100%/125%/150%、游戏字号 80%/100%/150%/200%、1920x1080 与 1440x900 窗口、60 Hz 和可用时的高刷新率显示。视觉测试不要求依赖肉眼；必须保留采样 JSON、失败 trace 或录像中的至少一种证据。

### 15.6 性能与确定性门禁

- 100 ms 档的共享视觉 clock 不能触发 `setGame()`、重建 `GameState`、提交额外 Worker 任务或让 `canvasGame` 反向覆盖真实 state。
- 只更新可见活动条；页面隐藏、全屏工作区覆盖画布、compact LOD 隐藏周期条或设备停机时取消订阅。
- 在后期样本上分别测 100/200/500 ms，每档至少 60 秒，记录主线程 long task、WorkCycle render 数、Worker 往返和 pending debt。100 ms 可以比 200 ms 更耗渲染资源，但不能造成模拟债务持续发散。
- 保留并扩展“所有刷新档的 1 小时模拟状态哈希一致”测试；新增视觉 helper 测试不得调用 `advanceSimulation()` 以外的写命令。
- `prefers-reduced-motion` 或游戏内减少动效开启时，装饰性 sheen/闪光停止；确定式进度和值仍保持同步，不能因全局 `animation-duration: 0.01ms` 直接跳到错误终点。

## 16. 需求十一：传送带吞吐抖动与真实供料核验

### 16.1 固定录屏拓扑与理论边界

建立不依赖玩家原存档的固定测试夹具，复刻以下拓扑：

```text
硅石矿脉 + 采矿机组
  输出缓存起始 500，实际生产率 640/min
              |
              | Mk.II，单线，堆叠 1，额定 12/s
              v
11 台电弧熔炉，高纯硅配方，满电，无增产剂加速
```

基础数值必须先锁定：

| 项目 | 换算 | 含义 |
| --- | ---: | --- |
| 采矿生产 | 640/min = 10.6667/s | 长期新增硅石速度，不包含既有缓存 |
| Mk.II 容量 | 12/s | 线路额定上限，不是强制实际流量 |
| 单台熔炉需求 | 2 硅石 / 2 秒 = 1/s | 高纯硅基础配方、满电、1 台 |
| 11 台熔炉需求 | 11/s | 下游基础稳态需求 |
| 供给与需求差 | 11 - 10.6667 = 0.3333/s | 若维持 11/s，下游会缓慢消耗采矿缓存 |

因此必须区分三个阶段：

1. 源和目标均有充足空间时，缓存可以让线路短期达到 12/s；此时源缓存按约 1.3333/s 减少，目标输入按约 1/s 增加。
2. 目标输入进入稳态或接近上限后，有用流量由 11/s 下游需求限制；稳定显示约 11/s是正确结果，不应强行显示 12/s。
3. 约 500 缓存最终耗尽后，长期供给上限降到约 10.6667/s，11 台熔炉不能永久全部满负荷；界面应明确“上游长期供给不足 0.3333/s”，而不是笼统显示线路异常。

测试必须读取录屏同构状态中的目标输入库存、熔炉实际 `powerFactor`、行星生产专长、采矿科技、喷涂模式、模拟倍率和线路堆叠。任何一项不同都会改变理论值，不能仅凭“11 台”硬编码 11/s。

### 16.2 分离真实搬运与显示采样

增加仅供开发/测试的线路轨迹，不写生产日志、不上传账号或存档：

```ts
interface BeltFlowTraceSample {
  requestId: number;
  requestSimulationSeconds: number;
  substepIndex: number;
  substepSeconds: number;
  simulationElapsedSeconds: number;
  beltId: string;
  sourceStockBefore: number;
  sourceStockAfter: number;
  targetInputBefore: number;
  targetInputAfter: number;
  targetFreeBefore: number;
  beltProgressBefore: number;
  beltProgressAfter: number;
  movedThisSubstep: number;
  totalTransferred: number;
  lastFlowBefore: number;
  lastFlowAfter: number;
  sourceRatePerSecond: number;
  targetDemandPerSecond: number;
  capacityPerSecond: number;
  blocker: "none" | "source-empty" | "target-full" | "invalid-route";
}
```

诊断输出至少同时计算：

- 当前内部子步搬运量，仅用于定位整数结算；
- 最近 5 个模拟秒的 `delta(totalTransferred) / delta(elapsedSeconds)`；
- 30/60 模拟秒累计转运量；
- 源缓存净变化、目标输入净变化和目标配方实际消费；
- 理论限制端 `min(源可用、源长期产率、线路容量、目标剩余空间、目标实际需求)`。

真实吞吐判定只看累计量和库存守恒。`lastFlow`、线路动画包数量、热力颜色或某一帧标签都不能作为实际少送的唯一证据。

### 16.3 修复近期流量口径

移除或替换固定的逐子步 `lastFlow *= 0.8`。最终实现必须满足：

1. 衰减或平均权重基于真实 `substepSeconds`，0.02 秒尾步不能和 1 秒整步同样衰减 20%。
2. 用户可见流量优先从 `totalTransferred` 的时间窗口增量派生，推荐 5 个模拟秒作为桌面线路标签的近期窗口；窗口未满时显示“采样中”或使用已有样本时长，不伪装成完整窗口。
3. 近期窗口属于运行时观察数据，默认保存在 UI/runtime sampler，不进入云存档。若所有状态型诊断确实需要持久窗口累计器，开发 Agent 必须先证明 UI-only 方案无法覆盖，再按第 5 节要求加入最终迁移。
4. `lastFlow` 若继续保留在 `GameState`，必须定义为明确的近期平均或兼容字段，不能再同时代表“最后一个内部子步”“当前流量”和“拥堵输入”。
5. `congestion` 的更新也要按模拟时间加权或从窗口供需派生，不能继续让内部子步数量决定衰减次数。
6. 线路停止后，阻塞原因立即由源库存和目标容量显示；近期平均可以在标明窗口的情况下平滑归零，但不能让“近期有流量”冒充“当前仍在搬运”。
7. 100/200/500/3000 ms 生产画面刷新档只影响观察值发布频率，不改变采样窗口中的模拟秒、累计件数或最终平均。

建议统一文案为：

```text
近期流量 11.0 / 12 s^-1
近 5 模拟秒 · 下游需求限制 11.0/s
累计运输 123,456
```

桌面悬停/检查器和手机点击可显示完整来源：近期窗口、源长期产率、源当前缓存、目标实际需求、目标剩余容量、额定容量和累计运输。

### 16.4 核验并保护真实结算

显示修复之外，必须验证 `belt.progress` 和整数转运本身：

- 在源库存和目标空间始终充足的场景中，Mk.II 单线 60 模拟秒累计转运应为 720，允许测试起止边界造成至多 1 个整数结算差，但 300 秒累计必须收敛到 12/s。
- 在目标稳定消费 11/s 且输入接近稳态的场景中，长期累计应接近 11/s；不能因为目标短暂满仓清空不相关的线路余量而长期低于实际需求。
- 非整数 Worker 请求序列与相同总秒数的固定 1 秒/0.1 秒序列必须得到相同的物品总量、`totalTransferred`、源输出、目标输入/输出和 `belt.progress`。若只剩观察字段不同，也要明确修复或从确定性哈希中建立有依据的派生边界，不能静默忽略。
- `transferBelts()` 在机器之前运行所产生的合法批次波动不得吞物、复制或降低长期平均。若调整阶段顺序，必须全量验证多输入配方、并行线路、分流器优先级、物流站预留和黑洞/银河出口端口，不能只为硅石特例改顺序。
- 源为空或目标满时，不允许无限积累可瞬间爆发的传送额度；恢复后也不能因每次清零小数余量造成系统性吞吐损失。余量策略要用长期累计测试决定。
- `totalTransferred` 保持单调非负整数，升级、复制蓝图、拆线退款、保存加载和离线结算不得回滚或重复增加。
- 不提高 Mk.II 容量，不修改硅石矿速和高纯硅配方来“修复”这项问题。

物资守恒报告至少核对：

```text
源期初 + 期间采矿产出
= 源期末 + 线路累计新增转运

目标期初 + 线路累计新增转运
= 目标期末输入 + 配方累计消耗
```

存在其他线路时按每条线路和物品分别核算，不能用全局总量掩盖重复运输或错误分流。

### 16.5 统一诊断与单位

以下消费者必须改用同一 `BeltFlowSnapshot` 或等价 selector，禁止各自读取/解释裸 `lastFlow`：

- 画布线路标签、运输动画包数量和速度；
- 右侧线路检查器的当前/近期流量与容量条；
- 生产统计中的实时吞吐、连续网络利用率、瓶颈和热力图；
- 生产管理的“有流量但吞吐不足”“下游暂未取货”；
- 新手教学中的零流量线路判断；
- 储物箱、储液罐、分流器和配送枢纽的运行状态；
- 经典手机与新版手机线路摘要。

`network.ts#entityItemRatePerSecond()` 同步修正矿机科研倍率重复计算，并让源/目标预测与实际 power factor、行星专长、喷涂模式和配方速率保持同一口径。预测值必须标成“理论供给/需求”，观察值标成“近期实际”，二者不能共用一个无说明数字。

所有线路吞吐统一使用 `/s` 或 `s^-1`。新版手机当前的 `/min` 是单位错误，必须修正；若某界面需要 `/min`，必须显式乘 60 并与桌面换算一致。数值保留一位小数，精确窗口累计和整数件数在详情中展示。

### 16.6 自动化与录屏回归

| 场景 | 时长 | 关键断言 |
| --- | ---: | --- |
| 录屏同构、目标输入空 | 60/300 模拟秒 | 初期累计接近 12/s，源/目标/消费守恒，显示不出现 12/9.6 一秒抖动 |
| 录屏同构、目标稳态 | 120 模拟秒 | 实际平均接近 11/s，诊断为下游需求限制，不误报上游缺货 |
| 缓存耗尽后的长期运行 | 至少 1,800 模拟秒 | 平均收敛到约 10.6667/s，明确上游长期供给不足，熔炉缺料真实可见 |
| 非整数 Worker 请求 | 总计 60 秒，交替 1.02/0.98 秒 | 与整秒基准的物品、累计转运和 progress 等价，尾步不制造 9.6 假读数 |
| 4x 前台 | 60 秒真实墙钟 | UI 仍按模拟秒显示 12/s 上限，累计模拟转运与 240 模拟秒基准一致 |
| 0.1/1/10/30 秒 chunk | 相同总模拟秒 | 物资守恒；观察窗口差异在规定容差内且不改变诊断限制端 |
| 下游满仓/输出堵塞 | 各 30 秒 | 近期平均有界归零，立即显示真实阻塞，恢复后无爆发复制或长期掉速 |
| 多线/分流/堆叠 | 各 120 秒 | 每线容量、优先级、1/2/4 堆叠和合计吞吐正确，公平游标不回归 |
| 保存加载/前后台/离线 | 各 120 秒 | 库存、progress、totalTransferred 保留，采样器可重建且不产生假流量 |
| Windows 100/200 ms UI | 各 60 秒 | 相同累计数据与近期平均；刷新档只改变发布密度，单位和限制原因一致 |

录屏验收应在相同拓扑下同时录到：源缓存、640/min、线路近期平均/上限、目标输入、11 台熔炉状态和累计运输起止值。只录一条跳动标签不能证明真实修复；只跑无 UI 的单测也不能证明玩家看到的抖动消失。

## 17. 建议的文件归属

| 领域 | 主要文件 | 配套文件 |
| --- | --- | --- |
| Tooltip/功率 | `src/components/PowerValue.tsx`、`QuantityValue.tsx`、`src/styles.css` | focused Playwright |
| 主题 | `src/theme.css`、`src/styles.css`、`src/styles/*.css`、`useResolvedTheme.ts` | 主题审计脚本、视觉 E2E |
| 储物节点 | `src/components/FactoryNodes.tsx` | `src/styles.css`、节点 E2E |
| 建筑锁定 | `src/game/types.ts`、`engine.ts`、`storage.ts`、`src/App.tsx` | `GamePanels.tsx`、mobile components、layout、storage/server tests |
| 检查器排序 | `src/components/GamePanels.tsx`，建议新增独立 layout preference helper/hook | mobile inspector、styles、E2E |
| 翘曲补仓 | `src/game/engine.ts` | `GamePanels.tsx`、engine tests |
| 物流复检 | `src/game/engine.ts`、`stellarIndustry.ts` | engine tests、logistics benchmark、E2E |
| 托盘上限 | `src/game/engine.ts`、`storage.ts`、`GamePanels.tsx` | `server/index.mjs`、storage/server/E2E tests |
| 制造中心 | `src/game/engine.ts`、simulation worker、`src/App.tsx` | engine/offline/performance tests、节点/工作区 E2E |
| 周期进度 | `src/components/FactoryNodes.tsx`、`src/game/productionRefresh.ts`，建议新增纯 cycle display helper/共享 visual clock | `src/App.tsx`、`MobileFactoryPanels.tsx`、`src/styles.css`、Vitest、Windows Electron/Chrome E2E |
| 传送带吞吐 | `src/game/engine.ts`、`src/game/network.ts`，建议新增无存档副作用的 `BeltFlowSnapshot`/runtime sampler | `FactoryEdges.tsx`、`GamePanels.tsx`、`MobileFactoryPanels.tsx`、`App.tsx`、engine/network/offline tests、Windows E2E |

`src/App.tsx`、`src/styles.css`、`src/game/engine.ts` 和 `tests/e2e/game-flow.spec.ts` 都是热点大文件。后续 Agent 应先确认其他任务已落盘，按最小区块修改；可独立的偏好解析、诊断采样和测试 fixture 应拆到小文件，不对热点做无关格式化。

## 18. 实施顺序与依赖

建议按以下顺序开发：

1. 先修 Tooltip selector 和组件生命周期，范围最小且能快速建立视觉回归。
2. 为周期条增加真实快照/DOM 轨迹，完成单一展示进度模型和 Windows 100/200 ms 对照；先证明引擎 progress 是否正常，再决定只改 UI 还是同时修引擎。
3. 固化录屏同构的硅石矿机 -> Mk.II 线路 -> 11 台熔炉 fixture，先记录 `totalTransferred`、两端库存和非整数 Worker 子步轨迹；随后修正流量窗口、矿机理论速率和各 UI 消费者，禁止用调配方或提高线路容量掩盖问题。
4. 建立主题变量和颜色审计，再重做储物节点，避免新节点 UI 重复写两套颜色。
5. 完成 v35 迁移和建筑锁领域命令，再接桌面/移动交互；迁移只做一次。
6. 抽取检查器 section 模型并接排序偏好，同时让锁定状态以只读方式贯穿 section。
7. 扩展翘曲器单一补仓 helper，再执行物流全流程测试和基准。
8. 提高托盘上限并补客户端/服务端校验；同时复检制造中心临时超额保护值。
9. 用冻结后的引擎、周期展示模型和线路吞吐口径跑制造中心 10 分钟诊断，根据证据修复 guard、Worker 或展示层。
10. 全量迁移、离线、物流、传送带守恒、视觉、Windows 桌面包和生产构建回归。

第 1、2、3、4、5、6 项都可能触碰 `FactoryNodes.tsx`、`GamePanels.tsx` 或 `styles.css`，应在同一 Agent 内顺序完成，或明确文件分区，避免并行覆盖。第 8 项改变托盘常量，会影响制造中心安全保护的派生上限，因此必须先于最终制造中心门禁。周期展示模型与线路近期流量口径也必须先冻结，避免把制造中心的视觉倒退或线路标签抖动误判为真实模拟降速。线路 fixture 必须先证明初期 12/s、下游限制 11/s 和长期矿速限制 10.6667/s 三种结果，再允许修改共享诊断 selector。

## 19. 自动化测试设计

### 19.1 Vitest/领域测试

至少新增或扩展以下用例：

| 用例 | 关键断言 |
| --- | --- |
| v34->最终版锁迁移 | 所有旧实体 `interactionLocked=false`，库存、线路、WIP、route、科研和戴森不变 |
| 最终版幂等加载 | true/false 锁值保持，重复 migrate 状态稳定 |
| 锁定命令 | 只改目标实体锁值，模拟推进仍正常 |
| 锁定批量写 | recipe/upgrade/remove/layout 跳过锁定实体并保持其他实体可修改 |
| 蓝图 | 可复制锁定实体，粘贴实体未锁定，源实体不变 |
| 检查器偏好解析 | 去重、未知 ID、缺失 ID、损坏 JSON、恢复默认 |
| 翘曲 belt 输入 | 开关开启后 input -> stationWarpers，数量守恒 |
| 翘曲物流到货 | output -> stationWarpers，in-flight 不提前计入 |
| 翘曲预留 | reserved outgoing 不被转仓，取消/完成后无复制 |
| 翘曲优先级 | 塔内 input/output 先于行星托盘，target/capacity 生效 |
| 50 艘调度 | 条件满足 busy=50；40 翘曲、2/船时可用=20且原因准确 |
| 多供应/多需求 | 公平轮换、故障切换、两端 owner、各自起送比例 |
| 托盘范围 | 100,000,000 合法；100,000,001、非整数非法；降限不裁剪 |
| 托盘自动写入 | 满仓阻止普通新增，保护性返还和在途到货可超额 |
| 制造 600/2400 秒 | chunk、离线、存档加载等价，guard 不丢 work |
| 制造 blocker | 缺料、低电和安全上限分别显示真实原因 |
| 周期展示纯函数 | 100/200/500/3000 ms 对同一快照序列得到同一相位；档位只改变采样密度 |
| 周期换轮 | 允许 95%-100% 后回到 0%-5%；拒绝无 semantic key 变化的中段负跳 |
| 周期速率 | 1x/4x、加速/额外产出、喷涂耗尽与恢复使用正确墙钟周期率 |
| 进度模式 | cycle/step/level/route/indeterminate 分流正确，非周期对象不生成虚假百分比 |
| Mk.II 额定吞吐 | 源与目标空间充足时 60 秒约 720 件、300 秒收敛到 12/s；`totalTransferred` 单调且物资守恒 |
| 录屏三阶段 | 初期缓存供料接近 12/s；目标稳态接近 11/s；缓存耗尽后收敛到 640/min = 10.6667/s，并报告正确限制端 |
| 非整数 simulation chunk | 交替 1.02/0.98 秒与等总时长整秒、0.1 秒基准的库存、消费、`progress` 和 `totalTransferred` 等价；不出现 12 -> 9.6 假衰减 |
| 线路阻塞与恢复 | 源空、目标满、并行线、分流和 1/2/4 堆叠均不吞物、不复制、不积累无界爆发额度，恢复后长期吞吐正确 |
| 线路理论预测 | 矿机 `productionRate` 不重复乘采矿科技；实际供给、目标需求、容量和近期观察值分别标注且使用一致单位 |

### 19.2 Playwright 功能与视觉测试

建议新建按主题拆分的 focused spec，避免继续扩大单一 `game-flow.spec.ts`。最低覆盖：

- 功率 Tooltip：未悬停、悬停、移开、A->B、键盘 focus/Escape、粗指针点击外部关闭。
- 亮色页面巡检：画布、每类节点、检查器、弹窗、菜单、输入、科技、资料库、统计和两套手机 UI。
- 储物仓/储液罐：空配置、长物品名、堆叠 1/10/大数量、输入/输出 handle 几何和真实连接。
- 锁定：单选、框选、混合选区、批量锁/解锁、Delete、拖动画布、移动 layout/select 模式、保存加载。
- 检查器：默认顺序、拖拽、触摸拖拽、折叠后排序、重载持久、恢复默认、切换不支持某 section 的建筑。
- 翘曲：传送带输入和物流到货后专用仓/槽位/托盘数量守恒，诊断文字正确。
- 托盘：1 亿预设、自定义上下界、旧值、超额库存和大数字 Tooltip。
- 制造中心：前台、4x、后台切换和加载后的状态/进度一致。
- 周期条：Windows 主路径 200 ms 对照、100 ms 复现、在线切档、1x/4x、喷涂耗尽、暂停/恢复和逐帧 fill/text/ARIA 对比；原“只检查 animation-name”的用例必须替换。
- 周期语义：储能真实下降、制造中心换 step、物流 route 切换和无真实周期的仓储/配送设施分别按设计显示，不得套用普通生产换轮断言。
- 线路吞吐：Windows 桌面录屏同构拓扑连续采集至少 60 秒，核对线路标签、检查器、统计与经典/新版手机使用同一近期值；不得出现固定 12.0/9.6 往返，手机不得把按秒值标成 `/min`。
- 线路诊断：分别构造额定容量、下游需求、上游长期供给、源空和目标满，详情中的限制原因、精确累计量与实际库存变化一致；100/200/500/3000 ms UI 刷新档不能改变模拟结果。

### 19.3 截图矩阵

以下截图均至少检查无横向溢出、文字截断、按钮不可点、Tooltip 常驻和 handle 偏移：

| 设备/视口 | 主题 | 字号 |
| --- | --- | --- |
| 1920x1080、1440x900 | dark/light | 80/100/150/200% |
| 390x844 经典手机 | dark/light | 80/100/150/200% |
| 390x844 新版手机 | dark/light | 80/100/150/200% |
| 844x390 新版手机横屏 | dark/light | 100/200% |
| 768x1024、1024x768 平板 | dark/light | 100/200% |
| Windows Electron 1920x1080、1440x900 | dark/light | 100/150/200% |

桌面另覆盖浏览器页面缩放 80%、100%、125%、150%。缩放后对每条测试线路计算 SVG path 起止点与真实 handle 中心距离，建议误差不超过 3 CSS px。

主题门禁不能只截图默认首页。每个主要工作区都要实际打开，让 lazy CSS 加载后再切换 dark/light/dark，确认局部不会重新变黑或保留白字。

周期条不能只靠静态截图验收。Windows 100/200 ms 用例必须同时输出逐帧采样 JSON 或 Playwright trace/录像，并在报告中列出最大 fill/text 差值、非法负跳次数和周期换轮次数。

线路吞吐同样不能只靠静态截图验收。Windows 录屏回归必须同步导出按模拟时间排序的 `totalTransferred`、源/目标库存、目标消费、近期窗口和限制原因；报告分别列出 60/300 秒平均吞吐、非法 12/9.6 往返次数、非整数 chunk 与整秒基准差异，以及完整物资守恒式。

### 19.4 服务端测试

服务端只需扩展云 payload 校验，不修改生产数据结构：

- 接受最终 `GameState.version`；
- 接受每颗行星托盘 100,000,000；
- 拒绝越界、小数、字符串、NaN 等非法值；
- 接受 boolean 锁值，拒绝恶意非 boolean；
- 旧 v34 payload 继续接受；
- 四槽上传、历史恢复和主槽排行榜摘要不因新增字段丢失。

测试继续使用临时 SQLite，不得连接香港或上海生产数据库。

## 20. 完整验证命令

实施完成后至少运行：

```powershell
npm run typecheck
npx vitest run src/game/engine.test.ts src/game/network.test.ts src/game/productionRefresh.test.ts src/game/offlineSimulation.test.ts src/game/performance.test.ts
npm test
npm run test:server
npm run build
npm run benchmark:logistics
npm run test:e2e
npm run desktop:pack
git diff --check
```

准备正式 release 时再追加：

```powershell
npm ci
npm --prefix server ci
npm run licenses:check
npm run test:native
npm run test:ops
```

本批未经明确要求不得因此自动提交、推送、部署或启动正式活动。

## 21. 完成定义

本批只有同时满足以下条件才算完成：

1. 十一项需求均有实现、领域测试或 UI 测试和相应文档更新。
2. 最终迁移版本基于开发时真实末版追加，旧存档关键状态逐字段保留。
3. 功率节点无常驻重复 Tooltip，Tooltip 生命周期符合鼠标与触摸规则。
4. 亮色模式覆盖所有主要页面和 lazy-loaded UI，切换后无局部旧主题。
5. 储物仓/储液罐在 80%-200% 字号下名称、输入、输出和端口均清晰对齐。
6. 锁定实体无法被移动、回收或修改，从其主体拖动能平移画布，并有可达解锁入口。
7. 检查器默认顺序正确，自定义排序和折叠状态重载后保持，恢复默认有效。
8. 翘曲器从塔内槽位和托盘按优先级自动补仓，预留、在途和数量守恒通过。
9. 50 艘场景没有隐式并发上限；合法限制有准确诊断，多塔公平与故障切换通过。
10. 每颗行星可设置 1 亿，旧配置和超额库存不被覆盖或删除，云校验同步更新。
11. 制造中心完成至少 10 分钟前台证据、4x、后台和加载测试，最终报告明确真实根因和修复层。
12. Windows 桌面 100 ms 周期条与百分比/ARIA 同步，无非法中段回缩；200 ms 对照、在线切档、1x/4x、喷涂状态和制造步骤均通过。
13. Mk.II 线路不再因内部短尾步出现固定 12.0/9.6 假抖动；额定 12/s、11 台熔炉需求 11/s、640/min 上游长期 10.6667/s 三类限制均有正确累计吞吐和诊断。
14. 非整数 Worker chunk、前台/离线、保存加载、阻塞恢复和多线路场景的 `totalTransferred`、库存与消费守恒；经典/新版手机线路单位统一为 `/s`。
15. TypeScript、Vitest、服务端测试、构建、桌面目录包、相关 Playwright、物流基准和 `git diff --check` 均报告本次新跑的准确结果。

## 22. 开发交接报告模板

后续 Agent 完成实现时应报告：

- 实际产品版本、Git 基线、最终 `GameState` 版本、envelope/schema/layout 是否变化；
- 修改文件列表，明确哪些文件与既有账号任务有交叠；
- 十一项需求逐项实现摘要；
- v34/真实上一版迁移前后库存、线路、route、WIP、科研和戴森对比；
- 50 艘与 10/50/100/500 塔性能数据；
- 制造中心 10 分钟轨迹、根因证据和修复后的吞吐；
- Windows Electron/Chrome 的 100/200 ms 周期采样、最大 fill/text 差值、非法回缩次数和最终根因；
- Windows 录屏同构线路的 12/s、11/s、10.6667/s 三阶段累计结果，`totalTransferred`/库存守恒、非整数 chunk 等价性、12/9.6 往返次数和手机 `/s` 单位结果；
- dark/light、桌面/经典手机/新版手机/平板、80%-200% 和浏览器缩放截图位置；
- 每条测试命令、通过数量、跳过项和已知非阻断告警；
- 仍待产品确认的版本号或交互细节；
- 明确说明未提交、未推送、未部署，除非用户后来单独授权。
