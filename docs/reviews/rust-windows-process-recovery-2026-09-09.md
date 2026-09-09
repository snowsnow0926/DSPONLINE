# Windows Rust：独立测试进程退出后的命令恢复

2026-09-09，Role: develop。基线 `4bc774d6ef24e74d0cf50b0176a3f09eea245c4b`，分支 `codex/rust-rp1-after-1.2.7`；完整 Windows Goal 继续 active。本批不改变生产 Host、玩家存档格式或实时准入。

## 比上一批多验证了什么

此前恢复测试是在同一测试进程中 drop/open。新增 `core_runtime_process_recovery_tests.rs`，仅通过 `cfg(test)` 内 include 引入：对 stage、WAL、checkpoint、receipt、lease acknowledge 五个持久边界分别启动三个独立子进程。第一个触发既有故障钩子后直接 exit；第二个从磁盘恢复后直接 exit，模拟恢复响应未送达；第三个再次重建、重试相同命令并推进下一 tick。

父测试逐次要求指定退出码和带阶段的实际回执。恢复后的 revision/sequence、canonical/domain SHA-256 与正常 Rust 执行对照一致；重试命令明确为 duplicate，没有重复递增，下一 tick 正确，最终 lease 没有 pending command。另验生产默认 coverage 仍拒绝启动恢复且不改已确认 lease。一次父测试经过 5 个边界、15 次独立子进程调用，不能把这些调用算成 15 个独立玩法覆盖项。

子进程使用当前 Rust 测试 EXE，Windows 指定 CREATE_NO_WINDOW 与 BELOW_NORMAL_PRIORITY_CLASS；只接收父进程创建的临时合成存档和所属标记，没有 Electron 或玩家 profile。辅助入口默认 ignored，父测试通过精确名称和 --ignored 显式执行它；父测试本身不忽略。

**这是既有故障钩子返回错误后，独立进程直接退出，未运行 SaveStore/CoreRegistry 析构；方法内部的错误返回仍会正常展开调用栈。不是写盘中途断电、指令级随机强杀、正式 Host JSON-RPC 或 Electron/main 的接管验收。** 初始租约仍由夹具直接建立，恢复资格仅用 cfg(test) 开关，命令为位置字段的合成变更；对照为同一 Rust 引擎，不能推导完整物资守恒、独立 JS 等价或正式包资格。

## 最终结果与证据

- 完整正常 release Host：库 **253 pass / 1 ignored / 0 fail / 0 filtered**，入口 **3/3**，合计 **256 pass / 1 ignored / 0 fail**。唯一 ignored 是上述子进程驱动入口，父测试实际覆盖它。fmt、直接 rustfmt 及严格 release workspace/all-targets Clippy 通过，见[完整记录](../../artifacts/rust-rp1-loop/process-recovery-full-v1.json)、[日志](../../artifacts/rust-rp1-loop/process-recovery-full-v1-guard/stdout.log)和[守护](../../artifacts/rust-rp1-loop/process-recovery-full-v1-guard/guard.json)。守护正常退出 0，195.9636414 秒，最低空闲 7,855,352 KiB，6/2 GiB。
- 新测试源码 SHA-256 `06d3c3cbf56366f4b3f6c27310a6c14bd14ec097d919168f7866414d4eaf3f2b`；上层 core_runtime SHA-256 `c6b49dc2b882907566102462345f9fd47d3b4e8b519464feae7eef4b0745a2c7`。早期独立专项也通过；最终完整运行已包含移除跨子进程 PID 不等断言的版本，避免将操作系统合法 PID 复用误判为失败。
- 采集器增加第八项并区分恢复方式。实际[最终报告](../../artifacts/rust-rp1-loop/realtime-foundation-run-v3/foundation-report.json) **8/8**：七项保留 `registry-reopen-in-test-process`，新项为 `abrupt-exit-in-owned-child-processes`，都仍是 `rust-host-library-test`。报告 TEST_ONLY，资格/Host/ASAR 为空、authority/release false。采集[守护](../../artifacts/rust-rp1-loop/realtime-foundation-run-v3-guard/guard.json) 正常退出 0，7.3258449 秒，最低空闲 9,753,884 KiB，6/2 GiB；不是游戏性能成绩。
- 实际测试 EXE 22,119,424 字节，SHA-256 `e257edbe2f985a9bd90a69a3cd54568076a02a1413ab071cf42e7872d0af7cba`；采集器 SHA-256 `7a40baecf2a31c1beebf7091de3c1defc8da943759bfba85e10ac171760dfc70`。[独立核验](../../artifacts/rust-rp1-loop/process-recovery-collection-audit-v1.json) 重验 89 个源码/依赖、程序与全部日志大小/摘要及两种恢复分类。来源如实记录 4bc 基线与 dirty 输入，不是干净正式包。
- 工具/CLI/既有链接入口/后台策略[最终专项](../../artifacts/rust-rp1-loop/realtime-foundation-tools-v4-guard/stdout.log) **82/82，0 skip / 0 fail**。[守护](../../artifacts/rust-rp1-loop/realtime-foundation-tools-v4-guard/guard.json) 正常退出 0，7.3581965 秒，最低空闲 10,408,556 KiB，轻量 3/2 GiB。零游戏窗口，本机重任务串行，没有操作玩家原档。

## 4c3 云端终态（独立于本批）

[Windows 全部步骤通过](../../artifacts/rust-rp1-loop/cloud-4c3-native-windows-v1.log)：正常 release 核心 1,113/5 ignored、Host 252+3、Native 730/1 skip、游戏单元 3,173/39 skip，全零失败；ASAR 写入完成修复通过实际 Windows 检查。[Linux 单元](../../artifacts/rust-rp1-loop/cloud-4c3-unit-v1.log) 3,171/41 skip，类型/许可证/生产构建通过；[Server/Ops](../../artifacts/rust-rp1-loop/cloud-4c3-server-native-v1.log) 在 Ops 链接入口检查失败，后续 Rust/Native 跳过，已在 4bc 修复。

浏览器[第一组](../../artifacts/rust-rp1-loop/cloud-4c3-shard1-v1.log) 192 pass/11 skip/27 fail/17 flaky，[第二组](../../artifacts/rust-rp1-loop/cloud-4c3-shard2-v1.log) 211 pass/22 skip/5 fail/3 flaky，完整 **403 expected / 33 skip / 32 unexpected / 20 flaky**。整体不能发布；不能用 Windows 单独通过替代完整浏览器回归。4bc 及本批新提交的云端结果仍按各自终态记录。

## 后续

下一步从这些库层恢复证据推进实际 Host RPC/桌面单所有者交接，继续具体化正式资格载体与验证；同时收口 RP1 大档完成入口和浏览器失败。暂停、tick、保存退出的其他真实进程边界、完整玩法、性能/内存、长测、硬件与发布候选都仍未全部验收。见[完整执行目标](../rust/windows-full-development.md)。

本批没有新增玩家提速比例；`authority_eligible=false`、1–30 秒采用范围、网页/安卓 Rust 后续范围与生产版本不变。
