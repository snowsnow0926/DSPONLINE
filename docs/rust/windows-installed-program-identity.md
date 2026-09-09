# Windows Rust 安装程序身份合同

2026-09-10，Role: develop。为[验证正文绑定](./windows-validation-body-v1.md)提供独立程序文件事实；完整候选还需要游戏 catalog/rules/matrix、会话、可信时间/撤销和认证生产者。身份摘要本身不是签名，也不授予玩家权威。

## 两端输入和输出

main 的 `collectPackagedWindowsProgramIdentity` 只从自身模块所在 ASAR 对应的安装资源读取；可信 main 可以选择该安装根，renderer 没有接口。Host 的 `collect_installed_windows_program_identity` 则从 OS 的当前可执行文件路径出发，必须处在 `resources/native/dsp-native-host.exe`，不接受 main/renderer、环境变量或报告提供的根路径。

两端各自输出九字段：version、sourceSha、buildId、editionId、channel、platform、arch、hostSha256、asarSha256。源码 SHA 和 Build ID 来自 ASAR 自身 package 元数据，与 `dist/version.json` 交叉核对；Host/ASAR 摘要来自实际文件完整字节。只支持 Windows x64、beta、`windows-performance-development-v1` 和干净 Build ID。不能把这九字段补上任意三个摘要当作完整可信候选。

## 文件与 ASAR 读取

Host 复用既有 catalog 验证器的 Windows 文件打开检查：祖先和文件保持句柄，拒绝共享写入/删除、重解析点与安装文件多硬链接。程序文件、ASAR 元数据与最终哈希在这些句柄存续期间读取；没有从另一个路径重新打开已核对的成员。main 使用 `original-fs` 读取实际磁盘容器，Electron ASAR 接口读取包内成员，并核对检测到的替换；两端不声称抵抗特权 OS 攻击者或证明已经载入的代码连续性。

| 输入 | 上限与处理 |
| --- | --- |
| Host | 128 MiB；完整 SHA-256，每块 64 KiB |
| ASAR | 256 MiB；完整 SHA-256，每块 64 KiB |
| Host 读取的 ASAR 目录 | 4 MiB；验证两层 pickle 长度、零填充、完整 UTF-8、唯一成员名及有限递归 JSON |
| package.json / dist/version.json | 各 64 KiB；完整 UTF-8 后解析，已知身份字段重复/缺失/类型不符拒绝 |

Host 只按固定成员名查找两份元数据，不提取文件到磁盘；拒绝目标或祖先的 link/unpacked 标记、非规范十进制偏移、越界/溢出/重叠区间、损坏或截断输入。Rust 的 JSON 跳过字段可能不验证其中的 UTF-8，所以编码校验覆盖完整目录及元数据正文，不能只检查已知字符串字段。

## 只读进程入口和验证

`dsp-native-host inspect-program` 没有其他参数；额外路径参数均拒绝。成功输出单行 schema 1 / `installed-program-identity-v1` JSON，包含 program 与固定 `authorityEligible=false`；失败仅输出固定错误码并 exit 1。该分支在打开 SaveStore 或创建 CoreRegistry 前返回，不启动模拟，不恢复或写入存档，不新增 Hello capability 或 renderer RPC。

公开 [ASAR 夹具](../../native/fixtures/installed-program-v1.json)由既有 Electron ASAR writer 生成，只有合成 package、version 和 HTML 字节，明确 TEST_ONLY。Rust 解析器与 Node 的独立 ASAR reader 使用同一份原始字节；Node 实际进程集成复制真实 release Host 到隔离目录，在无关 cwd 和伪造环境覆盖值下检查自己的程序身份，并验证不产生存档文件。夹具不是玩家包资格，实际冻结包的 main/Host 对照需要另外记录。

执行状态和首次失败见[本批证据](../reviews/rust-windows-host-installed-program-2026-09-10.md)。完整目标继续保留终局成功保存入口、长离线、完整实时准入及玩法、兼容、性能/内存、长测/硬件和发布候选要求，见[执行计划](./windows-full-development.md)。
