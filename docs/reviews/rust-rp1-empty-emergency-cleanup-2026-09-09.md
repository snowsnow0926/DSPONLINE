# Windows Rust：无应急记录时省去整档解析

2026-09-09，Role: develop，完整 Windows Goal 保持 active。独立开发分支；本批改变共享保存末尾的清理成本，没有开放 Rust 实时权威，也没有发布客户端。

## 原因与改动

`saveGameVerifiedOnce` 在主档持久验证后调用 `clearPrimarySaveEmergencyMirror(raw)`。旧实现即使不存在应急副本，也先解析整份 committedValue 来确定普通/竞速模式；大档会产生一次额外的完整对象树。

现在仅在普通与竞速的 payload、metadata 均不存在，且 IndexedDB 已知键和当前缓存均不含旧 speedrun emergency 键时直接返回。任何现存记录仍走原来的模式判断、写者链、时间和精确字节检查；metadata-only 孤立条目仍需清理，缺少 metadata 的 payload 仍保留。没有移除完整主档校验、持久读回、旧档备份、快照或写者 fencing。

## 验证记录

- [修复前反例](../../artifacts/rust-rp1-loop/emergency-cleanup-red-v1.json)：3 通过 / 1 失败；空应急记录下，两种模式合计发生 2 次完整 committedValue 解析，预期应为 0。原失败保留。
- [修复后专项](../../artifacts/rust-rp1-loop/emergency-cleanup-green-v1.json)：4/4，空记录的完整解析为 0，localStorage 不变；更新的副本、外部写者副本、精确副本、metadata-only、缺 metadata 和旧版 speedrun 路径均有行为检查。
- [最终五项专项](../../artifacts/rust-rp1-loop/emergency-cleanup-green-v2.json)：5/5，另补两种模式都没有 payload、只剩当前模式 metadata 的独立场景；正常退出 0，无失败或重试。
- [现有浏览器回归](../../artifacts/rust-rp1-loop/emergency-cleanup-regression-v1.json)：32/32，覆盖写者协调、容量保护、正常关闭及权威保存持久化；单 worker，无重试，无头静音。
- [完整验证](../../artifacts/rust-rp1-loop/emergency-cleanup-validation-v1.json) PASS：本机游戏 3,174 通过 / 39 条件跳过 / 0 失败，类型和 Web 构建及原门禁均通过。真实 release Host 摘要保持 ef56b807；生产改动前后摘要保持 d53b7ee0。守护正常退出 0，503.1589115 秒，最低空闲 4,701,972 KiB。随后仅追加了独立 metadata-only 浏览器反例，生产源码未变。
- [最终账目核验](../../artifacts/rust-rp1-loop/emergency-cleanup-final-audit-v1.json) PASS，绑定 19 份报告/守护/驱动/云端日志摘要，生产模块 d53b7ee0 与最终五项测试 af7d396d；后续测试补充没有改变已验证生产源码或 Host。轻量核验守护 3 GiB 启动 / 2 GiB 停止，正常退出。

## 原始终局档 A/B

[实际 Chromium 对比](../../artifacts/rust-rp1-loop/emergency-cleanup-private-ab-v1/report.json) PASS。使用注册原始终局 envelope（107,637,967 bytes），只读 loopback 传输，分别加载 git 冻结的 6500010 旧生产模块和当前模块；每次独立浏览器 context、真实 IndexedDB、无应急记录。两个预热不计入，三对按 AB/BA/AB 串行执行，计时仅覆盖 cleanup 函数，GC 在计时外。

旧函数每次解析完整正文 1 次，新函数 0 次，所有 localStorage 前后不变。中位 **283.5 ms → 0.1000001 ms，少约 283.4 ms**。新值接近浏览器计时精度，不据此报夸张倍数。原文件大小、mtime、SHA-256 及候选模块摘要未变。[守护](../../artifacts/rust-rp1-loop/emergency-cleanup-private-ab-v1-guard/guard.json) 正常退出 0，21.2743904 秒，最低空闲 7,794,364 KiB，6 GiB 启动 / 2 GiB 停止。

这是约 0.28 秒的局部收益，**不足以把先前 2 秒多主线程长任务归因于这一函数**；完整保存和入口仍有其他成本，不能把它加到既往百分比里。完整主档/备份/快照验证另列，不用单函数计时冒充实际桌面采用或峰值内存改善。

## 完整保存正确性

[终局完整保存诊断](../../artifacts/rust-rp1-loop/private-save-stages-v10/report.json) PASSED：真实 IndexedDB 主档与完整重新序列化的预期逐字节一致，旧档备份精确保留、快照全状态一致，3 条 record/catalog 的字节数准确；主线程大型重复 TextEncoder 分配仍为 0。写者以正常关闭接口及 AbortSignal 释放成功，玩家原文件未变。

这次单次完整保存耗时 **20,825.2 ms**，序列化约 5,956.3 ms、主档写入 4,578.2 ms、备份 5,714.5 ms、自动快照 4,018.2 ms；各项由原生产计时采集。它与旧记录不是配对采样，不能宣称完整保存更快，仍观察到约 2.9 秒长任务。[守护](../../artifacts/rust-rp1-loop/probe-private-save-stages-v10-guard/guard.json) 正常退出 0，45.5820838 秒，最低空闲 6,212,700 KiB；浏览器无头、静音、低优先级，重任务串行。此诊断没有执行实际 Windows 菜单或重开闭环。

## 上一冻结包的追加诊断

[a6 冻结包 v9](../../artifacts/rust-rp1-loop/private-packaged-complete-v9/report.json) 沿用原 90 秒入口 / 25 秒关闭门槛，仅扩展 Worker 与关闭的观察信息。仍在 `wait-for-active-factory` 超时，此次 Worker 尚未创建，快照重包约在入口 89,812.3 ms 才观察到。实际 9 秒 Native 请求 49,165.1841 ms，exact=9、approximation=0、sourceClosed；候选 canonical 与固定 9 秒参考相同。

此次两次正常关闭均 exit 0，无强制清理；不能覆盖 [v8 的正常关闭失败](./rust-rp1-a6a37b00-package-2026-09-09.md)。两次都没有完成成功入口后的完整 JS 对照、持久主档独立核验和两次重开。原玩家文件未变；隐藏、不可聚焦、静音、离屏策略保持。

## 资格与下一步

本改动减少共享保存的一项冗余工作，不代表完整 Windows Rust 已完成。下一步仍须用冻结的新 Windows 包验证原 90 秒完整入口、独立完整状态、持久写档、正常关闭及两次重开；同时继续 Rust 精确模拟、实际单所有者、长离线、兼容性和发布矩阵。

上一 a6 的 [Windows 完整工作流](https://github.com/snowsnow0926/DSPONLINE/actions/runs/34325748689) 已终态成功：核心 1,113/5 ignored、Host 253+3/1 驱动 ignored、Native 750/1 skip、游戏单元 3,174/39 skip，均零失败。Linux 生产构建、单元 3,172/41 skip、Server/Ops/Native 也通过；[两组浏览器](https://github.com/snowsnow0926/DSPONLINE/actions/runs/34325748609)总计 413 expected / 33 skip / 28 unexpected / 14 flaky，不能按失败数波动判断修复或回归根因。完整日志留在本机 artifacts，新的保存改动仍需自身的云端与冻结包验收。详见[完整进度](../RUST_WINDOWS_FULL_PROGRESS_2026-09-09.md)。
