# Windows Rust 资格载体与双端验证实施方案

2026-09-09，Role: develop。**Host 独立 catalog 成员验证器已有初版代码及定向负例证据；真实签名正例、main 验证器、生产者认证、正式资格签发和实时授权尚未完成。** 见[实现与验证范围](../reviews/rust-windows-catalog-verifier-2026-09-09.md)。不改变普通 Host 的 `authority_eligible=false`，不将 TEST_ONLY 结果升级为玩家资格。对应 [ADR-009](../architecture/ADR-009-WINDOWS-RUST-QUALIFICATION.md)及[完整目标](./windows-full-development.md)。

## 载体与冻结顺序

采用 Windows Authenticode 签名 catalog：安装资源中固定的 `native-qualification/qualification.json` 与 `native-qualification/qualification.cat`。两者位于冻结 Host/ASAR 外部。先冻结和验证程序、规则与矩阵，再生成资格正文，最后把该正文作为明确成员纳入 catalog 并签名。安装包签名、catalog 签名、catalog 成员验证、证据生产者认证是不同检查，缺一项不得授予权威。

签名 catalog 的成员验证是 Windows 提供的独立操作；签名本身有效不证明某个任意 JSON 属于该 catalog。[Microsoft catalog 签名与成员验证](https://learn.microsoft.com/en-us/windows-hardware/drivers/install/verifying-the-signature-of-a-catalog-file-signed-by-a-commercial-relea)

正文继续绑定完整 source SHA、Build ID、Host/ASAR/catalog/rules/matrix 摘要；另外明确 qualification ID、生产者证明集合摘要、发布者密钥版本、允许的 mode/slot/content/算法范围、签发/到期时间和撤销代次。未知字段、未知 scope 与未知版本均拒绝，不能用 renderer 提交的摘要填充预期身份。当前 12 项 TEST_ONLY 基础清单不够填满正式矩阵。

## 两个验证位置

| 验证端 | 下一步实现位置 | 信任输入与结果 |
| --- | --- | --- |
| Electron main | 固定、随程序交付的 Windows 平台验证助手；由 main 以结构化参数、隐藏进程调用，禁止 renderer 选择程序、脚本、资格路径或发布者 | main 自己确定安装资源与预期候选；助手经 Windows API 验证后返回小型结果，main 再校验正文、时效、范围及会话条件 |
| Rust Host | 已有内部 Windows API catalog 成员验证模块，尚未接入 RPC/运行资格 | 独立打开固定资格文件并验证；实际 Host/规则/内容身份校验仍需接入，不接受 main/renderer 的 `eligible=true` 替代验证 |

main 助手先采用系统 PowerShell 加固定 C# P/Invoke 的实现路线，避免把生产验证依赖于玩家安装 Windows SDK/SignTool。助手是受信任安装程序的一部分，不能从用户目录或远程下载脚本执行，不能接受任意代码；真实打包、启动时间、企业禁用 PowerShell 的行为仍需验证。平台能力不可用时拒绝新 Rust 接管，保留完整进度恢复；不能动态改用未经验证的 JS 信任判断。此路线尚未实现或纳入制品。

两端共享公开 schema 和测试向量，但独立调用 Windows 的信任验证，不把 Host 的回执当作 main 的签名证据。发布者预期值来自经过审查的程序发布策略，不能来自待验证的 JSON、环境变量、renderer 或玩家存档。签名者必须是获准的代码签名发布者；时间戳签名者不能被当作程序发布者。发布者固定、证书轮换及实际生产签名凭据仍需完成，不预填一个合成的获准发布者。

## Windows API 与文件快照合同

1. 对安装根、每级目录和两个文件做重解析点/类型检查；打开并持有目录与文件 handle，目录和文件都禁止共享删除及写入。验证期间任何锁定或路径身份检查失败均拒绝。目录锁定策略须在 Windows 的 rename/junction/hardlink 负例中实际证明，不能仅靠验证前后两次字符串路径相同。
2. 成员使用同一个打开的文件 handle 读取有界正文并计算 catalog 所需哈希；使用匹配 SHA-256 算法的 HCATADMIN 上下文。普通 `SHA256(file)` 不替代 Windows 的成员验证。catalog 最大 1 MiB、正文最大 256 KiB；不把完整玩家存档放进资格载体。[CryptCATAdminCalcHashFromFileHandle2](https://learn.microsoft.com/en-us/windows/win32/api/mscat/nf-mscat-cryptcatadmincalchashfromfilehandle2)、[WINTRUST_CATALOG_INFO](https://learn.microsoft.com/en-us/windows/win32/api/wintrust/ns-wintrust-wintrust_catalog_info)
3. 使用 `WINTRUST_ACTION_GENERIC_VERIFY_V2`、catalog 成员类型；只接受 WinVerifyTrust 返回 **0**。它不是 HRESULT，不能使用 `SUCCEEDED` 判断。`hwnd=INVALID_HANDLE_VALUE`，UI 设为 `WTD_UI_NONE`，不得弹验证或证书对话框。[WinVerifyTrust](https://learn.microsoft.com/en-us/windows/win32/api/wintrust/nf-wintrust-winverifytrust)
4. 启用明确的证书链撤销策略和 `WTD_CACHE_ONLY_URL_RETRIEVAL`，前台验证不产生隐式网络等待；缓存不足不能变成允许。独立的应用资格撤销和新鲜度检查仍然执行。每次 VERIFY 必须在所有返回路径执行 CLOSE，释放信任状态与文件/目录/HCATADMIN 资源。[WINTRUST_DATA](https://learn.microsoft.com/en-us/windows/win32/api/wintrust/ns-wintrust-wintrust_data)
5. 签名者从这次验证状态提取，绑定实际被接受的签名链，不能另读一个同名文件的证书。返回内容仅包含规范 ID、摘要、受控失败码、签名者身份和有效期；禁止资格正文之外的路径、密钥、玩家数据或证书私钥流入 renderer。[验证状态](https://learn.microsoft.com/en-us/windows/win32/api/wintrust/nf-wintrust-wthelperprovdatafromstatedata)、[签名者链](https://learn.microsoft.com/en-us/windows/win32/api/wintrust/nf-wintrust-wthelpergetprovsignerfromchain)

## 生效、失效和恢复

签名验证通过只产生“正文已认证”的内部凭据，不直接启用模拟。main 和 Host 还须确认当前程序、内容与状态处在获准范围，完成原单写者交接和持久 checkpoint/ACK，再开放时钟与命令。资格没有通过时，不能先运行 Rust 然后再补验证。

资格到期、撤销、时钟异常或内容变化后，先停止接受新的玩法命令和下一计算批次，完成/恢复已开始的原子持久边界，并停在最后可证明的 revision。已失效的玩法资格不应封死必要的只读导出和恢复通道：这类能力须单独限定为原权威进度的恢复，不允许新增 tick、离线收益或命令。禁止把旧 JS 镜像重新装回，覆盖较新的 Rust 存档。

防回退不能只靠玩家 profile 中可随备份回滚的一个时间戳或代次文件。需要签名撤销/时间材料、profile 之外的持久可信水位、并发协调和冷启动新鲜度策略；旧包安装、系统时钟倒退、资格缓存被恢复和撤销缓存离线均须测试。具体持久载体与新鲜度数值仍属实现前待决项，本页不宣称已经解决离线防回退。

验证专用资格必须由同一可信链签发，并绑定冻结程序、唯一隔离 profile 标识、确定的合成夹具摘要、有限时段和禁止云写入的范围。main/Host 都拒绝普通玩家 profile、其他夹具或复制后不符的身份。环境变量、启动参数与 UI 开关只能请求进入流程，不能制造这份资格。生产资格的完整范围仍需独立矩阵和正式签发，不能把验证专用会话累计为玩家发布通过。

## 按顺序实施与证明

已新增[真实签名测试流程](../reviews/rust-windows-signed-catalog-ci-2026-09-09.md)：只在临时云端 Windows 机上生成测试证书，验证信任前拒绝、签名成员/发布者/篡改、移除信任后拒绝和清理。本机仅编译及执行拒绝预检；云端实际终态未取得前，成功路径仍属待验。

1. 实现并交叉验证两个平台验证器：无签名、签名错误、成员不在 catalog、成员被改、发布者错误、重解析点/替换、文件超限、资源释放、无 UI、离线撤销失败；真实签名正例须使用明确的测试证书材料，与生产发布者分离。
2. 完成实际生产者认证、发布者轮换、时效/撤销防回退和验证专用资格签发；建立独立的候选输入，禁止从报告倒填预期身份。
3. 以可信验证资格在同一冻结程序中实际执行 Rust 接管、命令、暂停、保存、退出、重开和故障恢复；公开合成输入与实际 Native 结果、完整 JS 对照分开记录。
4. 按完整目标覆盖普通/竞速、内容、长离线、性能/内存、多线程、长测、Windows 安装升级回退，形成正式资格与发布候选。阶段 1 的验证器测试不替代阶段 3/4。

当前没有调用签名服务、修改系统证书存储、读取私钥或更改生产资源。研究与本方案仅用于推进上述实现，不能解除现有准入门槛。
