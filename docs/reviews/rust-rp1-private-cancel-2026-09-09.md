# Rust RP1 终局取消与新包复验｜2026-09-09

Role: develop。新包已验证完整终局档的 9 秒 Rust/JS 结果一致，以及取消后原档不变、两次正常重开仍有效；完成结算后的工厂入口仍超过原 90 秒门槛。未发布，未扩大 1–30 秒采用范围。

## 构建身份

从干净提交 `37630d058d333b397c9b8875b421a6436eef0c76` 重新执行正常 release Rust 构建、TypeScript、Vite、startup budget、thin-UI、coverage、平台检查和 desktop pack。其运行代码与已测试 `7fd6d52188c7229138aa534255acc48ea7dcafe9` 相同，二者只有文档差异；没有复用旧 Host 冒充新构建。

- Windows performance beta：`1.2.7+37630d058d33`，离线默认、隔离 profile，未签名 `NotSigned`。
- Rust/Cargo 1.96.1，正常 release 优化，无 RUSTFLAGS override；Host SHA-256 `6bea5576baac9fe52a6529a4d6e5417d9617f4c776a5e93af821fa4f3afe21f5`。
- 75 件包内制品、78 件冻结文件验证通过，旧 `package-2bb10b43-frozen` 再次核对未变。
- 构建守护 411.091 秒，最低可用 7,742,088 KiB，正常退出 0。没有运行游戏窗口。

证据位于开发 worktree `artifacts/rust-rp1-loop/`：`build-desktop-37630d05.mjs`、对应 `-guard/`、`package-37630d05-frozen/` 和 `package-37630d05-receipt.json`。回执 SHA-256 `186bd87f7cc64e45b0b01d6242bef5c56cf36e654fd8f2a36b92a754db389142`。

## 完整终局来源与结果

使用此前授权的 107,637,967 bytes 原档，SHA-256 `d64b5646f6117f3c089fba4dc95a95e84bedd9375f75b3c8c917b2e7cf473bc1`，保留 110,042 实体和 233,300 条传送带。只刷新隔离副本信封的 savedAt，真实时钟和菜单已有 orphan timeWarp 恢复照常执行；没有本机匹配 journal，不代表原始累计长离线已结算。

| 场景 | 结果 | 守护时长 / 最低可用内存 |
| --- | --- | --- |
| v5 完成结算 | **FAILED**：Host 50,049.801 ms 返回 9 秒精确候选，但工厂仍未在原 90 秒内就绪；两次正常关闭 0 | 110.358 秒 / 5,060,380 KiB |
| v5 取消 | **PASS**：9 秒完整 JS 对照、主档与原生检查点不变、取消后两次重开通过；四次正常关闭 0。收尾观察覆盖了 RPC 日志，下面 v6 补齐可追溯记录 | 184.239 秒 / 4,400,436 KiB |
| v6 取消与证据保留 | **PASS**：保留完整 RPC 和独立 settlementProof，原断言再次通过；四次正常关闭 0 | 184.129 秒 / 4,482,380 KiB |

v6 只修正测试记录：重开的未插桩进程不再用空值覆盖先前 RPC，并在对照前复制候选身份。游戏源码、计算和门槛未修改，不把 v5 的记录缺失解释为游戏保存问题。取消测试在 Host 已生成候选后延迟响应 3 秒，以确定性触发取消；这个人为延迟不用于性能测量。

v6 Host 请求 50,114.403 ms，`settledSeconds=exactCalibrationSeconds=9`、`approximatedSeconds=0`。恢复来源 canonical 为 `2b8be04ba8d8a00717340131069606b8cd5e609e11e00c20c421ca272c1259c4`；Rust 候选和独立完整 JS 逐秒参考均为 `6cf99f1d4d8bb0f172448c1c2e790b7cf5acd2cf47de9a6bede3e28a5ee8f96b`。这与 v5 完成场景的来源/候选相同，但完成场景的持久提交、进入工厂和成功结算后重进仍未验收。

三次测试原文件大小、mtime、SHA 均不变。共 10 次启动/正常退出，隐藏、不可聚焦、静音、离屏绘制，显示/聚焦/原生对话框计数为零，没有强制清理。低优先级串行执行，6 GiB 启动 / 2 GiB 停止线保持不变。

| 证据 | SHA-256 |
| --- | --- |
| `private-packaged-complete-v5/report.json` | `6333c4cf7f7d1402795dfd276ca958337646bd762ef114f8464354df959b9b6b` |
| `private-packaged-cancel-v5/report.json` | `be6c342900f5d3cf904221429684dc4ad20219de8923cd856b6556661dfc5010` |
| `private-packaged-cancel-v6/report.json` | `448469fdce860a7fd399fb6125ea8b6f4e98265d6b6eb278c05ed75254424c0d` |
| `probe-private-packaged-entry-v6.mjs` | `7f6946f51671e8f37257cdb2a30371c063e3685dc2770ae24bb4588cbc422694` |

## 同源码云端检查

7fd 的 [CI run 34304517707](https://github.com/snowsnow0926/DSPONLINE/actions/runs/34304517707) 已确认：

- Production build 成功；Linux 单元 3,168 pass / 41 skip / 0 fail，类型与许可证检查成功。与本机 3,170/39 的平台条件跳过分别记录。
- Server 390/2 skip、station 4/0、Ops 60/2 skip；Linux Rust core 1,113/5 ignored、Host 245+3/0、Native 670/5 skip，均零失败。
- 浏览器第二组 **208 expected / 22 skipped / 6 unexpected / 5 flaky**，完整门禁失败。六项分别涉及堆叠连接坐标 96/96.5、隐藏成员选择、连接设置场景的启动、菜单 p95 1,221 ms 超过原 500 ms、缓冲设置总超时、刷新设置 200/500 不符。不能统一归为机器慢。
- 第一组也已失败终态：195 expected / 11 skipped / 23 unexpected / 18 flaky。完整浏览器合计 **403 expected / 33 skipped / 29 unexpected / 23 flaky**。
- 独立 [Windows run 34304517681](https://github.com/snowsnow0926/DSPONLINE/actions/runs/34304517681) 现已失败终态：fmt、严格 Clippy、正常 release Rust 1,365/5 ignored、Native 674/1 skip 和类型检查通过；完整游戏单元 **3,169 pass / 39 skip / 1 fail**。失败为 `idleResourceSettlement.test.ts:192` 矿脉经传送带在长挂机中枯竭的完整精确跨界案例，6,451 ms 超过原 5,000 ms，未放宽门槛。完整已验证 Host 上传步骤按门禁跳过，仅有带未取得完整资格标记的开发候选；不可视为发布制品。日志 `cloud-7fd-windows-v1.log` 保留，需继续定位这项实际失败。

本地日志为 `cloud-7fd-{unit,server,shard1,shard2}-v1.log`；第二组 JSON ZIP 已按 GitHub digest `9d5e879864ae2d3fbfe2bee336989408268d48e0a70135da10ee93f62531f35d` 核对，文件 `cloud-pr31-7fd-shard2-json-v1.zip`，审计 `cloud-7fd-shard2-audit-v1.json`。第一组 `cloud-pr31-7fd-shard1-json-v1.zip` digest 为 `dbf772c9f6ebf0897eb91f07c7ff6def5c5607e8351df5cd7417458d72a3cf90`，也已下载核对。旧 0ce 蓝图失败的上下文已确认工厂界面存在且教学显示，尚未定位原因，不能仅用启动等待替代诊断。

## 剩余工作

下一步仍需减少 Native 返回后完整校验、保存和初始化的重复工作，取得终局完成场景的实际等待改善及持久/重进证据；同时逐类解决浏览器回归。保留完整备份检查、原性能门槛与历史堆异常隔离证据。之前的公开大工厂 71.3% 完整等待收益仍只属于冻结 2bb 对照；本次不宣称新整体提速或峰值内存下降。

参见[当前易读报告](../RUST_BATCH_REPORT_2026-09-09_CURRENT.md)、[保存优化](./rust-rp1-save-byte-length-2026-09-09.md)及[原始入口失败](./rust-rp1-endgame-entry-wait-2026-09-09.md)。完整开发目标继续进行。
