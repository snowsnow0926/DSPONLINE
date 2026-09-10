# Windows 持续验证会话：本批记录

2026-09-10，Role: develop。完整 Windows Rust Goal active，开发未发布；原工作区、玩家原档和生产保持独立。测试仅无头/已验证零窗口入口，BelowNormal，重任务串行 6 GiB 启动/2 GiB 停止，轻量 3/2。

## 实现范围

新增实际 Host/独立平台助手持有会话入口、有界递增 sequence/challenge 协议、固定空闲期限，以及 main 持有真实进程的不可复制 token、自动心跳、失效通知、确认释放和终止失败保护。复用上一批实际目录/fixture 锁及身份；不授予 gameplay authority、不改变 GameState/WAL、不接入 renderer 或云网络。详见[持续会话合同](../rust/windows-validation-lease-v1.md)。

## 验证进展

初版 V1 全套本地通过后，复查发现接入失败会在确认助手退出前提前返回。独立负例 red-v2 在未修复产品上明确失败：预期尚未完成，实际已返回 start-timeout；修复后同一负例通过，并纳入常规回归。另补齐正常回复后同回调异常数据的失效检查，以及释放 ACK 后未退出的负例。

red-v1 最初失败来自诊断 VM 漏传 queueMicrotask；该次不计为产品缺陷证据。修正诊断脚本后才得到上述 red-v2 产品负例，原输出保留。

| 当前证据 | 结果与范围 |
| --- | --- |
| V1 正常优化 Rust | 严格 release workspace/all-targets Clippy 通过；Host 286 pass/4 ignored，两个入口各 3；V1 Native 961 pass/1 skip |
| V2 最终客户端 | 相关 Node 189/189；完整 Native 966 pass/1 Windows 权限 skip/0 fail；前端目录/证明 7/7、类型、格式与夹具/目录漂移检查通过 |
| 精确复用 | V2 只改客户端与两份测试；逐文件验证其余源哈希不变，正常构建后 Host/助手字节与 V1 相同，保留同批 Rust 证据，没有声称重跑 Rust 核心全套 |
| 实际 Windows 进程 | 两个独立持有者身份相同，任一尚未退出仍阻止 profile 改名/固定夹具改写；正常双释放后可替换并重获新身份 |
| 实际时序 | stdin 保持打开，原 15 秒空闲期限实际退出；main 自动心跳实际跨越 17 秒并继续持锁；均未缩短/放宽原时限 |
| 故障 | 父管道 EOF、实际助手被终止、重放/畸形输入退出后解锁；本批没有实际杀死父进程的独立测试，不将管道 EOF 等同完整父进程崩溃验收 |

V1 守护正常 exit 0，430.90 秒、最低空闲 4,641,940 KiB；V2 正常 exit 0，135.86 秒、最低空闲 7,216,644 KiB，均未触发 2 GiB 停止。V2 Native 用时 84.03 秒，实际空闲期限 15,051 ms、自动续期测试 17,090 ms。以上是开发检查耗时，不是游戏性能。

Host SHA-256：`2758a630c6a9309563be49f8b26b51884515580fcad657d564724db320083927`；助手：`915998e64503574f6465e231567a19d56850a5c74393b0647c6c725b8375eec1`。本地证据：`artifacts/rust-rp1-loop/validation-lease-validate-v1/`、`validation-lease-validate-v2/`、各自 guard 和 `validation-lease-red-v2.json`。九份运行源码在最终检查前后哈希相同。

## 制品与剩余门禁

本源码的冻结包及实际 ASAR 入口验证待提交后构建；此前 491 冻结包保留，不能当作本源码实包通过。未发布、未签发资格、未新增性能结论。

上一提交 **4cac3db7** 云端浏览器已全部结束：468 pass/33 skip/2 fail/0 flaky。冷菜单两次 P95 为 956/945 ms，原门槛 500 ms；字号矩阵整例两次超过原 30 秒，定位在 v32-buffer-settings.spec.ts:221 的点击。此前失败的 v120 暂停画布、v103 启动辅助和 v101 点击本次通过，仅是本次观测，并未修改这些 UI/测试或宣称根因修复。构建、游戏单元 3217/42 skip、服务 390/2、station 4/0、Ops 60/2、Linux Native 926/21 通过；Windows 专项仍运行，当前新源码云端尚未开始。

后续仍须把持续失效通知接到真实 tick/命令/持久边界，落实 profile 与云网络隔离、可信正文、时间/撤销、证据生产者与完整矩阵；复杂终局长离线、完整玩法/模式/内容包、性能/内存和长测/硬件/安装回退维持完整 Goal。不能把该测试会话 token 当作单写者权限。
