# Windows Rust：Host 独立安装身份

2026-09-10，Role: develop，完整 Windows Rust Goal active。基线 `4b74a919345d99576af2b6cd1a776955967a32c8`；此前 c9aa 冻结包只通过 main 安装身份和助手拒绝验证，本批增加 Host 独立提供者及只读实际进程入口。仍无玩家准入或发布权限。

## 实现

Host 从自己的 OS 可执行文件路径定位安装资源，锁定祖先与 Host/ASAR 文件，解析固定元数据成员、核对版本和 Build ID，再计算完整程序摘要。不接收外部路径，不打开 SaveStore、模拟注册表或云连接。提取既有 Windows 有界文件打开函数供 catalog 与安装读取复用，原共享模式、重解析点和硬链接检查保持。合同见[双端安装身份](../rust/windows-installed-program-identity.md)。

## 当前实际证据

初版 `host-installed-validation-v1`：正常 release 全 Host 库 **271 pass / 0 fail / 4 专用 ignored**，格式、严格 workspace/all-targets Clippy、正常 Host/助手构建通过。守护正常 exit 0、无停止原因，249.8971545 秒，最低空闲 4,890,108 KiB，6/2 GiB 门槛不变。

初版实际 Host 进程测试 **2 pass / 1 fail / 0 skip**。公开 ASAR 由独立 Electron reader 正常读取，真实 Host 正常安装身份及额外参数拒绝已经执行；新增损坏 UTF-8 负例却返回 exit 0，整个安装场景因此失败，不能称为通过。该负例把目录中被忽略的 integrity 字段改成非法字节；本机 serde_json 源码和实际结果确认，跳过字段不等于完整文本编码验证。开发目录拒绝、未产生存档的测试通过。守护正常结束 exit 1，0.5188472 秒，最低空闲 8,576,624 KiB。

已增加目录和两份元数据正文的完整 UTF-8 检查及对应 Rust 负例；补强零填充测试以确保实际执行填充拒绝。最终 `host-installed-validation-v2` 的格式、严格 workspace/all-targets Clippy、完整 Host 库 **272 pass / 0 fail / 4 专用 ignored**、正常 release Host/助手构建全部通过。源文件前后摘要一致；守护正常 exit 0，无停止原因，250.0917492 秒，最低空闲 5,829,520 KiB，6/2 GiB。

最终实际进程及相关 Node 回归 `host-installed-process-final-v2-guard` **63 pass / 0 fail / 0 skip**：24 项 main 安装身份、3 项独立 ASAR/实际安装 Host/开发目录拒绝、34 项原 Host 进程及 2 项助手进程。无效 UTF-8 实际进程反例已转绿，原 serve 流程正常。守护正常 exit 0，无停止原因，47.2773933 秒，最低空闲 6,407,080 KiB，6/2 GiB。

本次正常构建 Host SHA-256 `3e68e32e959aee7c6d7cf053c52dfccfd43592279a0a0d25de8f1d5d461f4c77`，助手 `645249e89e56fdb1966ddff5bfc4a21db89c43154de561ba87d5892642bd5b5e`。新冻结包及包内 main/Host 独立身份对照待执行，旧 c9aa 包不含本次 Host 实现，不能继承成新实现实包通过。

## 剩余范围

本批仅取得九个程序文件字段，游戏 catalog/rules/matrix、profile 与夹具绑定、可信时间与签名撤销/防回退、生产者认证及实际准入仍缺。下一步把这些独立上下文接入既有已验签正文绑定和持久单写者交接，不能让只读 inspect 命令授予运行资格。普通/竞速、完整玩法/命令/投影、保存云兼容、终局成功入口、长离线、性能/内存、长测/硬件、签名安装升级回退均仍在完整 Goal 内。

测试保持后台、静音、无可见窗口、BelowNormal、单个重任务及 6/2 GiB 守护。没有修改原用户工作区、玩家原档或生产环境。
