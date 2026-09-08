# Rust RP1 普通运行态实际入口｜2026-09-09

Role: develop。本批为本地开发，不含生产部署。承接 `f7f10391` 的只读来源 Host 协议；Rust 算法及 Host 二进制没有在本批改变。

## 实现与存档边界

- `StartMenu` 将取消信号交给来源路径；1–30 秒普通 v47 未暂停存档优先使用新能力，旧 Host 保留检查点兼容，失败保留原始已加载状态。
- `nativeOfflineSource.ts` 按原 JSON 语义逐条编码顶层数组，256 KiB 一块，v2 UTF-16 FNV 完整信封一致；不构造整份来源 JSON/ArrayBuffer。完整 canonical/domain proof 仍同步计算，候选接收仍需完整缓冲区。
- preload 只接受目录、来源保存时间；逐块等待 ACK，最后发送完整状态证明。renderer 无权指定主进程时钟、磁盘路径、export ID 或临时修订。
- main 收到头即取真实时钟，验证所有权、顺序、长度、大小和磁盘余量；来源文件独占创建、增量 SHA、fsync 后交给 Host。
- 每次请求单独启动临时 Host，自己的临时 SaveStore 从空开始。计算不打开或写玩家持久原生档；正常退出并确认进程终止后才传回候选。完整候选确认后清理自身目录，`sourceClosed` 是成功屏障。
- 同时只允许一个来源事务。取消、窗口销毁、端口断开和应用退出均终止自己的临时进程并排空；若未确认进程终止，不在活进程下删除目录。异常退出可能留下唯一临时目录，本批没有添加宽泛历史目录清理。

## 已执行检查

证据根目录：`D:/GameDev/DSPidle2/artifacts/rust-rp1-next`。

| 检查 | 当前结果 | 证据 |
| --- | --- | --- |
| 类型检查 | 通过（含新测试） | `runtime-source-typecheck-v2.log` |
| 来源编码、加载及旧 transfer | 3 文件 / 23 通过 | `runtime-source-renderer-tests-v1.log` |
| 真实 main/preload、临时来源和旧候选传输 | 26 通过 / 0 失败 | `runtime-source-ipc-tests-v2.log` |
| 完整 Native/桌面工具 | 668 通过 / 1 条件跳过 / 0 失败 | `runtime-source-native-full-v1.log` |
| 完整 Vitest | 396 文件通过 / 14 文件跳过；3,159 通过 / 39 跳过 / 0 失败 | `runtime-source-unit-full-v1.log` |
| 完整浏览器、新实包 | 待执行 | 不继承旧包结论 |

真实 Host 专项使用公开量子容量工厂完整状态对照 JS，覆盖上传后的正常完成、输出过程取消及临时目录清理。窗口拥有者、并发拒绝、ACK、超时、坏证明和清理成功屏障均有回归。首轮 IPC 原结果 18 通过/2 失败是旧测试切片包含了新增处理器；调整处理器定义位置，保留原测试断言，v2 通过。`runtime-source-ipc-tests-v1.log` 保留，未改写为成功。

## 制品与后续验收

旧 `5274c6e1` 包完整冻结到开发树 `artifacts/rust-rp1-loop/package-5274c6e1-frozen`，78 个文件读回一致，独立 receipt 保留；默认 Python 命中 Windows 占位别名返回 1，改用已配置运行时后归档成功。

接下来从干净提交构建新包：不种原生检查点，验证公开主档完成与取消；再用实际界面保存作为来源、继续游戏、完整结果比对、持久保存和正常重开。旧 v16 仅作驱动参考，新结果独立保存。当前不报告新的用户完整等待提速，也不开放长离线、实时权威或网页/安卓 Rust。历史 debug 堆异常原因仍未定位。
