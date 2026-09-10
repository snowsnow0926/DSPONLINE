# Rust RP1 当前批次验收与回归缺口｜2026-09-09

Role: develop。本记录承接读取缓冲、自然主档入口和施工参考路径优化；不包含生产部署。当前运行源码为 `2bb10b435bd6a20d9cbea48f4349d3c7d5030f00`，分支 `codex/rust-rp1-after-1.2.7`。后续同步测试、云端诊断留存及文档提交不改变下面已冻结制品的源码身份。

## 1. 本批性能候选和实际用户入口

`artifacts/rust-rp1-loop/desktop-build-2bb10b43-v1-guard/` 正常退出 0，62.395 秒，最低可用内存 7,891,284 KiB。真实执行类型构建、Vite、启动预算、薄 UI、覆盖清单、桌面平台校验及 `desktop/pack.cjs pack`，构建前后干净源码均为 2bb。`package-2bb10b43-receipt.json` 和 `package-2bb10b43-frozen/` 包含 75 件运行清单文件、78 件冻结文件；Windows beta/offline，版本仍标 1.2.7 开发包，Authenticode 为 **NotSigned**。

本机 Host 是已冻结的 `6bf9f983` 正常 release 构建，17,878,016 字节，SHA-256 `1f19d28a92702096492293b8cde667252dc44859790b4a3055230122851ef80a`；构建器验证其 Native 源码与 2bb 相同。它并非本次云端 Host：push 云端 Host 为 17,885,696 字节、SHA-256 `3dc77379740dae4e67dca48f41384a3398ace9bd42d69798abbb42b2369a4d6b`。两者身份分别保留，不混用包内验收。

新包与旧 `33d96597` 使用同一冻结驱动 `probe-packaged-background-entry-v5.mjs`，SHA-256 `03ce915de8399be5c133a5ff043b198e29639e7f4da03e8cac3834c743b73401`。公开工厂 9,107 实体 / 20,000 带，实际均结算 5 秒；三对顺序为新旧、旧新、新旧。完整来源 SHA-256 `63e5393922ec2f511391489d6a510762ee296b74c96b3338fe5e10ebbed907bd`，完整候选 SHA-256 `f97a419552fdca84977395353b5a90db3090a06b7e421ff2a468d407fe8d2127`，六例一致。

`large-background-v2-summary.json` 汇总通过：继续到可操作中位 **20,789.2781→5,958.5585 ms，缩短 71.3383%**；Native 请求中位 **16,755.9391→2,014.8197 ms**。启动到可操作包含人为等待凑足 5 秒，不称为纯冷启动。保留三对单次数据及原 67a2ffbe 历史序列，不叠加百分比。

六个配对场景及另两项取消/游戏实际保存来源均检查完整候选、持久状态、JS 正常加载、两次重开。取消例为保档检查，候选准备后仅在该例延迟 3 秒，不进入计时配对。八例共 32 次正常关闭 0；全部隐藏、不聚焦、静音、真实离屏绘制，原 500 ms 动画门槛通过，无强制清理。最低可用内存 6,677,312 KiB，统一 6 GiB 启动 / 2 GiB 停止线。序列结束后旧新两包各 78 件冻结文件再校验一致。

同源码 Web 制品另冻结于 `web-2bb10b43-frozen/`，197 文件；`web-build-2bb10b43-receipt.json` 与 `web-2bb10b43-frozen-receipt.json` 记录实际构建和摘要。启动 gzip 181,963 字节，禁止启动模块 0；该制品不是 Rust 跨端接入证据。

## 2. 完整结果必须按每次运行分别报告

| 来源 | 结果 |
| --- | --- |
| 本机 `construction-reference-full-unit-v1.json` | 3,166 pass / 39 skip / 0 fail；390.029 秒；原 2 秒/5 秒计时断言未改 |
| Windows push [34289161105](https://github.com/snowsnow0926/DSPONLINE/actions/runs/34289161105) | fmt、严格 release Clippy、Host 构建、类型通过；Rust 1,363 pass / 5 ignored；Native 674 pass / 1 skip；Vitest 3,166 pass / 39 skip，均 0 fail |
| Windows 轻量 push [34289161215](https://github.com/snowsnow0926/DSPONLINE/actions/runs/34289161215) | 原五文件 40/40；建设案例约 1,718.896 ms |
| PR Linux [34292207571](https://github.com/snowsnow0926/DSPONLINE/actions/runs/34292207571) | Production build、许可证、类型、单元通过；Vitest 3,164 pass / 41 skip；Ops 与两组 E2E 失败 |
| PR Windows [34292207525](https://github.com/snowsnow0926/DSPONLINE/actions/runs/34292207525) | fmt、Clippy 通过；核心 1,110 pass / 5 ignored / 1 fail，后续 Host/Native/Vitest 未执行 |
| 本机 Chromium `chromium-2bb10b43-v1.json` | 428 pass / 33 skip / 27 fail / 0 flaky；488 项，单 worker、无重试，42.1 分钟 |
| PR E2E shard 1 | 204 expected / 11 skip / 19 unexpected / 13 flaky |
| PR E2E shard 2 | 199 expected / 22 skip / 14 unexpected / 6 flaky |

PR head 2bb、base `9f4ac5c35e50fe1a1fcb2f4615354362ed28fa9b`、测试 merge `e105ac3d0cf3c296588c6f50fb923f67674de20d`；GitHub API 验证 head 与 merge 的 Git tree 同为 `85eddd8c0d71247d8a5c8fe51e829e4ff3401228`。因此不能把 PR Windows 新失败解释为另一份源文件，也不能用 push 成功覆盖它。

PR Windows job `102280983675` 原断言为 `production_interstellar_congestion_updater_really_uses_2_4_8_workers_and_stays_authoritative`，`interstellar_logistics.rs:9352`：requested=2、observed=1。运行正常报告断言失败，没有本次堆异常；并行调度的前提仍需定位，未修改或放宽该断言。该案例使用实际映射闭包中的线程掩码，配置两条线程不等于证明两条线程实际参与。

本机 Chromium 外部守护正常结束、退出 1、最低可用 4,694,108 KiB，没有因资源线终止。多数失败发生在加载/运行时验证阶段；还包括时间加速准备未完成、菜单 606 ms 超过原 500 ms 等，不能一概认定是启动慢。`chromium-2bb10b43-failure-audit-v2.json` 保留三条 Vite WebSocket 错误；原 JSON、trace、error-context 保留，不发布临时 token 或完整页面数据。

已取 main [34213700460](https://github.com/snowsnow0926/DSPONLINE/actions/runs/34213700460) 的两份报告：442 expected / 33 skip / 7 unexpected / 2 flaky，总 484 项。对本 PR 的 33 项 unexpected，6 项同名历史失败、1 项历史 flaky、25 项历史 expected、1 项新增。不同运行/机器非因果 A/B，不能把 25 项直接认定为源码回归，也不能全部归为既有失败。逐项比较为 `pr31-browser-baseline-comparison-v1.json`。

原 CI 仅上传计时 JSON，错误附件只有 runner 路径，无法取得实际截图/轨迹。当前补充两个 shard 失败时上传 `error-context.md`、`test-failed-*.png`、`trace.zip`，保留 7 天；不改 browser workers、重试、断言或超时。新留存机制的云端执行尚待验证。

## 3. 已修复的 Ops 测试同步问题

PR job `102280984037` 的 Ops 原结果为 59 pass / 2 skip / 1 fail，第一项 handoff 测试在 2 秒内未见两条排队请求。main 和 2bb 的 proxy 实现及原测试相同；`applyState()` 在已有周期状态读取进行时可以直接返回，不能用其返回承诺下一代 mode 已可见。随后过早发送 hold 阶段读请求可能仍被 drain 路由，导致期望的队列数未出现。

仅修改 `deploy/api-handoff-proxy.test.mjs`：每次写状态并调用 applyState 后，沿用原 `waitUntil` 等待准确 generation 与 mode（2/drain、3/hold、4/forward），再发送或核对该阶段请求。原 2 秒等待、5 秒 hold、15 秒 request 预算以及路由、响应正文、零失败/拒绝断言均不变；生产 proxy 无变更。

本机 `proxy-state-sync-focused-v1-guard/`：4/4、正常退出 0、2.669 秒；`proxy-state-sync-full-ops-v1-guard/`：完整 package.json Ops 文件清单，文件并发 1，56 pass / 6 Windows 条件 skip / 0 fail，正常退出 0、17.972 秒。`nginx-config.test.mjs` 导入 handoff proxy 与 release-switch 测试，因此完整 Ops 覆盖该修改。两次均后台低优先级、3 GiB 启动 / 2 GiB 停止线。修复后的 Linux 云端结果尚未取得，不能称整个 PR 已绿。

## 4. 数据、异常和目标审计

授权终局来源仍为只读原件，107,637,967 字节、SHA-256 `d64b5646f6117f3c089fba4dc95a95e84bedd9375f75b3c8c917b2e7cf473bc1`。原始 timeWarp.enabled=true；新 Host 接收约 200.8 MB 运行态后 32.113 秒明确拒绝 `offline-macro-time-warp-active`，prepared=false、正常退出、原始摘要/大小/修改时间不变。不能把旧 300 秒超时与本次拒绝相减作为性能收益；兼容开发仍欠缺，见[读取缓冲记录](./rust-rp1-v47-read-buffer-2026-09-09.md)。

历史堆异常已绑定原构建、匹配 EXE/PDB、转储 SHA，实际 StackWalk64 展开到长期研究候选准备/JSON 值析构；检测点不等于破坏来源。同一冻结原案例三次独立复验约 68.8/68.1/67.0 秒通过，历史 main 及候选完整验证各有通过，仍不构成根因已修复。四份现存旧转储独立冻结并核对，三份其他异常的符号身份不同，不能合并归因；一份登记文件已缺失。原 Host 目录联接两案例复验通过，临时 ACL/目录夹具问题没有通过降低权限保护解决。具体证据沿用[持续开发记录](../RUST_RP1_DEVELOPMENT_LOG_2026-09-08.md)。

当前目标审计：代表性公开大工厂完整用户入口、稳定配对方向和超过 20% 的完整等待收益已满足本批指标；取消、完整状态、持久提交和正常重开有实际包证据。原始终局兼容、最新完整回归失败及历史异常的根因仍未收口，**完整目标保持 active，RP1 不标总验收完成**。原 256 MiB 传输、300 秒 Host、1–30 秒采用及宏证明预算保持不变。没有真实玩家数据上传、账号/云档变更、生产发布或长离线/实时权威开放。

## 5. 证据位置和复验

开发 worktree `artifacts/rust-rp1-loop/` 保存包、各例 `report.json`、外部 `guard.json` 和汇总；原工作区 `artifacts/rust-rp1-next/` 保存云端下载。私人数据不进入 Git 或 CI。

| 只读下载/文件 | SHA-256 |
| --- | --- |
| `cloud-ci-2bb10b43-diagnostics.zip` | `edbbb244d1024b883ee2d67fdec88bd2ad0607b3808e60271347ac9549821b53` |
| `cloud-pr31-native-diagnostics-v1.zip` | `56e646b445e29b03d3bdb4eb262f43399e2a18dd59ee0903b7090716c3ba360e` |
| `cloud-pr31-browser-shard1-v1.zip` | `9a35c1dd9563e9dc7aec03c3c092df782289925592718e487a20d731ce77565a` |
| `cloud-pr31-browser-shard2-v1.zip` | `f69fafdd0c76c4d4b09aaccdcdcfe24555cd9123ac1c0589dfaa470878cf89e9` |
| `cloud-main-9f4-browser-shard1-v1.zip` | `f648429388d54d35b0a417b42766407c452924843a55827e9fe1c4640611b182` |
| `cloud-main-9f4-browser-shard2-v1.zip` | `78c2c01e22188e5bb9e111854de68d382d0f7b43c9ac5c3601580345ddb01ebb` |
| `chromium-2bb10b43-v1.json` | `70a884ce4030d0b6dbf803c2ee5a85c74566c55744d1adec080d6b735d517b8e` |

复验先校验来源/Host/包和驱动摘要，再在隔离 profile 运行已验证的后台驱动；禁止旧 show/focus 驱动。完整模拟/私人测试只允许 6 GiB 以上启动余量，保持单任务及独立监控；资源不足不启动、不调整保护或关闭用户程序。浏览器失败先按固定案例定位，再决定是否需新的完整矩阵；不为得到绿色结果反复重跑成功检查。
