# Rust RP1 大存档读取缓冲｜开发中

Role: develop。承接运行态来源入口和后台测试阶段；未发布。云端已编译正常优化 Host，但整组门禁失败，未取得合格 Host 制品或生成新安装包。

## 后续轻量验证

`840ec68d` 的真实 v47 模块 12/12 通过（含新增 3 项），命令保留 release 的其余设置，仅以 `--config profile.release.package.dsp-native-core.opt-level=0` 关闭本 crate 的编译优化。同一 524,708 字节回归夹具现满足最多 9 次非空来源读取，完整结果与校验相同。单编译任务、低优先级、单测试线程，并以 1.5 GiB 剩余内存设自动终止线；此次约 77.7 秒，观测最少可用内存 2,147,032 KiB，没有触发停止。证据为原工作区 `artifacts/rust-rp1-next/v47-buffer-low-memory-v1/{stdout.log,stderr.log,receipt.json}`。Cargo 的日志仍显示 release，不可忽略明确的 opt-level=0 覆盖而称正式优化构建通过。

本机内存仍不足以安全重复正式优化构建，新增 [Windows 云端验证工作流](../../.github/workflows/native-windows-validation.yml)，使用同一仓库独立 RP1 分支、Rust 1.96.1、正常 release 优化和公开测试数据。工作流依次运行 fmt、严格 Clippy、完整 Rust workspace、Windows Host、完整 Native 工具、类型检查与完整游戏单元；失败保留日志，仅全部成功后上传 Host 及精确提交/哈希回执。不接触玩家档，不构建发布包或部署。

工作流提交 `74b57f1e4e6d235a216e0382a4455382c0f66377` 已推到 `codex/rust-rp1-after-1.2.7`，推送时 main 为 `9f4ac5c3`。[首次云端运行](https://github.com/snowsnow0926/DSPONLINE/actions/runs/34268571075)（job `102204086329`）已结束，结论为失败：fmt、严格 release Clippy、完整优化 Rust workspace **1,363 通过 / 5 ignored / 0 失败**及 Host 构建通过；Native Node **673 通过 / 1 失败 / 1 跳过 / 0 取消**。类型检查和完整游戏单元没有执行，合格 Host 没有上传。仅保留诊断 artifact `10073972545`，ZIP SHA-256 `0ad2f00d0aa87c108d6ef5c15768ccd34bd937c29042bc77d47c3096971ba205`；完整 job 日志在原工作区 `artifacts/rust-rp1-next/cloud-ci-74b57f1e-job.log`。

唯一 Native 失败是 Windows 超时进程树清理集成测试：`scripts/benchmark-native-core-fixed-affinity-ab.test.mjs:817` 的 PID 文件存在断言失败。此前超时分类、临时执行目录删除断言已通过，但六进程夹具没有提供启动记录，不能称进程清理已经验证或认定是 Rust 崩溃。本机原样独立执行 **1/1 通过**（约 17.2 秒）；只增加真实 spawnSync 返回值观察、保留原启动参数、8 秒请求加 250 ms 宽限及全部断言后，也 **1/1 通过**，两次均在约 8.27 秒超时前产生 PID 文件。原始与观察日志分别为 `ci-launcher-original-local-v1.log` 和 `ci-launcher-instrumented-local-v1.log`。

本机额外比较有效及超出本机 CPU 数的 START affinity，两者均能启动夹具并正常验证超时退出，未支持“亲和掩码单独导致失败”的假设。[轻量云端诊断](../../.github/workflows/windows-launcher-diagnostic.yml)的[首次运行](https://github.com/snowsnow0926/DSPONLINE/actions/runs/34273964060)也复现 **0 通过 / 1 失败**：同一本机通过的观察脚本在 Windows Server 2025、4 CPU、继承 affinity F、Node 24.19.0 上，两次约 8.27 秒返回 ETIMEDOUT，PID 文件均未出现，标准输出/错误均为空。诊断 ZIP 已下载并核对 SHA-256 `3f4c5ae1581c9016b4dd7a26a750b624f3699ca27427edc72e66c7a94e5622ce`，保存于原工作区 `artifacts/rust-rp1-next/cloud-launcher-3175c02b.zip`。

定位时[观察脚本](../../.github/diagnostics/windows-launcher.mjs)增加显式 trace 与 production-grace 模式：前者保留原期限并记录 PowerShell 就绪、Add-Type 完成、Job 挂接完成时间；后者以实际 launcher 默认 30 秒启动宽限检查同一清理断言，并相应调整诊断测试外层时限。它们仅作问题定位，当时未修改生产 launcher、原测试、工作负载或六进程退出/临时目录删除断言。本机 trace **1/1 通过**，日志 `ci-launcher-instrumented-local-trace-v1.log`。此次诊断矩阵不再次编译 Rust、不使用私人数据。

上述矩阵现已结束：[运行 34274304585](https://github.com/snowsnow0926/DSPONLINE/actions/runs/34274304585)的 trace **0/1**，输出只到 PowerShell 就绪，8.25 秒期限内 Add-Type 未完成；production-grace **1/0**，同一 Add-Type 首次实际约 **26.391 秒**、第二次约 **0.200 秒**，两次均生成夹具 PID，原超时分类、六进程退出和私有执行目录删除断言全部通过，整例约 78.1 秒。整体 run 因保留旧短期限的反例而失败，不能标成整组全绿。完整日志为原工作区 `cloud-launcher-0a3f-{trace,production-grace}.log`（在 `artifacts/rust-rp1-next/`）。这说明原测试 250 ms 启动宽限不覆盖该 runner 的冷编译；没有证据把等待归为 affinity 或 Rust 计算故障。

据此修正维护中的集成测试：移除测试专用的 250 ms 覆盖，使用 launcher 已有默认 30 秒启动宽限；外层 Node 测试期限改为 100 秒以覆盖两次 8 + 30 秒启动及清理。实际 benchmark 请求超时、生产启动器和游戏 300 秒期限不变，全部退出和文件断言保留。轻量云端工作流接下来只执行修正后的原测试；历史 trace 模式仍可显式复现旧问题。完整原生工具及其后门禁仍待在修正后的提交上通过，不能拿诊断成功代替。

修正后本机完整 `benchmark-native-core-fixed-affinity-ab.test.mjs` **15 通过 / 0 失败 / 0 跳过**，约 77.5 秒，其中真实六进程清理例约 76.5 秒。执行 Node 使用低于正常优先级，未启动游戏窗口；日志 `artifacts/rust-rp1-next/ci-launcher-default-grace-local-v1.log`。这不是全部 Native 套件或云端门禁完成；[本批易读报告](../RUST_BATCH_REPORT_2026-09-09_BACKGROUND.md)分别说明后台收益与未完成的玩家性能验证。

修正提交 `056b9b0840eaeab14c3f7c9c8c44ec4a8b0ca7ea` 的[原测试云端复验](https://github.com/snowsnow0926/DSPONLINE/actions/runs/34274908998) **1/1 通过**，约 78 秒，两次均在 38 秒真实期限下生成 PID 文件并通过全部清理断言。日志在原工作区 `cloud-launcher-056b9b08.log`（`artifacts/rust-rp1-next/`）；诊断 artifact `10075350743`，ZIP SHA-256 `651da87135fc39cbbf5b5882c067ff4c69b2651f1baf642dd0bdb0c6cb65767b`。[完整云端运行 34274908889](https://github.com/snowsnow0926/DSPONLINE/actions/runs/34274908889) / job `102225411083` 仍在运行：fmt、严格 release Clippy 已通过，完整优化 Rust 步骤尚未结束，其后门禁未完成。下一次应观察这个具体运行，不因等待重开。

本机另完成[独立内存监控 3/3](./rust-rp1-private-source-memory-guard-2026-09-09.md)，用于覆盖 Node 同步计算阶段内部定时器无法及时执行的情况。当前可用内存约 3–4 GiB，未满足私人诊断 6 GiB 启动条件；没有运行新终局档或使用旧 Host 冒充新制品。

公开运行态对照的新参数化驱动及外部监控已实际验证一个旧版成员：`public-runtime-source-baseline-p1-v1/report.json` 与 `-guard/result.json` 均 PASS。9,107 实体 / 20,000 带，源文件 4,143,963 字节，实际来源传输 10,234,284 字节、候选 11,051,481 字节；固定 1 秒的完整状态与 JS 相同，原状态/原文件不变，临时目录清理及一次正常退出 0/null 通过。`native-candidate → verify-complete-candidate` 约 **16,729 ms**，外层执行约 20.52 秒，观测最低空闲 3,536,908 KiB，未触发停止。该报告仍只有旧 Host，不能当作已完成的一对或三对性能结果。

原工作区 `artifacts/rust-rp1-next/probe-public-runtime-source-pair-v1.mjs` SHA-256 为 `fd8050338aa567b63f532c6e2aea02148f29809ca1a8f932b31c7fb9ea88f58d`，配套 `run-public-runtime-source-guarded-v1.ps1`；仅使用公开固定 SHA 文件。历史 Host 只接受冻结的 `a9019611…` / `f7f10391…` 对应身份，候选 Host 要求其来源提交与当前运行代码相同且文件哈希一致。公开入口以 3 GiB 启动余量复用外部监控，私人入口的 6 GiB 要求不变。后续独立进程交替配对，并分别报告来源编码/证明、候选请求及完整候选检查，不把这些诊断耗时当作 UI 完整等待。

下步公开耗时样本已生成：1,000 个合成产线单元、9,107 实体、20,000 传送带，共 4,143,963 字节，源 SHA-256 `7767eff12ef110a4dd7bccc9d385c9a7551d49f1561489055d2fa2d73a266d1a`。保存于开发 worktree 的 `artifacts/rust-rp1-loop/public-v47-read-fixture-v1`；原工作区 `artifacts/rust-rp1-next/run-public-v47-read-pairs.mjs` 已做语法检查，拟交替三对、完整导出状态和正常退出校验，尚未运行性能对照。旧本机与新云端二进制的编译环境不同，后续即使观察到耗时改善也必须注明；不得把这项文件导入 RPC 当作玩家完整等待。

随后完成两项**旧 Host 单次基线验证**，均非新旧性能对照：

- 文件导入/导出：原冻结 `a9019611…` Host 的导入 RPC 约 5,060 ms，导出完整 canonical 与输入相同，持久检查点身份一致，正常退出 0，源文件不变。证据 `artifacts/rust-rp1-loop/public-v47-read-pairs-v1/report.json`，mode 明确为 baseline-pilot，不能把它当作三对结果。
- 运行态来源：同一公开工厂由实际 JS 加载后，经生产 Broker 传输、完整证明和临时 Host 准备 1 秒候选，完整状态与 JS 一秒相同；来源不变、临时目录清理和一次正常退出均通过。固定绑定时钟为源 savedAt + 1 秒，这是诊断，未测 UI。请求阶段约 16,716 ms，包含准备候选、传出结果及正常退出；证据 `public-runtime-source-baseline-v1/report.json`。

第二项实际传输 10,234,284 字节，比原文件 4,143,963 字节大约 2.47 倍。后续必须记录实际运行态字节数，不能直接按原存档大小外推读取成本；终局档旧超时报告没有记录最终传输总量，不能把公开样本的比率套给该玩家。

以下保留先前失败和边界记录；正常优化 Rust 测试及云端 Host 编译现已通过，合格制品获取、终局复验及完整 UI 等待仍未完成。

授权终局档的只读副本经现有 JS 校验和运行态流式传输进入旧 Host 后，在原 300 秒请求期限内未返回候选。诊断使用 1 秒绑定时钟，不是实际 UI 等待配对。原文件字节数、修改时间和 SHA-256 在结束后保持不变；本次临时 Host 已终止，原失败证据保留在开发 worktree 的 `artifacts/rust-rp1-loop/private-runtime-source-v1/report.json`。报告不含玩家存档内容。不能据此认定唯一超时原因已经查明。

代码定位：serde_json 的 Read 解析器逐字节读取，原 BoundedHashReader 直接委托来源；Host 普通 JSON 文件来源没有缓冲。新增公开回归夹具包含有效信封及跨多个分块的合法尾部空白，共 524,708 字节。改动前实际 release 测试计数为 524,708 次非空底层读取，原样断言失败，日志为原工作区 `artifacts/rust-rp1-next/v47-buffer-before-test-v2.log`。

当前候选在 BoundedHashReader 内层加入 64 KiB BufReader，只减少底层读取次数。哈希、字节上限及 UTF-16 检查仍跟随解析器实际消费的字节，避免预读到后方孤立代理字符后改变前方语法错误分类。新增回归同时检查完整解析结果/哈希不变、最终 EOF 读取错误仍拒绝、未消费的代理字符不影响错误分类。格式和 256 MiB 上限未改，不放宽 300 秒超时或 1–30 秒采用资格。

**早期本机失败记录**：首次新增测试的 Cargo 命令遇到 rustc 访问异常 `0xc0000005`，仅库构建失败；随后指定 `--lib` 的原配置测试实际运行并复现上述逐字节失败。修改后的 release 测试编译使用单任务、低于正常优先级，检测到系统可用内存降至 654,868 KiB 时，主动终止本任务编译器以保护用户正在进行的工作。该次退出 `0xffffffff` 是主动终止，不是测试断言或产品运行崩溃；日志 `v47-buffer-after-tests-v1.log` 不能记为通过。

后续先查清云端原生工具失败、完成尚未执行的类型及完整单元，再取得精确来源和哈希的 Host 做公开性能配对及授权终局档复验。重型测试必须后台、低优先级、限制并发且留足内存；不要终止用户其他进程来制造测试资源。当前仍属于开发候选，不能把读取次数改善换算成玩家完整等待收益。
