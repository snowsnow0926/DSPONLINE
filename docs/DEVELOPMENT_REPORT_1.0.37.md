# DSPidle2 1.0.37 开发与发布前验证报告

> 日期：2026-08-11
> 分支：`codex/1.0.37-monopole-tech-offline`
> 候选源码：`853ecdb12795844c484b1415f8e72967a25e343d`
> Build ID：`1.0.37+853ecdb12795`
> 当前生产：`1.0.36+e0ad49062fa3`
> 状态：开发候选；未部署、未签名、未修改排行榜历史或玩家存档

## 1. 结论

1.0.37 已完成本批单极磁石资源完整性、科技树横向布局、离线结算决策保护，以及追加的星图批量物流操作优化。1.0.35 的纯挂机幂等/资源守恒和普通/速通存档隔离、1.0.36 的传送带/终局性能改动均保留并完成全量回归。

候选通过类型检查、936 项 Vitest、288 项 Playwright、服务端、运维、原生工具、许可证、生产依赖审计和 clean source 制品验证。23,531,371 字节真实存档在所有测试前后 SHA-256 保持不变，没有写回源文件。

候选仍不应无条件直接发布：该真实档四个长离线窗口的 Worker 往返约 17.1～17.5 秒，但候选验证还需要约 19.2～19.6 秒，端到端约 36.5～36.8 秒；非关键近似误差估计在 30 天窗口达到约 81.5%。60 秒精确模拟为 12.75 秒。Release Agent 应在低配 Windows 和 Android 真机上补做实机、覆盖升级与长时后台恢复，并明确接受或拒绝这些性能/近似风险后再灰度。

## 2. 需求实现

### 2.1 单极磁石与旧档资源完整性

- 明确当前生成模型：每种资源在每颗行星上只有一个规范资源实体；“只有一个单极磁石节点”本身不是缺矿证据，不能给全部存档自动补矿。
- 找到 v20+ 迁移边界缺陷：旧逻辑会用相同 seed、但可能不同的当前生成目录重建初始资源，再把持久 `galaxy.profiles[planet].resourceIds` 未声明的稀有矿带入旧档，形成幽灵资源节点。
- `migrateGame` 现在只恢复持久行星资源目录明确声明的稳定资源实体。迁移保持确定性、幂等，不删除合法节点、不补物资、不改库存。
- 新增只供人工确认存档使用的 `resourceIntegrity` 工具：只读审计、候选预览、源/候选哈希、确认令牌、备份、回滚和审计记录完整闭环。
- 工具不会在载入、导入、云恢复、自动保存或排行榜提交时自动执行。速通/排行榜相关存档必须额外提供独立审核通过标记。
- 没有修改任何历史排行榜数据，也没有把人工恢复逻辑接入自动迁移。

### 2.2 科技树布局与输入

- 桌面科技树改为横向唯一主滚动轴，按行和子列稳定排布；工作区尺寸变化由 `ResizeObserver` 重新测量。
- 鼠标滚轮、触控板横/纵向增量、`Shift+Wheel`、中键拖动、右键拖动和键盘方向键/Page/Home/End 都映射到横向浏览。
- 标准/紧凑卡片和 100%/150%/200% 字号均使用真实根设置验证；移动端继续使用纵向列表，不改变原导航习惯。
- 科研开始、暂停、恢复、取消及资源返还继续调用原领域命令，布局层不改科研状态或材料结算。

### 2.3 离线结算决策保护

- 快速 Worker 的零校准保守结果或保守失败现在返回 `decision-required`，不附带可提交状态，避免把不确定候选静默写回主档。
- 决策弹窗始终保留原始 `DeferredLoadedGame`：玩家可以从原始状态重试精确结算，或取消并返回主菜单；取消不写盘、不消费离线时间。
- 普通模式提供显式双重确认的“跳过本次离线收益”。该操作只将原状态时钟推进到当前时间，不增加生产、库存、缓存、科研或戴森收益，并记录原始/提交秒数和原因。
- 速通模式不显示且在领域层拒绝跳过，继续保持精确-only。
- 纯挂机页面进入后台后的普通离线尾段，若快速路径要求决策，会从原始尾段自动重试精确；只有完成正式序列化、重载和主档读回验证后才提交。
- 写盘失败继续保留原始区间和候选，不用删缓存、跳过产量或凭空增加物资掩盖失败。

### 2.4 星图批量物流操作

- “升级全部星际物流站”和“一键切换全部量子物流站”固定在同一行，按钮尺寸和顶部工具区间距缩小。
- 新增“量子网络一键接入所有轨道收集器”，批量调用既有单收集器安全规则，不新建第二套物流/氢气规则。
- 全局批量操作先计算预览，显示预计成功和跳过数量；多目标变更要求确认。确认后重新读取当前状态、重新计算并通过函数式更新提交，避免弹窗期间状态变化导致误操作。
- 结果反馈包含成功数量、跳过数量和按原因分组的跳过明细；无可执行对象也有明确反馈。
- 1024px、窄桌面、390px 手机和 200% 字号下，搜索框与按钮均保持可见、可点击，不重叠、不遮挡。
- 本批没有增加量子额度、修改氢气量子物流规则、清理物流缓存或补发物资。

## 3. 纯挂机计时与资源结算兼容说明

1.0.35 已把纯挂机字段拆分并保持到 1.0.37：

```text
idleSettlement.currentRunStartedAt
idleSettlement.currentRunElapsed
idleSettlement.lastSettledAt
idleSettlement.totalIdleTime
idleSettlement.currentRunProduction
idleSettlement.totalProduction
```

- `lastSettledAt` 是当前运行的单调前向游标，只结算 `(lastSettledAt, targetWallSeconds]`；重复开始、停止、暂停、恢复、页面恢复或重复加载相同检查点均为 no-op。
- `currentRunElapsed/currentRunProduction` 只描述本次挂机，下一次开始会重置；`totalIdleTime/totalProduction` 只累计已经验证并写入主档的运行。
- 采矿、矿脉扣除、建筑输出、传送带、物流塔、量子空间和托盘仍复用普通模拟的权威写入路径。输出容量不足时只能生产可写入数量，矿脉扣除与成功产出一致。
- 1/4/8/12 倍、供电不足、近满/满输出、堵带、满量子仓、有限/无限资源、重复恢复以及普通模拟对照均由既有 1.0.35 套件继续覆盖。
- 1.0.37 只加强后台尾段和普通离线的决策/提交边界，没有改变倍率平衡、矿物产率或缓存容量。

## 4. 普通/速通存档隔离兼容说明

1.0.35 已建立并由 1.0.37 完整保留以下边界：

- `GameState.mode`、存档 envelope 的 `mode` 和云 API 的 `mode + slot` 共同参与本地主档、备份、急救镜像、三个手动槽、快照、最近记录、自动保存、导入导出、云历史、恢复和删除。
- 普通与速通分别使用 IndexedDB/localStorage 命名空间；云端 schema v7 继续以用户、模式和槽位隔离 revision。
- 缺少模式字段的旧档安全归为 `normal`，迁移前保留原始备份；重复迁移不会重复复制。无法明确证明速通来源的档案不会被提升为速通。
- 普通档不能转换为速通或提交速通榜；速通档只能由玩家主动复制为新的普通档，副本移除速通资格，且不能转回。
- 导入、云下载和救援都校验目标模式；不匹配时在写盘前失败，不覆盖已有槽位。
- 速通排行榜继续要求明确 `speedrun` 模式、结构/规则校验、无普通专属/实验/MOD/近似结算污染。1.0.37 的普通离线“跳过收益”在速通中不可用。

本批没有升级云 schema 或 SQLite layout，也没有直接改任何排行榜历史成绩。

## 5. 存档结构与旧档迁移

| 项目 | 1.0.37 状态 |
| --- | --- |
| `GameState.version` | v46，不变 |
| 存档 envelope | v2，不变 |
| 本地 IndexedDB | 现有模式化 key/record，不升级 |
| 云 API schema | v7，不变 |
| SQLite layout | v2，不变 |
| 普通/速通模式字段 | 沿用 1.0.35，不新增必填破坏字段 |
| 离线决策记录 | 运行时报告/设备偏好，不加入权威 GameState |
| 资源完整性修复记录 | 人工工具返回值；不会自动写入存档 |

旧档处理顺序：先保留原始正文/迁移备份，再执行现有 v1→v46 连续迁移；缺模式按普通档处理；v20+ 资源恢复仅采用持久星球目录声明；完成 envelope 校验、序列化和正式重载后才允许写回。重复载入和重复迁移必须得到相同状态。任何需要补回单极磁石的个案都必须脱离自动加载流程，先做只读审计和备份，再凭确认令牌生成候选；速通另需独立审核。

## 6. 修改文件列表

候选源码提交共修改 70 个文件，新增 5 个文件，未回滚 1.0.35/1.0.36 改动。

### 版本与架构文档

- `CHANGELOG.md`
- `package.json`
- `package-lock.json`
- `android/native-version.properties`
- `docs/ARCHITECTURE.md`
- `docs/GAMEPLAY_SYSTEMS.md`
- `docs/NATIVE_APPLICATIONS.md`
- `docs/PROJECT_STATUS.md`

### 应用、界面与样式

- `src/App.tsx`
- `src/components/GamePanels.tsx`
- `src/components/OfflineReportWorkspace.tsx`
- `src/components/ReleaseNotesDialog.tsx`
- `src/components/StartMenu.tsx`
- `src/components/StarMapWorkspace.tsx`
- `src/components/TechnologyWorkspace.tsx`
- `src/hooks/useHorizontalPan.ts`
- `src/i18n/legacyTranslations.ts`
- `src/styles.css`
- `src/styles/mobile-workspaces.css`
- `src/theme.css`

### 领域与存档

- `src/game/offlineApproximation.ts`
- `src/game/offlineSettlementStrategy.ts`
- `src/game/offlineSimulation.ts`
- `src/game/offlineSimulation.worker.ts`
- `src/game/resourceIntegrity.ts`（新增）
- `src/game/storage.ts`
- `src/game/technologyTreeLayout.ts`（新增）

### 单元/组件测试

- `src/components/ReleaseNotesDialog.test.ts`
- `src/game/offlineSettlementStrategy.test.ts`
- `src/game/quantumLogisticsNetwork.test.ts`
- `src/game/resourceIntegrity.test.ts`（新增）
- `src/game/storage.test.ts`
- `src/game/technologyTreeLayout.test.ts`（新增）
- `src/hooks/useHorizontalPan.test.ts`

### 浏览器测试

- 新增 `tests/e2e/v137-release.spec.ts`。
- 更新 `tests/e2e/v118-station-upgrade.spec.ts`、`v119-quantum-logistics.spec.ts`、`v130-feedback-batch.spec.ts`、`v130-offline-timewarp-real-save.spec.ts`、`v132-pure-idle-macro.spec.ts` 和 `game-flow.spec.ts` 的新行为断言。
- 其余 28 个现有 E2E 文件只同步当前版本公告 seen ID 或保持跨版本入口可执行：`construction-automation-stability.spec.ts`、`mobile-shell.spec.ts`、`speedrun.spec.ts`、`ui-visual-feedback.spec.ts`、`v101-ui-logistics.spec.ts`、`v102-light-i18n.spec.ts`、`v103-release.spec.ts`、`v104-release.spec.ts`、`v105-release.spec.ts`、`v106-release.spec.ts`、`v108-release.spec.ts`、`v109-storage-recovery.spec.ts`、`v112-release.spec.ts`、`v115-pure-idle-tutorial.spec.ts`、`v117-space-station-construction.spec.ts`、`v120-paused-canvas-performance.spec.ts`、`v121-blueprint-construction.spec.ts`、`v121-statistics-alignment.spec.ts`、`v123-cloud-upload.spec.ts`、`v124-canvas-performance.spec.ts`、`v124-canvas-real-save-benchmark.spec.ts`、`v124-factory-management.spec.ts`、`v127-selection-batch.spec.ts`、`v135-idle-mode-isolation.spec.ts`、`v136-release.spec.ts`、`v31-workspaces.spec.ts`、`v32-buffer-settings.spec.ts`、`v33-release.spec.ts` 和 `v34-release.spec.ts`。

本报告、Release Agent 交接、candidate 记录和候选制品清单作为后续文档提交单独保存；二进制制品仍绑定上述源码提交，不绑定文档提交。

## 7. 新增与重点回归测试

### 单极磁石/资源

- 合法单节点生成与 128 个 seed 扫描。
- 资源设置变化不改变目录合法性。
- v20+ 持久目录不声明资源时不引入幽灵矿。
- 人工修复的预览、确认令牌、源/候选哈希、备份、回滚、幂等。
- 速通独立审核门禁、序列化/导入保持。

### 离线/纯挂机

- 零校准和保守失败返回 `decision-required` 且无候选状态。
- 取消后重载仍保留同一离线区间；不写盘、不发收益。
- 普通模式双确认零收益时钟推进；速通拒绝该操作。
- 从原始 Deferred 状态精确重试，不从失败近似候选继续。
- 后台纯挂机尾段 decision-required 自动精确重试。
- 1.0.35 的快速开始/停止、暂停/恢复、退出/重进、离线重进、重复恢复、1/4/8/12 倍、缓存/传送带/量子仓阻塞、有限/无限矿脉和普通模拟对照全部继续执行。

### 科技树

- 行/子列布局稳定且没有垂直滚动。
- 滚轮/触控板/Shift、中键/右键拖动、键盘导航。
- 标准/紧凑 × 100%/150%/200% 六组合真实设置。
- 200% 下科研开始、暂停、恢复、取消。
- 手机纵向布局。

### 星图批量操作

- 首两个按钮同排，新增轨道收集器按钮位于下一排。
- 宽桌面 100%、桌面 150%、窄桌面 200%、390px 手机 200%。
- 搜索框可见且不被遮挡。
- 轨道收集器预览、取消、确认、成功/跳过和原因分组。
- 状态变化后重新计算，避免陈旧闭包覆盖。
- 1.0.36 物流站升级与量子切换原行为继续通过。

### 存档模式隔离

- 普通/速通自动保存、手动槽、快照、删除、恢复互不覆盖。
- 同槽位的本地/云 revision 按模式隔离。
- 两种模式并存、多设备同步、导入模式不匹配拒绝。
- 速通复制为普通后互不影响；普通不能转回速通。
- 普通不能提交速通榜，明确速通档可按规则提交。
- 缺模式旧档归普通并保留迁移备份，重复迁移幂等。

## 8. 测试结果

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 103 个文件通过、6 个显式跳过；936 项通过、17 项跳过；0 失败 |
| `npm run build` | 通过，1,890 modules；仅既有 >500kB chunk 警告 |
| `npm run test:e2e` | 288 总数；277 项通过、11 项显式条件跳过、0 失败；803.5 秒 |
| `npm run test:server` | 70 项通过、2 项可选夹具跳过 |
| `npm run test:ops` | 6/6 |
| `npm run test:native` | 8/8 |
| `npm run licenses:check` | 128 个运行时包，当前 |
| 根项目 `npm audit --omit=dev` | 0 漏洞 |
| server `npm audit --omit=dev` | 0 漏洞 |
| clean `npm ci` | 457 packages；完整开发依赖仍有既有 1 moderate/4 high，生产依赖为 0 |
| clean Web build | 通过；Build ID 正确 |
| clean Electron pack | 通过；包内 1.0.37；隔离启动 10 秒 4 个进程；`NotSigned` |
| clean Android unsigned release | 413 tasks；lintVital；APK/AAB 通过且未签名 |
| source/Web/API | source manifest 160；Web 127 + API 33，逐文件 160/160；API 禁止路径 0 |

11 条 E2E 跳过均为需要显式真实夹具或性能环境开关的既有条件测试；真实大档离线和时间扭曲已通过单独启用的专项命令运行。

## 9. 真实存档与性能结果

测试源文件：`C:\Users\WINDOWS\Downloads\dsp-idle-save-2026-08-10.json`，23,531,371 字节。测试前后 SHA-256 均为：

```text
2ea7d94236f12124b3bc7626da063220792087e5cd9dc9a7ef0b9803c77c1048
```

### 快速离线 Worker

| 离线秒数 | Worker 往返 | 验证 | 总耗时 | 最大估计误差 |
| ---: | ---: | ---: | ---: | ---: |
| 6,984 | 17.546s | 19.218s | 36.764s | 2.624% |
| 30,171 | 17.116s | 19.649s | 36.765s | 5.877% |
| 604,800 | 17.351s | 19.153s | 36.503s | 49.941% |
| 2,592,000 | 17.511s | 19.290s | 36.801s | 81.521% |

四个窗口都只推进一次、正式重载有效、关键数量有限且非负，源文件未变。Worker 往返满足当前 35 秒硬门禁，但端到端验证超过需求期望的 30 秒；长窗口非关键误差较高，必须作为灰度风险，而不是描述成完全等价。

### 时间扭曲

| 倍率 | 往返 | Worker | 最大关键误差 |
| ---: | ---: | ---: | ---: |
| 8x | 5,929.5ms | 5,246.8ms | 0.0040 |
| 12x | 5,472.7ms | 5,271.2ms | 0.1316 |
| 16x | 5,308.5ms | 5,109.3ms | 1.0000 |

终止响应 262.3ms，没有迟到消息提交；源状态未变，关键字段保持有限值。16x 的关键误差上界仍高，继续保留为风险。

### 60 秒精确确定性

- v46；13,895 实体、32,562 条传送带、2,277 个物流站、22 颗行星。
- 活跃/最密集深渊星球：1,914 实体、4,334 条带、268 个站。
- Worker payload：23,151,329 字节。
- 一次 60 秒精确：12,749.065ms；玩法哈希 `156870f3`。
- 60×1 秒切片：P50 176.895ms、P95 268.444ms、最大 311.375ms；玩法哈希同为 `156870f3`。
- 非法数量 0；缓存和量子库存均保持有限非负。
- Node heap 从约 172.5MB 到约 955.5MB，但该值同时保留源、整段和切片三份状态，不代表单一浏览器进程峰值。

### 低内存与视觉

- 合成设备矩阵：2GB/2 核复杂档推荐 conservative，16GB 推荐 fast，1GB 速通仍强制 exact。
- E2E 覆盖低端手机 renderer 和 1.0.35/1.0.36 的 Canvas fallback。
- 已人工检查六张科技树字号/密度截图和四张星图批量工具栏截图；200% 字号下卡片、搜索框和操作按钮可达。

## 10. 候选制品

source manifest：`artifacts/release-manifests/1.0.37-853ecdb12795.json`；160 文件；聚合 SHA-256 `25b31f5b0ab500b67ac3d3f436d1c8fc8696f50672f627314587f52bdea86fba`；manifest 文件 SHA-256 `1fb186700f24796205730a3366571a1112767bc0556508f8f66be1b864c6c2e8`。

| 文件 | 字节 | SHA-256 | 用途 |
| --- | ---: | --- | --- |
| `1.0.37-853ecdb12795-web.tar.gz` | 1,367,067 | `896038c1837a42fae82cd58f41ebaef717edf79d29b81b7f235d3b5fb65bfd16` | Web 候选，仅可进入未激活目录 |
| `1.0.37-853ecdb12795-api.tar.gz` | 106,423 | `ad2927f30a9c901269fa22ffc1daafa6da629d27f90834bbe75004ca1c264c81` | API 候选；协议/schema 不变 |
| `1.0.37-853ecdb12795-windows-unpacked-diagnostic-unsigned.tar.gz` | 150,112,282 | `d3e5b4d9b0b896533a2ab7899bb43e3372c2fb1a0cf3f07e8f0988f094a2d0bf` | 未签名诊断包，禁止 stable |
| `1.0.37-853ecdb12795-android-unsigned.apk` | 4,822,679 | `751c89fd8669d0f977e96b643b31497880fd10c15bd1f6fac43e73e7a890fa01` | 未签名诊断 APK，禁止 stable |
| `1.0.37-853ecdb12795-android-unsigned.aab` | 4,637,964 | `82848a7ae4a0d1c7fc22c6f30a405303517c179bd41a67e94f5848b8cc1e74fc` | 未签名诊断 AAB，禁止 stable |

聚合记录 `candidate-artifacts.json` 为 2,129 字节，SHA-256 `f02c6e30149dd6c43bca5d84d26207e60b6b031cdad8695d666e27afe2a3449f`，5/5 制品复验通过。

## 11. 性能影响评估

- 资源迁移新增的目录判定只发生在载入迁移阶段，按行星/资源集合查找，不进入逐 tick 热路径。
- 资源人工审计只在明确调用时遍历实体，不在自动保存、云同步或排行榜提交中运行。
- 科技树新增布局计算与 `ResizeObserver` 只在工作区打开或尺寸变化时执行；横向输入监听为被动关闭的局部监听器，卸载时移除。
- 星图批量操作在用户点击时遍历目标站/收集器并复用已有校验，不增加常驻模拟成本。
- 离线决策保护会在不确定候选上增加一次用户交互或精确重试；这是防止错误提交的显式成本。真实大档的正式验证阶段仍约 19 秒，是当前主要性能风险。
- 生产 bundle 仍有 `FactoryRuntime` 和 CSS 大于 500kB 的既有警告，本批未解决。

## 12. 未解决风险

1. 23.5MB 真实档快速离线端到端约 36.5～36.8 秒，未满足“全部处理 30 秒内”的期望。
2. 7 天/30 天普通近似的非关键估计误差约 49.9%/81.5%；当前关键门禁通过不等于所有库存严格等价。
3. 16x 时间扭曲夹具的最大关键误差上界为 1.0，需继续观察复杂科技/戴森边界。
4. 60 秒精确模拟为 12.75 秒，低配设备可能更慢。
5. 没有 Android 真机、低配 Windows 物理机、锁屏/后台一小时、覆盖安装和签名连续性证据。
6. Windows/Android 候选制品均未签名，不能发布到 stable feed。
7. 完整开发依赖审计仍有既有 1 moderate/4 high；生产依赖审计为 0。
8. 没有针对真实玩家争议存档执行单极磁石人工修复；工具正确性通过合成/迁移测试，但实际个案仍需备份和双人审核。

## 13. 回滚方案

1. 发布前：直接废弃 `1.0.37-853ecdb12795` 未激活候选和未签名诊断制品，生产保持 `1.0.36+e0ad49062fa3`。
2. 灰度后：Web/API/下载指针原子切回不可变 1.0.36 目录；不热改服务器源码，不删除浏览器缓存，不补物资。
3. 本批没有数据库 schema、云 schema、SQLite layout 或 GameState 版本升级，因此代码回滚不要求数据库降级或批量改档。
4. 1.0.37 新增的设备级离线偏好在 1.0.36 中只是未读取键，不需要删除。
5. 已由人工资源工具生成但尚未写入的候选直接丢弃；若个案候选已获授权写入，使用其绑定的原始备份和审计记录逐档回滚，不能批量覆盖其他存档。
6. 排行榜历史恢复仍走既有人工 dry-run、备份、精确账号、停服 guard 和显式确认流程；不属于本版本回滚或发布步骤。

## 14. 发布边界

开发角色没有连接香港/上海生产 VPS，没有修改数据库、云存档、排行榜历史、下载页、Nginx、systemd 或 stable 指针，也没有读取 Android 签名私钥。Release Agent 必须从同一 clean source 使用既有长期证书重建 Android 正式包，验证签名连续性和覆盖升级；Windows 按既有 `NotSigned` 政策重建 setup。完成备份、未激活目录、物理设备、风险接受、原子切换和公网验收前，`1.0.37` 只能称为发布候选。
