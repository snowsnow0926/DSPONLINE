# Windows 验证会话身份 v1

2026-09-10，Role: develop。为[验证正文](./windows-validation-body-v1.md)补充隔离目录和固定公开夹具的独立事实。本模块不授予资格、不切换 Electron profile、不调用模拟或云服务。实际执行结果见[本批记录](../reviews/rust-windows-validation-session-2026-09-10.md)。

## 目录和输入

main 准备器不接收路径或存档；在 OS 临时根下新建 `dspidle-rust-validation-<32位随机小写十六进制>/`，内含空 `profile/` 和 `fixture-v47.json`。使用非递归、排他创建，不复用已存在目录，不覆盖同名文件，不删除准备失败后身份不确定的路径。准备阶段的 Node 目录检查不等于持久 Windows 句柄锁。

夹具由真实前端初始化和保存序列化器生成，空内容包、固定种子 1040406、normal/main、v47/envelope v2，保存时间和轨道合同确认时间固定为 1767225600000。它是公开新游戏数据，非玩家档、终局档或性能工作负载。`desktop/native-validation-fixture-v1.json` 同时编入 Rust、随自身 ASAR 交付；构建重新生成并逐字节验证漂移，不自动重写过期输入。最大 1 MiB。

Host 和 main 的独立平台助手只接受 32 位 selector，自己从 OS 临时根推导固定路径；不能传入 profile 路径、摘要、fixture、cloudWrites 或 authorityEligible。临时路径和 selector 只是查找条件，不能制造资格；尚未承诺跨机器复制、卷克隆或防回退。

## Windows 身份与锁

Rust `ValidationSessionLease::open` 打开并持有各级目录和夹具，拒绝重解析点、路径别名语法、非目录/非文件、夹具硬链接及超过大小限制的输入；夹具必须与编译公开字节完全相同。目录与文件均不共享写入或删除。持有期间可在 profile 内写入新进度，但不能重命名被锁的 profile/祖先或改写夹具。

profileId 是以下串联字节的 SHA-256 前 16 字节，输出 32 位小写十六进制：域标记 `dsp-windows-validation-profile-v1` 加 NUL；32 字节 ASCII selector；session 根、profile 目录依序各自的 64 位卷序列号、128 位 Windows 文件 ID、64 位创建时间（整数均 little endian）。通过同一锁定句柄取得 `FILE_ID_INFO`，不支持 API、零/无效文件 ID 即拒绝。复制全部文件后新建目录、更换 profile 或重建 session 根会改变身份。Windows 的文件 ID 与卷序列号用于区分实际打开文件，见 [Microsoft FILE_ID_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_id_info)。

Rust lease 不可从 JSON 构造，保留锁直到释放。它提供的初始夹具是已核对的编译字节；未来准入必须从这些字节导入，不能改为读取 profile 中碰巧存在的玩家存档。

## 快照不是运行租约

两个真实可执行程序都支持只读 `inspect-validation-session <selector>`，不打开 SaveStore。main 从自身 ASAR 找到平台助手路径与嵌入摘要，以隐藏、BelowNormal、无 shell、有限输出/时限调用；不读取模拟 Host 的会话回执作为自己的证据。响应再与 main 自身夹具摘要交叉核对，并拒绝非规范 JSON、重复/未知字段、无效 UTF-8、身份类型混淆及权限位改变。并发调用拒绝，无法确认子进程终止时禁止再次启动。

返回 schemaVersion=1、kind=windows-validation-session-snapshot-v1、sessionId、session（profileId/fixtureSha256/cloudWrites=false）、authorityEligible=false、releaseAllowed=false。只读调用结束便释放锁，快照**不能作为跨进程持续持有的租约**。

当前尚未接入正文绑定、实际 profile 切换、持续 main 助手租约、云网络拦截或单写者交接。cloudWrites=false 是验证范围声明，不是已经验证的运行期网络隔离。未来运行准入还须持有/复验真实句柄、独立签名/时间/撤销/生产者上下文，并拒绝用旧快照或复制目录恢复资格。实际玩家范围、竞速/内容包和完整矩阵仍待开发。
