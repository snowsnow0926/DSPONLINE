# Rust RP1 大存档读取缓冲｜开发中

Role: develop。承接运行态来源入口和后台测试阶段；未发布，未生成新的 Rust Host 或安装包。

## 后续轻量验证

`840ec68d` 的真实 v47 模块 12/12 通过（含新增 3 项），命令保留 release 的其余设置，仅以 `--config profile.release.package.dsp-native-core.opt-level=0` 关闭本 crate 的编译优化。同一 524,708 字节回归夹具现满足最多 9 次非空来源读取，完整结果与校验相同。单编译任务、低优先级、单测试线程，并以 1.5 GiB 剩余内存设自动终止线；此次约 77.7 秒，观测最少可用内存 2,147,032 KiB，没有触发停止。证据为原工作区 `artifacts/rust-rp1-next/v47-buffer-low-memory-v1/{stdout.log,stderr.log,receipt.json}`。Cargo 的日志仍显示 release，不可忽略明确的 opt-level=0 覆盖而称正式优化构建通过。

本机内存仍不足以安全重复正式优化构建，新增 [Windows 云端验证工作流](../../.github/workflows/native-windows-validation.yml)，使用同一仓库独立 RP1 分支、Rust 1.96.1、正常 release 优化和公开测试数据。工作流依次运行 fmt、严格 Clippy、完整 Rust workspace、Windows Host、完整 Native 工具、类型检查与完整游戏单元；失败保留日志，仅全部成功后上传 Host 及精确提交/哈希回执。不接触玩家档，不构建发布包或部署，云端结果待实际运行。

以下保留先前失败和边界记录；正式优化 Host、终局复验及完整 UI 等待仍未完成。

授权终局档的只读副本经现有 JS 校验和运行态流式传输进入旧 Host 后，在原 300 秒请求期限内未返回候选。诊断使用 1 秒绑定时钟，不是实际 UI 等待配对。原文件字节数、修改时间和 SHA-256 在结束后保持不变；本次临时 Host 已终止，原失败证据保留在开发 worktree 的 `artifacts/rust-rp1-loop/private-runtime-source-v1/report.json`。报告不含玩家存档内容。不能据此认定唯一超时原因已经查明。

代码定位：serde_json 的 Read 解析器逐字节读取，原 BoundedHashReader 直接委托来源；Host 普通 JSON 文件来源没有缓冲。新增公开回归夹具包含有效信封及跨多个分块的合法尾部空白，共 524,708 字节。改动前实际 release 测试计数为 524,708 次非空底层读取，原样断言失败，日志为原工作区 `artifacts/rust-rp1-next/v47-buffer-before-test-v2.log`。

当前候选在 BoundedHashReader 内层加入 64 KiB BufReader，只减少底层读取次数。哈希、字节上限及 UTF-16 检查仍跟随解析器实际消费的字节，避免预读到后方孤立代理字符后改变前方语法错误分类。新增回归同时检查完整解析结果/哈希不变、最终 EOF 读取错误仍拒绝、未消费的代理字符不影响错误分类。格式和 256 MiB 上限未改，不放宽 300 秒超时或 1–30 秒采用资格。

**验证尚未完成**：首次新增测试的 Cargo 命令遇到 rustc 访问异常 `0xc0000005`，仅库构建失败；随后指定 `--lib` 的原配置测试实际运行并复现上述逐字节失败。修改后的 release 测试编译使用单任务、低于正常优先级，检测到系统可用内存降至 654,868 KiB 时，主动终止本任务编译器以保护用户正在进行的工作。该次退出 `0xffffffff` 是主动终止，不是测试断言或产品运行崩溃；日志 `v47-buffer-after-tests-v1.log` 不能记为通过。

后续完成正式优化配置的 v47 模块测试、完整 Rust release、Host 文件身份/EOF/gzip 与实际 JS 全状态对照、严格 Clippy，并基于干净提交构建 Host 后复测授权终局档。重型测试必须后台、低优先级、限制并发且留足内存；不要终止用户其他进程来制造测试资源。没有通过这些检查前，本提交只属于待验开发候选，不能把读取次数改善换算成玩家完整等待收益。
