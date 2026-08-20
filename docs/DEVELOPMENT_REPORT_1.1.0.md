# DSP极简网络 1.1.0 RuntimeWorld 2.0 开发报告

> 状态：开发完成、候选已冻结，未发布
>
> 分支：`codex/1.1.0-runtimeworld-2`
>
> Runtime SHA：`9b2c579cbe0de8848f6a4573371fd1322cec0c45`
>
> Build ID：`1.1.0+9b2c579cbe0d`
>
> Release ID：`1.1.0-9b2c579cbe0d`
>
> 线上兼容基线：1.0.47 / `aab581cf0c78e480e1d10fe4c7f91e6d6d9311b7`

本轮在独立工作树 `D:\GameDev\DSPidle2-runtimeworld-2` 完成，没有修改主工作树，没有连接生产、签名、部署、修改下载页或写回玩家原档。详细数字见 [最终证据](./feedback/2026-08-20-1.1.0-runtimeworld-2.0-final-evidence.md)，Release Agent 操作边界见 [交接](./RELEASE_HANDOFF_1.1.0.md)。

## 1. 交付结论

1. RuntimeWorld 2.0 已在 1.1.0 默认启用，Worker 持有编译式 slot、domain revision、dirty journal、传送带/生产/供电/物流/量子索引和稳定依赖；生产构建不运行 shadow 双跑。
2. GameState 继续是存档与玩法权威格式。RuntimeWorld 可丢弃、可重建，不进入 GameState、云 payload、排行榜或 IndexedDB 持久记录。
3. 命令只失效明确领域；结构变化、revision 缺口、内容注册表变化或完整性失败会重建或回退旧领域实现，不保留陈旧引用。
4. Simulation Worker 在权威状态旁准备 canonical primary/snapshot；Persistence Worker 独立执行 checksum、proof、CAS、事务提交和精确读回。自动、手动、返回菜单和生命周期 primary 意图由同一串行边界协调。
5. 两份真实档的 60 秒精确模拟中位数较冻结基线下降 47.31% / 58.28%；两档都通过 40% 最低线，B 达到 55% 正式目标，A 没有。
6. 已正式发布的 1.0.47 产品差异完整纳入，包括经典卡片、Canvas 实时 viewport、连线草稿去淡化和 PWA release-root 修复。

## 2. RuntimeWorld 架构实现

### M0/M1：观测、外壳与变化账本

- `src/game/runtimeWorld.ts` 建立稳定 slot/generation、实体/线路映射、领域 revision、dirty bitset、journal 和 adapter。
- `src/game/runtimeWorldObservability.ts` 固化默认关闭的阶段计时；诊断模式才记录 compile、patch/apply、invalidation、领域、journal、projection、main merge、paint 和保存阶段。
- `simulation.worker.ts` 持有 RuntimeWorld，按请求 revision 处理局部命令；Projection v2 保留为 oracle 和受控 fallback。
- resumable session 只在完整确定性边界提交，不向 UI 暴露半步状态；未完成 debt 保持显式。

### M2：传送带编译热路径

- 端点、端口、源/目标索引、物品路由、目标容量、预留、拥塞和公平游标进入可复用索引。
- 输入/输出阶段保持旧数组顺序、两阶段检查、尾货和多输入/多输出语义；无法证明稳定时回到完整扫描。
- 1/4/12/60/600 秒、拓扑命令、量子/传统物流和完整索引关闭 adapter 由旧引擎逐状态 oracle 覆盖。

### M3：生产与供电依赖

- 配方静态量、输入/输出、增产剂、燃料、功率因子和供电 scratch 结构按 topology/recipe/power revision 复用。
- 缺料、输出满、断电/低电、配方变化和量子边界会精确唤醒；运行状态文案不参与玩法判定。
- 两份真实档逐实体运行状态 oracle 证明无文案聚合与 `getEntityOperatingStatus()` 一致。

### M4：物流、量子与稳定岛

- 站点槽位在编译边界一次规范化并缓存；空槽规范化保持幂等，不再在第二个会话生成 `itemId: undefined`。
- 量子容量按规范十进制字符串缓存，五秒边界集中清理实际零值，保持旧状态形状和 BigInt 语义。
- 本地非量子调度使用库存、在途、预留、车辆、电力、最低载荷与公平游标组成的阻断快照；未变时只跳过已证明无结果的扫描。
- `snapshot-changed`、`cross-island`、量子边界与未知依赖均显式 fallback，并记录原因；物流互斥阶段归因覆盖 100%。
- 单核运行删除只供多核合并使用的逐行星 `totalProduced` 拷贝/差分；多 Worker 默认仍关闭。

### M5：UI 与保存生命周期

- `RuntimePrimaryPersistenceLifecycle` 统一所有 primary 保存意图，修复上层队列交叉导致的真实 CAS 冲突，不通过 revision 重写绕过保护。
- `authoritativeSavePreparation`、`simulationPreparedSaveLifecycle` 与 Persistence Worker 协作，主线程不再为自动保存完整克隆并二次解码 UI 状态。
- `RuntimePersistenceViewStore` 和通知组件隔离高频保存进度，画布运行态数据按 selector 发布；React Flow 外层节点、位置、选择、拖动和无障碍结构保持稳定。
- 只在展示内容真实变化时派生动态节点；没有扩大到未经门禁的全量 WebGL/Canvas 重写。

## 3. 1.0.47 正式基线的合入

合入提交 `07132550abd5df4bd81eb3faa40534ad6cffbf21` 以线上 runtime `aab581cf0c78...` 为事实基线：

- `classic` 卡片使用独立 `224×76` 几何并复用轻量端口；`minimal` 保持 `96×32`。
- Canvas 线路只在 viewport 坐标真正变化时同步受控属性，手势期间保持实时 imperative viewport。
- connection draft 会暂停所有旧聚焦 dim，避免建筑在连线期间变半透明。
- PWA 子资源引用相对当前 release root，根站点与 canary 路径均有单元覆盖。
- 1.0.47 正式发布记录已纳入 `docs/releases/1.0.47.md`，并明确其内容是 1.1.0 兼容基线而非新的发布授权。

1.0.46 的时间感知周期进度验证、纯挂机瞬时量快照和普通空间站合同量子交付也保留在 1.1.0 回归矩阵中。

## 4. Android 预算返修

`07132550abd5` 首次 Android 构建在菜单闭包硬预算失败：`287,658 > 286,720 B`。只在设置页使用的 `NativeUpdateCard` 被静态导入，进入了 Android 菜单启动闭包。

最终修复在 `src/components/StartMenu.tsx` 使用项目已有的 `importWithRecovery` 懒加载卡片，Suspense fallback 为空。预算没有调整；Android 最终 menu 为 286,471 B，Web/desktop 分别为 284,843 / 284,811 B。类型检查、native 24/24、桌面更新生命周期和 Android release 全构建通过。

由于运行时代码变化，`07132550abd5` 和它的 source/Web/API/Windows 部分制品全部作废；最终 runtime 固定到 `9b2c579cbe0d`。

## 5. 正确性、性能与保存结果

| 指标 | A 最终 | B 最终 | 结果 |
| --- | ---: | ---: | --- |
| 60 秒精确模拟中位 | 11,397.269 ms | 2,718.954 ms | 较 M-1 下降 47.31% / 58.28% |
| 逐秒 P95 中位 | 266.373 ms | 54.416 ms | 下降 45.59% / 66.20% |
| production-preview 自动保存 | 1,222.5 ms | 370.1 ms | 通过 2,750 / 1,050 ms 门限 |
| 画布 6 秒 P95 | 16.7 ms | 16.8 ms | 通过 20 ms 门限 |
| 运行/保存 Long Task | 0 / 0 | 0 / 0 | 通过 100 ms 门限 |

三次独立进程的 exact/gameplay hash 固定，所有样本 `invalidAmounts=0`。两份真实档原件 bytes、mtime 与 SHA-256 测前测后完全一致。

密度性能第一次最终 SHA 执行有一个 auto 子轮 P95 33.3 ms，按未修改的 21 ms 门限失败；独立新进程复跑三轮 P95 16.8/16.7/16.7 ms 后通过。失败与通过证据同时保留，没有 retry、skip 或阈值放宽。若 Release Agent 目标机复现，应停止发布。

## 6. 完整门禁摘要

- root/server `npm ci`：456 / 75 packages；两处 production audit 0 vulnerabilities；license 125 packages。
- typecheck passed。
- Vitest：190 files passed / 16 skipped；1,512 passed / 29 skipped / 0 failed。
- server 363/2 + station 3/3；ops 56/6；release-switch 29/29；native 24/24。
- durable E2E 7/7。
- Chromium：429 passed / 28 explicit conditional skipped / 0 failed（457 total，4 workers）。
- Firefox + WebKit：10/10。
- production-preview functional 34/34；PWA repeat 3/3。
- Web build：1,972 modules；startup 195,203 B gzip，menu 284,843 B，forbidden 0。
- source manifest 254/254；candidate 10/10；provenance 3/3；SHA256SUMS 12/12。

## 7. 兼容边界

- GameState v47、save envelope v2、cloud schema v8、SQLite layout v3、IndexedDB records 不变。
- v1～v47 迁移、普通/速通隔离、checksum、backup、CAS、fencing、精确读回和云正文协议继续存在。
- RuntimeWorld 构建失败、内容 fingerprint 变化、revision 缺口或领域完整性失败都保留旧引擎 fallback；没有删除 Projection v2 或 legacy oracle。
- durable WAL、多 Worker、分块本地存储和 WASM/Rust 都没有因 1.1.0 默认启用。
- 当前生产仍为 1.0.47；代码回滚只允许切换不可变代码，不得恢复或降级数据库。

## 8. 制品与剩余门禁

不可变 bundle 位于 `D:\GameDev\DSPidle2-runtimeworld-2\artifacts\release-bundle\1.1.0-9b2c579cbe0d`，包含 source/Web/API、Windows unpacked、Android APK/AAB 和四份内嵌元数据，共 10 个文件、170,457,946 bytes。candidate aggregate 为 `18e0c471294a70bd01e1f7454fac7d643746792d274af00e18f89d010d3751eb`。

Windows Authenticode 为 `NotSigned`；Android APK 明确 `DOES NOT VERIFY`，AAB 签名条目 0。因此当前原生包只能用于诊断比对，不能进入 stable。

未验证项：正式签名与证书连续性、Android 实体设备、低配 Windows 长时趋势、Linux/systemd/Nginx、生产备份/容量/原子切换、公网 PWA/API/download smoke、下载页与观察窗口。以上均需要新交接、用户明确发布授权和 Release Agent 独立证据。
