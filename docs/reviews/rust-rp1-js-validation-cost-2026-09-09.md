# Rust RP1 验证中的空星球重复工作｜2026-09-09

Role: develop。承接读取缓冲及大工厂完整 UI 收益；本次修改共享 JS 精确模拟中的无用工作，保持时间断言、生产/存档规则及 Rust 准入不变。完整验证仍在进行，未发布。

## 已确认的失败与采样

第三轮云端 run `34280286855` / job `102243130872` 已结束，整组失败。正常 release Rust 1,363 通过 / 5 ignored / 0 失败，Native 全量、Host 构建、类型检查及带范围标注的候选上传成功；完整 Vitest 3,157 通过 / 2 失败 / 39 跳过。失败仍是有限矿脉宏结算 2,322.601 ms 超过原 2,000 ms 断言，以及递归量子建设对照超过默认 5 秒。完整日志保存在原工作区 `artifacts/rust-rp1-next/cloud-ci-6bf9f983-job.log`。此前失败保留，不能把大工厂 UI 通过称为全量检查全绿。

前两轮 Node CPU flags 没有取得执行游戏测试的工作进程采样：第一次无 profile，第二次仅调度进程；独立用例 2/31 跳过和两个完整文件 33/33 的本机通过不覆盖云端原失败。

第三轮改为测试 setup 中连接当前工作进程的 Node Inspector，在原测试开始前启用 CPU 采样、结束后主动保存；测试源文件、断言和超时均不变。实际取得 `game-timing-profile-v3/idleResourceSettlement.test.ts.cpuprofile` 和 `p2Batching.test.ts.cpuprofile` 及各自进程身份。前者约 3.866 秒采样中，有限矿脉案例约 2.602 秒，宏分支约 1.258 秒主要调用完整 Exact，热点包括电力计算、行星阶段和机器遍历；后者约 6.946 秒，建设规划、库存复制和结算占主要采样。采样时间仅用来定位函数，不算性能门槛验证。

## 两处有证据的空转修复

1. `runMachines` 把“已有完整索引，但该星球没有机器”误作“没有索引”，回退到 `state.entities.flatMap`，每个空星球每秒重新扫描所有星球。现在完整索引的缺席键代表空列表；空列表直接返回，无需创建科技集合和计算配方速度。没有索引时仍保留完整构建路径。
2. `runConstructionCenters` 在没有制造中心时仍枚举全部建设目标、检查科技与库存，并创建预算/缓存。现在确认该星球的中心列表为空后直接返回；有中心但关闭制造、缺料、缺电等情形仍经过原流程。

两处都只跳过没有可执行对象的工作，不对有机器/中心的生产、库存、进度或预算规则做修改，也不跳过任何模拟秒。

新增 `emptyPlanetSimulationWork.test.ts` 的两项回归在改动前实际失败：一个捕获到全实体 flatMap 一次，另一个捕获到无中心情况下读取三种建设目标。改动后这两项及原 `idleResourceSettlement.test.ts`、`p2Batching.test.ts` 共 **35 通过 / 0 失败 / 0 跳过**，并核对空机器场景实体/产量及无中心场景的完整施工状态未改变。证据 `empty-planet-before-v1.json`、`empty-planet-after-v1.json` 和 `empty-planet-after-v1-guard/`。

实际项目类型检查 `tsc -b --pretty false` 通过，约 43.41 秒，日志 `empty-planet-typecheck-v2/`。前一次误用根项目 `tsc --noEmit`，该配置只有 references、files 为空，不能计为覆盖代码的类型检查，故补跑实际命令。

轻量 Windows 诊断工作流增加引擎及这三个测试文件的触发条件，同一次运行保留原计时文件、增加空星球回归并记录四个源码摘要。原 2 秒性能断言、默认 5 秒期限、单 worker 均保持不变。

## 后续完整本机和轻量云端结果

源码提交 `2501f0d4c679f8df95ed356b25b1543bd9e796be` 的完整本机单元已结束：**3,160 通过 / 39 跳过 / 1 失败**。仅 `p2Batching.test.ts` 的 `keeps direct-quantum working capital exact across a recursive cycle` 失败，整个案例约 5,110.045 ms，超过原默认 5 秒。有限矿脉案例约 3,148.010 ms，案例内部只计宏计算的原 2 秒断言通过；整个案例含精确参考计算，不能把两种耗时混用。证据为开发工作树 `artifacts/rust-rp1-loop/empty-planet-full-unit-v1.json` 及 `empty-planet-full-unit-v1-guard/`。外部监控以 6 GiB 启动余量、2 GiB 停止线和单 worker 低优先级运行，399.070 秒退出码 1，最低可用内存 3,935,172 KiB，没有触发内存或期限终止，失败不得算作正常通过。

[轻量 Windows 云端 run 34285116573](https://github.com/snowsnow0926/DSPONLINE/actions/runs/34285116573) / job `102258780428` 同源码结果 **34 通过 / 0 跳过 / 1 失败**。仍仅递归量子建设案例失败，约 5,232.447 ms；有限矿脉原计时断言及两项新增空星球回归通过。制品 `10079168351` 的 ZIP 已下载并验证 SHA-256 `ae240bcd00788be76b8d5076dbfae3c8459aa5181a4cbce5728760fd0d366f4b`，本地原工作区 `artifacts/rust-rp1-next/cloud-game-timing-2501f0d4.zip`；只读取 `source.json`、`results.json`、`run.log`。两份原计时测试文件摘要均未改变，未提高超时或性能断言。

同源码完整 Windows 云端 run `34285116554` / job `102258780214` 仍在运行；最近观测已通过格式和严格 release Clippy，正在完整优化 Rust 测试。本次没有为等待结果重新触发或取消它。接下来分解递归建设用例的旧逐项和批处理时间，定位规划/库存复制成本；生产构建和适用浏览器检查仍待完成。尚未测得该 JS 改动的独立新旧性能比率，不能把旧缓冲包 72.13% UI 收益重复算为这项改动的收益。

旧冻结 `67a2ffbe` 包的 UI 证据仍只属于该包。本次 JS 源码改变后不能直接继承为新包验收。原始终局 timeWarp 准入、历史堆异常及长离线/实时/跨端 Rust 边界保持此前状态。
