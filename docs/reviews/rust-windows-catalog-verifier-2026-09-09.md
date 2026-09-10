# Windows Rust catalog 成员验证器初版

2026-09-09，Role: develop。工作分支 `codex/rust-rp1-after-1.2.7`，基于 `ae1ecbf0`。这是完整 Windows Rust 目标的接管前置模块，不是实时授权或发布验收。

## 已实现边界

新增 [Rust 验证模块](../../native/dsp-native-host/src/qualification_catalog.rs)。独立程序策略必须显式提供 1–8 个不重复的发布者证书 DER SHA-256；模块不提供生产发布者默认值。固定读取安装根下 `native-qualification/qualification.cat` 和 `qualification.json`，上限分别为 1 MiB、256 KiB。

只接受本地绝对路径，在访问文件前校验完整路径语法。逐级打开目录并拒绝重解析点；目录及文件禁止共享写和删除，文件必须为单硬链接普通文件。正文从锁定 handle 有界读取，同一 handle 交给 SHA-256 HCATADMIN 计算 Windows catalog 成员哈希。验签过程中保持全部目录、文件、路径和 Windows 验证状态存活。

仅从 System32 动态加载 WinTrust；使用 catalog 成员验证、无 UI、仅本地撤销缓存策略，严格只接受返回 0。从本次成功状态提取主签名者，区分时间戳签名者，要求 SHA-2 签名摘要，并核对独立发布者策略。全部退出路径关闭 WinTrust 状态、释放 HCATADMIN、DLL 和文件锁。返回值字段私有，只暴露认证正文和摘要，不含 `eligible`，没有 Host RPC、renderer 或 main 接线。

旧保存测试的 Windows `mklink` 辅助命令补上 `CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS`；新的联接夹具同样隐藏低优先级执行。Electron 通信夹具补齐临时 profile、静音、不可聚焦、跳过任务栏、禁止显现方法及 60 帧离屏运行，父进程在结束后只清理自身创建的临时目录。生产存档逻辑未改。

## 本机证据

首轮 `artifacts/rust-rp1-loop/windows-catalog-focused-v1.json`：正常 release 6 项专项、fmt、严格 workspace/all-targets release Clippy 全部通过。外部守护正常退出 0，用时 218.295 秒，最低空闲 5,379,612 KiB；启动 6 GiB、停止 2 GiB 门槛未改。

专项覆盖缺失/重复/超量发布者策略、Windows 实际拒绝伪造 catalog、连续八次失败后锁释放、写入/目录替换被锁阻止、硬链接、正文和 catalog 空文件/超限、已有写 handle 和非法路径。后续增加真实目录联接夹具，分别在载体目录和安装祖先处拒绝，目标文件保持原样。

完整 `windows-catalog-full-v2.json` 已 PASS：新增专项 7/7；正常 release 核心 1,115 pass/5 ignored、Host 库 260 pass/1 ignored、Host main 3/3，严格 workspace/all-targets Clippy、fmt、正常 Host build 通过。Native Node 750 pass/1 条件跳过/0 fail。守护正常退出 0，1,102.250 秒，最低空闲 4,314,504 KiB，6/2 GiB 门槛未改。本批没有重跑未修改的完整游戏/Web 回归。

正常 Host 为 17,906,176 bytes，SHA-256 `821433eb6241c226e7c58de8918cdd89f961c50972a301bde8ab4e7bda7a2d3b`。尚未生成包含此模块的新冻结 Windows 包。

最后的通信夹具隔离/清理修改另做 `windows-catalog-background-v3.json` 增量验证：7/7、0 skip、0 fail，实际 Electron 双向传输 31,457,280 bytes，显示/焦点事件均 0，静音、不可聚焦、60 帧离屏、独立 profile 均通过；守护正常退出 0，2.754 秒，最低空闲 7,069,108 KiB。此前 v2 同样 7/7；v3 绑定最终排版后的文件。它是独立通信夹具，没有加载游戏或玩家资料。全套 Native 结果与最终增量分开记录，不声称随后又重跑整套 Rust。`windows-catalog-background-binding-v1.json` 在全套结束后才记录，不作为执行前绑定证据；增量驱动在启动前绑定实际受测文件。

本批未读取或改写玩家存档，未修改系统证书存储或调用生产签名服务。

## 前一提交云端终态

`ae1ecbf0` 的 Windows run `34356690641` 已 SUCCESS：正常核心 1,115/5 ignored、Host 256/1 ignored、完整游戏 3,180/39 skip，均零失败。Linux 单元、构建、Server/Ops/Native 通过。完整浏览器 run `34356690706` 为 460 直接通过、33 skip、5 unexpected、1 flaky，仍未通过发布门禁。

分片 1 为 237/11 skip/4 fail/0 flaky，失败在建设连放、移动端路由、校验损坏救援和暂停画布；分片 2 为 223/22 skip/1 fail/1 flaky。后者的冷菜单 p95 两次为 551/539 ms，原门槛 500 ms；读取正文、解析及缓存正确性断言均先通过。减少同机 browser worker 后的这次失败数低于前次，不能仅据此认定所有原失败已修复。这些云端结果对应 ae1，不包含本批的新验证模块。

## 尚未完成

- 真实受信任签名正例、成员篡改/不属于 catalog、错误但有效发布者、证书到期和撤销场景尚无完整证据；负例通过不证明正例可用。
- main 的独立平台验证器、正式发布者策略与轮换、证据生产者认证尚未接入。
- 资格正文 schema、程序与规则身份匹配、有效期/撤销/时钟防回退、受限验证资格和失效后的恢复能力仍需完成。
- 普通 Host 继续 `authority_eligible=false`，没有开放实时接管。本批没有新的整段等待、帧率或全进程内存收益结论。
- 当前工作不会改变既有终局 v15 `targetClosed` 的失败结论，也不替代复杂长离线、真实实时运行、全玩法、长测与 Windows 安装升级回退验收。

当前模块只完成[载体方案](../rust/windows-qualification-carrier.md)中的 Host 验签基础。[完整目标](../rust/windows-full-development.md)保持 active，继续推进其余步骤。
