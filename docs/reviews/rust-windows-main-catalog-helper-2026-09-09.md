# Windows main 独立 catalog 验证助手

2026-09-09，Role: develop，基于 `355d4d5e`。**完成只读助手与 main 调用模块初版；尚未连接实际游戏启动、打入冻结安装包或开放实时权威。** 本批推进完整 Windows Rust 的可信资格前提，没有新增游戏性能结论。

## 实现与边界

- [独立 Rust 程序](../../native/dsp-native-host/src/bin/dsp-catalog-verifier.rs)只有一个有界 stdin 请求，没有 Host RPC、游戏 tick、写档或证书安装入口。请求最多 16 KiB，严格版本、未知/重复字段拒绝、随机 nonce、绝对安装根及 1–8 个独立发布者摘要。错误输出为固定代码，不回显原路径或输入。
- [main 调用模块](../../desktop/native-catalog-verifier.cjs)固定运行安装资源根下的 `native/dsp-catalog-verifier.exe`。根目录、程序预期摘要与发布者列表须由受信程序提供；没有默认生产发布者、环境策略覆盖或 renderer 接口。先检查目录/文件身份和程序摘要，隐藏、BelowNormal 启动，15 秒截止，输出最多约 513 KiB。进程未正常退出、超限或错误输出不得产生凭据；终止无法确认时封锁该 verifier 的后续启动。
- 助手复用 Rust Windows 文件锁和 WinTrust 实现，但在自己的进程重新打开固定正文与 catalog、独立调用 Windows 验签。**这是独立进程验证，不是两份不同语言的实现，也不把模拟 Host 的回执当作 main 的签名证据。** 采用 Rust 替代先前拟定的 PowerShell/C# 路线，减少重复 FFI 和玩家运行时脚本依赖。Windows [脚本执行策略](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_execution_policies?view=powershell-7.5)不会成为该助手的启动前提。
- main 校验响应 nonce、规范 JSON、精确字段、正文 SHA-256 和发布者，返回 WeakMap 持有的内部凭据。读取正文每次复制，JSON 或 IPC 不能制造凭据。正文认证仍不等于玩法授权：候选身份、schema、生产者认证、模式/内容范围、时效撤销和持久单写者交接仍待接入。
- 安装目录及 main 本身是受信边界。Node 的程序身份检查不提供 Windows deny-write handle 锁，不能宣称防御具备修改安装程序权限的 OS 攻击者在 CreateProcess 前竞态替换助手。实际签名交付、安装目录与制品身份验证仍需完成。

## 本机验证

`artifacts/rust-rp1-loop/windows-catalog-helper-v1.json`：Rust 助手 3/3，严格 release workspace/all-targets Clippy、fmt、真实 release 助手构建通过；main 单元 8/8、实际助手进程集成 2/2，均零失败跳过。覆盖伪造 nonce/摘要/发布者、响应重复字段、无效十六进制、错误退出、最大正文、超限/诊断输出、并发/终止未确认和凭据复制隔离。实际进程验证缺失载体拒绝、退出后文件可重命名，以及错误/重复/超大 stdin 的受控拒绝。

助手为 **665,600 bytes**，SHA-256 `6f32df339f538f58f5fef11435b915d5568f19beb7fe43cde53105a34d075726`。守护正常退出 0，11.580 秒，最低空闲 7,119,592 KiB，6/2 GiB 门槛。

追加 `windows-catalog-helper-build-v1.json`：正常构建入口同时产生 Host/助手，桌面入口、包身份与发布工具 32 pass/1 skip/0 fail，跳过项为本机无目录符号链接权限。守护正常退出 0，44.536 秒，最低空闲 3,928,124 KiB，保留 6/2 GiB 门槛。新 Host 为 17,906,176 bytes，SHA-256 `d03577bac6b902eb773be95a351e8857c545e9ca83f4e0258b7517361f0e4c35`；没有重新冻结完整游戏安装包，旧包证据不转算本批。

`windows-catalog-ci-preflight-v4.json`：PowerShell 解析/拒绝和 Node 云端夹具误调用拒绝 3/3，零失败跳过；守护正常退出 0，3.258 秒，最低空闲 7,206,880 KiB，轻量 3/2 GiB 门槛。上述源码摘要随证据保存。没有启动游戏、操作本机证书库或读取玩家存档。

## 云端接续与剩余工作

[云端助手脚本](../../scripts/test-native-catalog-helper-ci.mjs)加入已有测试证书生命周期：安装测试信任前 main 拒绝两个 catalog；信任有效时 8 类检查，包括实际成员接受、错误发布者、轮换、另一个自身有效 catalog、正文/签名篡改和恢复；移除信任后两个 catalog 再拒绝。每个检查实际启动独立助手，发布者摘要来自本次创建的证书，不从正文取值。helper 构建安排在证书创建之前。

`bfae44fd` 首次云端在测试根安装阶段超时，正例未执行，清理通过；`355d4d5e` 修复后实际 Host 签名、篡改和移除信任拒绝全部通过，归档与源码摘要已核验，详见[签名测试记录](./rust-windows-signed-catalog-ci-2026-09-09.md)。本批新增 main 成功签名路径仍须由后续云端真实结果证明，单元伪造回执不算签名正例。

下一步完成实际冻结包交付/助手身份绑定、双端资格正文和独立生产者验证、到期撤销及真实接管。`authority_eligible=false` 保持，完整终局流程、复杂长离线、玩法矩阵和发布候选也仍在完整目标内。
