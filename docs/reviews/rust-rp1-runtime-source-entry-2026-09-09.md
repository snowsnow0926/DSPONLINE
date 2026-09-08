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
| 完整 Chromium | 455 通过 / 33 跳过 / 0 失败，8.9 分钟 | `runtime-source-e2e-full-v1.{log,json}` |
| 实际 Windows beta 包 | 完成/取消/自然保存来源 3/3，12 次正常退出 0 | 下方最终制品 |

真实 Host 专项使用公开量子容量工厂完整状态对照 JS，覆盖上传后的正常完成、输出过程取消及临时目录清理。窗口拥有者、并发拒绝、ACK、超时、坏证明和清理成功屏障均有回归。首轮 IPC 原结果 18 通过/2 失败是旧测试切片包含了新增处理器；调整处理器定义位置，保留原测试断言，v2 通过。`runtime-source-ipc-tests-v1.log` 保留，未改写为成功。

## 提交前的制品与验收计划（历史记录）

旧 `5274c6e1` 包完整冻结到开发树 `artifacts/rust-rp1-loop/package-5274c6e1-frozen`，78 个文件读回一致，独立 receipt 保留；默认 Python 命中 Windows 占位别名返回 1，改用已配置运行时后归档成功。

接下来从干净提交构建新包：不种原生检查点，验证公开主档完成与取消；再用实际界面保存作为来源、继续游戏、完整结果比对、持久保存和正常重开。旧 v16 仅作驱动参考，新结果独立保存。当前不报告新的用户完整等待提速，也不开放长离线、实时权威或网页/安卓 Rust。历史 debug 堆异常原因仍未定位。

## 最终制品与实际入口验收

实现提交 `ee2ea715efc733200c6534e598abf18dee2e3293`；清单提交/实际运行提交 `dfe0e980d646bcb2e6f5c903108fef60dbf47f6e`。清单仅新增上一批 Host 的 `native-core-offline-runtime-source-export-v1`，没有改变 Rust 算法、门槛或渲染器行为。

- 首次 `runtime-source-package-ee2ea715-v1.log` 因生成清单过期失败；`native:coverage:generate` 更新后严格验证通过。
- v2 成功产出开发身份 stable 渠道的本地目录包（未启动或发布）；保留其清单，再显式 `DSP_RELEASE_CHANNEL=beta` 构建 v3。v2/v3 标准目录均遇到 Windows rename EPERM，项目现有 fallback 路径成功。不是自动审批拒绝。
- 最终 `release-performance-edition-fallback`，`1.2.7+dfe0e980d646`、beta、`windows-performance-development-v1`、NotSigned。构建、启动体积、thin UI、coverage 门禁通过，77 件清单逐项检查；冻结目录 `artifacts/rust-rp1-loop/package-dfe0e980-frozen` 完整 80 件文件复制后读回一致。
- 新驱动 `artifacts/rust-rp1-loop/probe-packaged-source-entry-v1.mjs`，结果分别 `packaged-source-{complete,cancel,natural}-v1/report.json`；三组均使用独立临时应用资料目录、`loopback-only-v1` 网络策略、公开 110 实体/2 带工厂、真实 5 秒墙钟，无原生检查点。
- 三组候选均比较完整 JS 状态；两组完成路径比较完整持久投影、暂停后实际保存、正常关闭、读回、实际重新进入后的标准 JS 加载结果及第二次重开。取消路径在 Host 实际准备后延迟返回 3 秒，以实际按钮取消，原普通主档字节与空原生档不变，两次重开一致。延迟是取消测试手段，不是性能样本。
- natural 来源实际点击继续模拟和立即保存；正常退出合法完成了另一笔保存，因此绑定重新打开后、点击 Continue 前实际读取的完整主档，再用公共标准加载器独立推导来源和 5 秒预期；没有修改该存档来适配结果。
- 三组各 4 次正常应用关闭，合计 12 次 exit 0，无强杀成功样本。来源成功路径收到物理清理后的 `sourceClosed`，未调用持久 `coreOpen`。
- 单次 Continue→可操作观察约 2,141/2,058 ms，来源 RPC 约 177/191/195 ms。仅小样本且与完整 E2E 同跑，不是配对性能证据，不与旧包数字作提速比较。

总证据清单 `D:/GameDev/DSPidle2/artifacts/rust-rp1-next/runtime-source-entry-evidence-v1.json`，SHA-256 `088e156f97d085f877b67394944b0e8587a5d69fa3b204a4f6f3b4bfdb863e24`，绑定 20 件证据与 14 件实际代码/清单文件；冻结包独立 receipt 为 `runtime-source-package-frozen-v1.json`。本批完整 Vitest 与 Native 工具在相同业务代码上执行；后续清单变动仅新增能力字符串，E2E 与实包全部通过。

**测试交互偏好（用户新要求）**：后续测试必须后台运行，不显示游戏窗口、不前台激活、不抢焦点。以上可见驱动已结束且全部正常关闭，禁止再次直接运行；下一次桌面验收需先实现后台隔离方式。完整浏览器回归为无窗口运行，本批结束后不再打开测试 UI。未修改用户自己的游戏客户端。

本批完成普通保存来源入口验收，不代表终局完整等待收益、超过 30 秒离线、实时权威或跨端 Rust 验收完成。本地开发未发布，线上资料未触碰。[用户完整报告](../RUST_BATCH_REPORT_2026-09-09_ENTRY.md)。

收尾校验：34 件证据/源码与冻结 80 件文件再次独立读回一致，新报告和技术记录 3 个本地链接有效，git diff 空白检查通过。Skill 验证首次 bundled Python 缺少 PyYAML；改用已安装 Python 3.11 的原验证器后通过，见 `runtime-source-skill-validation-v2.log`。没有修改 Skill 或绕过验证器。
