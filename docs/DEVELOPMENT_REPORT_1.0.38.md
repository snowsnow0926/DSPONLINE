# DSPidle2 1.0.38 开发与发布前验证报告

> 日期：2026-08-11
> 固定源码：`351c649af9eedb22f56f47a6cd06c14cedce6221`
> Build ID：`1.0.38+351c649af9ee`
> 开发分支：`codex/1.0.38-performance-resource-cap`
> 开发报告时点生产：`1.0.36+e0ad49062fa3`
> 状态：开发报告保留发布前事实；该候选随后已由 Release Agent 正式签名并发布，生产结果见 [1.0.38 正式发布记录](./releases/1.0.38.md)

## 1. 结论

1.0.38 已完成本批 P0/P1/P2 安全范围内的实现、1.0.35～1.0.37 全量回归、真实 23.5 MB 终局存档只读验证、clean Web 构建、source manifest、Web/API 归档、Windows unpacked 与 Android APK/AAB 未签名诊断制品。

本版达到的主要结果：

- 30 天纯挂机真实档总耗时由本批优化前 `37.24s` 降到 `14.36～14.78s`，源状态、路线、实体/线路数量、科研和重载完整性保持有效。
- 23,531,371 字节旧 v46 存档重新保存为 17,920,539 字节，减少 5,610,832 字节（23.84%）。
- 三次独立 60 秒精确模拟为 13.500～13.817 秒，中位 13.572 秒；完整状态哈希固定 `b9bb64ab`，玩法哈希固定 `156870f3`，非法数量为 0。
- 普通模式单个健康单极磁石矿脉可在持久快照和双重确认后补到两个；不增加库存、累计产量、矿机或既有矿脉储量，速通和重复执行被拒绝。
- 全量门禁 0 失败：Vitest 950/18，Playwright 280/11，server 70/2，ops 6/6，native 8/8，生产依赖审计 0。

没有达到或没有证明的内容：

- 60 秒精确模拟没有达到原建议的 10～11.5 秒目标；相对本批同机前测 14.518 秒，中位收益约 6.5%，不能宣称总精确模拟提升 15%～25%。
- 没有把持久存档改成不透明二进制，也没有拆分一个会破坏旧客户端读取的全新拓扑格式；体积目标改用兼容的稀疏 v46 JSON 达成。
- 没有低配 Windows、Android 真机、锁屏后台一小时、覆盖升级或正式签名证据；Canvas 数据仅来自本机 Chrome 有界矩阵。

## 2. 修改文件列表

固定源码相对开发起点 `d490cdb05e…` 共修改/新增 73 个文件；最终交接文档在固定源码之后单独提交，不进入 Build ID。

### 产品与领域实现

- `src/App.tsx`
- `src/components/CanvasBeltLayer.tsx`
- `src/components/OperationsWorkspace.tsx`
- `src/components/ReleaseNotesDialog.tsx`
- `src/components/StartMenu.tsx`
- `src/game/engine.ts`
- `src/game/offlineSimulation.ts`
- `src/game/offlineSimulation.worker.ts`
- `src/game/pureIdleMacro.ts`
- `src/game/pureIdleMacro.worker.ts`
- `src/game/pureIdleMacroClient.ts`
- `src/game/pureIdleMacroValidation.ts`
- `src/game/quantumLogisticsNetwork.ts`
- `src/game/resourceIntegrity.ts`
- `src/game/save.worker.ts`
- `src/game/saveEnvelopeIntegrity.ts`
- `src/game/saveProjection.ts`
- `src/game/saveTransfer.ts`
- `src/game/storage.ts`
- `src/i18n/legacyTranslations.ts`
- `src/styles.css`

### 新增或扩展测试

- `src/game/resourceIntegrity.test.ts`
- `src/game/saveCompaction.test.ts`
- `src/game/saveTransfer.test.ts`
- `src/game/v138Performance.test.ts`
- `src/game/workerImportBoundary.test.ts`
- `src/game/pureIdleMacro.test.ts`
- `src/components/ReleaseNotesDialog.test.ts`
- `tests/e2e/v121-content-pack-workers.spec.ts`
- `tests/e2e/v130-offline-timewarp-real-save.spec.ts`
- `tests/e2e/v132-pure-idle-macro.spec.ts`
- `tests/e2e/v138-release.spec.ts`
- `tests/e2e/game-flow.spec.ts`
- 其余 31 个既有 E2E 文件只把发布说明已读 ID 机械更新为 `2026-08-11-v1.0.38`，没有改变场景逻辑。

### 版本与规范

- `package.json`、`package-lock.json`
- `android/native-version.properties`
- `docs/ARCHITECTURE.md`
- `docs/GAMEPLAY_SYSTEMS.md`
- `docs/NATIVE_APPLICATIONS.md`
- `docs/PROJECT_STATUS.md`
- `docs/TESTING_RELEASE.md`

用户原有的两份 `docs/feedback/2026-08-10-*.md` 保持未跟踪、未修改、未提交。

## 3. 存档结构变化

协议版本没有变化：

| 层 | 1.0.38 | 变化 |
| --- | --- | --- |
| GameState | v46 | 不变 |
| save envelope | v2 | 不变 |
| 本地模式 | `normal` / `speedrun` | 不变 |
| 云 schema | v7 | 不变 |
| SQLite layout | v2 | 不变 |
| 排行榜协议 | 既有服务端校验 | 不变 |

新写出的 v46 JSON 采用稀疏持久投影，只省略当前 v46 迁移会精确重建的字段：

- 实体的缺省锁定、电网、优先级、零机器/矿机、零进度、零供电输入输出、零物流诊断和空运行时映射。
- 传送带的默认并联数、等级、分拣器、堆叠、优先级、监视、零进度、零累计、零拥堵、零流量和 `auto` 路由模式。
- 运行时量子流量和生产历史诊断仍不落盘。

不会省略：非零输入/输出、托盘库存、生产/矿脉余量、在途路线、非零线路状态、蓝图、物流槽位、量子库存、科研、戴森和模式字段。显式值为 0 的物资键如果会影响持久语义也会保留。

## 4. 旧存档迁移方案

- 旧裸状态、旧 envelope 和未压缩 v46 继续走原有连续迁移；缺少 `mode` 的旧档仍只迁移为 `normal`，不会自动获得速通资格。
- 稀疏化只在下一次成功保存时发生；写入前继续保留既有主档/备份和模式迁移备份，写入后必须精确读回。
- 迁移幂等：同一稀疏 v46 重复载入、保存不会继续复制资源节点或改变模式。
- 旧未压缩 v46 与稀疏 v46 的下一次精确模拟状态哈希一致；真实 23.5 MB 档稀疏重载通过 checksum 和 v46 校验。
- 导入失败、内容包缺失、校验错误或本地容量不足时不写入现有主档。
- 本版没有数据库 migration；代码回滚不需要数据库降级，也不能以删除缓存替代恢复。

## 5. P0：主线程与 Worker 重复复制

### 权威序列化

- `saveTransfer.ts` 使用一次权威 state JSON 序列化，通过 `TextEncoder.encodeInto` 写入精确大小的 `ArrayBuffer`。
- Worker 同时返回 v2 state checksum、payload FNV 哈希、字节长度和摘要；主线程先验证缓冲区长度/哈希，再解码。
- 主档、已验证手动槽位和快照均在 `save.worker.ts` 内完成稀疏投影和校验；同步 API 仍是 Worker 不可用时的兼容回退。
- 云上传 Worker 返回已验证稀疏 payload，主线程不再重新解析刚生成的 20 MB 结果。
- 普通离线 Worker 返回完整运行态的单一可转移缓冲区，避免 structured clone。

### 纯挂机停止

旧路径在 Worker 内“稀疏序列化→解码→解析迁移”，再 structured-clone 完整状态回主线程。新路径由 Worker 对完整运行态做一次权威序列化和哈希，转移缓冲区后主线程只解析一次；正式落盘再由保存 Worker 使用 17.9 MB 稀疏格式。

真实档结果：

| 阶段 | 优化前 | 1.0.38 |
| --- | ---: | ---: |
| 30 天纯挂机总时间 | 37.24s | 14.36～14.78s |
| 初始化校准 | 未单列 | 12.90～13.48s |
| 最终结算/传输/解析 | 约 22.74s | 1.46～1.49s |
| Worker 最终化 | 未单列 | 1.32～1.34s |
| 运行态传输字节 | 对象 clone | 23,314,461 |

相对本批失败前测，总时间下降约 60%～61%。该数据不等同于所有设备峰值内存下降比例；Chrome 没有稳定可比较的强制 GC 峰值，因此不报告未经测量的 25%～40% 数字。

### Worker 依赖边界

生产 build 曾捕获 `save.worker → storage → save.worker` 循环，最终通过 `saveProjection.ts` 和 `pureIdleMacroValidation.ts` 分层修复。`workerImportBoundary.test.ts` 固定验证 Worker 纯模块不能静态导入含 Worker URL 的 `storage.ts`。最终 clean Vite build 通过。

## 6. P1：传送带、生产、电力和量子物流

### 传送带

- 源/物品组缓存稳定线路顺序。
- 持久运行时复用候选对象、源可用量账本、目标容量账本和结算条目，使用 epoch 清理而不是每步重新分配。
- 线路结构变化才重建组；legacy 无索引路径继续作为 oracle。
- 四向分流、混带、优先级和持久线路顺序没有改写。

### 建筑生产

- 现有 `machineCount` 聚合继续使用“整数批次 + 小数余量”，不按堆叠台数循环。
- 复用配方基础量、喷涂成本、发射能耗、矩阵标记和阶段倍率。
- 每个建筑的 inputs/outputs/progress/增产余量仍独立更新；矩阵、喷涂、副产物、液体和递归制造没有改成只比较总量。

### 射线接收与电力

- 电网覆盖拓扑按网格计算一次，优先级分配改为单次分区。
- 戴森发电快照按星系复用；射线接收器仍逐实体保留效率、临界光子和发电修正。

### 量子物流

- 静态量子站、上传/下载槽位、塔/采集器堆叠和带宽拓扑进入运行时索引。
- 已归一化的 Worker 私有网络允许原地结算；公共 API 默认仍返回不可变结果。
- 供需、优先级、库存、供电和线路变化继续触发动态脏标记；量子库存和运输汇总不逐船伪造。

### 实测

同一 23.5 MB 档三次独立 60 秒精确模拟：

- 13.500 / 13.572 / 13.817 秒，中位 13.572 秒。
- 本批同机前测 14.518 秒，中位约下降 6.5%，范围约 4.8%～7.0%。
- 中位阶段：生产约 2.958s、传送带约 5.370s、物流约 1.267s、量子约 0.479s、电力约 2.098s。
- 电力阶段相对单次前测存在噪声回升，不能声称每个模块都达到建议降幅。
- 60×1 秒玩法哈希与一次 60 秒一致；缓存、在途、量子库存、矿脉和累计产量完整校验通过。

## 7. P2：存档与 Canvas

### 存档体积

真实档：

| 指标 | 字节 |
| --- | ---: |
| 原始 | 23,531,371 |
| 1.0.38 稀疏 envelope | 17,920,539 |
| 减少 | 5,610,832（23.84%） |

达到建议的 20%～35% 目标。没有引入紧凑二进制格式，因为旧版本回退、手工导出可读性和云端 v7 兼容优先级更高。

### Canvas

线路物品/颜色映射只依赖 `planetId + topologyRevision`，运行态线路数组刷新不再重建映射。1,600 条线、80 个建筑、200% 字号和极限模式的本机 Chrome 有界矩阵覆盖：

- 线路选择：P95 7.1ms，最大帧 97.2ms。
- 暂停拖动：P95 13.9ms，最大 34.8ms。
- 暂停缩放：P95 7ms，最大 27.9ms。
- 建筑选择/打开检查器：P95 20.8ms，最大 76.5ms。
- 运行拖动：P95 7.1ms，最大 14ms。
- 390×844 移动窗口：P95 34.8ms，最大 139ms。

这不是 Android 真机或“所有设备稳定 60 FPS”的证据。

## 8. 单极磁石一→二功能

领域常量：

- 新节点固定 ID：`ashen_unipolar_secondary`。
- 单极磁石矿脉硬上限：2。

资格门禁：

- 明确普通模式且速通未激活。
- 游戏暂停。
- 全档恰好一个健康规范单极磁石节点，星区目录声明一致。
- 新 ID 不冲突，当前数量未达到上限。

执行流程：预览→第一次确认→保存“增加第二个单极磁石矿脉前”持久快照→生成带候选哈希/确认令牌/回滚审计的候选→第二次确认→主档验证写入成功后才更新 UI。

新增节点是确定性的有限资源点，矿机数 0、机器数 0、输入空、输出缓存 `unipolar_magnet: 0`、进度和累计生产均为 0。它不会修改原节点储量、托盘、建筑缓存、`totalProduced` 或排行榜状态。

历史超过两个节点的旧档仍可读并显示审计问题，不自动删除玩家资产。该功能不处理真实玩家个案，也不替代 1.0.37 的缺失规范节点人工修复流程。

## 9. 纯挂机计时与资源结算说明

1.0.38 没有重写 1.0.35 的结算口径：

- `[lastSettledAt, currentTargetTime]` 前向游标仍是唯一可提交区间。
- 当前运行字段与历史累计字段继续分离。
- 停止、暂停恢复、页面重进、刷新、云恢复和快速点击不能重复提交同一区间。
- 普通模拟、离线和纯挂机仍复用同一采矿、输出缓存、传送带、物流/量子容量和有限矿脉扣除路径。
- 满缓存或堵塞时不能先扣矿脉再静默丢失产物；本版 Worker 传输失败会丢弃候选，不会补物资或跳过产量。

本版改变的是候选状态的序列化与传输方式，不改变倍率、矿脉扣除公式或平衡。完整 1.0.35 回归随 950 项 Vitest 和 280 项 E2E 全量执行；30 天真实档源状态保持不变，候选完整重载后才可提交。

## 10. 普通/速通存档隔离说明

- `GameState.mode`、envelope `mode`、本地槽位/快照命名空间、云 `mode + slot`、导入校验和排行榜门禁没有变化。
- 保存 Worker 新增 `slot` 参数，保证后台序列化的手动槽位仍写入真实数字槽，不退回 `main`。
- 普通和速通同槽的自动保存、上传、下载和删除继续独立。
- 速通存档不能使用单极磁石扩容，也不能提交普通/实验/近似状态。
- 本版没有修改服务端 schema、排行榜规则或任何历史成绩。

## 11. 本地与云兼容性

- 本地：主档、备份、三个手动槽位、自动/手动快照均保留原键和 envelope v2；Worker 回退同步路径仍可用。
- IndexedDB：没有版本升级；精确字符串读回仍是成功条件。
- 云：schema v7 和 30 MiB 明文安全边界不变；真实 23.5 MB 上传 E2E 使用 17,920,539 字节 payload 通过校验，普通/速通 mode + slot 仍由服务端隔离。
- 导入导出：格式版本、模式、槽位、时间和 checksum 仍在 envelope；模式不匹配或 checksum 失败不写盘。
- 回滚：1.0.36/1.0.37 的 v46 迁移按相同默认值恢复稀疏字段；正式灰度前仍要求 Release Agent 用真实副本做旧客户端兼容复验。

## 12. 新增测试与最终结果

### 新增专项

- transferable save：单次权威 checksum、Unicode、截断/篡改拒绝、模式/槽位、可信稀疏迁移、完整运行态单解析。
- save compaction：默认字段省略、非零状态保留、旧未压缩 v46、下一步精确哈希、真实档体积/重载。
- persistent batching：传送带候选/账本对象复用与 legacy 完整持久状态等价；量子原地与不可变路径逐字节等价。
- Worker import boundary：保存投影和纯挂机核心不能反向导入 `storage.ts`。
- 单极磁石：一→二、零库存/零产量、错误令牌、重复执行、速通拒绝、ID 伪造、迁移幂等、历史超限只警告。
- E2E：保存 Worker/槽位/快照；单极磁石双确认和持久快照；桌面/移动 Canvas 有界矩阵。

### 最终门禁

| 门禁 | 结果 |
| --- | --- |
| typecheck / clean build | 通过；仅既有 >500kB chunk 警告 |
| Vitest | 107 文件通过/6 跳过；950 通过/18 跳过 |
| Playwright | 280 通过/11 条显式条件夹具跳过；0 失败；838.6s |
| server | 70 通过/2 可选夹具跳过 |
| ops | 6/6 |
| native tools | 8/8 |
| licenses | 128 个运行时包，当前 |
| root/server `npm audit --omit=dev` | 均为 0 漏洞 |
| source/Web/API | 161/161；Web 128、API 33；缺失/额外/哈希错误 0 |

真实档额外通过：四个离线窗口、8x/12x/16x、30 天纯挂机、三次 60 秒精确、真实云上传和稀疏存档重载。原附件只读使用，没有保存或上传。

## 13. 候选制品

source manifest：`artifacts/release-manifests/1.0.38-351c649af9ee.json`；161 文件；聚合 SHA-256 `73e221c5fdc81eaf0537ad958276990861a5dcfc5956ef65ab356fc8c304e79a`；manifest SHA-256 `f32929f472ba2e1a2301297c1aef15e90f17e95e576447bcd0b42abaddbca6e7`。

| 文件 | 字节 | SHA-256 | 策略 |
| --- | ---: | --- | --- |
| `1.0.38-351c649af9ee-web.tar.gz` | 1,380,311 | `4434c2e1e6c18aaaf760adbed974637ba3097035bb069d7412c1a24722c8309a` | Web 候选；只进入未激活目录 |
| `1.0.38-351c649af9ee-api.tar.gz` | 106,453 | `75af9a097c9d562515651d912246e762a8c9c0bda678c00fd52e8d38f3e3b234` | API 候选；只进入未激活目录 |
| `1.0.38-351c649af9ee-windows-unpacked-diagnostic-unsigned.tar.gz` | 149,489,314 | `a5110d434b3421be11d106fb52b841727e624e0d469821fd40ae30ce4a3f9972` | `NotSigned`，禁止 stable |
| `1.0.38-351c649af9ee-android-unsigned.apk` | 4,837,074 | `7f70527e229a19d70ee175fa1e8d8409bbae4ddcd0a2fcf8435ae3be00acfb89` | unsigned，禁止 stable |
| `1.0.38-351c649af9ee-android-unsigned.aab` | 4,652,404 | `9a2a469b5051972b2f657242ae16eb36094325d7dcb8daf5190520f3675eca44` | unsigned，禁止 stable |

`candidate-artifacts.json` 为 2,190 字节，SHA-256 `156bfd3c24c08b92832a9ab69a49a0bb33d912bd503a4f7dcbd02e8dd95bebda`，5/5 复验通过。

## 14. 性能影响评估

- 保存/上传：减少主线程重复 JSON parse/checksum 和 Worker→主线程对象 clone；稀疏落盘降低 23.84%。
- 纯挂机：真实档停止/恢复的主要收益已实测约 60%～61%。
- 精确模拟：真实档中位约 6.5%，低于建议目标；量子、生产、物流改善明显，电力有噪声回升。
- 内存：对象生命周期和转移机制已减少同时驻留副本，但缺少稳定强制 GC 峰值，不能给出百分比承诺。
- 存档 CPU：第一次稀疏投影和迁移仍是 O(实体+线路)；不会进入逐 tick 热路径。
- Canvas：映射重建只在拓扑变化，普通运行状态刷新减少一次 O(线路数) 映射分配。

## 15. 未解决风险

1. 60 秒精确模拟 13.5～13.8 秒，未达 10～11.5 秒目标；传送带仍是最大热点。
2. 没有对所有复杂混带、四向分流器和极端优先级组合做真实玩家档穷举，主要依赖 oracle/合成矩阵与一个大型真实档。
3. 没有 Android 真机、低配 Windows、锁屏后台一小时、覆盖升级或正式签名验证。
4. Canvas 移动窗口最大帧 139ms，不能承诺所有手机稳定 60 FPS 或无内存不足。
5. 长窗口快速离线的既有非关键误差风险没有被本版消除；decision-required 和速通 exact-only 必须保留。
6. 30 MiB 明文云上传上限不变；17.9 MB 档仍会随未来实体/线路增长再次接近上限。
7. 历史超过两个单极磁石节点的档只警告不删除；真实争议档需要个案审核，不能批量修复。
8. Windows/Android 诊断制品均未签名，不能加入 stable feed。

## 16. 回滚方案

- 发布前：废弃 `1.0.38-351c649af9ee` 候选目录即可，生产保持完整 1.0.36。
- 灰度后：香港/上海 Web/API 和上海下载指针分别原子切回不可变 1.0.36；不清缓存、不删除玩家本地档、不补物资。
- GameState/envelope/cloud/SQLite 均未升级，不执行数据库降级。
- 稀疏 v46 字段由既有默认迁移恢复；回滚前仍需在备份副本上验证 1.0.36 客户端读取候选档。
- 单极磁石操作在写入前有绑定快照；若真实个案另获授权执行，只能用该个案快照逐档回滚，不能覆盖其他玩家档。
- 不修改排行榜历史；速通成绩修复继续沿用既有人工 dry-run、备份、精确账号和停服 guard 流程。

## 17. 发布边界

开发角色没有连接香港/上海生产主机，没有创建或恢复数据库快照，没有修改云 revision、玩家存档、排行榜、下载页或 stable 更新清单，也没有读取签名私钥。Release Agent 必须先完成签名、真机、覆盖升级、两地备份/隔离启动和风险接受，取得用户明确发布授权后才能灰度。
