# Rust RP1 终局档实际入口等待｜2026-09-09

> 后续新包 37630d05 包含保存优化，完成入口仍失败；9 秒完整 JS 对照、取消保档与取消后两次重开现已通过，见[新包复验](./rust-rp1-private-cancel-2026-09-09.md)。下方保留原 2bb 包 v1–v4 的当时证据及未执行项。

Role: develop。完整终局档已在真实隐藏 Windows 包中走到 Rust 候选返回，但两次均未在原 90 秒内进入可操作工厂。本记录保留失败，不代表终局档保存、重开、取消或整体提速已验收。

## 来源与运行身份

授权原档为 107,637,967 bytes，SHA-256 `d64b5646f6117f3c089fba4dc95a95e84bedd9375f75b3c8c917b2e7cf473bc1`；完整保留 110,042 实体、233,300 条带。四次前后大小、mtime、SHA 均相同，原档和玩家本机日志没有修改或上传。诊断只刷新独立副本信封的 savedAt，保留其原状态；真实菜单执行已有 orphan timeWarp 恢复。此短时条件不代表原档积累的长离线已结算。

包为冻结 `2bb10b435bd6a20d9cbea48f4349d3c7d5030f00` / `1.2.7+2bb10b435bd6` Windows performance beta，75 件制品验证通过。驱动提交 `7cfcdd60748a6d729a0e75e8f784ebb887743a14`，生产 `src` / `desktop` 与包来源相同，新增测试不改变运行时。实际 Host 保持本机冻结 SHA-256 `1f19d28a92702096492293b8cde667252dc44859790b4a3055230122851ef80a`，没有替换为云端新 Host。

所有启动采用已验证 hidden-no-focus-offscreen-v2、独立临时 profile、仅回环网络、静音和低优先级。外部监控坚持 6 GiB 启动 / 2 GiB 停止，串行执行；没有放宽 90 秒工厂就绪或 25 秒正常关闭期限。

## 四次原始结果

证据均位于开发 worktree 的 `artifacts/rust-rp1-loop/`；对应驱动 `probe-private-packaged-entry-vN.mjs`、结果 `private-packaged-complete-vN/report.json`、外部守护 `private-packaged-complete-vN-guard/guard.json`，旧文件保持原样。

| 尝试 | 已确认结果 | 整个守护时长 / 最低可用内存 |
| --- | --- | --- |
| v1 | 巨大 DevTools 参数传输约 190 秒；手工种入 revision 后漏了页面重载，正常关闭失败，仅清理自己的失败测试进程 | 234.284 秒 / 3,976,692 KiB |
| v2 | 用带随机标识的回环 HTTP 传输，约 1.2 秒；仍缺少重载，正常关闭失败 | 44.730 秒 / 6,612,444 KiB |
| v3 | 补齐种档后重载和目录 bytes 元数据，两次正常退出 0；真实 Rust 返回 9 秒精确候选，但工厂就绪超时 | 105.555 秒 / 3,724,888 KiB |
| v4 | 加入仅记录静态阶段及时间的观察；同 9 秒候选返回，仍在工厂就绪阶段超时；两次正常退出 0 | 106.367 秒 / 5,312,776 KiB |

v1/v2 的关闭拒绝符合 `closeLocalSaveWriter` 对旧缓存 revision 与真实主档不一致的保护，原因是驱动漏掉重载，不是生产退出故障。v3/v4 没有强制退出。四次都记 FAILED，没有以 Host 成功替代整个流程成功。

| 结果文件 | SHA-256 |
| --- | --- |
| v1 report | `b84c916f3c5ea5bddd7a492513032b980d0581583555aaf2067f6e6c8542171b` |
| v2 report | `7354b93cd28416915e5fb1b75b3dd3e4adaf420f07d3b8421316aa2e18439c43` |
| v3 report | `c61e9849221ee1366dea0a6153f051ccaa117d2be9508caa5a6dc07254af8598` |
| v4 report | `9473f7fa60a2ae3c62d7a69fbb31e7c4c4ff6d3bc354985f40e87064ded727ed` |

## 等待发生在哪里

v3/v4 的 Host 请求分别 49,235.330 / 50,147.567 ms，均 `prepared=true`、`settledSeconds=exactCalibrationSeconds=9`、`approximatedSeconds=0`，随后收到 `sourceClosed`。来源 canonical 为 `2b8be04ba8d8a00717340131069606b8cd5e609e11e00c20c421ca272c1259c4`，两次候选 canonical 同为 `6cf99f1d4d8bb0f172448c1c2e790b7cf5acd2cf47de9a6bede3e28a5ee8f96b`。

v4 的 renderer performance 时钟约 74,537 ms 创建 `save-serialization` Worker，89,891 ms 创建 `save-snapshot-rewrap` Worker；中间多次主线程任务达到 1–2 秒。它们是 renderer 时钟时间点，不能直接改写为点击后的耗时。未观察到 `offline-simulation` Worker，证据指向 Native 返回后的保存流程仍有明显成本；尚不能只归因于某一段序列化。

没有执行到这个 9 秒候选的独立 JS 完整对照、持久主档断言和两次重开，取消场景也尚未运行。[此前一秒恢复来源证明](./rust-rp1-recovered-endgame-source-2026-09-09.md)只覆盖它自己的范围。

下一步先拆分 `saveGameVerified` 的序列化、主档提交、旧档备份和自动快照成本。备份必须保留完整结构检查与原样读回；目录 checksum 正常本身不证明存档可加载，不能作为跳过结构检查的依据。优化后再回到完整菜单验证，保留原门槛与原失败。
