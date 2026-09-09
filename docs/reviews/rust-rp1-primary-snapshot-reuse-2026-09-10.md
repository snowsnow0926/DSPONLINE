# RP1：菜单主档与自动快照复用

状态：开发候选，未发布；完整 Windows Rust Goal 持续进行。角色 develop。本批不改变 Rust 实时资格，`authority_eligible=false` 保持。

## 触发证据与范围

冻结 `c09cfdf217ca0becec0c01ab8805397283e37438` 包的完整终局入口 v17 仍 **FAILED**：实际 Native 精确结算 10 秒、近似 0 秒，请求 49,188.389 ms。`wait-for-active-factory` 未在原 90 秒 action 等待期限内完成。此期限没有放宽。

只观察到 save Worker 与 persistence Worker 返回；尚未独立读回完整持久状态，也未完成 JS 全状态对照、暂停保存及两次重开。因此不计为终局入口成功，更不能推断旧 v15 的 targetClosed 根因已解决或存档损坏。

v17 页面相对时间：序列化 Worker 72,715→80,430 ms，约 7.715 秒；持久 Worker 80,430→88,690 ms，约 8.260 秒；普通模拟 Worker 在 91,045 ms 收到 205,697,162 bytes 的初始化状态，超时前没有首个结果。诊断源：`artifacts/rust-rp1-loop/private-packaged-complete-v17/report.json`。原始授权存档为 107,637,967 bytes，SHA-256 `d64b5646f6117f3c089fba4dc95a95e84bedd9375f75b3c8c917b2e7cf473bc1`，完整文件未改。

两次 Electron 关闭均正常 exit 0，无强制清理、显示、聚焦或原生弹窗；隐藏/离屏/静音审计通过。外部守护 FAILED/exit 1，无中途停止原因，126.574 秒，最低空闲 2,154,012 KiB。后续完整流程仍需同源包复验。

## 实现

菜单 proof 保存原来会额外序列化一份完整运行态 transfer，只供可能到期的自动快照使用。现在调用者保有完整状态时，save Worker 只返回压缩主档和小型证明；成功持久提交、备份及精确读回后，到期快照接收 persistence Worker 归还的那份压缩正文。

快照 Worker 复核来源的绑定摘要、压缩/正文 SHA-256、FNV、字节数及主档封装，只改变外层时间、类型和原因，完整 state JSON 与 state checksum 保留，不重新解析、投影或序列化 GameState。新快照的摘要和目录绑定重新生成，persistence Worker 继续独立验证正文和目录，执行原有 fencing、CAS 和精确读回。

快照的到期条件、主档身份检查、低优先级队列与提交前让位规则保持。新主档请求或主档身份变化仍阻止旧快照提交。已拥有 checkpoint transfer 的保存、纯挂机 envelope 的接管、旧模式迁移和无 Worker/IndexedDB 的兼容路径保持原行为。没有改 GameState v47、信封 v2 或云协议。

省去的是菜单保存为快照生成的额外运行态缓冲区；普通模拟首次启动自己的完整状态传输仍存在。尚不宣称终局整段等待、帧率或全进程峰值内存已改善。

## 验证

- `snapshot-reuse-focused-v3.json`：类型检查及 **62/62** 保存、传输、快照、证明与投影专项通过。覆盖 raw/gzip、普通/竞速完整快照字节一致；正文、长度、目录、绑定、摘要和模式篡改拒绝；Worker 故障/取消保留调用者状态。守护正常 exit 0，48.359 秒，最低空闲 5,510,628 KiB。
- `snapshot-reuse-browser-v1.json`：真实无头 Chromium **28 expected / 0 skipped / 0 unexpected / 0 flaky**，未重试。普通/竞速各自到期快照与主档完整状态一致；两次主档保存与一次快照均不返回运行态缓冲区，快照恰好一次且源为已持久提交的非空压缩正文。旧模式迁移原始备份、失败重试、原 transfer 保存、持久 proof 与跨标签页协调通过。守护正常 exit 0，51.058 秒，最低空闲 5,400,480 KiB。
- `snapshot-reuse-full-v1.json`：完整本机游戏 **3,193 pass / 39 skip / 0 fail**，其中实际正常 Host 差分 **50 pass / 1 长测 skip**；Web 构建、startup budget、thin-UI boundary 和 coverage 门禁通过。守护正常 exit 0，424.717 秒，最低空闲 4,520,268 KiB。正常 Host 摘要保持 c09 冻结基线。新的冻结桌面包及终局全流程待验。

首次类型检查发现新代码排版导致的 TypeScript 语法错误，已修复。focused v1 为 61 pass/1 fail：新测试将 Node 运行库初始化解析 `"{}"` 误记为解析大存档；检查改为禁止大型正文解析，完整字节对照保留。v2 未产生守护或测试结果且 wrapper 已退出，原因未记录，不计测试通过；v3 新路径有完整成功证据。所有重任务串行、BelowNormal、6 GiB 启动/2 GiB 停止守护；不关闭用户应用腾内存。

[上一轮菜单保存](./rust-rp1-startup-worker-save-2026-09-09.md) · [完整执行目标](../rust/windows-full-development.md) · [最新包基线](./rust-windows-catalog-package-2026-09-09.md)
