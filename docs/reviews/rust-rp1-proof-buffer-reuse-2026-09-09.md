# Windows Rust 候选校验：复用编码与哈希视图

2026-09-09，Role: develop。基线 `98745e42be135fc58d249f8d5f5e1feb57e66253`，独立开发分支 `codex/rust-rp1-after-1.2.7`。本批优化 JS 侧跨语言状态校验，完整 Windows Goal 保持 active。

## 具体变化

`IncrementalSha256` 的 64 字节块地址固定，原先每次压缩仍创建 DataView；现在同一个哈希实例只保留一个块视图。`ProofWriter` 为 little-endian revision/float64 保留一个 8 字节缓冲和视图，每次同步写入哈希后再复用；原字段顺序、UTF-8、数值归一、revision 范围及全部校验保持。

仅注册终局档每个实体和传送带的三个数值字段，就有 1,030,026 次 float64 编码；原先每次创建缓冲与视图，现在复用当前 writer 的缓冲。这个数值来自代码调用次数与工厂规模，不是测得的峰值内存节省。没有把完整 canonical JSON 拼成新大字符串，也没有绕过任何摘要。

## 已完成的结果

- [两文件专项](../../artifacts/rust-rp1-loop/native-proof-scratch-tests-v1-guard/stdout.log) **16/16**。新增手写二进制 wire vector 由 Node crypto 独立计算预期摘要，覆盖跨 32 位及最大安全 revision、不同数值反复写入、负零、极值、非有限值、Unicode、符号顺序和输入不变；原跨 SHA 块/填充边界与 Native 离线准入测试保留。
- [完整原始终局档三对 A/B](../../artifacts/rust-rp1-loop/native-proof-scratch-v1/report.json)：110,042 实体、233,300 传送带，各实现一次预热后按 AB/BA/AB 测量；每次 GC 在计时外，预热不进入中位数。六次正式测量的 canonical/domain SHA-256 均与固定原档证据相同，内存中的状态及原文件大小/修改时间/SHA-256 检查不变。

| 调用 | 旧实现中位 | 候选中位 |
| --- | ---: | ---: |
| Canonical SHA-256 | 2,348.351 ms | 2,211.988 ms |
| Domain SHA-256 | 1,491.220 ms | 883.491 ms |
| 两类完整校验合计 | 3,871.110 ms | 3,097.598 ms |

合计中位减少 **773.5115 ms，约 19.98%**。三对合计分别为 3,921.401→3,110.310、3,839.571→3,097.598、3,871.110→3,073.953 ms。这里只测原始状态的完整校验调用，不是恢复后的候选状态、Rust 模拟、保存/菜单整体等待、帧率或全进程内存资格；不能直接把两次校验收益相加成玩家入口提速。

候选源码 SHA-256 `8bda027b917136fb4b85d158195b8063bdf1e1a2a71d10d23b97f27e8297890a`，专项 SHA-256 `a6ed7df131ce22fb5ed8ff5fd0afd311df4ea53f028184aa1e9837d4d09c7517`；基线与实际 bundle 摘要在报告中。A/B [守护](../../artifacts/rust-rp1-loop/native-proof-scratch-v1-guard/guard.json) 正常退出 0，33.4955785 秒，最低空闲 9,544,216 KiB；专项守护正常退出、最低空闲 9,039,952 KiB。均为 6/2 GiB、低优先级、零游戏窗口，没有操作原档。

## 完整验证状态

正常 Host 构建与类型检查退出 0，完整游戏单元 **399 文件通过 / 14 文件跳过；3,174 项通过 / 39 项跳过 / 0 失败**。[首轮驱动记录](../../artifacts/rust-rp1-loop/native-proof-full-validation-v1.json) 的 FAIL 是账目脚本误要求默认精简 stdout 包含文件名；实际 Vitest 退出 0、总数正确。保留原失败记录和日志，没有重跑全套或改写成通过。

[独立补验记录](../../artifacts/rust-rp1-loop/native-proof-followup-validation-v1.json) 重验上述日志摘要和原账目，再用 JSON reporter 单独执行实际 Native 差分：**50 pass / 1 长测按条件 skip / 0 fail**，不是缺 Host 导致的整组跳过。Web 构建及原 startup budget、thin UI boundary、Native coverage 门禁全部退出 0。源码、测试与 Host 摘要在两轮前后不变；正常 Host 17,889,792 字节，SHA-256 `ef56b807e5d753e83f7f6bb41c08e2de1a1372dfccb8a071578bce88abddb4f4`。它尚不是冻结桌面包。

首轮守护因账目脚本退出 1，未触发停止条件，最低空闲 4,832,444 KiB；补验[守护](../../artifacts/rust-rp1-loop/native-proof-followup-validation-v1-guard/guard.json) 正常退出 0，92.7448964 秒，最低空闲 6,913,944 KiB。均保持 6/2 GiB 门槛、低优先级、本机重任务串行和零游戏窗口。

## 前一 4bc 提交的云端终态

[Windows 全部通过](../../artifacts/rust-rp1-loop/cloud-4bc-native-windows-v1.log)：核心 1,113/5 ignored、Host 252+3、Native 750/1 skip、游戏 3,173/39 skip，均零失败，七项历史采集通过。[Linux Server/Ops/Native](../../artifacts/rust-rp1-loop/cloud-4bc-server-native-v1.log) 通过，Ops 60/2 skip、Native 746/5 skip；[Linux 单元](../../artifacts/rust-rp1-loop/cloud-4bc-unit-v1.log) 3,171/41 skip，类型/许可证/生产构建通过。

浏览器[第一组](../../artifacts/rust-rp1-loop/cloud-4bc-shard1-v1.log) 234 pass/11 skip/1 fail/1 flaky，[第二组](../../artifacts/rust-rp1-loop/cloud-4bc-shard2-v1.log) 216 pass/22 skip/3 fail，合计 **450 expected / 33 skip / 4 unexpected / 1 flaky**。仍失败于移动统计宽度、50 卡堆叠连线端点、冷菜单存档预算、80–200 字号布局；数量比 4c3 少不能说明根因已修复。4bc 的成功不代替本批新源码或桌面包的云端验收。

## 保留的缺口

253 冻结包的终局完成入口仍超原 90 秒，尚未取得本候选的完整菜单、持久采用和重开成绩。实时可信资格/桌面单所有者、其他恢复边界、完整玩法与长离线、性能/内存/硬件/发布候选继续按[完整目标](../rust/windows-full-development.md)推进；不改变 `authority_eligible=false` 或 1–30 秒自动采用范围。
