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

本轮本机通过不覆盖原云端失败，新测试的完整云端结果仍待取得。没有因此重新运行或改写已冻结 2bb Windows 包的性能数字，没有声明 greatstar 的个人现场在本轮重新复验。

## 其他云端收尾与证据

同一 c6 CI job `102290211979` 已终态成功：Server 390 pass / 2 skip，另站点专项 4/4；Ops **60 pass / 2 skip / 0 fail**；Linux Rust core 1,111 pass / 5 ignored、Host 245+3 pass；Native Node **670 pass / 5 skip / 0 fail**。这为上一轮 proxy generation/mode 测试同步修复补齐了 Linux 证据，生产 proxy 无修改。

c6 的独立 Windows run `34295204069` / job `102290211848` 随后于 2026-09-09 01:11:42 UTC 终态成功：正常优化核心 1,111 pass / 5 ignored、Host 249+3 pass、Native 674 pass / 1 skip、完整游戏单元 3,166 pass / 39 skip，均 0 fail；fmt、严格 Clippy、Host 构建和类型检查通过。测试 merge SHA 为 `571cada389341d132c414fee8172258476d177f3`；它尚不包含 a05 的新参与专项前提或本次恢复辅助函数，不能代替这两项修复的云端验收，也不覆盖早先发生的线程参与失败。所有原 c6 作业终态后才推送下一份候选，不为观察等待而取消或重启旧验证。

云端制品保存在原工作区 `artifacts/rust-rp1-next/`；两份 JSON 均只含 `playwright-report.json`，先按 GitHub digest 校验 ZIP 再读取。第二组上下文与实际截图的只读摘录在开发 worktree 的 `artifacts/rust-rp1-loop/c6-shard2-context-audit-v1/`。

| 制品 | SHA-256 |
| --- | --- |
| `cloud-pr31-c6-shard1-json-v1.zip` | `9e78eade5ec245cda34fd78b1b5b33acd270821c951670683b433fbe026b7770` |
| `cloud-pr31-c6-shard2-json-v1.zip` | `9c2a3209f1881f5c19c0ebdabc38d667da372e9f4ac86b9d9c7bddf4d913401d` |
| `cloud-pr31-c6-shard1-failure-v1.zip` | `1e352291a654e35fa3cd4be940eb54c13cee51d6883f46946941cb508b913c41` |
| `cloud-pr31-c6-shard2-failure-v1.zip` | `f02b20418efe82dc11f6d856bf5acc5843e49dc02267e51ecc46aeb2e9317f76` |

后续继续取得新测试云端结果、逐类定位剩余浏览器失败，再处理原始终局 timeWarp 兼容。Rust 完整目标、长离线/实时资格和发布边界不变；[当前完整报告](../RUST_BATCH_REPORT_2026-09-09_CURRENT.md)与[并行参与验证记录](./rust-rp1-worker-participation-2026-09-09.md)分别保留范围。
