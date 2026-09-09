# Windows Rust 资格证据与准入设计

2026-09-09，Role: develop。当前完成开发证据检查器，以及七项实际 Rust 库测试的 TEST_ONLY 采集；生产准入、签名资格载体和完整证据流水线尚未实现。对应 [ADR-009](../architecture/ADR-009-WINDOWS-RUST-QUALIFICATION.md)，完整范围见[执行计划](./windows-full-development.md)。

## 1. 要解决的问题

现有 Rust 领域清单、Host 命令和桌面接管代码已经存在，但 `DomainCoverage::implemented_beta_scope()` 的 `authority_eligible` 仍为 false。清单中的 implemented、测试替身返回 true、旧包的通过记录，以及 renderer 自报的门禁指标，都不能授予新包实时玩家资格。

必须把以下五件事分开记录：代码存在、测试执行、实际 Native 路径、当前实包通过、发布允许。JS 回退、跳过和重试后成功分别保留；不能通过删除失败记录制造全绿。

## 2. 证据生产与验证边界

| 参与者 | 输入与职责 | 能否开放玩家权威 |
| --- | --- | --- |
| 构建器 | 干净 Git SHA、锁定依赖和构建参数；生成实际 Host/ASAR/矩阵摘要，沿用 `desktop-artifact-evidence.cjs` | 不能；摘要证明文件一致，不认证发布资格 |
| Rust/Host 验证器 | 合成夹具、独立 JS 对照、确定性、守恒、租约/WAL 与故障注入；记录真实执行方式 | 不能；`cfg(test)` 结果标 TEST_ONLY |
| 隐藏桌面驱动 | 冻结 EXE/ASAR/Host、隔离 profile；采集所有权、命令序列、持久 revision、正常退出与重开 | 不能；实际观察与测试替身分列 |
| 性能/硬件驱动 | 固定夹具与 JS 基线、完整等待和全进程内存、线程矩阵、长测、设备条件 | 不能；单个比例不替代完整规则与恢复 |
| 开发证据检查器（本批） | 独立候选身份、当前时钟、报告引用；检查完整性、来源一致性、时效和结果账目 | 永远不能；只输出 CONSISTENT / REJECTED |
| 可信发布资格链（待实现） | 经审查的生产者、完整矩阵、签名与撤销材料；绑定最终候选 | 仅在完整验收和授权后产生受限资格 |
| 桌面 main 与 Rust Host（待实现） | 从固定安装资源位置独立核验资格、构建、内容与会话范围 | 可执行被验证的范围；renderer 不能提供资格材料或信任根 |

现有构建证据文件明确声明不是签名。本批不把它提升成信任根，也不新增私钥、renderer 密钥或环境变量放行路径。

## 3. 冻结身份与当前检查器协议

候选身份由构建端单独冻结，不能从待审报告反向提取为“预期值”：

- `version`、完整 `sourceSha`、与二者一致的干净 `buildId`。
- `editionId=windows-performance-development-v1`、`channel=beta`、`platform=win32`、`arch=x64`。
- 实际 `hostSha256`、`asarSha256`、运行目录 `catalogSha256`、模拟规则 `rulesSha256`、验收矩阵 `matrixSha256`。

外部 `qualification-evidence.json` 包含 `schemaVersion=1`、`kind=native-qualification-evidence-v1`、固定 scope、`evidenceClass=TEST_ONLY`、候选身份、`issuedAtMs`、`expiresAtMs` 和检查项引用。每个引用绑定报告的相对路径、精确字节数与 SHA-256。清单和每份报告最多 256 KiB；不接受目录联接、符号链接、绝对路径和向上路径。

每份 `native-qualification-check-v1` 报告重复绑定候选与 scope，记录 `checkId`、执行方式、夹具摘要、开始/结束时间、结果及 passed/failed/skipped/flaky。当前只审计 `windows-normal-main-1x-builtin-v1` 的 12 个基础检查，检查 ID 由[实现](../../scripts/native-qualification-evidence.mjs)固定，不能从输入删掉必需项。它们不是完整 RP3/RP4 矩阵。

检查器拒绝：身份错配、缺项/重复项、重复报告、文件大小或摘要不符、未知字段、错误模式、未来报告、过期或超过七天的有效期、被撤销的报告摘要，以及失败、跳过、重试后才通过、零测试或 JS/mixed 执行方式。所有“通过”仍只是报告的一致性检查；生产者的声明尚未被认证，也未校验该检查具体断言和数值阈值是否充分。

调用方式（占位文件需由真实构建和验证驱动产生）：

```text
node scripts/native-qualification-evidence.mjs <candidate.json> <evidence-directory>
```

当前没有为本批生成一份伪造的全绿资格清单；单元测试只在临时目录使用明确的合成数据。任何成功输出仍固定 `producerAuthenticated=false`、`authorityEligible=false`、`releaseAllowed=false`，不会传给运行时。

## 4. 正式信任与失效设计（尚未实现）

正式信任沿用 Windows 发布者和现有签名/制品校验边界。后续资格载体须能由 Windows 签名链认证，并绑定获准发布者、精确 Host/ASAR/规则/矩阵摘要、范围、有效期与撤销代次；普通 JSON 加 SHA-256 不够。具体载体、发布者固定方式、Windows 离线证书策略和 Host 原生验证接口须在实现前补入 ADR；目前没有可用生产凭据或已批准的载体实现。

资格载体在待测 Host/ASAR 冻结后生成，位于其外部，避免把资格文件打入 ASAR 后又改变被批准摘要的自引用问题。新版本程序、内容包、规则、运行模式或矩阵改变均使原资格失效。main 负责可信时钟、安装位置、通道与用户选择；Host 必须独立确认适用于当前状态的范围，不能只相信 renderer 或一条 `eligible=true` IPC。

撤销须覆盖资格 ID、候选摘要、发布者/密钥版本和最小撤销代次，具备新鲜度与防回退规则。资格丢失、签名无效、时钟异常、过期、撤销信息不满足策略、错包和未知内容均拒绝新接管。已运行 Native 会话先停收命令，在自身持久边界暂停/结束；禁止装回较旧 JS 镜像。

## 5. 消除验证与资格的循环依赖

1. 先复用现有受限测试 Host、`cfg(test)` 和公开合成存档，验证 Rust 规则、命令、所有权与恢复。这些产物永远 TEST_ONLY，不修改普通 Host 的资格判断。
2. 在 JS 仍为权威的隔离 shadow 场景完成独立对照、性能、故障和硬件证据。不能把 shadow 的通过算作实际 Native 玩家入口通过。
3. 正式包的真实 Native 入口必须另行具备可信、范围受限的资格。若需验证专用资格，它必须同时绑定冻结程序、可丢弃 profile、合成夹具、有限时间和禁止云写入，且普通玩家 profile 永远拒绝；不能靠环境变量或 UI 绕过原门禁。这一接口仍待 ADR 具体化及实现，不以本批 TEST_ONLY 检查器代替。
4. 最终在符合正式资格的同一候选上补普通包入口、命令、保存退出和冷恢复，补齐全部 RP3/RP4 证据后才形成发布交接。

## 6. 当前增量与后续实现

前一批交付证据文件的有界读取、候选/报告绑定、时效/撤销检查、结果分类及负例测试。没有接到 main、preload 或 Host，不开放实时权威。

当前新增 `native-realtime-foundation.mjs`：构建实际正常优化 Host 库测试程序，采集固定七项既有测试的准确执行/结果账目，记录源码/依赖、程序和原始日志摘要。Windows CI 在完整 Rust 测试后运行；`npm run native:realtime-foundation -- artifacts/<fresh-directory>` 必须使用新目录，不能覆盖旧证据。每项标为 `rust-host-library-test` / `registry-reopen-in-test-process`，报告类型与上述 12 项资格协议分开，scope/Host/ASAR 资格为空，始终不能授予权威或发布。

七项 7/7 只证明合成夹具下的库行为；直接准备租约、进程内重开及合成命令不等于 public handoff、真正 Host 崩溃恢复、完整守恒或性能。见[运行证据](../reviews/rust-windows-realtime-foundation-2026-09-09.md)。下一步补独立子进程恢复和实际桌面交接，再完善正式载体/验证、受限接管、完整玩法和发布验证；不能将 TEST_ONLY 日志拼成完整全绿资格。
