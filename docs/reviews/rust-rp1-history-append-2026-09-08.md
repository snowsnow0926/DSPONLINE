# Rust RP1：统计历史有序追加

Role: develop。日期：2026-09-08。状态：代码与局部性能测量完成，稳定性及两项 Host 夹具验证仍待关闭；未发布。

## 范围与结果

普通 Rust 离线宏重建统计历史时，原先每追加一秒都对完整历史稳定排序。现在局部追加器独占数组，首次仍执行原排序，之后利用已建立的顺序；若新时间戳回退，重新使用原排序。合并桶保留最后一条时间戳，淘汰只移除前缀，所以压缩不会破坏顺序不变量。同时间戳仍保持先前稳定顺序，未知初始历史不会直接进入快路。

分桶、加权累计、舍入、库存快照、终端遥测和保留窗口均复用原实现。重建仍逐秒计算原 round4 时钟和采样边界，局部失败不会写入候选；新增时钟异常检查保留拒绝语义。普通 recorder 的非法历史早退顺序、私人分层历史、所有权、WAL 与算法版本未改。

实现只改变两个 Rust 文件：[追加与分桶](../../native/dsp-native-core/src/production_history.rs)、[离线重建](../../native/dsp-native-core/src/pure_idle/offline_history.rs)。实时模拟仍由 JS 持有权威，超过 30 秒的自动 Rust 离线采用继续关闭；该阶段为后续开发候选，未发布，不包含新的 Windows 安装包或跨端 Rust 接入。

## 身份

| 项目 | 值 |
| --- | --- |
| 接手 main | `9f4ac5c35e50fe1a1fcb2f4615354362ed28fa9b` |
| 进度报告提交 | `b0ef5345` |
| 实现与测试源码 | `5c619817d192f920877480fbf021d995b5bf656c` |
| 分支 | `codex/rust-rp1-after-1.2.7` |
| 测试 Host | 17,830,912 B，SHA-256 `1ca71bd401223071b583da0d0d55d4c87579b674c9ec8dfe7814366666a4d266` |
| 兼容 | GameState v47、envelope v2；普通离线算法仍为 `native-offline-macro-v1-closed-ledger-one-shot-v3-state-parity` |

Host 从干净实现提交构建；后续文档不改变二进制。源码、Host 摘要和测试记录位于本工作区 `artifacts/rust-rp1-history/`。基准测试编译时实现文件尚未提交，随后原样提交为上述 SHA，未变更代码或替换基准二进制；这是开发测量证据，不是正式包资格。

## 独立性能对照

使用公开合成单机生产遥测，起点 0.0043 秒，先生成 900 秒已有压缩历史，再取得同一组真实 recorder 的 30 秒观察。两条路径输入相同：旧参考保留原 Map 时钟读写及逐次排序循环，新实现使用独占追加器。新实现计时还包含原有前缀绑定校验；旧循环参考未包含该入口检查，不会因此有利于新实现。

release 优化构建下分两个独立进程运行；每个进程先预热，两条路径按 A/B、B/A 交错，各时长各 5 对，总计每时长 10 对。没有同时运行其他本任务的构建或测试。每对结束后完整序列化字节一致，源输入未变；校验在计时外。所有 30 对新实现都更快。

| 模拟历史长度 | 旧重建中位 | 新重建中位 | 中位耗时缩短 |
| --- | ---: | ---: | ---: |
| 600 秒 | 10.315 ms | 7.504 ms | 27.3% |
| 3,600 秒 | 74.144 ms | 53.545 ms | 27.8% |
| 28,800 秒 | 665.180 ms | 483.721 ms | 27.3% |

旧/新范围分别为 600 秒 9.939–11.169 / 7.143–8.093 ms，3,600 秒 71.417–76.561 / 52.270–55.786 ms，28,800 秒 645.940–727.988 / 471.901–500.698 ms。仅测历史重建，没有测完整工厂模拟、IPC、导入导出、保存、玩家总等待、峰值内存或 FPS；不能把这里的约 27% 外推给全量 Rust、真实终局档或网页/安卓。

可重复命令：`cargo test --manifest-path native/Cargo.toml -p dsp-native-core --lib --locked --release --jobs 1 benchmark_ordered_history_reconstruction -- --ignored --nocapture --test-threads=1`。原始样本为 `benchmark-1.log`、`benchmark-2.log`，汇总为 `benchmark-summary.json`。

## 验证

- 新增逐次完整字节对照覆盖 3 个时间偏移、12,000 次追加和保留窗口；另 1,000 次乱序/重复时间戳、缺时钟、负零及不规则时长与原路径对照。
- 重建与原循环按 1/9/11/599/601/3,661 秒、正常/倒序旧历史逐次对照；现有八小时 recorder 等价、继承诊断值、晚期拒绝与源档不变测试继续执行。
- 定向 Rust 13 通过，1 个性能测试在普通运行中显式跳过；该性能项已单独两次运行通过。严格 Clippy workspace/all-targets、fmt、类型与 Web 构建、预算、原生边界通过。
- 初轮完整 JS 单元 3,076 通过、96 条件跳过。新 Host 补验 66 通过、2 个性能条件跳过：原生核心差分 51、记录释放生命周期 1、公共目录 14；公开 12 场景完整状态/物料全相同，无差异字段，覆盖八小时、容量/耗尽、小数时间、旧历史、热继续和检查点重开。独立长采矿边界项包含 30 天单段/分段对照，也通过。
- Native/desktop Node 630 通过、1 条件跳过、0 失败。
- 两轮 JS 按完整文件用例清单合并后，3,142 通过、30 条件跳过、0 失败；保留同名参数化用例，未按名称去重减计数。这是首轮全量加新 Host 定向补验的并集，不是一条新的全量命令。
- 标准 debug 核心串行 1,099 通过 / 4 ignored，587.91 秒；其他测试结束后的同一二进制四线程复验 1,099 通过 / 4 ignored，224.51 秒。这两组耗时仅用于识别测试记录，不是性能基准。
- Host library 串行 242 通过、2 失败；Host binary 独立补验 3/3 通过。完整 Rust workspace 仍为未通过，不把分组复验拼成全绿。

首次误用 release profile 运行完整 Rust：Core 1,098 通过、1 失败、4 ignored。失败的既有 checkpoint 测试无条件期待 `unmarked writer`，而对应审计仅编译于 `cfg(debug_assertions)`；原样隔离复查复现，基线源码相同。没有删除断言或修改生产审计，改用项目标准 debug profile 补完整矩阵；release 模式仅用于开发性能测量。原失败文件为 `rust-full.log` 与 `checkpoint-focused-recheck.log`，保留为失败。

第一次标准 debug 四线程核心测试在结束前发生 `0xc0000374 / STATUS_HEAP_CORRUPTION`。Windows Application 事件记录时间为北京时间 18:46:03，应用为 `dsp_native_core-c5b57ae6eb847cf8.exe`，模块为 `ntdll.dll`；见 `rust-full-standard-profile.log`、`windows-heap-crash.json`。当时本任务另有 Node/Host 差分工作；后续串行及安静四线程都通过，但不能据此断言并发负载是原因，也不能认定已修复或与本次改动无关。原因仍为 **UNRESOLVED**，开放玩家原生资格前需补基线对照和可定位的崩溃证据。

Host 失败分别为 `every_use_rejects_replaced_slot_and_export_directories` 与 `initialization_rejects_prepositioned_fixed_directory_redirects`。既有 `create_directory_redirect` 辅助函数启动 `cmd.exe /d /c mklink /J` 时返回 `Access is denied`，尚未到达产品的保存路径拒绝断言。独立复查其中一项、给另一次复查设置仅限该进程的工作区 TEMP/TMP，仍复现；同路径手动目录联接探针可以创建，因此不能只归因于临时目录不可写。此文件相对接手 main 没有变更，未修改系统安全配置、跳过断言或降低保存路径保护；仍需在可正常构造夹具的环境复验。证据为 `host-junction-focused-recheck.log`、`host-junction-workspace-temp.log` 与标准串行日志。

本地证据汇总 `artifacts/rust-rp1-history/verification.json` 记录 20 份日志/报告的大小与 SHA-256，状态为 `LOCAL_PERFORMANCE_VERIFIED_VALIDATION_OPEN`，`releaseQualified=false`；汇总文件 SHA-256 为 `cc63ebbf5295abe36d53fa049c9aa5a8290ca9f59fa1e136c43b5c33edbf19f9`。完整 JS、新 Host、测试分组和失败均分别记账，不覆盖首轮失败日志。

没有读取或修改本轮真实玩家存档，没有生产连接、签名、推送、部署或下载安装包变更。本阶段未做完整 Electron 玩家旅程、实体设备或完整浏览器 UI 重测；产品改动只在 Rust 历史重建，采用 Rust 全量、真实 Host/JS 完整状态与桌面桥接覆盖对应路径。1.2.7 上线时的浏览器结果保留为旧制品证据，不冒充本轮新 Host 验收。

## 下一阶段

先关闭上述核心稳定性与 Host 夹具验证缺口。本阶段减少已具备资格的普通宏尾段成本，RP1 仍需按真实大厂拒绝原因拆解复合产线，证明全状态与完整入口的取消、持久提交和重开，再测玩家实际等待。当前普通宏稳态证明的 30 次观察与 60,000 记录步预算，意味着实体与带合计超过 2,000 即拒绝；同时保留 8 MiB 原始记录/32 MiB 运行内存预算。这个由源码推导的规模门槛需要先做代表性大厂测量，再设计有界证明；不能直接提高阈值或借本轮局部收益开放所有长离线/实时权威。总阶段进度见 [进度报告](../RUST_PROGRESS_REPORT_2026-09-08.md)与[逐步计划](../RUST_PERFORMANCE_ROLLOUT_PLAN_2026-09-07.md)。
