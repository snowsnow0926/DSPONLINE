# Windows Rust：JavaScript 独立证明使用固定编码缓冲

2026-09-09，Role: develop。完整 Windows Goal 继续 active；本批保留独立 JS 校验、原摘要算法和普通 Host 的权限边界，未发布。

## 根据实际采样减少分配

[863 冻结包诊断](./rust-rp1-863cf76e-package-2026-09-09.md)把频繁 UTF-8 编码定位到 Native 来源和候选的 JS 证明。[ProofWriter](../../src/game/nativeCoreProof.ts)此前遇到二进制数字就将前面的短字符串编码成临时数组，并立即送入 SHA。现在使用一个固定 **64 KiB** 字节缓冲，保持文字与二进制原顺序，填满或结束时送入同一个增量 SHA-256。

没有缓存玩家状态、信任 Rust 自报摘要、删减字段或改变小端数字格式。`encodeInto` 不拆分 UTF-8 序列；剩余空间放不下完整字符时先提交缓冲。超长文本仍分段写入，不构造完整规范字节大数组。核心源 SHA-256 `e4167e6820306a9b8d98b43ff42ec60e2fc547175d96c9a9a4a5e5ea59a8925f`，测试源 `ef7771d121ce373a93d56899c6cc78e1d56ca589a466269ece2c4ac7fa3834d6`。

## 正确性

[定向验证](../../artifacts/rust-rp1-loop/native-proof-buffer-validation-v1.json)：类型检查通过，证明/启动及实际 Native 对照 **68 pass/1 长测 skip/0 fail**，其中实际 Native **50/1 skip**。新增两项回归对照 Node 独立 SHA-256：长文本跨 64 KiB 边界、中文/emoji/孤立代理项，以及 UTF-8 与小端数字交错，保留负零和非有限值归一化、源状态不变。

[定向守护](../../artifacts/rust-rp1-loop/native-proof-buffer-validation-v1-guard/guard.json)正常 exit 0，95.1247418 秒，最低空闲 8,630,296 KiB，6/2 GiB。正常 Host 始终为 `dce6af810e191dce7f05f8b3a2c969c7cd9228df0c2cb47ad2e60ae80b493839`，本批没有修改 Rust 代码或重新构建该程序。

## 终局证明成本 A/B

[A/B 报告](../../artifacts/rust-rp1-loop/native-proof-buffer-private-v1/report.json)使用注册原档的只读读取和相同 9 秒恢复输入，110,042 个实体、233,300 条传送带。计时只包括 JS 完整规范摘要和 binary domain 摘要，排除读取/解析/恢复。每种程序一次预热排除，再以 AB/BA/AB 顺序运行三个独立进程配对。

| 配对 | 旧证明合计 ms | 新证明合计 ms |
| --- | ---: | ---: |
| 1 | 5,578.6578 | 4,974.3984 |
| 2 | 5,465.2749 | 4,991.2304 |
| 3 | 5,486.6457 | 4,933.9361 |
| 中位 | **5,486.6457** | **4,974.3984** |

中位少 **512.2473 ms，约 9.34%**。8 次规范摘要均为 `2b8be04ba8d8a00717340131069606b8cd5e609e11e00c20c421ca272c1259c4`，domain 均为 `1d8545a2c3ffcd76382dd09724f7d46c1917ce0946453dfa69970886ec70764a`，与此前真实 Native 来源摘要一致。8 个独立 Node 进程 exit 0/signal=null，原档字节/mtime/SHA-256 未变。[A/B 守护](../../artifacts/rust-rp1-loop/native-proof-buffer-private-v1-guard/guard.json)正常 exit 0，69.8268754 秒，最低空闲 8,470,272 KiB，6/2 GiB。

这里只测 JS 证明成本，没有新跑 Native 结算、整个进入游戏或帧率/内存对比；不能与前批 Native 请求约 4.99% 相加。新增固定缓冲的容量也不能当作已测全进程内存收益。

## 完整验证与后续

[完整游戏及构建](../../artifacts/rust-rp1-loop/native-proof-buffer-full-v1.json)通过：**3,178 pass/39 skip/0 fail**，其中实际 Native 对照 **50/1 长测 skip**；Web 构建及 startup/thin-UI/coverage 原门禁全部通过。没有重复编译未改的 Rust 或重跑未改的 Node Native 工具。[完整守护](../../artifacts/rust-rp1-loop/native-proof-buffer-full-v1-guard/guard.json)正常 exit 0，415.3609373 秒，最低空闲 7,914,260 KiB，6/2 GiB。

新源码尚无冻结桌面入口和云端结果。863 冻结包 v13 原 90 秒入口失败、诊断 v1 持久读取失败与诊断 v2 的 13 秒样本分别保留，不能拼接成同一包的完整通过。

下一步提交完整验证后的候选，继续处理保存校验/目录成本，再验证相同输入的完整进入、持久保存、正常关闭和两次重开；可信资格、实际实时单所有者、完整玩法、线程/内存/长测及 Windows 安装升级回退仍待完成。测试始终后台、静音、不聚焦，重任务串行、低优先级并保留内存守护。
