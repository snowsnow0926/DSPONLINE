# Windows 持续验证会话 v1

2026-09-10，Role: develop。将[目录身份快照](./windows-validation-session-v1.md)接成实际进程持续持有的读锁。它不是玩法资格、单写者 fence、云网络隔离或正式发布许可；没有接入普通 Host `serve`、renderer IPC 或模拟时钟。执行结果见[本批记录](../reviews/rust-windows-validation-lease-2026-09-10.md)。

## 进程与有界协议

实际 Host 与独立平台助手新增专用入口 `hold-validation-session <32位selector> <64位challenge>`。selector 从 OS 临时根查找固定公开会话，challenge 只用于匹配该次启动。程序持有真实 `ValidationSessionLease`，不接受根路径、fixture、scope、权限、截止时间或游戏状态参数。

启动输出 compact UTF-8 JSON+LF：schemaVersion=1、kind=windows-validation-session-lease-v1、event=ready、sequence=0、原 challenge、既有完整 snapshot。后续输入固定顺序 schemaVersion/sequence/challenge/command，command 仅 probe 或 release；sequence 从 1 连续增长且不超过 JS 安全整数，challenge 严格 64 位小写十六进制。每帧最多 256 字节，拒绝缺少 LF、重复/未知字段、非规范 JSON、无效 UTF-8、未知命令、重放/乱序和非法数值。

probe 返回 event=live，release 返回 event=released，两者回显本次 sequence/challenge 和同一锁定目录的 snapshot。不得从该响应获得玩法权威。release 后退出；EOF、输入/输出错误、协议拒绝或 15 秒无完整请求也退出并释放锁。部分字节不能延长等待。输入线程只负责有界读取，单元素队列限制预读请求；它不持有目录锁，专用进程入口结束后进程退出，不作为普通库内可反复调用的后台服务。

## 主进程持有者

main 从自身 ASAR 定位并核对平台助手摘要，以隐藏、BelowNormal、无 shell 的固定参数启动。每个 broker 同时只持有一个助手；acquire 返回不可复制的空对象 token，内部 WeakMap 关联真实子进程，JSON 快照不能还原它。

main 核对 ready 的启动 challenge 与实际固定夹具、profile 身份；每 5 秒自动 probe，并对每次响应设置 5 秒期限。启动期限 15 秒；输出单帧/缓冲区最多 2 KiB。所有 ACK 必须匹配当前 sequence/challenge、事件及初始 snapshot，未知/畸形或无请求的输出使会话失效。

调用方通过 probe 取得当前确认，通过 closed 等待释放/丢失通知，通过 release 请求释放。释放 ACK 不等于锁已释放；成功必须等待正常 exit 0、无 signal、无剩余输出。失联、非预期退出或超时后原 token 不可用，不自动恢复或从旧快照重新制造资格。强制终止无法在 2 秒内确认时 broker 被永久停用，禁止再启动重叠助手。

接入尚未返回 token 时，失败必须等到助手确认 close 或返回 termination-unconfirmed 后才结束；调用方不能拿到一个无法观察退出的普通启动超时。ready/probe 回复解析成功后，异步返回前再次核对会话仍然有效，拒绝同一输出回调里紧接着出现的异常数据。此处的存活确认不替代随后每个实际命令/持久边界的准入核对。

## 接入边界

这是持续锁与进程生命周期基础。实际 runtime 仍须把失效信号连接到 tick/命令准入，在每个持久边界遵守原恢复规则，并具备可信正文、签名发布者、时效/撤销、证据生产者和完整矩阵。main 的 profile 切换、云请求拦截及已持久进度恢复也仍需接入；本批不把正常玩家目录、当前云档或已有恢复镜像当作合成初始输入。
