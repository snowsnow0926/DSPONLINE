# Rust RP1 实际入口：恢复与保存身份修复

Role: develop。后续版本开发候选，未发布。Rust Host 仍为 `b39131a3`；本阶段处理进入离线计算前的共享存档边界，不修改模拟、保存格式或原生采用资格。

## 已复现的问题与修复

冻结桌面包 `1.2.7+0cc971d8b451` 的公开工厂连续两次在“继续游戏”提示“本地存档不可用”，尚未调用 `coreOpen`。原主档和重建结果均完整有效、均为 93,034 B，但正文 checksum 分别为 `aea2e7e7` 和 `92d97129`。目录标识原主档；原入口误用重建结果比较目录，因此 JSON 顺序变化或有效恢复都会被拒绝。

读取接口现在保留原主档和恢复结果的字符串引用。目录继续核对原主档，恢复结果独立经过 Worker 完整校验；无恢复时复用 Worker 已计算的正文身份，不重复扫描。备份、快照候选顺序不变。

进一步的浏览器回归复现了第二处问题：入口将恢复后的正文放进同步保存缓存，之后保存时把它当作磁盘原文，误报另一标签页已经修改存档。入口现在只缓存实际读到的主档，直接加载已验证恢复状态。开发直达入口复用原同步离线计算和回归奖励逻辑，独立处理读取结果，避免改写保存比较基准。真正的版本、租约和原文冲突检查未放宽。

另一项修复前失败的反例：主档以同一状态 checksum 保存到较晚时间后，旧 journal 仍可能匹配并回退 `savedAt`。IDB/native 两种恢复读取均要求 journal 时间不早于有效主档时间，且在读取大块数据之前检查。主档时间无效时保留主档，不采用 journal；不重写时间戳。

## 当前验证

- 保存、菜单、native journal 与 native 启动专项 **35 通过 / 0 失败**。
- 新增四个实际浏览器场景：菜单/开发直达 × 同状态重组/推进后恢复。均通过真实界面的“立即保存”，完整持久状态读回及导航重开后相同；与原保存协调测试合计 **22 通过 / 0 失败**。旧原文确实变化、另一写入者、租约及冲突副本保护继续通过。
- 类型检查通过。
- 完整单元 **3,148 通过 / 39 跳过 / 3 失败**：有限矿精确跨界耗时约 2,270 ms 超出原 2,000 ms 门槛，递归量子批处理和普通/槽位离线测试分别在约 5.36/5.52 秒结束并失败。该批次与全量浏览器并行，尚待独立复验；保留原断言与时限。完整浏览器、生产构建与新桌面包实际 Native 入口仍在验证，不能据专项标记全部门禁通过。

此前没有时间先后和保存基准修复的版本，完整单元曾 **3,145/39 跳过**，不转记为当前最终结果。浏览器首次收集因工作区未安装 server 的锁定依赖失败；安装后首个全量在发现时间反例时主动中断。随后全量进程在没有最终报告时消失，已有失败多停在工厂 Worker 初始化，尚未完成与冻结基线的同例归因。所有失败和中断均保留，未降低断言或超时。

## 制品与证据

证据根：`artifacts/rust-rp1-loop/`（不入版本库，均为公开夹具；私有档报告只含白名单摘要）。

- `packaged-offline-complete{,-v2}/report.json`：冻结旧包真实入口失败、RPC 与退出清理结果。
- `packaged-offline-complete-v2/selected-payload-diagnostic.json`：冻结包主档/目录/恢复结果的独立检查。
- `menu-recovery-stale-primary-before-tests.json`：较新主档反例修复前失败。
- `menu-recovery-focused-e2e.json`：保存基准修复前 **4 通过 / 2 失败**，保留冲突现场。
- `menu-recovery-cas-focused-tests.json`、`menu-recovery-ui-save-e2e.json`、`menu-recovery-final-typecheck.log`：当前专项结果。
- `menu-recovery-final-unit-v2.json` 及 `-job.json`：完整单元原始失败和独立进程退出记录。
- `menu-recovery-interrupted-validation-receipt.json`：前两次浏览器全量和前次单元的中断事实、已输出的部分结果计数；无最终报告不算完成。
- `package-0cc971d8-frozen-receipt.json`：完整旧包归档并逐文件读回，**78 件 / 428,002,359 B** 相同；供新包入口对照，原目录可重新构建。

## 回归复验收口

完整单元原批次的三个失败所在文件在没有本任务其他重负载时复验，**137 通过 / 0 失败 / 0 跳过**，保留原断言和时限。全量结果仍记为 3,148/39/3，不能改写成一次全绿。

完整浏览器原批次 **350 通过 / 33 跳过 / 105 失败**；该批次与完整单元并行。把全部原失败地址串行复验，实际运行 112 项（参数化额外匹配 7 项），**105 通过 / 7 失败**：原 105 项中 98 项通过、7 项仍失败。之后这 7 项独立复验 **6 通过 / 1 失败**。其中星球重置夹具在真实冷开跨过一秒时会显示正常离线报告，现由测试点击真实“确认结算”，再验证原有三次危险确认及数据保留；没有伪造时钟或强制点击。

最后剩余菜单计时曾为 p95 586 ms，超出原 500 ms。用同一独立 Vite 配置分别运行冻结旧六个运行模块和当前代码：旧模块 p95 **258 ms**，当前 **277 ms**，均通过；大存档正文不读取、不解析、缓存为零的断言均保留。它们是独立诊断，不是配对性能结论。所有原失败场景已在后续复验通过，但没有新的单次完整全绿结果；不据此授予发布资格。

新增证据：`menu-recovery-unit-failure-isolated.json`、`menu-recovery-full-e2e-v4.json`、`menu-recovery-e2e-failed-serial.json`、`menu-recovery-serial-membership.json`、`menu-recovery-final-seven-e2e.json`，以及 `recovery-control/cold-{baseline,candidate}-driver.log` 与配置目录下嵌套的 JSON 报告。旧模块工作区在对照时为干净 `0cc971d8`，当前运行模块为 `8a8e859e`。

完整玩家等待的收益、真实终局档实际采用与取消、持久提交及正常退出重开仍需完成。本阶段没有部署、没有修改授权原玩家文件，超过 30 秒自动采用及实时权威继续关闭。

## 2026-09-09：实际桌面通信入口补修

干净 `31991bcf` 的本地 beta 目录包构建及制品验证通过，仍为 `NotSigned`。真实 UI 已不再误拒目录，可以进入工厂；但公开样本在正式 Native 候选请求前回退 JS。诊断先纠正了驱动把精简主档当成原生运行检查点，以及诊断 canonical 未忽略 undefined 的问题，原失败 v3–v7 全部保留，不计 Native 成功。

修正夹具后的真实包确认：Worker 加载状态与 Core 打开状态的 canonical/domain SHA 相同，发出了离线传输请求，但还未调用 Host 的候选方法即返回通用失败。实际 `main.cjs` 入口仍引用已不存在的 `performanceEditionRuntimeIdentity`。现在复用 Host 初始化所用的 `desktopRuntimeIdentity`、路径模块及该版本目录名，继续通过固定目录验证，不改变源证明、时间或权威边界。

新增测试执行实际 main 事件处理块，使用真实固定目录解析器，覆盖性能开发版和普通版；修复前两例均捕获该未定义变量，修复后与传输、preload、固定目录保护、版本身份和 Host 合计 **67 通过 / 1 条件跳过 / 0 失败**。完整 Native 工具测试另行 **632 通过 / 1 条件跳过 / 0 失败**；新包实际结算/取消/重开继续验证。

`f9feb88a` 新包确实到达 Host，公开 5 秒候选完整状态与 JS 相同，但 renderer DTO 仍误拒：短前缀实际标记为 `pure-idle-bounded-exact`，旧边界只接受 `offline-macro-v1`。已增加仅 1–30 秒、全部时间精确校准且估算时间为零的匹配分支，保留源、revision、导出与时间绑定。Host 在计算前拒绝超范围请求时没有 advance，现在也能作为无候选的拒绝结果传回，不会误报协议损坏。未改变 Rust 算法、30 秒采用限制或实时权威。

DTO 新反例修复前失败，补齐缺失/不完整校准、估算尾段、31 秒伪装精确及拒绝结果夹带导出的负例；实际 Host 集成新增将成功与超范围拒绝送入同一 renderer 校验器。当前完整 Native 工具测试再次 **632 通过 / 1 条件跳过 / 0 失败**。证据 `offline-exact-dto-{before,full-native}.log`、实际包 `packaged-offline-complete-v8/report.json` 和 `-v9/live.json`。v9 驱动后续教学关闭按钮被真实弹窗遮挡而中断，不计完整 UI 通过。

## 最终公开短流程验收

最终运行源码 `5274c6e1af14c5a5d6a5da0a69b60922b40e48df`，Build ID `1.2.7+5274c6e1af14`，75 件制品独立 SHA 复验通过，`NotSigned`。Host SHA 仍为 `a3b1bf2283f5b66f2be9d156a8b9a57509fb8aff558150e2fb9498a2cbf09ba4`；EXE SHA `03a6269c5323090321298d12cd88349205dfd0f9cdb36bc43a59f663d83da96c`，ASAR SHA `324dcfe764fd5192a8d59fe910192047cf9e1a563eb33304ef27113931671e75`。

v16 驱动的完成/取消两例均通过：公开 110 实体/2 带，准备匹配的完整运行检查点和标准主档 revision/catalog，真实墙钟 5 秒，真正调用 Host，再由真实 Continue 界面执行。完成例 Native 完整 canonical 与 JS 相同、初始持久投影相同；实际界面暂停/保存、正常退出/重开、再次进入暂停工厂及第二次重开通过。点击至可操作 1,659.65 ms，只是单次公开小样本观察，不是配对性能资格。

取消例在真实 Host 候选准备后额外延迟响应 3 秒以便点击按钮；原主档 SHA 不变、Native generation/revision/rootHash 不变，正常退出并连续两次重开后不变。延迟不是性能样本。两例共 8 次正常进程退出码均为 0，无强制清理成功样本。

完整状态核对区分磁盘读回与普通 JS 加载：磁盘暂停主档在首次重开原样保留；实际 Continue 后，既有迁移会删除未安装喷涂器的 `proliferatorBonusProgress.iron_ingot=0`。v11/v12 原严格字节断言失败保留；最终用相同暂停原文独立调用普通 JS inspect/migration/projection 生成整个预期状态，所有字段再次一致，后续磁盘重开一致。没有修改迁移、投影或忽略字段。

驱动问题均保留：v10 初始夹具 autosave=0 与真实 UI 默认 30 秒不同，v11 起采用相同公开设置；v12/v14 取消未改源，但原始手写主档没有 revision，关闭保护拒绝并需失败清理；v15 补 revision 后首次关闭仍未完成，重试退出码为 0。v16 用生产纯 helper 同时生成匹配 revision/catalog，重载等待目录可用，完整关闭通过。旧式无元数据主档的自然补齐/关闭兼容仍需单独验证，不当作已修复。

证据：`packaged-offline-{complete,cancel}-v16/report.json`、`probe-packaged-offline-entry-v16.mjs`、`packaged-public-fixture.ts`；23 件批次记录清单 `public-startup-batch-evidence-2026-09-09.json`，SHA `74a5504f31d6a4603ee514bc034430d384dd2c73cd09c57da0ff916256f316e1`。本轮没有重新运行真实终局完整入口，也没有配对完整用户等待，RP1 总目标仍未完成。易读交付见[批次报告](../RUST_BATCH_REPORT_2026-09-09.md)。
