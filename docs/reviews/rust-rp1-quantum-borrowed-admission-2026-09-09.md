# Windows Rust：量子物流开档检查复用设备记录

2026-09-09，Role: develop。完整 Windows Goal 继续 active，本批没有发布，也没有开放 Rust 实时玩家权威。

## 改动

开档已经解析整批设备，量子物流准入检查此前仍逐条重新解析原始记录。现在借用本次开档的只读设备切片，保留网络、目标设备、切换阶段、运输桥、量子站等级、远程路线和非法模式检查及其原有顺序。没有现成切片的调用者继续逐条解析；记录数量不符直接拒绝。

[量子物流实现](../../native/dsp-native-core/src/quantum_logistics.rs)与[开档接线](../../native/dsp-native-core/src/simple_factory.rs)是仅有的 Rust 改动。源摘要分别为 `cb62d36a200b79d6cc58149d873f17cf0bc568a455133bf81b0a70b71a92fbf2`、`dabd9a7c50befef332f687fad0a65c7f08110eaa5b40de8abcdd0767cb4a2c83`。没有新增常驻设备副本、改变线程数、模拟规则、存档格式或 1–30 秒自动采用范围。

## 正常优化配置验证

[Rust 验证报告](../../artifacts/rust-rp1-loop/native-quantum-borrowed-validation-v1.json)通过：新增一项回归包含 12 种正常/异常情况，对照两种读取路径的明确预期，并确认输入字节、状态摘要和 revision 不变、长度错配拒绝。完整核心 **1,115 pass/5 ignored**，Host 库 **253 pass/1 驱动 ignored**、主程序 **3 pass**；全部 0 fail。格式、严格 release/workspace/all-targets Clippy 和正常 Host 构建通过。

候选 Host 为 17,901,568 bytes，SHA-256 `dce6af810e191dce7f05f8b3a2c969c7cd9228df0c2cb47ad2e60ae80b493839`。[验证守护](../../artifacts/rust-rp1-loop/native-quantum-borrowed-validation-v1-guard/guard.json)正常 exit 0，1,276.7601444 秒，最低空闲 4,797,752 KiB，6/2 GiB。条件忽略和测试驱动不计通过。

## 真实终局请求 A/B

[完整 A/B 报告](../../artifacts/rust-rp1-loop/native-quantum-borrowed-private-ab-v1/report.json)通过。使用原注册终局档的只读副本：110,042 个实体、233,300 条传送带；同一恢复状态、固定 **9 秒**精确结算、两个工作线程，approximation=0。基线取自 c3c85cf1 冻结包的 Host `7253807b6ccead1ba2f02d0175294d716064d34517c7e05b740530bf5ef9474b`，候选为上述新 Host。

每种程序各一次预热排除，随后以 AB/BA/AB 顺序运行三个独立进程配对；没有启用 Native 性能采样开关。

| 配对 | 旧 Host 请求 ms | 新 Host 请求 ms |
| --- | ---: | ---: |
| 1 | 51,771.1312 | 49,257.2576 |
| 2 | 51,918.7490 | 48,583.5382 |
| 3 | 51,091.8376 | 49,190.2685 |
| 中位数 | **51,771.1312** | **49,190.2685** |

中位减少 **2,580.8627 ms，约 4.99%**。8 份完整导出均为 208,891,374 bytes，SHA-256 `15c91fa1509ad6949d22a2db6a257890992c1dfb9b3bcd635bd8d1ec9c1cb934`，来源/候选 revision、canonical components、字段和 domain 摘要均一致。候选 canonical 为 `6cf99f1d4d8bb0f172448c1c2e790b7cf5acd2cf47de9a6bede3e28a5ee8f96b`。

本轮对照的是此前六份已经完成完整 JS 验证的导出字节；本轮没有重新跑私档 JS。8 个实际 Host 均正常 exit 0、signal=null；两个正式存档槽均未写入，临时目录已清理，原档字节/mtime/SHA-256 未变。[A/B 守护](../../artifacts/rust-rp1-loop/native-quantum-borrowed-private-ab-v1-guard/guard.json)正常 exit 0，415.9051761 秒，最低空闲 5,199,320 KiB，6/2 GiB。

这只计完整 Native 请求收益，不能当作整个进入游戏的收益、帧率或内存改善，也不能与不同基线的历史百分比相加。

## 集成与尚未通过的项目

[新 Host 的完整集成](../../artifacts/rust-rp1-loop/native-quantum-borrowed-integration-v1.json)通过：类型检查 exit 0，Native **750 pass/1 skip/0 fail**，完整游戏 **3,176 pass/39 skip/0 fail**，其中实际 Native 对照 **50 pass/1 长测 skip/0 fail**，Web 构建及 startup/thin-UI/coverage 门禁通过。前后核对候选 Host、两份 Rust 源码及未改的启动恢复代码摘要。[集成守护](../../artifacts/rust-rp1-loop/native-quantum-borrowed-integration-v1-guard/guard.json)正常 exit 0，603.7628531 秒，最低空闲 5,090,560 KiB，6/2 GiB，无内存停止或超时。

[前一 c3 冻结包](./rust-rp1-c3c85cf1-package-2026-09-09.md)虽然在原 90 秒截止前只观察到一个模拟 Worker，并且两次正常关闭，但终局完整入口仍失败；成功保存和两次重开没有执行。

c3 的 Linux 浏览器已首轮通过两项启动顺序测试和精确堆叠路由回归；两组完整合计 **422 pass/33 skip/23 fail/17 flaky**。c3 的 Linux 单元、生产构建、Server/Ops/Native 和 Windows 全量均通过；Windows 为核心 1,114/5 ignored、Host 256/1 ignored、完整游戏 3,176/39 skip。见[云端终态](../../artifacts/rust-rp1-loop/cloud-c3c85cf1-terminal-summary.json)。这些验证绑定 c3，本批新 Rust 源码还需要自己的冻结包和云端证据，失败数量波动不能替代逐项复现。

接下来在新冻结包复验原 90 秒完整入口、持久状态、正常关闭与两次重开，继续可信资格、实际实时单所有者、完整玩法与发布矩阵。后台、静音、隐藏、不聚焦、低优先级和本机重任务串行保持不变。
