# Rust RP1 并行参与验证的调度前提｜2026-09-09

Role: develop。承接 [当前批次回归记录](./rust-rp1-current-batch-validation-2026-09-09.md)，只修复测试对实际线程参与的调度前提，不修改生产调度、游戏规则、存档或 Rust 准入。正常优化完整核心及严格 Clippy 已通过，新源码云端待验，本记录不授予发布资格。

## 失败和可重复隔离

同源码 PR Windows run `34292207525` 的核心结果为 1,110 通过 / 5 ignored / 1 失败。`production_interstellar_congestion_updater_really_uses_2_4_8_workers_and_stays_authoritative` 在 requested=2、observed=1 时触发原断言；不是堆异常，也没有取得该次完整状态比较的通过结果。此前同源码一次完整 Windows 成功不能覆盖该失败。

只读冻结实际 `deterministic_runtime.rs`，SHA-256 `d5f296bd9cf24ec92bd367ebda222a39727a70bbdfffa603f8c69d9c8c290c1e`，用现有锁定依赖和正常 `opt-level=3` 编译独立模块探针。在两线程池内明确占用其中一条线程，实际 `indexed_try_map_with_diagnostics` 仍能完成 4,353 行映射：配置 2、实际观察 1、全部有序结果等于串行参考。反例为 **1/1 通过**，不是重跑直至绿色。

该隔离证明“选用多线程路径”不能保证短工作在任意一次调度中都被至少两条线程执行。占用线程是诊断条件，不认定云端当时发生了完全相同的占用，也不把简单行映射的正确性替代物流完整状态检查。独立探针路径为 `artifacts/rust-rp1-loop/worker-participation-probe-v1/`，外部守护正常退出 0、7.959 秒、最低可用内存 8,932,556 KiB。

## 测试修改

新增仅在 `cfg(test)` 下存在的 runtime 构造方式，供两项物流更新器的实际参与专项使用。在**实际映射闭包**第一次进入时等待另一个不同 worker index 进入；其余普通 runtime、生产构建和小于并行阈值的串行路径都不加同步。

等待最多 2 秒；未满足条件就使专项明确失败，并锁定失败状态、唤醒其他等待者，后续行不能各自重新等待两秒或用迟到线程把失败改成成功。它不把配置数量伪装成实际参与数量：原 worker mask、至少两条线程参与的断言、配置上界、完整实体字节与 authority 指纹比较全部保留。请求 4/8 线程时仍按原标准验证至少两条实际参与，不宣称每次所有线程都一定工作。

新模块检查覆盖不同 worker index、同一个 index 不可重复计数、期限到达后保持失败、1/2/4/8 线程下完整有序输出、最低输入索引错误优先和小输入串行阈值。独立负例进一步实际占用另一条线程：启用专项同步后必须在期限内明确失败，不能错误报告并行参与成功；测试捕获的是该特定断言，没有吞掉未知失败。

生产 `indexed_map`、`indexed_try_map`、线程池大小选择、4,096 行门槛和任意持久状态均未变。此项修复只让并行路径的正确性测试具备可控前提，不宣称玩家新增性能收益，也不解决历史堆损坏根因。

## 当前验证

| 检查 | 结果和范围 |
| --- | --- |
| 冻结旧运行时占用线程反例 | 1/1，配置 2 / 观察 1，4,353 行完整有序输出相同 |
| 冻结新运行时模块及占用线程拒绝负例 | **21 通过 / 0 失败 / 0 ignored**，含原模块、新边界和一项独立负例；不是整个核心 |
| `cargo fmt --all -- --check`、`git diff --check` | 通过 |
| 正常 release 完整核心 | **1,113 通过 / 5 ignored / 0 失败 / 0 过滤**，原两项物流并行/完整状态断言均通过 |
| 严格 release Clippy | workspace/all-targets、`-D warnings` 通过 |
| 新源码云端 | 尚未执行；现有 c6 运行不包含本修复 |

新模块来源 SHA-256 `4aeef4fd9656ed76c7031b6ada6f31f388ea722b82a6a432633d8324bafc8455`，独立探针 EXE SHA-256 `0f47a71a873733795c2f568a42b6384db8e2aa11fc88c1bc3e5bbe10644b0431`。`worker-participation-probe-v2/` 保存来源、编译日志、全部结果及明确拒绝负例；外部守护正常退出 0、10.308 秒、最低可用内存 8,676,232 KiB，实际测试约 2.23 秒。

完整构建由 `worker-participation-build-v1.mjs` 执行 `cargo test --locked --release -p dsp-native-core --lib --no-run`，一项编译任务、不覆盖 profile；8 分 50 秒完成，Cargo 实际 profile 为 opt-level=3、debug assertions=false。三份源码摘要和实际测试程序绑定于 `worker-participation-build-v1/receipt.json`，随后复制并核对冻结 EXE SHA-256 `78b1bc5fd43bce2eaa00c32d414813c8652289e99b65de92cc182c27e3668c2b`，在独立监控下无过滤运行全部核心用例。`worker-participation-core-test-v1/report.json` 为 1,113/5 ignored/0 失败，测试约 151.99 秒，外部守护正常退出 0、152.261 秒、最低可用 7,689,188 KiB；两个原生产更新器断言的日志均为 ok。

构建外部守护最低可用 5,291,532 KiB，正常退出 0、530.883 秒，无内存或期限终止。随后独立执行 `cargo clippy --locked --release --workspace --all-targets -- -D warnings`，守护正常退出 0、66.386 秒、最低可用 7,165,024 KiB。三阶段各自要求 6 GiB 启动余量，均使用独立 2 GiB 停止线、隐藏及低优先级；不启动游戏窗口、不关闭用户程序。没有用模块探针或旧 EXE 冒充新完整核心通过，也没有为测试变化重建已冻结的 2bb 玩家候选。

上一轮 `c6b44c4a` 的云端 CI 仍是另一份未包含本修复的源码；已观察到 build/unit 成功及 Ops 步骤通过，部分步骤仍在运行，最终计数待终态日志。第二组浏览器已结束：202 expected / 22 skipped / 11 unexpected / 6 flaky。新增失败附件留存实际生效，45,184,639 字节 ZIP SHA-256 `f02b20418efe82dc11f6d856bf5acc5843e49dc02267e51ecc46aeb2e9317f76` 已下载验证；其中 15 份挂机停止失败上下文（含重试）全部还在工厂加载或模拟运行时验证阶段（3/12），第一张实际截图也确认这一状态，不能称停止流程已执行失败或已经通过。原始报告和附件保留，`c6-shard2-context-audit-v1/` 是只读取证。

浏览器失败的只读轨迹另确认：本机恢复目录场景在 5 秒断言到期前约 0.6 秒才开始加载模拟 Worker，未取得初始化返回；此为该次入口未就绪证据，不能外推解释所有失败或直接调宽断言。

完整目标继续进行。下一步验证本修复的云端运行，定位浏览器恢复入口的启动前提，再继续原始终局 timeWarp 兼容；现有冻结 2bb 包的 71.3% 收益身份保持独立，不重新标记或叠加。
