# Rust RP1 恢复入口测试的启动前提｜2026-09-09

Role: develop。本轮只修改测试：等待工厂运行时完成初始化后，再执行原有挂机停止/保存/重开断言。生产恢复逻辑、存档、Worker 协议和性能断言均不变。

## 已确认的现场

`c6b44c4a` 的 [CI run 34295204072](https://github.com/snowsnow0926/DSPONLINE/actions/runs/34295204072) 已完整结束，build、unit、Server/Ops/Native 成功，两组浏览器失败。浏览器合计 **401 expected / 33 skipped / 37 unexpected / 17 flaky**；这些原结果保留，不改记为本轮通过。第一组 199/11/26/11，第二组 202/22/11/6。

本次 CI 新增的失败附件留存已实际生效。第二组 28 份错误上下文中，15 份属于挂机停止检查（含首次和重试）：3 份停在“正在载入行星工厂”，12 份停在“正在验证工厂运行时”。实际截图和原错误栈一致，尚未进入要验证的挂机界面。此前本机恢复目录失败轨迹中，模拟 Worker 在 5 秒断言到期前约 0.6 秒才开始加载，也没有取得初始化响应。

这说明这些记录不能直接解读为“已经执行停止操作但保存失败”。它们仍是失败的回归检查，也不能由此解释其他菜单性能、几何或交互失败。

## 修复与结果

新增 [waitForFactoryRuntimeReady](../../tests/e2e/runtime-helpers.ts)，等待 `.game-shell` 的 `data-simulation-worker` 从 `initializing` 变成 `active` 或 `fallback`。使用现有工厂启动辅助函数已有的 **15 秒启动预算**，随后仍用原 5 秒界面断言、原停止/保存等待、原整体测试时限。允许 fallback 只表示启动流程已结束，不豁免后续原有完整状态及保存断言。

该前提应用于 [挂机停止恢复检查](../../tests/e2e/v127-pure-idle-stop-recovery.spec.ts) 和 [恢复主档目录检查](../../tests/e2e/v127-recovered-save-catalog.spec.ts)。不把加载中的占位 `.game-shell` 当成可操作工厂，不添加固定 sleep，也不修改产品初始化路径。

两文件在真实 Chrome 下 **13 通过 / 0 跳过 / 0 失败 / 0 flaky**，单 worker、无重试，约 94.591 秒。覆盖保存失败后一次/两次重试、重载后恢复、主档提交后的 journal 收尾、后台停止、明确放弃、取消、私人诊断导出、普通离线报告共存，以及 menu/bypass × 原始/推进后 journal 的四种保存重开。停止与持久状态检查仍实际执行，没有在前提步骤直接返回或跳过。

来源为 `a05d1d18` 加三份明确记录的测试变更，运行元数据如实标记 dirty=1；`recovery-startup-readiness-v1/process.json` 记录 Git 身份及逐文件摘要。`report.json`、`stdout.log`、`exit.json` 和外部 `recovery-startup-readiness-v1-guard/` 保留原始结果。全程 headless、静音、低优先级，仅 loopback API；守护正常退出 0、97.447 秒，最低可用 7,102,172 KiB，6 GiB 启动 / 2 GiB 停止线。项目实际 `tsc -b --pretty false` 通过，守护正常退出 0、40.762 秒、最低可用 7,292,120 KiB（轻量检查 3 GiB 启动 / 2 GiB 停止）。

本轮本机通过不覆盖原云端失败。后续 0ce 的专项云端结果见下节；没有因此重新运行或改写已冻结 2bb Windows 包的性能数字，没有声明 greatstar 的个人现场在本轮重新复验。

## 新源码的云端恢复检查

`0ce55ff4bdb080ff7ff7f6574680c9a0e15b49e0` 的 CI run `34298454294`，第二分片 job `102300056903` 于 2026-09-09 01:36 UTC 结束：**208 expected / 22 skipped / 6 unexpected / 5 flaky**，241 个场景，约 20.4 分钟。完整 JSON 逐例确认上述恢复两文件共 **13 项均首次通过，无重试**，本机的启动前提修复取得云端证据；该分片整体仍失败。

六个剩余失败涉及画布矩阵帧数、重叠卡片带端点 96 对 96.5、隐藏警报成员的选择、冷菜单耗时 1,020/1,082 ms 超过原 500 ms 门槛、手机设置整体 30 秒超时、刷新配置应为 200 实为 500。原始和重试均保留；部分重试另有启动未完成，不能将全部失败统一解释为初始化等待。未改变这些性能或数据门槛。

开发 worktree `artifacts/rust-rp1-loop/` 新增下载并逐件完整验证的 `cloud-pr31-0ce-shard2-json-v1.zip`（SHA-256 `6b1d436b29f84ffee0a7765eae9db5321c1011522658ec21f072ceb5adf14204`）与 `cloud-pr31-0ce-shard2-failure-v1.zip`（`51f6570d78fc3800476d27f80180a930db974ecccd6339d8be5342cbc963bd51`），原失败上下文、PNG、trace 保留；白名单统计为 `cloud-0ce-shard2-audit-v1.json`。第一分片和完整 Windows 检查在此记录时仍运行，不能把第二分片计数当作一次完整全量结果。

## 其他云端收尾与证据

### 0ce 完整终态补记

0ce 的两组浏览器均已结束：第一组 **193 expected / 11 skipped / 28 unexpected / 15 flaky**，第二组 **208 / 22 / 6 / 5**，完整合计 **401 直接通过 / 33 跳过 / 34 失败 / 20 重试通过**。恢复两文件 13 项仍全部首次通过；整个 CI 未通过。第一组失败也已保留，尚未逐项完成诊断。

独立 Windows PR run [34298454318](https://github.com/snowsnow0926/DSPONLINE/actions/runs/34298454318)，job `102300056889` 成功：正常 release 核心 **1,113 pass / 5 ignored**、Host **249+3 pass**，合计 Rust **1,365 pass / 5 ignored**；Native **674 pass / 1 skip**、游戏单元 **3,166 pass / 39 skip**，均零失败，fmt、严格 release Clippy、Host build、typecheck 通过。push run `34298449941` / job `102300044453` 也终态成功；这里的详细计数来自 PR 日志。实际测试 merge `eae3f08a66c2efb57991904a172c3840cb91cc12` 与 0ce 的 Git tree 均为 `fb0c127133e3bb001adfa2b0c1743deacf3e47f7`，已用本地 Git 对象核对。

同一主 CI 的 Server/Ops/Native job `102300057072` 成功：Server **390/2 skip**、站点 **4/4**，Ops **60/2 skip**；Linux core **1,113/5 ignored**、Host **245+3**、Native **670/5 skip**。Linux 此命令不作为 Windows 正常优化性能证据。

新制品下载后已对完整 ZIP 校验，位于开发 worktree `artifacts/rust-rp1-loop/`：

| 制品 | SHA-256 |
| --- | --- |
| `cloud-pr31-0ce-shard1-json-v1.zip` | `661f9cba58cbef3e522841eaf19e1c07acd12e6daa2018ac26fe8b75e142e077` |
| `cloud-pr31-0ce-shard1-failure-v1.zip` | `52fc11319ff416f0a0c887818e952c1dbe79c222375b7da0757bcfaa79b2203f` |
| `cloud-pr31-0ce-native-diagnostics-v1.zip` | `c9d6cfb91304053f8c267342751c2e3ea4f44ee3a5179ad6b3d8b16886001522` |

Windows receipt 记录新 Host **17,885,696 bytes**、SHA-256 `56e7be70969181210e06e663e7064813dd23cad72ea4660166108ed14234dd13`，rustc 1.96.1、release 无优化覆盖。此为云端自动检查制品身份，没有用它替换本机已冻结的玩家开发包，不继承旧包性能数字，也不取得签名、UI 或发布资格。白名单审计 `cloud-0ce-validation-audit-v1.json` 汇总 tree、结果和 receipt。

以下 c6 记录为上一轮历史结果。

同一 c6 CI job `102290211979` 已终态成功：Server 390 pass / 2 skip，另站点专项 4/4；Ops **60 pass / 2 skip / 0 fail**；Linux Rust core 1,111 pass / 5 ignored、Host 245+3 pass；Native Node **670 pass / 5 skip / 0 fail**。这为上一轮 proxy generation/mode 测试同步修复补齐了 Linux 证据，生产 proxy 无修改。

c6 的独立 Windows run `34295204069` / job `102290211848` 随后于 2026-09-09 01:11:42 UTC 终态成功：正常优化核心 1,111 pass / 5 ignored、Host 249+3 pass、Native 674 pass / 1 skip、完整游戏单元 3,166 pass / 39 skip，均 0 fail；fmt、严格 Clippy、Host 构建和类型检查通过。测试 merge SHA 为 `571cada389341d132c414fee8172258476d177f3`；它尚不包含 a05 的新参与专项前提或本次恢复辅助函数，不能代替这两项修复的云端验收，也不覆盖早先发生的线程参与失败。所有原 c6 作业终态后才推送下一份候选，不为观察等待而取消或重启旧验证。

云端制品保存在原工作区 `artifacts/rust-rp1-next/`；两份 JSON 均只含 `playwright-report.json`，先按 GitHub digest 校验 ZIP 再读取。第二组上下文与实际截图的只读摘录在开发 worktree 的 `artifacts/rust-rp1-loop/c6-shard2-context-audit-v1/`。

| 制品 | SHA-256 |
| --- | --- |
| `cloud-pr31-c6-shard1-json-v1.zip` | `9e78eade5ec245cda34fd78b1b5b33acd270821c951670683b433fbe026b7770` |
| `cloud-pr31-c6-shard2-json-v1.zip` | `9c2a3209f1881f5c19c0ebdabc38d667da372e9f4ac86b9d9c7bddf4d913401d` |
| `cloud-pr31-c6-shard1-failure-v1.zip` | `1e352291a654e35fa3cd4be940eb54c13cee51d6883f46946941cb508b913c41` |
| `cloud-pr31-c6-shard2-failure-v1.zip` | `f02b20418efe82dc11f6d856bf5acc5843e49dc02267e51ecc46aeb2e9317f76` |

后续继续取得其他新源码云端结果、逐类定位剩余浏览器失败，并验证终局档现有恢复路径的完整菜单流程。此前 raw timeWarp 直接拒绝的诊断前提已由[终局来源复核](./rust-rp1-recovered-endgame-source-2026-09-09.md)纠正。Rust 完整目标、长离线/实时资格和发布边界不变；[当前完整报告](../RUST_BATCH_REPORT_2026-09-09_CURRENT.md)与[并行参与验证记录](./rust-rp1-worker-participation-2026-09-09.md)分别保留范围。
