# 完整 Windows Rust：资格证据基础与建造复制候选

2026-09-09，Role: develop。旧 RP1 Goal 已由用户取消，新完整 Windows Rust Goal 已创建且 active。见[执行目标](../rust/windows-full-development.md)。基线 `d7602c51bdd27173f61e411c189bef41c8bcb2b1`，独立分支 `codex/rust-rp1-after-1.2.7`。

## 开发证据检查器

新增 `scripts/native-qualification-evidence.mjs` 与专项，纳入 `npm run test:native`。预期身份独立绑定 source/build/Host/ASAR/catalog/rules/matrix，初始 scope 为普通模式、1×、内置内容。12 个必需检查不允许缺失或重复；拒绝错包、过期、撤销、失败、跳过、flaky、JS/mixed、缺报告和报告修改。

元数据最大 256 KiB，拒绝链接/联接和路径越界；同一次有界读取的字节同时用于 SHA-256 与解析，补中途文件改写的行为反例。成功输出仍是 TEST_ONLY，且 `producerAuthenticated=false`、`authorityEligible=false`、`releaseAllowed=false`。没有接入 renderer/main/Host，也没有生成当前包的全绿资格。

见[资格设计](../rust/qualification-design.md)和 [ADR-009](../architecture/ADR-009-WINDOWS-RUST-QUALIFICATION.md)。本批只校验报告一致性，认证生产者、正式签名载体和各检查的行为/数值验收仍待实现。

## 本机验证

- 检查器 SHA-256：`40afeb2d6cb6ebdff3684766776d8e648a7ab61b97ea20d04deb5b1e3c68486d`。
- 专项 SHA-256：`c09e5026dee5a823cd7f8de9a7085f90758117c3b934d8143270ac669ff34d25`。
- [最终输出](../../artifacts/rust-rp1-loop/qualification-audit-v3-guard/stdout.log)：检查器 **53/53**、后台策略 **6/6**、包身份 **13 通过 / 1 条件跳过**，合计 **72 通过 / 1 跳过 / 0 失败**。跳过为既有跨平台符号链接检查缺 Windows 权限，实际 Windows 目录联接负例通过。
- [守护](../../artifacts/rust-rp1-loop/qualification-audit-v3-guard/guard.json)：正常退出 0，2.9840888 秒，最低空闲 6,906,660 KiB，轻量 3/2 GiB 门槛，零 Electron 启动。
- Rust 格式检查通过，见[前一轻量验证](../../artifacts/rust-rp1-loop/qualification-audit-v2.json)。该记录早于最后新增的中途改写反例，最终测试数只取 v3。

## Rust 建造候选与未完成验证

`construction::run_centers()` 原先对已经移出的 automation/jobs/quantumMaterialBuffer 再完整复制，本批改为直接移动三个映射。必需字段错误仍返回原错误，可选缓冲缺失/错误仍为空映射；中心选择、调度、预算、物料和写回逻辑不变。

候选 SHA-256：`c361513134d78e84bea85cb171d54dea75d453cea6f02f3b62ca5284922f24f4`。尚不声称完整等待或峰值内存改善。

完整正常 release 核心 **1,113 通过 / 5 ignored / 0 失败 / 0 过滤**，fmt 与严格 release workspace/all-targets Clippy 通过，见[验证记录](../../artifacts/rust-rp1-loop/construction-owned-validate-v2.json)与[核心日志](../../artifacts/rust-rp1-loop/construction-owned-validate-v2-guard/stdout.log)。正常优化编译约 9 分 02 秒，测试 157.92 秒，Clippy 约 67 秒；源码摘要在验证前后相同。

[独立守护](../../artifacts/rust-rp1-loop/construction-owned-validate-v2-guard/guard.json) 正常退出 0，772.5582908 秒，最低空闲 7,310,780 KiB；6/2 GiB 门槛、单编译任务及低优先级不变。一次早期启动因余量不足被拒绝，没有子进程；随后 v1 续接时句柄丢失，系统核查确认已不存在且无最终结果，不记通过。v2 独立记录 PID/创建时间和终态，已结束，未重复启动。新 Host、同源状态/性能 A/B 和隐藏实包待下一批，不能据单元通过授予完整性能或发布资格。

## 上一提交 d760 的云端结果

两条 workflow 均已终态失败，不能发布；PR 合并校验身份为 `be7843ad566abd96906c07d80dfff070138015a1`，对应 d760 提交的运行，不是本批新源码。

- Linux 单元 **3,171 通过 / 41 跳过 / 0 失败**，类型、许可证及生产构建通过，见[日志](../../artifacts/rust-rp1-loop/cloud-d760-unit-v1.log)。Server 390/2 skip、站点 4/4、Ops 60/2 skip、Rust 核心 1,113/5 ignored、Host 248+3、Native 670/5 skip 均零失败，见[Server/Native 日志](../../artifacts/rust-rp1-loop/cloud-d760-server-native-v1.log)。
- 浏览器[第 1 组](../../artifacts/rust-rp1-loop/cloud-d760-shard1-v1.log) 232/11 skip/4 fail，[第 2 组](../../artifacts/rust-rp1-loop/cloud-d760-shard2-v1.log) 211/22 skip/6 fail/2 flaky，完整合计 **443 直接通过 / 33 跳过 / 10 失败 / 2 flaky**。建设、采矿奖励、移动布局、暂停画布、堆叠、冷菜单、字体和刷新等问题继续待收口。
- [Windows](../../artifacts/rust-rp1-loop/cloud-d760-windows-v1.log) 正常 release 核心 **1,113/5 ignored**、Host **252+3** 全部通过，Host 构建通过；Native **673 通过 / 1 跳过 / 1 失败**，后续游戏单元和制品资格步骤跳过。失败为 ASAR 测试夹具生成后立即读取到零字节，属于下面的写入完成前提问题。此前解析参与断言本次通过，没有新的堆损坏证据。

## ASAR 测试夹具写入完成修复

锁定的 `@electron/asar` 实现中，`createPackage()` 最终返回 `out.end()` 的输出流，Promise 完成不代表该流 finish。旧夹具立即读 ASAR/写清单可能遇到未完成的数据，云端在 `packageIdentity()` 解析 `package.json` 时实际读取到了 NUL。新增共享夹具助手，明确 `await finished(output)` 后才校验、改写或清理；三个既有调用位置统一使用它，生产验证规则不变。

[旧行为反例](../../artifacts/rust-rp1-loop/asar-write-red-v1-guard/stdout.log) 在可控延迟的最终写入尚未完成时已经返回，原行为 **1 项失败**；修复后三个专项验证等待完成、传播最终写错误和真实 ASAR 即时读取/重写。连同证据、身份、包清理、发布内容与工具专项，[最终完整定向输出](../../artifacts/rust-rp1-loop/asar-write-green-v1-guard/stdout.log) 为 **104 通过 / 1 条件跳过 / 0 失败**。[守护](../../artifacts/rust-rp1-loop/asar-write-green-v1-guard/guard.json) 正常退出 0，10.0956169 秒，最低空闲 8,999,344 KiB，轻量 3/2 GiB 门槛，零游戏启动。没有延长测试时限、重试读错内容或绕过包完整性检查；本批完整云端复验尚未执行。

## 后续

本机验证已完成，提交本批后对建造候选测完整状态和成本。资格线连接真实验证生产者，明确断言合同与运行身份，再推进实时单所有者、命令和保存退出闭环。RP1 终局成功入口和浏览器失败继续收口。文档链接、Skill 和差异检查通过；新提交完整云端验证待收齐。

`authority_eligible=false` 和 1–30 秒自动采用范围保持原样。原玩家存档、原用户工作区、线上站点及下载未操作；没有新正式包或本批性能百分比。
