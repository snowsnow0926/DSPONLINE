# Windows Rust：内存采样计入读取开销

2026-09-09，Role: develop。完整 Windows Goal 继续 active；本批只改变测试与性能证据采样器，不改变游戏或 Rust Host。

## 问题与修复

[863 Windows 云端](../../artifacts/rust-rp1-loop/cloud-863cf76e-terminal-summary.json)正常 Rust/Native 已通过，最后游戏检查有一项采样器失败：目标 50 ms，观测 p95/max 为 101 ms，超过原 p95 100 ms 上限。

[采样器](../../src/game/nativeCoreRealSaveBenchmark.test.ts)原先每次读取后固定睡 50 ms；读取、PowerShell 调用与调度开销会再叠加。现在依据上一条真实 Stopwatch 时间戳计算剩余周期，只等待尚未经过的时间。读取较慢时不增加固定睡眠；所有实际间隔仍原样记录，超时或调度延迟仍可能使本次证据被拒绝。

没有改变目标 50 ms、p95 ≤ 2×interval、max ≤ 5×interval、用例原 20 秒时限、真实 PID 的 Win32 private-commit 指标、读数错误或正常关闭判断。也没有增加虚构样本、重写时间戳或把失败解释为通过。云端那次 101 ms 的具体开销分布仍无采样记录，不能断言已复现了相同机器上的全部原因。

## 旧代码反例与修复验证

新增调度契约测试为实际 Win32 读数注入固定 60 ms 的返回开销。该参数仅供测试内部调用，默认始终为 0，正式性能采集调用不传它；这不是实际 Native 内存性能样本。

[旧固定睡眠反例](../../artifacts/rust-rp1-loop/windows-memory-sampling-red-v1.json) **0 pass/1 fail**，观测 p95/max 137 ms；其余 8 项未选择，不计通过。旧调度源 SHA-256 `6610537f4302219b3a19dfe1fa11e3310dcac5ffe90b8b9a4824b7304f9fdc05`。[反例守护](../../artifacts/rust-rp1-loop/windows-memory-sampling-red-v1-guard/guard.json)FAILED/exit 1、stopReason=null，7.944122 秒，最低空闲 9,202,244 KiB。

[修复验证](../../artifacts/rust-rp1-loop/windows-memory-sampling-green-v1.json)通过：

- 完整文件 **8 pass/1 opt-in benchmark skip/0 fail**。
- 普通读数与注入读取开销的两项核心测试各三轮，**6/6 通过**；后两轮未选择的其他案例不计通过。
- 三个内存/性能证据策略工具测试文件全部 exit 0，类型检查 exit 0。
- 修复源 SHA-256 `8cd1dd82290d284f801af383f55338c5202c2d46b7b0922d0efc3da70f4ed561` 前后不变。

[修复守护](../../artifacts/rust-rp1-loop/windows-memory-sampling-green-v1-guard/guard.json)正常 exit 0，157.6783313 秒，最低空闲 8,138,148 KiB，6/2 GiB。重任务串行、后台隐藏；没有启动游戏窗口。

## 范围

本机结果尚需自己的 Windows 云端复验，不消除 863 的失败记录，也不证明 Native 已有全流程内存收益。游戏运行代码与[629 冻结包](./rust-rp1-629accab-package-2026-09-09.md)一致，因此没有为这一测试采样器改动重复构建桌面或 Rust；629 的实际 9 秒终局入口仍超原 90 秒，完整保存/重开未通过。

后续继续减少完整保存/目录校验成本，以及可信资格、实际实时单所有者、完整玩法和复杂长离线、同包性能/内存/线程矩阵、长测及 Windows 安装升级回退。完整目标没有因这项验证修复而缩小。
