# Windows catalog 真实签名测试流程

2026-09-09，Role: develop，基于 `7541ace2`。本批为[Host 验签初版](./rust-windows-catalog-verifier-2026-09-09.md)补充可执行的签名正例与拒绝用例。**355d4d5e 的云端实际签名、篡改和移除后拒绝已通过；本批不开放实时资格。**

## 执行内容

[Rust 专用用例](../../native/dsp-native-host/src/qualification_catalog_signed_tests.rs)仅在 Windows 的测试模块编译。两个入口默认 ignored，由[云端脚本](../../scripts/test-native-catalog-signature-ci.ps1)逐个以 exact/ignored 调用，必须确认实际运行一项且零失败。普通 Host 不读取这些测试环境变量或测试发布者输入。

流程在现有 Windows workflow 的严格 Clippy 之后执行，先编译 Host 测试程序，再创建任何测试证书。签名专项的独立证据先上传，完整 Rust、Native 和游戏门禁按既有顺序继续执行：

1. 使用云端 Windows SDK 为两份固定的合成 JSON 建立 SHA-256 catalog，并用本次新建的短期、不可导出私钥的测试证书签名。签名者预期摘要来自新建证书，独立于被验证的正文。
2. 未安装测试信任根时，实际 Rust/Windows 验证必须拒绝。
3. 仅在这台临时测试机的 LocalMachine Root 安装该公开测试证书（原有管理员权限不足则预检拒绝，不提权）；验证正确成员、精确字节和全部摘要、错误发布者拒绝、包含正确发布者的轮换列表、JSON 篡改拒绝、另一个自身有效的 catalog 不能冒认正文、签名损坏拒绝及锁释放。
4. 删除这一个测试信任根，再以新的 Rust 测试进程确认同一签名被拒绝。
5. 所有正常和失败出口清理本次证书、私钥和临时目录，记录证书不存在、CNG 私钥不存在及目录不存在；清理失败同样使步骤失败。结果、固定输入摘要和受控子进程日志单独归档。

CDF 使用 version 2、SHA256 和 HASH 成员标记，签名使用固定 SDK SignTool。实现依据 [Microsoft MakeCat](https://learn.microsoft.com/en-us/windows/win32/seccrypto/makecat)及 [SignTool](https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool)。测试证书与私钥清理依据 [Certificate Provider](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/about/about_certificate_provider?view=powershell-7.5)。没有调用正式签名凭据、外部时间戳服务或生产资源。

## 本机边界与证据

脚本先拒绝本机、自托管 runner、非 Windows、其他仓库和缺失 runner 临时根的调用，随后才访问 SDK、文件或证书。该运行限制防止误用，不是运行时资格认证机制。本机只执行 PowerShell 语法解析与拒绝路径测试，不创建、读取现有私钥或安装测试证书。

最终 `windows-catalog-signed-local-v3.json`：release 专项 7 pass/2 签名场景 ignored、fmt/严格 workspace/all-targets release Clippy 通过，包含“替换 catalog 自身有效”的编译检查；守护正常退出 0，122.930 秒，最低空闲 6,530,196 KiB，保留 6/2 GiB 门槛。include 引用的独立测试文件另做显式 rustfmt 检查，并加入云端门禁。两个专用场景尚未在本机执行，默认忽略符合隔离约束。

`windows-catalog-ci-preflight-v2.json`：最终 PowerShell 脚本解析及五类拒绝调用检查 2/2，零跳过失败；仅轻量元数据预检使用 3/2 GiB 守护，正常退出 0，2.878 秒，最低空闲 7,463,224 KiB。最终工作流结构单独记录为 `windows-catalog-workflow-shape-v3.json`：先编译 Host 测试程序再创建证书、提前上传专项证据、两个助手文件变更触发 PR 检查；除新增专项、证据上传和触发路径外，所有既有工作流门禁保持不变。新用例不修改模拟、存档或普通 Host 的验证实现，没有把前批完整 Rust/Native 结果计作本轮重跑。

## 仍待证明

### cd515022 的 main 独立助手签名专项通过

Windows run `34370552520` 早期制品 `10112314492` 已取得，绑定 merge SHA `d55fc6b7776434b6de1baf397389c4f1ed955522`，ZIP SHA-256 `a63a9837db9dce9fc45b963f0c87b4e57a1a82bc29172d95108a12a427a86528` 与元数据相符。11 个步骤全部退出 0、无超时；Host 三次 exact 调用与 main 独立助手的信任前 2 项、有效信任 8 项、移除信任后 2 项全部通过，测试 Root/My 证书、私钥和临时目录清理全为 true。

main 云端助手 SHA-256 为 `9294c30eea203810f77311f65305f1735bd5b3fbf68b5929aa366442756d6e98`，三阶段一致。它是云端独立构建，不与本机助手摘要混用。该结果验证实际独立进程的签名路径，仍属 TEST_ONLY/authorityEligible=false；实际冻结包的 ASAR 加载、完整资格及玩法授权仍须另行验证。

### 355d4d5e 云端签名专项通过

Windows run `34368661022` 的早期专项制品 `10111487479` 已取得，源码为 PR merge `4980065a5d5ea017d76fb5286a80640dd5b97548`，ZIP SHA-256 `d59315df7eb82b1333f190168775287b9b22905d5edb8d49c10b6434a6363b8f` 与 GitHub 元数据相符。`result.json` 为 PASS/TEST_ONLY/authorityEligible=false；两份生成/签名、信任前拒绝、机器测试根安装、实际签名成员/发布者/轮换/篡改与锁释放、移除信任后拒绝全部退出 0，均无超时。三个 exact Rust 调用各实际执行 1 项、0 失败、0 ignored；测试 Root/My 证书、私钥和临时目录清理全部 true。

这证明现有 Host 模块的真实 Windows 签名路径，不等于新 main 助手已在云端验签，也不等于完整 Windows 工作流或发布门禁通过。后者按后续独立结果更新，不能由早期制品推断。

### 首次云端结果与测试机信任库修复

`bfae44fd` 的 Windows run `34366402106` 已失败，实际合并源码为 `13ff2a10c72cfeb94892b04ae7f66df96b2d0e79`。SDK 10.0.26100.0 成功生成和签署两份 catalog；实际 Rust 在未安装信任根时拒绝测试签名。随后 `install-owned-test-root` 达到原 180 秒期限，正例、篡改及移除后拒绝均未执行；完整 Rust/Native/游戏步骤也被跳过。归档 `10110713619` 的 ZIP SHA-256 为 `57ef0121fcceab51802d5861a50a4e9252a5b5add1d07f8f213db5e5b7d61764`，源码和结果一致，证书、私钥及临时目录清理全部为 true。

CurrentUser Root 的交互式保护提示是超时的疑似原因，日志未捕获对话框，不能写成已证实。修复选择临时云端机的 LocalMachine Root，预检已有管理员权限，保留原期限和严格 WinTrust 策略。只删除本次新生成且确认原先不存在的测试根；超时子进程先收集日志和退出状态再报错。微软提供 [LocalMachine Root 导入方式](https://learn.microsoft.com/en-us/powershell/module/pki/import-certificate?view=windowsserver2025-ps)，GitHub 说明了[托管 Windows 机的管理员环境](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#administrative-privileges)。本机只重跑语法与拒绝预检，实际签名正例仍待下一次云端结果。

签名正例、篡改和信任根移除的实际 Windows 终态须由新云端步骤产生。测试根证书的一日有效期及信任根移除，不等于已验证真实发布者的证书到期、证书撤销、资格到期或应用防回退。测试发布者列表不是生产发布者轮换策略，也不能授予游戏权威。

main 独立验证、正式发布者策略、证据生产者认证、资格正文与候选匹配、有效期/撤销防回退和真实实时接管仍需继续；终局完整入口、复杂长离线、全部玩法与 Windows 交付目标保持不变。完整 Goal active。
