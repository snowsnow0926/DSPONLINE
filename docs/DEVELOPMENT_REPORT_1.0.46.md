# DSP极简网络 1.0.46 发布阻断返修与候选重建审计报告

审计日期：2026-08-19

状态：发布前开发门禁已完成，未发布。本轮没有访问生产节点、生产数据库、账号、证书或签名密钥，也没有执行部署。两份玩家存档仅在本机临时浏览器与内存中做只读输入和本地 IndexedDB 验证，未提交 Git、未复制进制品、未输出正文。

## 结论

1.0.46 已解决本轮最主要的阻断：普通构建不再默认运行 1.0.44 的 durable recovery-head/WAL 协调器，而是恢复到 1.0.43-compatible 的 verified-primary 保存路径。模拟 Worker 先给出权威检查点，保存 Worker 再按既有 writer lease、backup、checksum 和逐字读回合同提交。自动保存前正在运行的模拟在保存期间和完成后都保持运行，玩家主动暂停则保持暂停。

durable WAL 没有被删除，但只允许通过显式开发变量启用。它的 finalize、T1、recovery-head rollover 和 Worker 重建故障都保留完整回归，防止以后继续开发时再次引入“durable 模拟 Worker 不可用，已暂停；刷新后从 recovery 精确恢复”的永久阻断。

手机连续拉线也完成重构：next-mobile shell 只挂载一个非模态、可折叠的底部操作面；全部候选可滚动查看、按最新优先显示，并可定位或移除任意一条。重复、已有线路、不兼容或缺料点击只产生短暂反馈，不会污染此前有效候选；最终提交仍由领域层严格原子复核。

画布展示现已从一个混合开关拆成三个独立设备偏好。玩家可以固定完整、中等或一行卡片，也可以独立决定重叠位置显示数量标记、代表卡或全部卡片，以及普通选择/悬停是否展开。默认数量标记会在每个重叠组留下“层叠图标 + 数量”，不再让建筑位置完全消失；它在低缩放下维持可触控的屏幕尺寸，点击后展开并选择代表建筑。

最后一轮真人反馈还定位到一个独立根因：画面当时仍处于“线路网络聚焦”检查状态，旧逻辑把不属于该网络的节点统一加上 0.18 透明度，而选中/悬停展开没有覆盖这个 dim class；LOD 从一行/中等切到完整时又未给 React Flow wrapper 提供新档位初始尺寸，测量窗口会把 wrapper 暂时设为 `visibility:hidden`。鼠标移到下一个节点后，前一节点重新进入重叠隐藏，因此视觉上就是“悬停哪个哪个消失”。同时，这些几乎透明的节点仍是 `draggable/nopan`，密集区域会截获画布拖动，造成卡死感。现在交互目标不再继承 dim，LOD 均有确定初始几何；上下文节点降为可辨识的 0.5 透明度且不再阻断画布平移，建筑或空白点击会退出临时线路聚焦。

随后“放置/拉线后画布卡死、视角外建筑不显示、小地图不移动、框选和放置坐标失效”又暴露了另一条状态脱节：React Flow 手势中的 `onMove` 已经更新 CSS transform 和线路 Canvas，但虚拟节点矩形、密度展示 zoom 与 CanvasMiniMap 仍等到 `onMoveEnd` 才发布；节点拖动触发的自动平移不保证产生该结束事件。虚拟窗口因此停在旧世界坐标，屏外节点被继续卸载，所有依赖当前 transform 的交互看起来一起失灵。修复后，手势中以 120 CSS px 阈值和 160 px overscan 发布虚拟窗口，zoom/节点发布进入 transition；小地图用单次节点遍历并按 80 ms 节流实时重绘，结束时必定补最终帧。回归在 pointer 尚未松开时检查小地图、跨旧窗口拖动建筑、框选、选中展开和移动后放置坐标。

用户最终给出的“只要切换到空间站再切回来，工厂建筑就无法移动和拉线”还有更直接的独立根因：工厂和空间站曾处于同一个 `ReactFlowProvider` store。空间站挂载时的 StoreUpdater 用空间站节点、边和视口覆盖工厂 store，离开时清理又重置同一 store。修复为给空间站嵌套独立 provider 与固定 flow id，二者不再共享节点仓、手势状态或 viewport。生产预览同时发现直达 `/station/<id>` 时相对 `./assets` 会解析到 `/station/assets/*` 并白屏；Web 资源与 manifest 现使用站点根路径，Desktop/Android 仍保持相对路径。

旧候选 `865f125e8624` 的发布门禁失败不是产品进度真实倒退。失败时 aria、可见文字与 fill 始终一致，问题在旧 E2E 用固定“下降至少 50 才算回绕”判断模 1 进度；Playwright 延迟跨过完整周期后继续前进时，合法净下降可以小于 50。新验证器在浏览器内连续采样并记录 `performance.now()`，用弧形熔炉磁铁配方的 `2/3 cycle/s` 与权威发布窗口展开完整周期；自然回绕必须出现，无法由时间解释的非回绕下降仍失败。目标用例单 worker 连续 20/20，没有 retry、skip 或阈值放宽。

截图中的纯挂机负数来自呈现层把上一宏观桶的瞬时戴森功率变化率外推到下一次 30 秒提交。戴森功率与轨道人口会在吸收、过期等边界真实升降，不能作为累计计数线性插值。现在只有白矩阵、火箭、吸收帆、结构点和活动交付按非负速率插值；瞬时字段只显示最后提交快照，功率副文案明确为“已结算快照 · 30 秒更新”。

空间站前三个普通任务无法量子交付则是渠道匹配错误：`terminal` 要求在 UI 和领域层同时排除了 `quantum`。修复后玩家确认的量子扣除可满足所有普通任务要求，指定来源只继续约束自动轨道终端；扣库存与推进任务仍在同一状态变更中完成。另一个 4-worker 重复失败最终证明是画布真实竞态：上下文卡 hover 视觉展开后错误恢复 `draggable`，pointer-enter 与 pointer-down 会随机选择节点拖动或画布平移；现在视觉保护与交互权限分离，专项连续 20/20。

## 最终设计边界

1. **默认保存路径回到稳定协调器**：缺失、关闭或错误设置 durable 环境变量时均选择 1.0.43-compatible verified-primary；打开旧玩家档不会隐式启用 durable。空间站 v46 bridge 也强制使用稳定路径。
2. **两种编辑设置语义分开**：默认保护模式拒绝保存窗口内的玩家编辑，但不暂停模拟、不回滚保存前进度；实验性开关开启时，已接受操作保留，保存失败仍可继续并立即导出。
3. **durable 只做显式验证且可同页自愈**：T0、finalized/pending intent、T1 和 recovery head 保持严格身份与 revision 绑定；新 Worker 清除旧 disabled latch，暂停后可同页继续。
4. **纯挂机保持原子终态**：恢复日志、宏观进度、主存档验证与 Worker 接管必须全部完成后才清理；失败不伪装为成功，不删除当前进度，并保留导出边界。
5. **临时 UI 不进入存档**：连续拉线候选、展开状态、临时提示和定位状态均不新增 GameState、云同步、迁移或 IndexedDB 字段。
6. **画布三类决策互不覆盖**：基础卡片只决定普通卡片层级，重叠处理只决定同坐标组如何留下入口，交互展开只决定普通选择/悬停/聚焦；拖动、采矿和连线目标仍可按安全规则强制完整显示。三项均只写本机 localStorage。
7. **密集保护保持可恢复**：玩家选择“完整 + 全部卡片”时，视口节点超过 480/1,000 会统一改用中等/一行基础卡，并在界面明确显示“密集保护”；单个选中或悬停目标仍完整展开，不更改设置值，也不写入存档。
8. **视口发布只有一个实时坐标真相**：节点虚拟化、线路端点、放置坐标、框选和小地图都从同一实时 React Flow transform 派生；节流只减少重绘频率，不允许把最终视口留在旧值。
9. **空间站画布拥有独立 store**：空间站往返、缩放、直达和卸载不能改变工厂节点仓、选择、连接、拖动状态或 viewport；Web history route 的静态资源必须从站点根解析。
10. **周期进度由时间展开而非下降阈值判定**：同一页面时钟、已知周期速率与权威发布窗口共同决定合法完整周期；显示源必须一致，非回绕下降仍为硬失败。
11. **纯挂机只插值累计量**：瞬时戴森功率和轨道人口只接受宏观桶权威快照；累计计数忽略负速率，不允许呈现层制造倒退。
12. **量子交付是显式人工备用渠道**：普通合同可由玩家确认后从共享量子库存完成，来源限制仍属于自动终端合同；不新增存档字段或迁移。

## 两份真实玩家存档的只读验收

以下真实附件验收完成于上一 clean runtime `865f125e8624`，用于证明未改存档格式和画布/空间站兼容基线；本轮 `d64b9ef85f9d` 没有再次读取或复制玩家附件，也不把这部分历史证据冒充最终 SHA 的新执行结果。

| 输入 | 精确字节 | SHA-256 | 第一次自动保存 | 第二次自动保存 | 结果 |
| --- | ---: | --- | ---: | ---: | --- |
| `dsp-idle-save-2026-08-14.json` | 36,704,109 | `cd2356ea2b9a90a47cfa32ed9533e7056bfc4202f6af777fc4f3b98faa9a81b1` | 6,441 ms | 4,943 ms | 两次均 Worker active、`paused=false`，刷新后主档仍为运行态 |
| `dsp-idle-local-backup-2026-08-17 (1).json` | 11,723,913 | `f832f7fb909bad1981cd8476f28dcf0f1026c62955d822904218cee270a43d2a` | 1,087 ms | 835 ms | 两次均 Worker active、`paused=false`，刷新后主档仍为运行态 |

两份源文件的 bytes、mtime 与 SHA-256 在测试前后完全一致。专项还断言自动保存期间没有任何 `paused=true` 或 Worker fallback 状态变化，没有 durable/recovery 刷新提示，backup 与重载后的 primary 均通过完整检查。

## 手机连续拉线与运行时错误修复

- next-mobile shell 不再挂载桌面 `.batch-connection-panel`，不是依赖 CSS 隐藏；收起底栏位于底部导航和 safe area 上方，展开列表没有 backdrop，不阻断继续点地图。
- 移除 `slice(0, 5)`；6、10、50、100 条候选均完整渲染并可滚动。候选使用物品、建筑名称和目标端口作为主要识别，支持“定位”和“移除”。
- “撤销”只移除最近候选；“清空候选”与“退出连续模式”独立。重复或本次无效点击不新增、不扣料，也不禁用此前有效候选。
- 最终原子复核失败会把原因映射到候选索引，保持零创建、零扣料；领域层对畸形重复请求仍严格拒绝。
- `isDynamicImportFailure()` 不再把所有 `TypeError` 归类为 chunk 故障，只识别真实 module/chunk/CSS-chunk 加载签名。普通 React 运行时错误使用独立文案、稳定脱敏诊断码和 component stack，不记录错误正文、props、存档、云数据或玩家隐私。

## 画布展示与重叠建筑修复

- 基础卡片新增固定“中等”，形成自动、完整、中等、一行四档；自动档仍按视口原始可见节点数和 140/100、480/360 两组迟滞阈值切换，固定档不再被阈值覆盖。
- 重叠处理提供数量标记、代表卡片、全部卡片。默认数量标记每组只挂载一个 `88×44` 点击入口，可见胶囊约 `80×30`，只显示层叠图标、数量和聚合告警；完整“叠放 N”保留在无障碍名称与悬停说明中。其屏幕尺寸用 inverse zoom 补偿，低缩放不再退化成难以点击的小字。
- 交互展开提供仅选中、悬停也展开、保持基础。普通 focus/hover 不再让数量标记闪退；选中、采矿、拖动和连线 source/candidate 仍解除标记并展示真实建筑卡。React Flow 节点层级明确分为普通 0、重叠 halo 6、交互展开 20、选中 30，CSS 不再用 `!important` 把选中节点压回 halo 层；展开后的卡片通过实际屏幕命中测试验证可见且可交互。
- 线路网络、生产链、任务和线路追踪的 dim class 在派生时会避开选中/悬停/安全交互目标。上下文节点透明度从 0.18/0.24 提升到 0.5，并在 dim 状态取消 React Flow `draggable/nopan`；从其卡片区域拖动可平移画布，点击建筑或画布可退出聚焦。
- 每个 LOD、数量标记和隐藏代理都提供与档位一致的 `initialWidth/initialHeight`；一行/中等切完整时不再经历 React Flow 因未知测量而设置的隐藏帧。
- 一行生产卡优先显示配方与产物，例如“金伯利矿提炼 · 金刚石”；特殊建筑没有配方/产物时回退建筑名称，不再出现空无障碍名称。
- “完整 + 全部卡片”增加 480/1,000 视口节点安全阈值，分别统一使用中等/一行基础卡。设置值保持不变，状态栏和设置页显示密集保护，选中/悬停仍是完整卡。
- 展开模式只让单个 halo/marker 节点持有成员数组，其他成员共享 membership token，不为每个成员复制整组引用；4,213 个 exact-overlap 的派生仍保持线性边界。
- 普通平移和缩放现在持续刷新世界视口矩形，固定中等与自动密度不会在 Fit View 或普通拖动画布后把屏内节点误判为视口外。
- 节点拖动/放置自动平移也在 `onMove` 阶段发布虚拟矩形，不再依赖可能缺失的 `onMoveEnd`。发布用 overscan 保留边缘节点，小地图以 80 ms 上限重绘并在结束时强制精确同步；节点派生的 no-op 更新直接复用旧状态，避免为每个手势帧重算整棵重卡树。
- 变换中的 React Flow viewport 已移除 `contain: paint`，避免线路仍在但节点层被错误裁空；一行卡及 wrapper 固定为 `96×32`，中等、数量标记和完整卡的裁剪/线路几何也按当前档位尺寸计算。
- fully-deferred 空白视角保留四个边界恢复节点，Fit View 不再因节点仓为空而失效；标准 SVG MiniMap 与低频 CanvasMiniMap 均可点击定位世界坐标。
- 本机键为 `dsp-idle-network.ui.canvas-detail.v1`、`dsp-idle-network.ui.canvas-overlap.v1`、`dsp-idle-network.ui.canvas-interaction-detail.v1`；缺失/损坏分别回退 `auto`、`marker`、`selected`，不新增任何存档字段。

## 本地验证结果

除表中明确标为“上一候选兼容基线”的真实附件项外，以下数字均来自独立 detached clean worktree 的固定运行时候选 `d64b9ef85f9dea1cf2d0617cb300fa492ca1f43c`。

| 范围 | 结果 |
| --- | --- |
| TypeScript | `npm run typecheck` 通过 |
| 发布阻断专项 | 周期进度目标用例单 worker 20/20；网络聚焦真实指针专项 20/20；周期验证器、纯挂机呈现和空间站量子交付均有单元覆盖 |
| 全量 Vitest | 173 files passed / 7 conditional skipped；1,434 passed / 20 skipped / 0 failed |
| 服务端与空间站 | server 363 passed / 2 skipped；station 3/3 |
| 运维与切换模拟 | ops 56 passed / 6 Linux-only skipped；release switch 29/29 |
| 原生静态安全 | 24/24 |
| durable WAL | 7/7 |
| 默认 runtime protocol | 5 passed / 3 条真实大档条件跳过；相同三条在 durable 大档模式 3/3 |
| 默认保存进度 | 2/2；保护模式和实验模式分别验证 |
| 纯挂机教程与宏 | 20 passed / 1 条真实夹具条件跳过 |
| 手机连续拉线 | 21/21，含 6/10/50/100 候选、390×844、360×640、844×390 与 80%～200% 字体 |
| 完整 Chromium | 最终固定候选 426 passed / 26 explicit conditional skips / 0 failed（452 总项，4 workers，6.3 分钟） |
| 空间站专项 | production preview 7/7；Firefox + WebKit 14/14；新增普通合同量子交付 E2E 通过 |
| Firefox / WebKit 通用夜间项 | 2/2 |
| Production preview | 功能门禁 31/31，PWA 3/3；标准隔离密度 1/1（内部 9 轮）与连接性能 1/1。额外密度 `repeat-each=3` 为 2 pass / 1 原阈值 fail，失败子轮 P95 27.8 ms、max 34.8 ms，完整记录保留 |
| 真实存档专项（上一候选兼容基线） | 两份档的自动保存、画布核心、选中/悬停、实时虚拟化平移和空间站往返通过；本轮未再次读取附件 |
| 匿名 v47 发布夹具 | 12/12 |
| 许可证与依赖 | 125 个运行时包一致；root/server `npm audit --audit-level=high` 均 0 漏洞 |
| Web 构建 | 1,962 modules；startup 194,810 B gzip（JS 101,823 B、CSS 92,987 B、最大 JS 58,974 B）；menu 282,321 B gzip；forbidden startup modules 0；Build ID `1.0.46+d64b9ef85f9d`；生产直达空间站、根 assets 与 manifest 均通过 |
| 不可变制品 | source manifest 251/251；Web 155/155；API 166/166；candidate 10/10；provenance 3/3；SHA256SUMS 12/12；Windows/Android 明确未签名 |

Chromium 的条件跳过均由用例内显式条件控制，包括未提供的真实夹具、durable-only 与 production-preview-only 场景；它们不是失败。开发 E2E 的 `/api → 127.0.0.1:65534` 拒绝是线上 API 隔离，不是产品故障。

## 审计中额外处理

- 把经典进度专项从 Playwright 外部定时轮询改为浏览器内连续采样；独立纯函数按实测时间展开模 1 周期，并用单元测试证明 89→59 可在足够时间内是前进、相同下降在短间隔仍是非法倒退。
- 纯挂机呈现新增字段语义边界：累计字段可插值，瞬时字段只读权威快照；负速率不能降低累计显示。空间站合同渠道匹配则把人工量子备用渠道与自动终端来源限制分开。
- 完整 Chromium 重压中额外发现并修复上下文节点 hover 恢复 `draggable` 的产品竞态；专项与全量均使用真实鼠标命中，不以 `force` 点击绕过页面几何。
- 修正保存失败 E2E 的注入位置：现在拦截真正写主档的 authoritative persistence Worker `commit`，并正确返还 transferable payload；已证明连续 quota 失败时实验性编辑仍保留、可导出、刷新后精确恢复且不暂停。
- 修正 production Web 构建门禁：`npm run build:web` 强制 Web 平台，release gate 在构建后执行 PWA 生命周期，避免 Android/Desktop 的旧 `dist` 被误当 Web 候选。
- 更新匿名 v47/空间站发布夹具及服务端持久化原子性回归；根与 server 高危依赖审计均为零。
- 修正 PWA 离线测试的旧 document listener 竞态：重载前用 context init script 在新 document 安装状态监听，并主动请求 Service Worker 状态；产品缓存逻辑未为测试放宽。
- 修正空间站 React Flow store 隔离和 Web history-route 资源根路径；生产预览不再因 `/station/assets/*` 404 白屏，空间站卸载也不会清空工厂交互状态。
- 保留开发服务器偶发的 `ResizeObserver loop completed with undelivered notifications` 为非阻断诊断；候选稳定性专项没有 pageerror、dynamic-import-fatal 或 runtime render error。后续若处理，应先在 production preview 独立采样，不能用吞错掩盖真实异常。

## 残余风险与优化方向

1. durable WAL 仍是开发实验路径，发布构建不得设置 `VITE_DURABLE_RUNTIME_RECOVERY=true`；若未来要重新默认启用，必须重新完成真实大档、故障注入和跨浏览器全矩阵。
2. `FactoryRuntime` 约 695 KB minified，主 CSS 约 608 KB，Vite 仍报告大 chunk 警告。后续优先从 `App.tsx` 拆出 persistence lifecycle、Worker lifecycle 与 batch-connection presentation，但不得改变权威状态边界。
3. Android/Windows 正式签名、实体设备、Linux systemd/Nginx 备份与切换、线上 smoke、下载页更新均未执行，不能视为已发布或已签名。
4. 固定源码、候选归档、manifest、SBOM 与 provenance 只证明开发侧输入与输出一致；正式证书、生产备份、目标节点与受保护切换仍属于 release agent。
5. 合成 506 个重卡的固定“完整”或显式“展开全部”override 仍会产生数百毫秒到约 1.2 秒的帧；自动档最终隔离三轮 P95 为 7.1～20.9 ms、max 21.0 ms、没有 >50 ms 帧。“完整 + 全部卡片”已有 480/1,000 密集保护，后续仍应拆分重卡内容。
6. production 功能与性能必须分进程。额外 `repeat-each=3` 压测有一次 auto 子轮 P95 27.8 ms 超过原 `<=21 ms` 预算（max 34.8 ms、无 >50 ms），其前后隔离执行通过。这个结果按失败保留，不能用 retry、删除覆盖或阈值放宽处理；若 release agent 的目标环境可重复超限，应停止候选。

## 发布交接原则

开发侧已从干净固定 SHA `d64b9ef85f9dea1cf2d0617cb300fa492ca1f43c` 生成并复验 Web/API/source、未签名原生诊断制品、10 文件 candidate manifest、SBOM 与 3-subject provenance；Release ID 为 `1.0.46-d64b9ef85f9d`，完整路径和哈希见发布交接。旧 `1.0.46-865f125e8624` 因发布门禁阻断作废，更早的 c24 候选继续作废。运行时内容未命中当前本机路径、截图名或私钥/token 模式；source archive 仅内部交接。release agent 仍必须独立复算，并在签名、目标节点、备份 evidence、回滚指针和公开 smoke 齐备后才能发布；本报告本身不授权部署。
