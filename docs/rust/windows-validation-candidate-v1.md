# Windows 验证候选身份 v1

2026-09-10，Role: develop。为[验证正文 v1](./windows-validation-body-v1.md)提供独立的十二字段候选身份；不是完整可信上下文、生产者认证或玩家资格。源码与实包结果见[本批记录](../reviews/rust-windows-validation-candidate-2026-09-10.md)。

## 独立输入

main 的 `collectPackagedWindowsValidationCandidate()` 不接收参数，从自身模块所在 ASAR 推导资源位置，再由同包程序身份提供者独立检查；同时取得内置目录和固定矩阵。外层只读启动器的资源目录不作候选安装位置。Host 的 `collect_installed_windows_validation_candidate()` 同样不接收路径/预期身份，从 OS 可执行路径、编译内置目录和矩阵独立取得事实。不会从 renderer、存档、资格正文或报告反填候选。

输出保持原十二字段顺序：version、sourceSha、buildId、editionId、channel、platform、arch、hostSha256、asarSha256、catalogSha256、rulesSha256、matrixSha256。前九字段沿用[程序身份合同](./windows-installed-program-identity.md)，内置目录沿用[独立目录](../reviews/rust-windows-builtin-catalog-2026-09-10.md)。

真实 Host `inspect-validation-candidate` 只读返回 schemaVersion=1、kind=installed-validation-candidate-v1、candidate，以及严格 false 的 authorityEligible/releaseAllowed。拒绝附加参数，不创建存档或模拟。非 Windows x64 或不符合已装程序身份的环境拒绝；不能通过环境变量或传入路径生成候选。

## rulesSha256 的确切含义

它是保守的**可执行规则实现身份**，不是行为等价证明。对以下 JSON 采用既有递归对象键排序、数组保持原顺序和 ECMAScript 数字表示的 canonical SHA-256：

```json
{"schemaVersion":1,"kind":"native-executable-rules-v1","hostSha256":"<实际 Host SHA-256>","asarSha256":"<实际 ASAR SHA-256>","catalogSha256":"<内置目录 canonical SHA-256>"}
```

三个摘要均为 64 位小写十六进制，由程序提供者取得。规则摘要在 Host/ASAR 冻结后计算，不写回被哈希的程序，避免自引用。即使只有界面文件改变，ASAR 和 rulesSha256 也会改变，旧资格必须失效。该身份不独立证明算法正确、运行库/硬件等价、数值边界或性能。

## matrixSha256 的确切含义

对 `desktop/native-validation-matrix-v1.json` 的完整规范 JSON 计算 SHA-256。该文件分别随 ASAR 打包及编入 Host，两端独立解析，拒绝未知字段、丢失/重复/改变的检查或放宽结果要求。

这是已有 **TEST_ONLY 基础证据矩阵**的固定合同：scope windows-normal-main-1x-builtin-v1、十二个检查 ID、native-qualification-check-v1 报告类型，以及 minimumPassed=1、failed/skipped/flaky 上限均为 0。authorityEligible 和 releaseAllowed 固定 false。实际开发证据检查器启动时交叉检查固定检查名单与矩阵相同；Host 构建和桌面打包也验证矩阵。

矩阵身份并不新增或证明每项报告的断言、执行真伪、数值阈值及性能充分性。其完整生产验收矩阵仍待完成；字段齐全不能使这份 TEST_ONLY 矩阵获得玩家授权。后续矩阵变更须同时更新独立校验、报告生产者和执行证据，形成新的 matrixSha256，不能只把 false 改为 true。

## 接入边界

当前提供者与零窗口实包探针完成候选事实采集；正文仍需独立的发布者/密钥版本、profile/夹具、可信时间、撤销与生产者上下文。尚未接入运行资格、持久交接或模拟时钟。普通/竞速、扩展内容及正式发布范围不得由调用方随意扩大。
