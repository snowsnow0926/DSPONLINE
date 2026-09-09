# Windows Rust：先完成启动恢复，再创建普通模拟 Worker

2026-09-09，Role: develop。本批修正实际冻结 Windows 包发现的启动顺序问题；完整 Windows Goal 仍 active，尚未发布，也未开放 Rust 实时玩家权威。

## 实际冻结包与失败

[84e79a86 构建收据](../../artifacts/rust-rp1-loop/package-84e79a86-receipt.json)：干净源码 `84e79a8608c9d467258c9d142ef49947c68d43f4`，开发 beta `1.2.7+84e79a8608c9`，75 件制品、78 个冻结文件通过。Host SHA-256 `7253807b6ccead1ba2f02d0175294d716064d34517c7e05b740530bf5ef9474b`，与本批完整 Rust/Native/游戏验证的程序一致；ASAR `d2366175526448d62035c8bc13d96faca5faea14f20b51357e2036b89fba39c8`。此前 a6 冻结目录未变。

- [完整入口 v10](../../artifacts/rust-rp1-loop/private-packaged-complete-v10/report.json)：FAILED，未在原 90 秒内达到 active 工厂；9 秒真实 Native 请求 46,079.5539 ms，exact=9、approximation=0。87.49 秒创建 Worker，90.61 秒首次传输 205,666,648 bytes。超时后的诊断看到第二个 Worker，以及约 96.68 秒才出现 active；不能把超时后观察算作通过。退出请求被 renderer 立即归为 refused，25 秒后仍未正常退出，已强制清理本次所属隐藏进程。
- [同包 v11 观察诊断](../../artifacts/rust-rp1-loop/private-packaged-complete-v11/report.json)：仍 FAILED，原 90 秒未通过；9 秒 Native 请求 44,207.8248 ms。只增加 Worker terminate 的静态资源行列位置记录，没有改模拟、超时或包。85.97 秒创建第一 Worker，87.80 秒传输；88.22 秒终止，88.68 秒重建，90.33 秒又传相同大小。两次正常关闭均 exit 0，不覆盖 v10 的失败。

两次候选 canonical 均 `6cf99f1d4d8bb0f172448c1c2e790b7cf5acd2cf47de9a6bede3e28a5ee8f96b`，原注册终局档字节/mtime/摘要未变。它们没有走到成功入口后的独立完整 JS 对照、主档核验和两次重开，不得补记通过。单次 RPC 数值不能替代三对 A/B，也不是整款游戏提速。

[构建守护](../../artifacts/rust-rp1-loop/build-desktop-84e79a86-guard/guard.json) 正常 exit 0，64.0872913 秒，最低空闲 5,890,480 KiB；[v10 守护](../../artifacts/rust-rp1-loop/private-packaged-complete-v10-guard/guard.json) exit 1，135.6557468 秒，最低 4,187,688 KiB；[v11 守护](../../artifacts/rust-rp1-loop/private-packaged-complete-v11-guard/guard.json) exit 1，118.9391256 秒，最低 5,368,068 KiB。全部 6/2 GiB、串行低优先级，隐藏/静音/不可聚焦，实际 show/focus 事件均 0。

## 原因与修复

v11 的第一条终止栈绑定冻结资源 `FactoryRuntime-CNownMpi.js` 第 2 行列 1,154,538/1,156,052；从同包 ASAR 提取对应代码，确认是 `native-player-authority-startup-reconcile-v1` 分支调用 `stopLegacySimulationWorker`。第二条终止是正常 React effect cleanup。没有 Worker error 或 needs-resync 回复在前，故不是首次模拟计算失败引发的重试。

之前仅等待 main 的时钟回复 ready，随后便创建普通 Worker。main 发来的启动挑战还需检查浏览器持久 handoff 日志，晚到的挑战会停止刚创建的 Worker；确认不存在遗留 Rust 租约与浏览器锁后又重建。未完成的启动检查还会令退出保存受保护；v10 的具体保护分支仍未单独取证，不能断言所有关闭失败只有这一原因。

现在具有启动 handoff 接口的客户端从挂载起保持启动等待，并在同步保存/异步租约入口读取同一等待标志。仅三个已经验证的终态清除等待：无浏览器锁、持久归还浏览器锁完成、匹配真实 Rust 会话并完成绑定。unknown、fail-closed、异常和持久归还失败继续阻止旧 JS 操作；没有新增超时放行、环境变量或 renderer 授权入口。Web/旧桥接没有该接口时沿用原启动行为。

## 验证

[旧代码反例](../../artifacts/rust-rp1-loop/startup-reconcile-order-red-v1.json)：0 pass / 2 fail，两项都观察到不应提前创建的 1 个 Worker。

[修复后三轮](../../artifacts/rust-rp1-loop/startup-reconcile-order-green-v1.json)：6 pass / 0 skip / 0 fail / 0 flaky。使用真实 React/Worker/IndexedDB 和明确的桌面协议替身，覆盖 ready idle 时钟仍等待启动检查，以及 unknown 保持停止、后续已确认 absent 才继续；成功后仅创建一个 Worker、没有提前终止。它是界面协议回归，不是 Native 资格。没有增加原测试超时或重试。[浏览器守护](../../artifacts/rust-rp1-loop/startup-reconcile-order-green-v1-guard/guard.json) exit 0，26.1066693 秒，最低空闲 9,358,340 KiB。

[完整集成](../../artifacts/rust-rp1-loop/startup-reconcile-integration-v1.json)的类型、Native 接口 750 pass/1 skip、完整游戏 3,176 pass/39 skip 均通过，实际 Native 对照 50 pass/1 长测 skip。该次报告保留 FAILED：Web 编译及前两项门禁已通过，最后的覆盖清单校验因 App 新增行使记录行号过期而失败。

[定向补验](../../artifacts/rust-rp1-loop/startup-reconcile-build-v2.json)核对前次源码、Host 与成功步骤未变，仅重新生成 29 个写入面的源码行号，并逐字段确认覆盖范围和权限未变。Web 构建及全部门禁通过；画布三类检查各三轮 9 pass/0 skip/0 fail/0 flaky。[补验守护](../../artifacts/rust-rp1-loop/startup-reconcile-build-v2-guard/guard.json)正常 exit 0，86.0095403 秒，最低空闲 8,235,728 KiB，沿用 6/2 GiB。本次无 Rust 修改，仍为上述同一 Host；不把旧 FAILED 报告改写为 PASS。

84 源码的 Linux 构建、游戏单元和 Server/Ops/Native 云端检查通过；浏览器仍 407 expected/33 skip/31 unexpected/22 flaky，Windows 云端全量通过。云端已通过修正后的可见端口断言，下一条旧固定路由高度 256 却遇到 Linux 实测 257。本批把这一测试预期改为独立 DOM 卡片高度加原 64 单位留白，保留命中、选择、路由及原超时，以上本地 9 次均通过；新 Linux 结果仍待验证，其他浏览器失败未据此销项。

修复后的冻结包仍须自己的原 90 秒终局入口、正常关闭、完整持久状态与两次重开证据。正式资格、实际实时单所有者与完整发布矩阵继续按[目标](../rust/windows-full-development.md)推进。
