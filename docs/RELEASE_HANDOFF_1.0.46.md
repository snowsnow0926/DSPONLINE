# 1.0.46 发布阻断返修与完整候选开发交接

> 状态：发布前开发门禁完成，未发布；不授权线上切换、正式签名或下载页更新。
>
> 分支：`codex/1.0.46-save-recovery`
>
> 版本：Web/Desktop `1.0.46`；Android `1000046`
>
> 默认保存协调器：1.0.43-compatible verified-primary；durable WAL 仅显式开发启用。

## Task ID / title

`DSPIDLE-1046-SAVE-STABILITY-MOBILE-BATCH-CANVAS-STATION-RECERT`：在原 1.0.46 范围上处理发布门禁阻断：用周期/时间感知采样替代经典进度的下降阈值误判，修复纯挂机终局功率短暂显示负增量、普通空间站任务无法从量子库存交付，以及聚焦上下文 hover 后偶发把画布平移切成节点拖动的竞态，并从新的 clean runtime SHA 完整重建候选。

## Priority

P0 发布阻断 + 存档/模拟稳定性，P1 手机与空间站交互。任何修复都必须保留玩家状态、原子扣料、纯挂机恢复日志与导出边界。

## Source and attachments

- 玩家多次复现：自动保存完成或保存期间拉线后模拟自动暂停；继续模拟显示“durable 模拟 Worker 不可用，已暂停；刷新后从 recovery 精确恢复”。
- 保存设置合同：默认关闭“保存期间允许继续操作”时拒绝保存窗口内操作；开启时已接受操作保留，失败不回滚且可立即导出。
- 手机玩家反馈：连续拉线时桌面面板与底部条同时出现、遮挡地图；超过 5 条后曾显示“页面模块未能载入”，重复点击会阻断整批确认。
- 画布反馈：自动档同时出现完整卡、中等卡、一行卡和完全隐藏的重叠组，玩家无法分别控制基础卡片、重叠建筑和交互展开；重叠位置至少必须留下可识别数量入口。
- 画布二次反馈：检查线路网络后，非网络节点被降到极低透明度；选中或悬停展开仍继承 dim class，LOD 切换又缺少初始几何，表现为“悬停哪个哪个消失”。大量半透明节点同时保留 `draggable/nopan`，还会形成无法从卡片区域平移的画布死区。
- 画布最终阻断：导入大档并放置/拉线一段时间后，拖动画布或 React Flow 自动平移只更新了变换和线路层，虚拟节点窗口与 CanvasMiniMap 却等待 `onMoveEnd`；自动平移并不保证触发该回调，最终表现为视角外建筑不再挂载、小地图不动、建筑拖动/框选失效以及放置坐标看似错位。
- 一行卡反馈：密集模式应优先显示配方和产物，而不是大量相同的建筑名称。
- 空间站切换阻断：工厂位于 `ReactFlowProvider` 下，空间站曾直接挂载第二棵 `ReactFlow` 并复用同一 store；空间站 StoreUpdater 覆盖工厂节点/视口，卸载清理又重置共享 store，因此返回工厂后画布交互整体失效。空间站现使用自己的嵌套 provider 和固定 flow id，与工厂状态完全隔离。
- 生产预览直达阻断：Web 构建曾使用相对 `./assets`，浏览器直达 `/station/<id>` 时会请求 `/station/assets/*` 并白屏。Web 现固定根路径 `/`，Desktop/Android 继续使用相对路径；manifest 同样通过 `%BASE_URL%` 按平台生成。
- 发布 agent 在旧候选 `865f125e8624` 上复现 `exact-value tooltip and classic progress share one visible value`：完整 Chromium 1 failed，单 worker `repeat-each=5` 为 3 pass / 2 fail；失败样本包括 89→59 与 59→更低。产品进度按模 1 自然循环，旧测试却只把下降至少 50 当成回绕，Playwright 调度跨过完整周期后继续前进时会把合法净下降误判为倒退。
- 截图反馈：纯挂机“终局产出”中的戴森总发电功率会在 30 秒权威刷新之间按旧速率外推，短暂显示负数，下一次刷新恢复。
- 空间站反馈：每日特别任务可以使用量子库存，前三个普通任务的终端/来源限制却把量子按钮禁用，导致量子库存充足时仍无法完成任务。
- 两份本地只读玩家存档：
  - `dsp-idle-save-2026-08-14.json`：36,704,109 bytes，SHA-256 `cd2356ea2b9a90a47cfa32ed9533e7056bfc4202f6af777fc4f3b98faa9a81b1`
  - `dsp-idle-local-backup-2026-08-17 (1).json`：11,723,913 bytes，SHA-256 `f832f7fb909bad1981cd8476f28dcf0f1026c62955d822904218cee270a43d2a`

附件正文和截图不得进入 Git、制品、日志或发布交接包。

## Reproduction or observed evidence

### 默认玩家路径

1. 普通 Web 构建不设置 `VITE_DURABLE_RUNTIME_RECOVERY`。
2. 导入玩家存档，确认模拟 Worker active，并确保 `data-simulation-paused=false`。
3. 触发真实 30 秒自动保存处理器两次，串行等待 authoritative checkpoint、主档写入与读回。
4. 两份档的两次保存均保持 Worker active、`paused=false`，期间没有 `paused=true`/fallback 属性变化。
5. 刷新回菜单后，primary 完整检查有效，模式、实体数、线路数保持，持久 `paused=false`。
6. 两份源文件 bytes、mtime 和 SHA-256 前后未变化。

实测保存耗时：

| 玩家档 | 第一次 | 第二次 |
| --- | ---: | ---: |
| 36,704,109 bytes | 约 6,441 ms | 约 4,943 ms |
| 11,723,913 bytes | 约 1,087 ms | 约 835 ms |

### durable 显式开发路径

1. 设置 `VITE_DURABLE_RUNTIME_RECOVERY=true`。
2. 分别注入 finalize、第二次 persistence Worker、T1 后 recovery-head initialize 和 primary commit quota 故障。
3. T0 与 pending intent 保留；T1 revision 绑定生成该 payload 的权威 Worker 回执。
4. 新 Worker 清除旧 disabled latch；运行中自动保存恢复为运行态，玩家主动暂停可在同页继续。
5. 实验性编辑模式保存失败时，已接受进度、WAL 和立即导出能力都保留。

### 手机连续拉线

1. next-mobile shell 进入连续模式时，React 树中桌面 `.batch-connection-panel` 数量为 0，只有底部操作面。
2. 390×844、360×640、844×390 下默认收起不遮挡中部画布，可展开、收起并继续选择地图端口。
3. 重复或本次非法点击不增加候选、不扣料、不设置阻塞失败；此前有效候选仍可确认。
4. 6、10、50、100 条候选完整可滚动，最新优先；任意条可定位或移除，撤销仅删除最近一条。
5. 最终原子复核失败按候选定位原因，并保持线路、库存和持久状态完全不变。

### 周期进度发布阻断判定

1. 产品的 aria、可见文字和 fill 在失败样本中始终一致（89/89/约 89、59/59/约 59），没有出现三个呈现源彼此分叉。
2. 新专项在页面内用 `requestAnimationFrame` 与 `MutationObserver` 连续捕获 DOM，并为每个样本记录同一页面时钟的 `performance.now()`；Playwright 只等待最终样本，不再假设 100 ms 调度恒定。
3. 弧形熔炉磁铁配方的已知速率为 `2/3 cycle/s`。验证器把可见模 1 差值按实测时间展开为零个或多个完整周期，并纳入 1 秒权威发布窗口；只有存在与时钟相符的前向展开才认定为合法回绕。
4. 短时间内无法由任何完整周期解释的下降仍报告 `non-wrap-backstep`；缺少自然回绕、样本不足、时钟倒退、aria/text/fill 不一致也分别失败。没有增加 retry、skip、固定下降阈值或删除单调性覆盖。
5. 修复后目标用例单 worker 连续 20/20；其中一次完整用例因宿主调度延长到约 21.7 秒仍通过，直接证明判定不依赖 Playwright 采样间隔。

### 纯挂机与空间站补充反馈

1. 纯挂机只对白矩阵、火箭、吸收帆、结构点和活动交付等累计字段按非负速率插值；戴森功率、壳层帆与轨道帆等瞬时字段只展示最后提交的 30 秒权威快照。
2. 戴森功率不再显示基于旧速率推导的“本次负数”，界面明确标注“已结算快照 · 30 秒更新”。
3. 玩家确认的量子交付可匹配普通、指定来源、多来源及原量子要求；来源行星约束只继续限制自动轨道终端交付。量子库存扣除和任务进度更新保持同一状态事务，缺料时不部分扣除。

## User-visible acceptance criteria

- 自动保存不再自动暂停正在运行的模拟；手动暂停意图不被自动开启。
- 暂停/继续不会因旧 Worker disabled 状态永久卡死。
- 默认保护模式拒绝保存期间编辑但不暂停模拟；实验模式保留已接受操作，失败可继续和导出。
- 纯挂机恢复日志、宏观进度和主档验证正常时不再显示已过期“保存与恢复”警告。
- 纯挂机终局功率不再在 30 秒提交间隔内显示虚构负增量；累计产出仍平滑且不得因负速率倒退。
- next-mobile shell 同时只存在一个连续拉线操作面，底栏无 backdrop、不阻断地图。
- 重复、已有线路、不兼容或缺料点击不污染有效候选；最终领域事务仍严格原子。
- 6/10/50/100 候选无 pageerror、runtime fatal 或 dynamic-import 误报。
- 普通运行时异常与真实 chunk/module 加载故障使用不同的脱敏错误界面。
- 基础卡片提供自动、完整、中等、一行；只有自动档由可见节点数和迟滞切换。
- 重叠建筑提供数量标记、代表卡片、全部卡片；默认数量标记始终留下 `88×44` 点击区和约 `80×30` 的“层叠图标 + 数量”可见胶囊，低缩放手机画面仍可触控，点击后可选择真实建筑。
- 交互展开独立提供仅选中、悬停也展开、保持基础；拖动、采矿和连线安全目标不受关闭限制。
- React Flow 变换层不再使用会裁空世界坐标子节点的 paint containment；一行卡及 wrapper 固定 `96×32`，各档裁剪与线路端点统一使用当前展示尺寸。
- fully-deferred 空白视角保留四个 Fit View 边界锚点；标准 SVG MiniMap 与低频 CanvasMiniMap 均可点击恢复到建筑区。
- 选中、悬停、聚焦、拖动和连线安全目标使用高于重叠 halo 与普通邻居的交互层级；展开卡通过 `elementFromPoint()` 屏幕命中回归确认不会再被遮挡后看似消失。
- 线路/任务/生产链检查只淡化上下文节点；当前选中、悬停或其他交互目标保持不透明。上下文 hover 可以视觉展开，但仍保持不可拖拽且允许从卡片区域平移，点击建筑或空白画布会退出临时线路聚焦。
- 一行生产卡优先显示“配方 · 产物”，例如“金伯利矿提炼 · 金刚石”；没有配方/产物的特殊建筑可靠回退到建筑名称。
- “完整 + 全部卡片”在视口节点超过 480/1,000 时统一降到中等/一行基础卡并标明“密集保护”；被选中或悬停的单卡仍完整展开，避免数千重卡让页面失去响应。
- 拖动、滚轮缩放和 React Flow 自动平移期间会实时发布带 overscan 的虚拟视口，并在 pointer 仍按下时更新小地图；手势结束强制发布最终精确视口。拖动建筑穿过旧窗口、框选、选中展开和移动后放置坐标均以同一实时 transform 为准。
- 空间站与工厂各持有独立 React Flow store。反复切换、空间站缩放或直接打开 `/station/<id>` 后返回工厂，原工厂视口不被覆盖，建筑拖动、反向框选、拉线、放置坐标和小地图仍可用。
- 空间站前三个普通任务与特别任务都能由玩家确认后从量子库存交付；自动终端仍必须遵守任务声明的来源行星。

## Compatibility and data-preservation constraints

- 保持 GameState v47、save envelope v2、cloud schema v8、SQLite layout v3 和 IndexedDB records 格式。
- 连续拉线候选只存在于 React UI 状态，不新增存档、云同步或迁移字段。
- 画布三个偏好只写 `dsp-idle-network.ui.canvas-detail.v1`、`dsp-idle-network.ui.canvas-overlap.v1`、`dsp-idle-network.ui.canvas-interaction-detail.v1`，不进入 GameState、云 payload、迁移或状态哈希。
- 保持 10/50/100 条原子提交、材料扣除、端口校验、顺序与确定性逻辑。
- 保持桌面连续拉线面板及 Ctrl/Shift、Enter、Escape 行为。
- 量子任务修复复用既有 GameState v47 字段与合同结构，不增加迁移；只调整交付渠道匹配和 UI 可用条件。
- 不清理或重写玩家浏览器存档，不上传附件，不访问生产数据库。

## Target platforms

Web/PWA 为本地已验证目标；Chromium、Firefox、WebKit 已跑浏览器门禁。Windows unpacked 诊断包已完成 4 进程隔离启动并确认为 `NotSigned`；Android unsigned APK/AAB 已完成 bundle、assemble 与 lintVital，版本为 `1.0.46 / 1000046`。正式签名、证书连续性和实体设备仍属于 release agent 门禁。

## Required tests and exact results

以下结果均在独立 detached clean worktree、固定运行时 `d64b9ef85f9dea1cf2d0617cb300fa492ca1f43c` 上执行；没有依赖主工作区的未提交内容：

- 根/`server` `npm ci`：456 / 75 packages，均成功；root/server `npm audit --omit=dev --audit-level=high` 均为 0 vulnerabilities。
- 阻断用例 `exact-value tooltip and classic progress share one visible value`：单 worker `repeat-each=20` 为 20/20，0 retry、0 skip。新增周期验证器单元测试覆盖多周期稀疏样本、自然回绕、非回绕倒退、三种显示源分叉和非单调时钟。
- 网络聚焦上下文真实指针专项：连续 20/20；hover 后仍断言 `draggable=false / nopan=false`，真实平移、退出聚焦和拖拽恢复均通过。
- `npm run typecheck`：passed。
- `npm test -- --maxWorkers=1`：173 files passed / 7 conditional skipped；1,434 passed / 20 skipped / 0 failed。
- `npm run test:server`：server 363 passed / 2 skipped；station profile 3/3。
- `npm run test:ops`：56 passed / 6 Linux-only skipped。
- `npm run release:test-switch`：29/29。
- `npm run test:native`：24/24。
- `npm run licenses:check`：125 runtime packages consistent。
- `npm run test:e2e:durable -- --workers=1`：7/7。
- `npm run test:e2e -- --project=chromium --workers=4`：426 passed / 26 explicit conditional skips / 0 failed（452 total；6.3 分钟）。
- `npm run test:e2e:nightly -- --workers=1`：Firefox + WebKit general 2/2。
- 空间站 production preview 7/7；其中普通来源限制合同从量子库存交付的新增 E2E 通过。Firefox + WebKit 对完整空间站文件为 14/14。
- production preview 功能门禁 31/31；PWA `repeat-each=3` 为 3/3。
- 独立密度性能门禁最终 1/1：内部 auto/full/expand-all 各 3 轮；auto 三轮 P95 为 20.7 / 7.1 / 20.9 ms，max 20.9 / 13.9 / 21.0 ms，0 个 >50 ms 帧。连接视口门禁 1/1：bounded entry 10.0 ms、P95 13.9 ms、max 83.4 ms；显式 expand-all entry 51.6 ms、P95 7.1 ms、max 118.2 ms。
- 额外的密度 `repeat-each=3` 压测不是通过证据：2 pass / 1 fail；失败执行只有一个 auto 子轮 P95 为 27.8 ms（max 34.8 ms，仍无 >50 ms），前一执行与随后隔离执行通过。原 `<=21 ms` 预算保持不变，没有 retry 或阈值放宽。
- `npm run build:web`：1,962 modules；startup 194,810 B gzip（JS 101,823 B、CSS 92,987 B、最大 JS 58,974 B）；menu 282,321 B gzip；forbidden startup modules 0；Build ID `1.0.46+d64b9ef85f9d`。
- API 展开候选：166/166 文件，临时 SQLite health 200，cloud schema/layout 8/3；归档再解包逐文件 166/166。
- Windows unsigned unpacked：`1.0.46 / 1.0.46.0`，ASAR Build ID 正确；使用独立用户目录和禁止外网解析参数启动 4 个候选进程后只按精确路径停止，Authenticode `NotSigned`。
- Android unsigned：bundle/assemble/lintVital 通过；`cn.dsponline.network / 1.0.46 / 1000046`，zipalign 成功；`apksigner` 明确返回 `DOES NOT VERIFY`，AAB 签名条目 0。
- source manifest 251/251，Web 归档按 manifest 155/155，source 二次 `git archive` SHA-256 完全一致；candidate 10/10、provenance 3/3、SHA256SUMS 12/12。

旧候选上的两份真实玩家档 autosave、38 张画布矩阵与空间站往返证据仍作为未改存档格式路径的兼容参考；本次没有覆盖或重写附件，source archive 仍只用于内部交接，不作为公开下载制品。

开发 E2E 的 `/api` 代理故意指向 `127.0.0.1:65534`，其 `ECONNREFUSED` 是线上 API 隔离证据。偶发 `ResizeObserver loop completed with undelivered notifications` 目前是开发服务器非阻断诊断，不应被吞错逻辑掩盖。

## Release target and version

开发目标已形成可由 release agent 独立复验的 `1.0.46-d64b9ef85f9d` 固定源码和候选制品。旧 `1.0.46-865f125e8624` 已因可重复发布门禁阻断明确作废，更早的 `1.0.46-c24a0f57efeb` 继续作废；两者均不得发布。本交接不授权香港、上海、下载页、Android、Windows 或任何 stable channel 发布。

## Known risks / rollback

- stable 构建不得设置 `VITE_DURABLE_RUNTIME_RECOVERY=true`；durable 再次成为默认前需要重新资格审查。
- `FactoryRuntime` 和主 CSS 仍有大 chunk 警告，属于后续拆分目标，不影响当前 startup/menu 预算。
- Android/Windows 正式签名与实体设备、Linux systemd/Nginx、备份、生产健康、公开 PWA 与下载页门禁均未执行。
- 当前香港线上回退/版本由其他任务负责；development 任务不得改生产或替换线上 rollback pointer。
- 合成 506 个重卡的固定“完整”/显式“展开全部”诊断仍可出现数百毫秒到约 1.2 秒的帧；这是玩家明确选择高细节或诊断 override 的残余成本，不能描述成自动档结果。
- 自动档标准隔离性能门禁通过，但额外 `repeat-each=3` 压测保留一次 P95 27.8 ms 的原阈值失败。该失败与前后通过结果一并交接，release agent 不得把重跑、retry 或放宽 `<=21 ms` 预算当作修复；若目标发布机可重复超限，应暂停发布并单独处理性能门禁。

## Development handoff

Runtime / candidate Commit SHA: **`d64b9ef85f9dea1cf2d0617cb300fa492ca1f43c`**。Build ID：**`1.0.46+d64b9ef85f9d`**。Release ID：**`1.0.46-d64b9ef85f9d`**。候选来自干净 detached checkout，source gate 记录为 clean；之后的交接文档提交不改变运行时候选 SHA。

Changed files:

- 默认/实验保存选择与运行时：`src/game/runtimePersistenceMode.ts`、`src/App.tsx`、`src/FactoryRuntime.tsx`
- authoritative persistence/serialization/Worker/protocol：`src/game/authoritativeSave*`、`simulationRuntimeProtocol*`、`simulation.worker.ts`、`localSaveStore.ts`、`storage.ts`
- 纯挂机/离线/投影：`pureIdleMacro*`、`pureIdleRecovery.ts`、`offlineSimulation*`、`simulationProjection*`
- 本轮纯挂机呈现：`src/game/pureIdlePresentation.ts`、`src/game/pureIdlePresentation.test.ts`、`src/components/TimeWarpIdleOverlay.tsx`
- 手机连续拉线与错误边界：`src/App.tsx`、`src/styles.css`、`src/styles/mobile-factory.css`、`DynamicImportRecovery.tsx`、`dynamicImportRecovery.ts`
- 画布三组偏好与重叠标记：`canvasDensityPresentation*`、`uiPreferences*`、`FactoryNodes.tsx`、`OperationsWorkspace.tsx`、`src/App.tsx`、`src/styles.css`、`v144-canvas-density-stack.spec.ts`
- 实时虚拟化与小地图：`src/App.tsx`、`src/components/CanvasMiniMap.tsx` 及视口/拖动/框选/放置/性能/PWA Playwright 回归
- 空间站隔离与 Web 直达：`src/components/StationCanvasRenderer.tsx`、`vite.config.ts`、`index.html`、`src/versionMetadata.test.ts`、`tests/e2e/orbital-station.spec.ts`、`tests/e2e/v146-real-save-canvas-density.spec.ts`
- 本轮空间站量子交付：`src/game/stationContracts.ts`、`src/game/stationContracts.test.ts`、`src/game/orbitalStation.test.ts`、`src/components/OrbitalStationWorkspace.tsx`、`tests/e2e/orbital-station.spec.ts`
- 本轮周期进度门禁：`src/game/periodicProgressValidation.ts`、`src/game/periodicProgressValidation.test.ts`、`tests/e2e/v101-ui-logistics.spec.ts`、`src/game/productionRefresh.test.ts`
- 服务端原子性审计：`server/cloud-payload-store.mjs`、`server/cloud-payload-recovery.mjs`、`server/index.mjs` 及其测试
- 回归：`tests/e2e/v144-*.spec.ts`、`v146-real-save-autosave.spec.ts`、`v127-selection-batch.spec.ts`、纯挂机/菜单/画布相关 E2E 与 focused Vitest
- 版本与规范：`package.json`、`src/i18n/releaseNotes.ts`、本报告及 canonical docs

发布 agent 必须从最终提交的 `git diff --name-only <baseline>...<sha>` 取得完整清单，不能把上述分组当作 manifest。

Artifact root：`D:\GameDev\DSPidle2\artifacts\release-bundle\1.0.46-d64b9ef85f9d`。其中 10 个文件已经 candidate manifest 独立复验，总计 170,092,889 bytes。辅助元数据位于：

- `artifacts/release-manifests/1.0.46-d64b9ef85f9d.json`：Web `dist` + API source manifest，251/251，aggregate `a05f0a2f09a3575e109ee67a3ad4695a9ba0ef0b26d5c029539037f919b4c24f`。
- `artifacts/release-manifests/1.0.46-d64b9ef85f9d-candidate.json`：bundle 10/10，aggregate `09826ccc60e1c594979878cf6507405e913c180963f84a8d3e76405d5b587e52`。
- `artifacts/release-manifests/1.0.46-d64b9ef85f9d-provenance.json`：3/3 subjects verified against runtime SHA。
- `artifacts/release-manifests/1.0.46-d64b9ef85f9d-SHA256SUMS.txt`：12 个交接文件逐项 SHA-256，已在 clean worktree 与最终目标位置各复算 12/12。
- `artifacts/release-gate/1.0.46-d64b9ef85f9d-{source-gate,sbom.cdx,gate-report}.json`：clean source、CycloneDX SBOM 与含 19 条条件跳过声明的脱敏门禁报告。

| 制品 | 字节 | SHA-256 |
| --- | ---: | --- |
| source archive | 6,732,081 | `5a569e402807283e5ce39f5909c00a233273a328ba5e289bf03f842e4fe9edec` |
| Web archive | 1,737,960 | `a3e7e0376d80904ddc02e36bd348162b49f2980ffab15f4bab200ddd430e1ed7` |
| API archive | 668,336 | `1a4e7bfba761e7f6c74b570b370e3a8aca0bde304f0d6fe74f7df19ca40116d3` |
| Windows unpacked unsigned diagnostic | 150,430,872 | `f89b63226b177d7c43c159af716b69edab9d47f3a455117d84ed406b05ec49c3` |
| Android unsigned APK | 5,125,477 | `324102ae19e0e7af7fee1f266efacdb6694f0d3e901a6dfad3d435849f6366df` |
| Android unsigned AAB | 4,941,881 | `8d90e7a18dbfedd540fe455bc63222e962802b664d34013790de9c4b79d4f9dd` |
| source manifest | 42,721 | `56f0c85189c92910a3538166519965fd17df75e3896a29e0955ed3cb5aadd68d` |
| source gate | 176 | `56ee78f94342281164db110747ee3125d60c8fa12aaa023d7fab0eb5b82191aa` |
| SBOM | 407,391 | `495108a0e06536038b4b9b6ec740013a405b2549da080a75da837356a193c8fb` |
| gate report | 5,994 | `9fbc1b15920b615da7d2e947599bd5d02bb389571ca098237c7f915c605554f7` |

六种归档及 Windows ASAR 内层共扫描 7,872 个条目，未发现真实 `.env`（无凭据 `.env.example` 除外）、数据库、私钥或证书/签名容器。Web/API/Windows/Android 解包运行时内容也未命中当前本机路径、截图名或私钥/token 模式。source archive 由固定 SHA 的 `git archive` 生成并二次生成到相同 SHA-256，仅作内部交接，不得作为公开下载制品。

Unverified gaps：正式 Windows/Android 签名与证书连续性、Android 实体设备、真实 Linux/systemd/Nginx、生产备份和切换、公开 PWA/API/download smoke、下载页更新与观察窗口。Windows/Android 诊断制品明确不可进入 stable feed。

## 给 release agent 的下一跳

只有用户明确批准发布后才能继续：

1. 从 runtime SHA `d64b9ef85f9dea1cf2d0617cb300fa492ca1f43c` 建立新的隔离 checkout，并复核本交接的版本、默认环境与完整测试结果；不得把后续 docs-only commit 当成运行时制品 SHA，也不得复用已作废的 `865f125e8624` 候选。
2. 先按 `SHA256SUMS`、candidate manifest 和 provenance 独立复算当前候选，再执行 `npm ci`、`npm run build:web`、production-preview PWA 与完整 release gate；不得复用 Android/Desktop 覆盖后的 `dist/`。
3. 使用批准证书重建并验证 Windows/Android 正式制品；检查证书连续性、时间戳、APK/AAB 签名和 Android 实体设备。当前 unsigned 诊断制品只能用于比对，禁止发布。
4. 若包含 API，先在临时 SQLite 和展开后的发布目录启动验证；生产写入前取得并验证备份 evidence。
5. 证书、签名、目标节点、previous-stable pointer、回滚命令或健康门禁任一缺失即停止，不得绕过。
