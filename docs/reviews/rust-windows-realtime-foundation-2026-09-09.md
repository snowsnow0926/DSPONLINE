# Windows Rust：实时核心实际测试证据采集

2026-09-09，Role: develop。基线 `4c3b1953cbbccfbde511861e8aafeb69625b7236`，分支 `codex/rust-rp1-after-1.2.7`。完整 Windows Goal 保持 active；本批推进 RP2 的开发证据生产，不开放玩家权威或发布。

## 实现与范围

新增 `scripts/native-realtime-foundation.mjs`，通过 Cargo JSON 识别正常 release 的真实 Host **库测试程序**。固定运行七个已有 Rust 测试，每项单独启动测试进程，要求准确名称、恰好一次执行、1 passed / 0 failed / 0 ignored 和退出码 0。零选中、错误目标、debug/优化覆盖、重复或失败账目都拒绝。

记录源码及依赖助手的逐文件大小/摘要、Git 基线与 dirty、rustc 版本、实际测试 EXE 摘要/profile、原始日志字节摘要、退出码和时间；结束前重验输入。每个子进程输出最多保留 8 MiB，输出超限不能通过；新目录限于仓库 artifacts 下，不能覆盖旧证据或穿过链接/联接。本机维持 6/2 GiB 进程树守护，CI 维持原作业截止时间。

七项验证 tick 持久链/幂等、命令与 tick 共同顺序/幂等、暂停恢复与时钟、暂停各持久边界、已确认会话及丢失 hello 后重建、重建前重新检查资格、检查点失败后保留可恢复 WAL。完整名称和原始输出见[实际报告](../../artifacts/rust-rp1-loop/realtime-foundation-run-v2/foundation-report.json)。

夹具使用实际 Rust 库与临时 SaveStore，但直接准备/激活租约，部分恢复只在同一进程内 drop 后重新打开，命令含合成元数据变更。**它们没有证明 Electron/main 交接、真正 Host 被杀后冷恢复、完整物资守恒、独立 JS 全状态对照、性能或正式包资格。** 每项记录 `rust-host-library-test` / `registry-reopen-in-test-process`；类型为独立 `native-realtime-foundation-v1`、TEST_ONLY，包/ASAR/scope 为空，authorityEligible/releaseAllowed 永远 false，不能转成 12 项全绿资格。

## 最终验证

- 采集器 SHA-256：`f82724df2096287570a2a2c5281420faf90ed5cb1eccd4307f796cdd7d5d43ae`。
- rustc `1.96.1`、`x86_64-pc-windows-msvc`；release 库测试 EXE 22,083,584 字节，SHA-256 `c8e3527a1923b6956ad6602948845cc4bb96ac30863c458385ba785d90bc2bbe`。它**不是待发布 Host**。
- 最终实际 Rust **7/7，无忽略/失败**。[守护](../../artifacts/rust-rp1-loop/realtime-foundation-run-v2-guard/guard.json) 正常退出 0，4.7056539 秒，最低空闲 9,902,312 KiB。复用正常构建产物，时长不代表全新编译或游戏性能。
- v1 首次编译/七项运行通过，391.1063635 秒、最低空闲 6,339,176 KiB。随后修改 CLI 和摘要范围，最终采用 v2，不把两次相加成 14 项不同覆盖。
- [最终工具专项](../../artifacts/rust-rp1-loop/realtime-foundation-tools-v3-guard/stdout.log) **82 通过 / 0 跳过 / 0 失败**：采集器/CLI 20、检查器 53、既有链接入口 3、后台策略 6。[守护](../../artifacts/rust-rp1-loop/realtime-foundation-tools-v3-guard/guard.json) 正常退出 0，7.3837581 秒，最低空闲 7,808,648 KiB，轻量 3/2 GiB。
- [独立核验](../../artifacts/rust-rp1-loop/realtime-foundation-verification-v1.json) 重验 88 个输入文件、测试程序和全部日志的大小/摘要，校验 CI 步骤顺序、失败传播/诊断上传。输入如实记录 `dirty=true`，不是干净提交或实包验收。

本批 Rust 运行代码未改，不把上一批 1,113 项完整核心当作新成绩。零游戏窗口、低优先级、重任务串行，没有操作玩家原档。

## 云端发现与修复

4c3 的 [Server/Ops 日志](../../artifacts/rust-rp1-loop/cloud-4c3-server-native-v1.log) 在“CLI 不得仅按路径字符串判断主入口”检查失败，准确指出 `scripts/native-qualification-evidence.mjs`。Server 通过，后续 Rust/Native 因 Ops 失败跳过。

修复为比较双方 realpath，解析失败保持导入无副作用；新采集器也使用同一模式。真实目录链接/Windows 联接测试要求：无参数直接调用报 usage 并退出 1，导入静默成功。原失败检查和两个新行为测试均通过，原门槛未删。

Windows CI 在完整优化 Rust workspace 测试后采集 TEST_ONLY 结果，再继续原 Host 构建、工具、游戏单元和制品验证。失败仍停止正常后续步骤，诊断 always() 上传。当前提交的干净云端采集待执行，4c3 其余结果按实际终态另记。

## 下一步

将进程内恢复推进到独立子进程在持久边界退出后的恢复，再补正式资格和实际桌面交接。RP1 大档入口、完整浏览器回归及完整玩法/性能/发布候选继续按[完整目标](../rust/windows-full-development.md)执行。

实时 `authority_eligible=false`、短离线自动采用 1–30 秒、网页/安卓 Rust 后续范围不变；本批无新增玩家性能百分比、正式 Windows 包或生产部署。
