# Rust RP1 大存档读取缓冲｜开发中

Role: develop。承接运行态来源入口和后台测试阶段；未发布。云端已编译正常优化 Host，但整组门禁失败，未取得合格 Host 制品或生成新安装包。

## 后续轻量验证

`840ec68d` 的真实 v47 模块 12/12 通过（含新增 3 项），命令保留 release 的其余设置，仅以 `--config profile.release.package.dsp-native-core.opt-level=0` 关闭本 crate 的编译优化。同一 524,708 字节回归夹具现满足最多 9 次非空来源读取，完整结果与校验相同。单编译任务、低优先级、单测试线程，并以 1.5 GiB 剩余内存设自动终止线；此次约 77.7 秒，观测最少可用内存 2,147,032 KiB，没有触发停止。证据为原工作区 `artifacts/rust-rp1-next/v47-buffer-low-memory-v1/{stdout.log,stderr.log,receipt.json}`。Cargo 的日志仍显示 release，不可忽略明确的 opt-level=0 覆盖而称正式优化构建通过。

本机内存仍不足以安全重复正式优化构建，新增 [Windows 云端验证工作流](../../.github/workflows/native-windows-validation.yml)，使用同一仓库独立 RP1 分支、Rust 1.96.1、正常 release 优化和公开测试数据。工作流依次运行 fmt、严格 Clippy、完整 Rust workspace、Windows Host、完整 Native 工具、类型检查与完整游戏单元；失败保留日志，仅全部成功后上传 Host 及精确提交/哈希回执。不接触玩家档，不构建发布包或部署。

工作流提交 `74b57f1e4e6d235a216e0382a4455382c0f66377` 已推到 `codex/rust-rp1-after-1.2.7`，推送时 main 为 `9f4ac5c3`。[首次云端运行](https://github.com/snowsnow0926/DSPONLINE/actions/runs/34268571075)（job `102204086329`）已结束，结论为失败：fmt、严格 release Clippy、完整优化 Rust workspace **1,363 通过 / 5 ignored / 0 失败**及 Host 构建通过；Native Node **673 通过 / 1 失败 / 1 跳过 / 0 取消**。类型检查和完整游戏单元没有执行，合格 Host 没有上传。仅保留诊断 artifact `10073972545`，ZIP SHA-256 `0ad2f00d0aa87c108d6ef5c15768ccd34bd937c29042bc77d47c3096971ba205`；完整 job 日志在原工作区 `artifacts/rust-rp1-next/cloud-ci-74b57f1e-job.log`。

唯一 Native 失败是 Windows 超时进程树清理集成测试：`scripts/benchmark-native-core-fixed-affinity-ab.test.mjs:817` 的 PID 文件存在断言失败。此前超时分类、临时执行目录删除断言已通过，但六进程夹具没有提供启动记录，不能称进程清理已经验证或认定是 Rust 崩溃。本机原样独立执行 **1/1 通过**（约 17.2 秒）；只增加真实 spawnSync 返回值观察、保留原启动参数、8 秒请求加 250 ms 宽限及全部断言后，也 **1/1 通过**，两次均在约 8.27 秒超时前产生 PID 文件。原始与观察日志分别为 `ci-launcher-original-local-v1.log` 和 `ci-launcher-instrumented-local-v1.log`。

本机额外比较有效及超出本机 CPU 数的 START affinity，两者均能启动夹具并正常验证超时退出，未支持“亲和掩码单独导致失败”的假设。新增[轻量云端诊断](../../.github/workflows/windows-launcher-diagnostic.yml)和[观察脚本](../../.github/diagnostics/windows-launcher.mjs)，采集同一原测试的实际启动结果及云端 CPU 信息；只运行公开测试，不再次编译 Rust。该云端诊断尚待执行，不提前放宽断言或产品超时。

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
