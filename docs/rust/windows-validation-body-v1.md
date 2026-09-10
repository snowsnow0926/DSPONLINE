# Windows Rust 验证专用资格正文 v1

2026-09-10，Role: develop。实现范围是已验签正文与独立候选、隔离会话的绑定；不是玩家授权，也不证明生产者报告真实。对应 [ADR-009](../architecture/ADR-009-WINDOWS-RUST-QUALIFICATION.md)和[外部 catalog 载体](./windows-qualification-carrier.md)。

## 两端接口与信任输入

Electron main 的 `bindAuthenticatedValidationQualification` 只接收既有 Windows 助手验证器生成的 WeakMap 内部 token。Rust 的 `bind_authenticated_validation_qualification` 只接收系统验签模块构造的 `VerifiedCatalogMember`。两者解析的都是验签时取得的同一份不可变字节，不重新打开资格文件。输出仍是私有构造的绑定凭据；JSON 回执不能恢复该凭据。

调用者须另外提供完整候选身份、隔离 profile ID、合成夹具摘要、请求范围、获准发布者证书 SHA-256 与密钥版本、当前时间、撤销代次及已撤销资格/证明集合。不能从待验正文、renderer、玩家存档或报告反填这些预期值。[独立十二字段候选提供者](./windows-validation-candidate-v1.md)已实现程序、内置目录、保守规则实现和固定基础矩阵身份；profile 路径与 ID 的映射、可信时钟、签名撤销材料及防回退持久水位仍需实现。候选字段齐全并不证明完整上下文已经可信。

main 和 Host 分别调用 Windows 验签并分别做正文绑定。签名者、候选及会话不匹配时拒绝；即便全部匹配，也必须再完成生产者认证、完整矩阵、会话准入和持久单写者交接才可能启动模拟。本模块没有 renderer IPC、环境开关、运行资格授予或模拟调用。

## 字节合同

正文最多 **16 KiB**，比外层 catalog 成员的 256 KiB 上限更小。采用下列固定字段顺序、无空格的 UTF-8 JSON，结尾恰好一个 LF。嵌套字段也采用明确顺序；这不是通用 JSON 规范化或 RFC 8785。两端解析后按该顺序重新编码并逐字节比较，拒绝重复/未知/遗漏字段、BOM、CRLF、额外文档、替代转义、非规范数值或损坏 UTF-8。所有有效字符串限定为下述 ASCII 范围。

顶层字段顺序：`schemaVersion`, `kind`, `qualificationId`, `publisherKeyVersion`, `candidate`, `scope`, `session`, `producerSetSha256`, `proofSetSha256`, `issuedAtMs`, `expiresAtMs`, `revocationGeneration`。

| 字段 | 合同 |
| --- | --- |
| schemaVersion / kind | `1` / `dsp-windows-validation-qualification-v1` |
| qualificationId | 1–64 个小写字母、数字或连字符，首字符不能是连字符 |
| publisherKeyVersion | 1–4,294,967,295；与独立发布策略中实际签名者对应的版本完全一致 |
| candidate | 下述完整身份，与独立冻结候选逐字段完全一致 |
| scope | 目前仅 `windows-normal-main-1x-builtin-v1`；竞速、其他槽位/倍率/扩展内容和玩家资格均拒绝 |
| session | 固定顺序 `profileId`, `fixtureSha256`, `cloudWrites`；分别为 32 位小写十六进制隔离 ID、64 位夹具摘要、严格 `false`，与独立会话一致 |
| producerSetSha256 / proofSetSha256 | 64 位小写十六进制；只是待认证材料的引用，不是生产者认证结果 |
| issuedAtMs / expiresAtMs | 正安全整数，签发 ≤ 当前时间 < 到期，且窗口最多 86,400,000 ms |
| revocationGeneration | 正安全整数，与独立当前代次完全一致；旧代次和未知未来代次都拒绝 |

candidate 字段顺序复用现有证据身份：`version`, `sourceSha`, `buildId`, `editionId`, `channel`, `platform`, `arch`, `hostSha256`, `asarSha256`, `catalogSha256`, `rulesSha256`, `matrixSha256`。版本由三个 1–5 位十进制段组成，source 为 40 位小写十六进制，Build ID 为版本加 `+` 和 source 前 12 位；固定开发版 `windows-performance-development-v1` / `beta` / `win32` / `x64`，各 SHA-256 为 64 位小写十六进制。

其中 **candidate.catalogSha256 是游戏内容目录摘要**。验签回执的 catalog 摘要是外部 Authenticode 文件，绑定回执另命名为 `carrierCatalogSha256`，两者不相互替代，也不形成构建哈希自引用。

上下文时间和撤销代次也要求正安全整数（最大 9,007,199,254,740,991）。撤销资格 ID 与证明集合列表各最多 128 项、拒绝重复及非法格式。匹配任一撤销项即拒绝。可信时间/撤销材料的获取和持续刷新未在本模块实现；通过一次绑定不是可重复使用的实时运行租约。

## 证据与后续

[共享公开向量](../../native/fixtures/qualification-binding-v1.json)是合成 TEST_ONLY 输入：76 项涵盖边界正例、身份/范围/会话不符、过期/撤销、非规范 JSON、非法上下文及字符串尾部换行。Node 与 Rust 独立执行同一组数据，另测损坏 UTF-8 和凭据拷贝隔离。测试凭据构造器仅在 Rust `cfg(test)` 或 Node 测试 VM 内存在。

真实 Windows 签名集成在既有一次性云端证书生命周期中增加 `binding` 成员：独立 Host 和真实 main 助手各自验签，再验证绑定正例与程序/会话/撤销负例；未信任及移除信任后仍拒绝。合成候选和固定测试时钟不代表当前发布包资格。本机禁止运行该证书安装流程。实际执行状态见[本批记录](../reviews/rust-windows-validation-binding-2026-09-10.md)。

安装上下文已具备 [main 与 Host 独立程序身份提供者](./windows-installed-program-identity.md)：分别从自己的安装位置读取 ASAR 元数据及实际 Host/ASAR 文件，提取九字段程序事实。d97 冻结包内两端与父进程独立核对相同，实际助手拒绝缺失 carrier；游戏 catalog/rules/matrix、profile、时钟与撤销仍待完成。这不是完整资格上下文或签名信任。

新增[独立内置目录提供者](../reviews/rust-windows-builtin-catalog-2026-09-10.md)：从实际前端定义生成的完整目录分别编入 Host 和自身 ASAR，双端独立计算 canonical 摘要；构建验证漂移。它只提供内置目录事实，未接入资格正文或玩家准入，不能把摘要等同于完整可信上下文。上文程序身份九字段和已有 API 合同不变。

新增[十二字段候选](./windows-validation-candidate-v1.md)对当前 Host/ASAR/内置目录计算保守规则实现摘要，并独立绑定已有 TEST_ONLY 基础检查矩阵。这些是程序事实，不认证报告断言或形成完整生产验收矩阵，尚未自动接入本正文绑定或玩家准入。

下一步仍是其余可信上下文、生产者认证、完整验收矩阵、验证专用会话准入与冻结程序内实际单写者交接；扩展玩家、竞速和内容范围须新增对应资格矩阵与合同，不能仅增加允许字符串。
