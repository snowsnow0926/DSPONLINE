# Rust RP1 大存档读取缓冲｜开发中

Role: develop。承接运行态来源入口和后台测试阶段；未发布。现已取得本机正常优化 Host 并完成公开三对收益验证；整组云端门禁仍有失败，新安装包和终局完整结算待验。

## 当前已验证的收益与终局限制

干净源码 `6bf9f983bcbc4593ceb9761f22c30217c2400a67` 使用本机 rustc 1.96.1 正常 release 构建（不覆盖 opt-level，CARGO_BUILD_JOBS=1）。约 348.08 秒正常退出 0，最低可用内存 6,331,760 KiB，未触发资源停止。17,878,016 字节 Host SHA-256 为 `1f19d28a92702096492293b8cde667252dc44859790b4a3055230122851ef80a`，另冻结为原工作区 `artifacts/rust-rp1-next/buffered-host-6bf9f983-frozen-v1.exe` 并复核摘要。构建回执 `buffered-host-release-build-local-v1/receipt.json` 只证明构建，不授予发布资格。

基线仍为历史本机正常 release 的 `f7f10391` / `a9019611…`。两者原生源码差异只有 v47 读取缓冲和覆盖清单；本次两种对照均在同机执行，不能称作新云端二进制测量。基线不是这次重编译的二进制，各自来源和构建回执独立保留。

公开 9,107 实体 / 20,000 带工厂：文件 4,143,963 字节，运行态传输 10,234,284 字节，候选 11,051,481 字节。每种试验按 AB / BA / AB 三对独立进程执行，Host 两线程、低优先级且外部内存监控。完整文件导出状态、检查点身份、原文件及正常退出全部通过；运行态试验则六次完整 JS 状态一致、源状态/原文件不变、临时目录清理及正常退出 0/null 全部通过。

| 计时范围（ms） | 基线三次 | 候选三次 | 基线→候选中位 | 缩短 |
| --- | --- | --- | --- | --- |
| 文件导入 RPC | 5177.225 / 5149.607 / 5196.664 | 401.189 / 396.772 / 402.497 | 5177.225→401.189 | 92.25% |
| 运行态候选请求，含返回及正常关闭 | 16951.955 / 16966.712 / 17072.504 | 1758.028 / 1777.202 / 1754.216 | 16966.712→1758.028 | 89.64% |
| 诊断来源验证至完成 JS 对照 | 18850.036 / 18842.443 / 18909.741 | 3562.033 / 3608.260 / 3565.578 | 18850.036→3565.578 | 81.08% |

后两行使用 savedAt + 1 秒的绑定诊断时钟。第三行包含测试专用 JS 参考计算；三行都不是 UI 完整等待，也不是长离线或终局档完成收益。报告位于开发 worktree `artifacts/rust-rp1-loop/public-v47-read-pairs-v2/report.json`、`public-runtime-source-{baseline,candidate}-p{1,2,3}-v2/report.json`、各自 `-guard/result.json` 及 `public-runtime-source-pairs-v2-summary.json`。两种驱动 SHA-256 分别为 `ab29e9a049e3710d9de0b7f055ca797ea0d5ec3d1e2d9b72adf1481933a444d3`、`02aa5abb448983c469aacdeb43c93b79ffdd077584dd1ac0e686c77e4a85ae2d`；历史 v1 驱动摘要不复用给本次。

新本机 Host 原文件前后 SHA 固定，串行运行 `desktop/native-host.integration.test.cjs`、`desktop/native-offline-runtime-source.test.cjs`、`desktop/background-smoke-policy.test.cjs`：**49 通过 / 0 失败 / 0 跳过 / 0 取消**，约 46.76 秒正常退出。日志与监控为 `artifacts/rust-rp1-loop/buffered-host-local-integration-v1/`。没有启动实际 Electron 窗口，旧 33d 小工厂的 UI 通过不作为新 Host UI 通过。

授权终局原档以既有 6 GiB 启动余量、独立内存监控和原 300 秒 Host 期限运行 **private-runtime-source-buffered-v1**，本次 **FAILED**：110,042 实体 / 233,300 带，实际传输 **200,841,424 字节**，Host 明确返回 `offline-macro-time-warp-active`，prepared=false。外层约 32.11 秒结束，最低可用内存 5,452,916 KiB，未触发资源停止；来源完整校验不变，临时目录清理通过，Host 正常退出 0/null。原 300 秒超时失败保留；当前拒绝与旧超时不是完成同一工作的新旧性能样本。没有禁用玩家 timeWarp 或放宽准入，尚未取得这份原始终局来源的完整候选。证据为相应 `report.json` 与 `-guard/result.json`，不含玩家存档内容。

独立云端 JS 诊断 run `34280286908` / job `102243130724` 已结束：原两个文件 **31 通过 / 2 失败 / 0 跳过**。有限矿脉宏结算实际 2,386.167 ms，要求低于 2,000 ms；递归建设参考例约 5,147.622 ms，触发默认 5 秒超时。四逻辑处理器、Node 24.19.0，文件 SHA 与未修改原测试一致。artifact `10077352510` 已取回并核对 ZIP SHA `72dba341336b15edbf0606734e5f2418d36945d473c24ec79ea1d3a875d1afc4`，本地 `cloud-game-timing-6bf9f983.zip`。新完整 run `34280286855` 当前仍在正常优化 Rust 测试步骤，不记为通过；未改变原断言。

下一阶段为大工厂真实离屏 UI 完整等待配对与取消、保存、重开；同时处理时间加速来源的精确兼容边界及两项 JS 计时失败。历史堆异常根因仍未确定。超过 30 秒采用和实时资格继续关闭。[本批易读报告](../RUST_BATCH_REPORT_2026-09-09_BUFFERED.md)区分已测收益与未完成范围。

以下保留各次早期诊断的当时状态；“未取得新 Host”“尚未运行对照”已经由上方本机新证据更新。

## 后续轻量验证

`840ec68d` 的真实 v47 模块 12/12 通过（含新增 3 项），命令保留 release 的其余设置，仅以 `--config profile.release.package.dsp-native-core.opt-level=0` 关闭本 crate 的编译优化。同一 524,708 字节回归夹具现满足最多 9 次非空来源读取，完整结果与校验相同。单编译任务、低优先级、单测试线程，并以 1.5 GiB 剩余内存设自动终止线；此次约 77.7 秒，观测最少可用内存 2,147,032 KiB，没有触发停止。证据为原工作区 `artifacts/rust-rp1-next/v47-buffer-low-memory-v1/{stdout.log,stderr.log,receipt.json}`。Cargo 的日志仍显示 release，不可忽略明确的 opt-level=0 覆盖而称正式优化构建通过。

本机内存仍不足以安全重复大规模 Rust 测试编译，新增 [Windows 云端验证工作流](../../.github/workflows/native-windows-validation.yml)，使用同一仓库独立 RP1 分支、Rust 1.96.1、正常 release 优化和公开测试数据。工作流依次运行 fmt、严格 Clippy、完整 Rust workspace、Windows Host、完整 Native 工具、类型检查与完整游戏单元；失败保留日志，仅全部成功后上传最终 Host 及精确提交/哈希回执。后续另保留范围明确的待验候选，见下方改进。不接触玩家档，不构建发布包或部署。

工作流提交 `74b57f1e4e6d235a216e0382a4455382c0f66377` 已推到 `codex/rust-rp1-after-1.2.7`，推送时 main 为 `9f4ac5c3`。[首次云端运行](https://github.com/snowsnow0926/DSPONLINE/actions/runs/34268571075)（job `102204086329`）已结束，结论为失败：fmt、严格 release Clippy、完整优化 Rust workspace **1,363 通过 / 5 ignored / 0 失败**及 Host 构建通过；Native Node **673 通过 / 1 失败 / 1 跳过 / 0 取消**。类型检查和完整游戏单元没有执行，合格 Host 没有上传。仅保留诊断 artifact `10073972545`，ZIP SHA-256 `0ad2f00d0aa87c108d6ef5c15768ccd34bd937c29042bc77d47c3096971ba205`；完整 job 日志在原工作区 `artifacts/rust-rp1-next/cloud-ci-74b57f1e-job.log`。

唯一 Native 失败是 Windows 超时进程树清理集成测试：`scripts/benchmark-native-core-fixed-affinity-ab.test.mjs:817` 的 PID 文件存在断言失败。此前超时分类、临时执行目录删除断言已通过，但六进程夹具没有提供启动记录，不能称进程清理已经验证或认定是 Rust 崩溃。本机原样独立执行 **1/1 通过**（约 17.2 秒）；只增加真实 spawnSync 返回值观察、保留原启动参数、8 秒请求加 250 ms 宽限及全部断言后，也 **1/1 通过**，两次均在约 8.27 秒超时前产生 PID 文件。原始与观察日志分别为 `ci-launcher-original-local-v1.log` 和 `ci-launcher-instrumented-local-v1.log`。

本机额外比较有效及超出本机 CPU 数的 START affinity，两者均能启动夹具并正常验证超时退出，未支持“亲和掩码单独导致失败”的假设。[轻量云端诊断](../../.github/workflows/windows-launcher-diagnostic.yml)的[首次运行](https://github.com/snowsnow0926/DSPONLINE/actions/runs/34273964060)也复现 **0 通过 / 1 失败**：同一本机通过的观察脚本在 Windows Server 2025、4 CPU、继承 affinity F、Node 24.19.0 上，两次约 8.27 秒返回 ETIMEDOUT，PID 文件均未出现，标准输出/错误均为空。诊断 ZIP 已下载并核对 SHA-256 `3f4c5ae1581c9016b4dd7a26a750b624f3699ca27427edc72e66c7a94e5622ce`，保存于原工作区 `artifacts/rust-rp1-next/cloud-launcher-3175c02b.zip`。

定位时[观察脚本](../../.github/diagnostics/windows-launcher.mjs)增加显式 trace 与 production-grace 模式：前者保留原期限并记录 PowerShell 就绪、Add-Type 完成、Job 挂接完成时间；后者以实际 launcher 默认 30 秒启动宽限检查同一清理断言，并相应调整诊断测试外层时限。它们仅作问题定位，当时未修改生产 launcher、原测试、工作负载或六进程退出/临时目录删除断言。本机 trace **1/1 通过**，日志 `ci-launcher-instrumented-local-trace-v1.log`。此次诊断矩阵不再次编译 Rust、不使用私人数据。

上述矩阵现已结束：[运行 34274304585](https://github.com/snowsnow0926/DSPONLINE/actions/runs/34274304585)的 trace **0/1**，输出只到 PowerShell 就绪，8.25 秒期限内 Add-Type 未完成；production-grace **1/0**，同一 Add-Type 首次实际约 **26.391 秒**、第二次约 **0.200 秒**，两次均生成夹具 PID，原超时分类、六进程退出和私有执行目录删除断言全部通过，整例约 78.1 秒。整体 run 因保留旧短期限的反例而失败，不能标成整组全绿。完整日志为原工作区 `cloud-launcher-0a3f-{trace,production-grace}.log`（在 `artifacts/rust-rp1-next/`）。这说明原测试 250 ms 启动宽限不覆盖该 runner 的冷编译；没有证据把等待归为 affinity 或 Rust 计算故障。

据此修正维护中的集成测试：移除测试专用的 250 ms 覆盖，使用 launcher 已有默认 30 秒启动宽限；外层 Node 测试期限改为 100 秒以覆盖两次 8 + 30 秒启动及清理。实际 benchmark 请求超时、生产启动器和游戏 300 秒期限不变，全部退出和文件断言保留。轻量云端工作流接下来只执行修正后的原测试；历史 trace 模式仍可显式复现旧问题。完整原生工具及其后门禁仍待在修正后的提交上通过，不能拿诊断成功代替。

修正后本机完整 `benchmark-native-core-fixed-affinity-ab.test.mjs` **15 通过 / 0 失败 / 0 跳过**，约 77.5 秒，其中真实六进程清理例约 76.5 秒。执行 Node 使用低于正常优先级，未启动游戏窗口；日志 `artifacts/rust-rp1-next/ci-launcher-default-grace-local-v1.log`。这不是全部 Native 套件或云端门禁完成；[本批易读报告](../RUST_BATCH_REPORT_2026-09-09_BACKGROUND.md)分别说明后台收益与未完成的玩家性能验证。

修正提交 `056b9b0840eaeab14c3f7c9c8c44ec4a8b0ca7ea` 的[原测试云端复验](https://github.com/snowsnow0926/DSPONLINE/actions/runs/34274908998) **1/1 通过**，约 78 秒，两次均在 38 秒真实期限下生成 PID 文件并通过全部清理断言。日志在原工作区 `cloud-launcher-056b9b08.log`（`artifacts/rust-rp1-next/`）；诊断 artifact `10075350743`，ZIP SHA-256 `651da87135fc39cbbf5b5882c067ff4c69b2651f1baf642dd0bdb0c6cb65767b`。

[完整云端运行 34274908889](https://github.com/snowsnow0926/DSPONLINE/actions/runs/34274908889) / job `102225411083` **已结束，整组失败**：fmt、严格 release Clippy、完整优化 Rust **1,363/5 ignored/0 失败**、Host build、Native Node **674/1 跳过/0 失败**及类型检查通过；完整 Vitest **3,157 通过 / 2 失败 / 39 跳过**（394 文件通过、2 失败、14 跳过）。失败一是有限矿脉边界宏结算的耗时断言，实际约 2,298.95 ms、要求低于 2,000 ms，之前的资源/科研守恒断言已通过；另一是递归量子建设新旧完整状态对照超过框架默认 5 秒期限。原日志 `cloud-ci-056b9b08-job.log` 已保存；只有诊断 artifact `10076692516`，ZIP SHA-256 `4204dc4a1aed92e7dcb11de314aa043da34e4e6785cd16a0e9d9dfd3a1b33cad`，没有上传 Host。

本机按用户要求以低优先级、单 worker 原样运行上述两个完整文件，**32 通过 / 1 失败 / 0 跳过**：宏耗时约 2,197.33 ms，仍未满足原 2 秒断言；递归量子建设例约 4,916 ms，通过完整状态及批处理数量断言。证据 `cloud-game-failures-original-local-v1.{json,log}` 位于原工作区 `artifacts/rust-rp1-next/`。不能只凭这些结果把全部异常归为云端环境，断言和游戏代码暂未改变。新增[两文件云端原样诊断](../../.github/workflows/game-timing-diagnostic.yml)，无需重复编译 Rust。

为避免后续测试失败又丢失已编译的开发程序，工作流增加按原生 Git tree、构建脚本 blob、Rust 版本和 runner 镜像版本精确绑定的 `native/target` 缓存；仍执行全部编译检查与测试，不按缓存命中跳过断言。Rust/Native 检查通过后，另存明确标注“仅这些检查通过”的 `host-candidate`，供后续诊断；最终 Host 仍须全部门禁通过，并核对二进制未在游戏单元期间变化。缓存使用固定 SHA 的官方 [actions/cache v5](https://github.com/actions/cache/tree/caa296126883cff596d87d8935842f9db880ef25)，缺少镜像标识时不使用缓存。这些新流程尚待实际运行，当前仍没有新 Host 性能结果。

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
