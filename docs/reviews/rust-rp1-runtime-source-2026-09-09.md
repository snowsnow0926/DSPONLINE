# Rust RP1 临时运行态来源候选

Role: develop。日期：2026-09-09。范围：Host 只读来源接口与回归验证；未连接生产或新 renderer 入口。

## 来源与复现

从开发分支 `codex/rust-rp1-after-1.2.7` / `04157e19` 开始。旧本地包 runtime `5274c6e1af14c5a5d6a5da0a69b60922b40e48df` 的实际 UI 自然保存探针在 `inspect-actual-game-checkpoint` 失败，原因 `game-did-not-create-native-checkpoint`。此前候选采用与第一次写档仍成功，不能把整个探针计为通过。

代码核对：`App.tsx` 的活跃 durable 路径在 `persistPrimaryCheckpoint` 中转入 `persistDurablePrimaryCheckpoint`，未写 Native 存档；旧路径也仅对满足条件的大负载自动保存启用 Native 镜像。普通手动保存或小档不能据此推断有匹配检查点。加载后的完整运行态还可能不同于紧凑持久化投影，不能用不一致的 Native 检查点或直接上传紧凑原文绕过全状态证明。

实际包探针首轮被 sandbox 以 EPERM 阻止；自动审批批准隔离本地进程运行后，第二轮取得上述证据。没有自动审批拒绝、生产访问或玩家文件改写。

## 实现与边界

- 新 `CorePrepareOfflineSourceExportRequest` / `corePrepareOfflineSourceExport`，新增 capability `native-core-offline-runtime-source-export-v1`。修改 Host `core_runtime.rs`、`protocol.rs`、`main.rs`；`desktop/native-host.integration.test.cjs` 增加真实协议测试。
- Host 入口复用受保护绝对文件读取器：普通 JSON、文件身份/锁、大小与读完身份复核；此来源通道拒绝 gzip。上限沿用 256 MiB，不提高既有预算。
- 绑定字节数、源 SHA-256、保存时间、normal/primary/main、内容目录 fingerprint、完整 canonical/domain proof、安全时钟范围及非暂停运行态。未知请求字段拒绝。主进程传输接入后应拥有实际路径、时钟和 export ID；目前没有新增 preload 暴露。
- 构造仅本次使用的 revision 0 CoreState，不插入注册表，不发布 normal-main/speedrun-main 检查点，不追加 WAL。共享候选 helper 对已有会话 `Cow::Borrowed` 后按需克隆，对临时来源 `Cow::Owned` 转移所有权。
- 同样使用现有 MacroV1 的 1–30 秒精确前缀、结算时钟、revision/catalog 及导出预检/写出一致性门禁。0 秒、31 秒及以上返回未准备候选，不把新路径当作长离线资格。
- 只写候选导出。大档上传、取消中断、超时后清理与浏览器持久采用必须由下一阶段实际传输闭环验证；本批的“丢弃候选保档”不能冒充新 UI 取消通过。

## 新鲜验证

| 命令/范围 | 结果 |
| --- | --- |
| 原 `offline_candidate` release 专项 | 4/4 |
| `cargo test --release -p dsp-native-host -- --test-threads=1` | library 249 + binary 3 = 252 通过，0 失败/ignored |
| 新真实进程专项 `node --test --test-name-pattern='temporary runtime source' desktop/native-host.integration.test.cjs` | 22/22，0 跳过/失败 |
| `npm run test:native` | 654 通过，1 条件跳过，0 失败/取消 |
| `cargo clippy --release --workspace --all-targets --locked -- -D warnings` | 通过 |
| `cargo build --release -p dsp-native-host --locked`、`cargo fmt --all` | 通过 |

真实 Host 专项使用生产目录生成的 infinite/finite-reserve/quantum-capacity 三类公开工厂，分别 1/5/30 秒，对照 JS 每秒 `advanceSimulationBudget(state, 1, 1)`，九组完整字段和生产 canonical/domain proof 均相同。实际来源由共享 transfer 编码器生成，返回经现有 DTO、传输 checksum 和完整运行态解析器验证。空 Native 档可计算；源文件和全部持久文件不变；空档及旧检查点正常关进程、换新客户端重启后仍一致。此专项正常退出要求真实进程 close code 0 / signal null。

新 Host 17,876,480 bytes，SHA-256 `a901961117d1e9aa0495403ac61663765fabfa0dac81bf71f54dfa17ef702489`。本批未改 Rust Core 算法源码、共享游戏源码或桌面产品源码；没有重新跑完整浏览器/共享单元矩阵，也未重建 Windows 玩家包。旧包 `5274c6e1` 的实际 UI 证据只归属于旧路径。

## 原始失败及修正

所有本批证据位于本机 `D:/GameDev/DSPidle2/artifacts/rust-rp1-next/`，不含玩家存档；最终目录内 `runtime-source-evidence-v1.json` 记录源码、二进制与日志摘要。

- `natural-checkpoint-v1/report.json`：EPERM 未启动；`natural-checkpoint-v2/report.json`：实际游戏保存没有新匹配原生检查点，失败保留。
- `host-source-tests-v1.log`：新增测试引用并不存在的 `Exact` 枚举，未编译通过；改为安全整数越界反例。
- `host-source-tests-v2.log`：5 个测试均在测试快照读取自有 Windows 空锁文件时失败；空锁改验存在/大小，所有存档文件仍完整读字节。
- `host-source-tests-v3.log`：3/5；`v4.log`：4/5。测试曾将 Native 导出原文字节校验误作 JS 重序列化兼容导入校验，并用不合法的 slot/kind/缺失 speedrun 状态构造反例。改用实际 transfer 原文字节/完整 proof 校验及正确拒绝阶段的反例；没有改产品校验器。Native 原始导出与 JS 兼容导入的数值文本规范差异仍存在，不声称本批修好原生导出直接重导入。
- `host-full-tests-v1.log`：修正上述新测试后完整 Host 252/0。
- `host-source-integration-v1.log`：20 子项通过、顶层 1 失败。新增驱动复用尚未退出的 NativeHostClient，`stop()` 后立即 `start()` 收到旧进程 SIGTERM；旧产品 API/退出实现未改。改为显式 shutdown，等待 close 0，再建新客户端。
- `host-source-integration-v2.log`：22/22；`host-source-full-native-v1.log`：654/1 条件跳过/0；`host-source-clippy-v1.log` 与 `host-source-build-v1.log`：通过。

## 下一步和发布资格

先实现 main 拥有的分块来源传输及清理，再接实际自然保存→继续→候选→取消/持久保存→正常重开。随后做授权终局档的完整等待配对，最后扩展有界长离线证明。必须把加载、来源证明、传输、计算、候选解析、提交及重开成本计入相应完整等待口径，不能用 RPC 时间替代。

本阶段没有新的性能配对结论；RP1 总目标保持进行中。30 秒自动采用限制、长离线/实时权威资格、跨端 Rust 接入及签名/多硬件门禁均没有放开，历史堆异常根因仍未查明。本批不含生产发布；回退本提交的 Host 协议与文档即可，新接口不改变持久存档格式。易读交付见[本批报告](../RUST_BATCH_REPORT_2026-09-09_RUNTIME_SOURCE.md)。
