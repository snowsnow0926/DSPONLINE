# 2026-09-12 开发工作归档与工作树清理

按用户授权扫描、提交、推送项目开发内容，并清理可重建缓存与旧工作树。扫描 48 个登记工作树，其中 34 个有未提交内容；创建 28 份历史工作 checkpoint，加上主工作区历史记录提交。所有历史实验均为保存进度，不代表回归通过或可以发布。

主线合并提交 `dde6bcc4` 保持 GitHub 1.2.9 运行代码和构建配置完全一致，仅补充历史运维文档。此前已完成的 Android 和玩家展示修复由 1.2.9 实现接续。

- GitHub：主线与 94 个 `codex/archive-20260912/*` 归档分支已逐一核对远端 SHA。
- 清理：删除 45 个旧工作树；另处理 22 个未登记的测试副本、编译缓存和旧操作目录。
- 磁盘：两阶段净释放约 70.1 GB（受系统并发磁盘活动影响，以清理前后可用空间计）。
- 本地材料：发布证据、性能报告、历史脚本与无 Git 元数据的源码副本保存在 `D:/GameDev/DSPidle2-local-archive-20260912/`；原有 `DSPidle2-worktree-artifact-archive` 保持原处。
- 保留工作树：`DSPidle2`（main）、`DSPidle2-rust-rp1-development`（当前 Rust 开发）、`DSPidle2-main`（旧 cherry-pick/sequencer 现场）。
- `DSPidle2-main` 的改动通过独立索引生成快照，没有更改其索引、cherry-pick 状态和工作区文件，因此原工作区仍显示未提交改动。

历史发布线含一个约 150 MB 的已跟踪安装包。涉及它的 5 个分支保留完整本地 Git 历史，向 GitHub 推送排除生成目录 `artifacts/` 的独立源码快照（名称以 `-source-only` 结尾），不上传旧安装包。原分支与原提交没有重写。

## 验证范围

- Android 构建配置定向测试：5/5 通过。
- 主线新增 JSON 解析：3 份通过；新增本地文档链接：16 条通过。
- 主线 `git diff --check`、技能 frontmatter 校验通过；旧指令工作树自带文档校验通过。
- 推送历史扫描覆盖 1,257 个新增 blob，未发现扫描规则匹配的密钥/token；识别并排除了上述大安装包所在历史。
- 5 个历史 checkpoint 的空白检查保留原有 Markdown 行尾空格等发现，没有为归档改写原文件。
- 未重跑旧实验的全量游戏、Rust、浏览器或发布矩阵；所有归档提交注明未验证发布资格。
- GitHub 接受 main 推送的回执提示 required `verify` 尚未提供；本次归档提交使用 `[skip ci]`，未把该远端检查记为通过。没有打版本标签或触发发布。

## 工作树源码索引

| 原工作树 | 保存位置 | 原 HEAD |
| --- | --- | --- |
| DSPidle2 | [codex/archive-20260912/root-main](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/root-main) | `f6499add` |
| dspidle-belts-candidate-7c378e0 | [codex/archive-20260912/belts-candidate-7c378e0](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/belts-candidate-7c378e0) | `7c378e0f` |
| DSPidle2-android-cloud-fix | 原提交 b6226b47（已有远端或历史归档可达）；非源码材料在本地归档 | `b6226b47` |
| DSPidle2-approximate-offline | [codex/archive-20260912/approximate-offline](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/approximate-offline) | `019bac52` |
| DSPidle2-audit-pure-idle-construction-block30 | [codex/archive-20260912/audit-pure-idle-construction-block30](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/audit-pure-idle-construction-block30) | `46ef9251` |
| DSPidle2-audit-pure-idle-construction-fix | [codex/archive-20260912/audit-pure-idle-construction-fix](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/audit-pure-idle-construction-fix) | `46ef9251` |
| DSPidle2-blueprint-reconcile-audit-86f1db2 | [codex/archive-20260912/blueprint-reconcile-audit-86f1db2](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/blueprint-reconcile-audit-86f1db2) | `86f1db29` |
| DSPidle2-blueprint-reconcile-audit-91a321a | [codex/archive-20260912/blueprint-reconcile-audit-91a321a](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/blueprint-reconcile-audit-91a321a) | `91a321ac` |
| DSPidle2-divergence-diag-2645578 | [codex/archive-20260912/divergence-diag-2645578](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/divergence-diag-2645578) | `26455783` |
| DSPidle2-divergence-parent-4cca590 | [codex/archive-20260912/divergence-parent-4cca590](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/divergence-parent-4cca590) | `4cca590b` |
| DSPidle2-generation-kw-order | [codex/archive-20260912/generation-kw-order](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/generation-kw-order) | `53943434` |
| DSPidle2-hk-player-display | 原提交 fccaa35e（已有远端或历史归档可达）；非源码材料在本地归档 | `fccaa35e` |
| DSPidle2-hk-player-display-control | 原提交 dab2ff50（已有远端或历史归档可达）；非源码材料在本地归档 | `dab2ff50` |
| DSPidle2-hk-presence-fix | [codex/archive-20260912/hk-presence-fix](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/hk-presence-fix) | `df828869` |
| DSPidle2-json-map-preserve-order-exp | [codex/archive-20260912/json-map-preserve-order-exp](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/json-map-preserve-order-exp) | `9778ba4c` |
| DSPidle2-main | [codex/archive-20260912/main](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/main) | `4e207c34` |
| DSPidle2-native-belt-transfer-hotspot | 原提交 fb2ea282（已有远端或历史归档可达）；非源码材料在本地归档 | `fb2ea282` |
| DSPidle2-native-blueprint-rename-audit-tmp | [codex/archive-20260912/native-blueprint-rename-audit-tmp](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/native-blueprint-rename-audit-tmp) | `836331cf` |
| DSPidle2-native-dyson-runtime | 原提交 2c7c92eb（已有远端或历史归档可达）；非源码材料在本地归档 | `2c7c92eb` |
| DSPidle2-native-next-serial-hotspot | 原提交 1b08be59（已有远端或历史归档可达）；非源码材料在本地归档 | `1b08be59` |
| DSPidle2-native-power-event-source | [codex/archive-20260912/native-power-event-source](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/native-power-event-source) | `16e5583a` |
| DSPidle2-native-pure-idle-construction-audit-tmp | [codex/archive-20260912/native-pure-idle-construction-audit-tmp](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/native-pure-idle-construction-audit-tmp) | `46ef9251` |
| DSPidle2-native-renewable-gate | [codex/archive-20260912/native-renewable-gate](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/native-renewable-gate) | `c93ccd14` |
| DSPidle2-release-1.0.38-351c649 | [codex/archive-20260912/release-1.0.38-351c649-source-only](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/release-1.0.38-351c649-source-only) | `351c649a` |
| DSPidle2-release-1.0.46-62104eb | [codex/archive-20260912/release-1.0.46-62104eb](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/release-1.0.46-62104eb) | `ddb0659a` |
| DSPidle2-release-1.1.2-48d70aa | [codex/archive-20260912/release-1.1.2-48d70aa](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/release-1.1.2-48d70aa) | `48d70aa5` |
| DSPidle2-rp1-recovery-baseline | 原提交 0cc971d8（已有远端或历史归档可达）；非源码材料在本地归档 | `0cc971d8` |
| DSPidle2-runtimeworld-2 | [codex/archive-20260912/runtimeworld-2](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/runtimeworld-2) | `6a8af94a` |
| DSPidle2-rust-rp1-baseline | 原提交 9f4ac5c3（已有远端或历史归档可达）；非源码材料在本地归档 | `9f4ac5c3` |
| DSPidle2-rust-rp1-development | 原提交 f2f6d033（已有远端或历史归档可达）；非源码材料在本地归档 | `f2f6d033` |
| DSPidle2-system-station-native-commands | [codex/archive-20260912/system-station-native-commands](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/system-station-native-commands) | `5df0e4eb` |
| DSPidle2-v113-dev | 原提交 17719c1c（已有远端或历史归档可达）；非源码材料在本地归档 | `17719c1c` |
| DSPidle2-v115-dev | [codex/archive-20260912/v115-dev](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/v115-dev) | `f67bdd09` |
| DSPidle2-v115-release-candidate | [codex/archive-20260912/v115-release-candidate](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/v115-release-candidate) | `a92c0d31` |
| DSPidle2-v117-belt-fix | [codex/archive-20260912/v117-belt-fix](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/v117-belt-fix) | `538eadec` |
| DSPidle2-v117-development | 原提交 2dca5770（已有远端或历史归档可达）；非源码材料在本地归档 | `2dca5770` |
| DSPidle2-v118-memory-optimization | [codex/archive-20260912/v118-memory-optimization](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/v118-memory-optimization) | `c53497b0` |
| DSPidle2-v119-windows-performance-layer1 | [codex/archive-20260912/v119-windows-performance-layer1](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/v119-windows-performance-layer1) | `d3750056` |
| DSPidle2-v123-windows-native-performance | [codex/archive-20260912/v123-windows-native-performance](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/v123-windows-native-performance) | `836d6545` |
| DSPidle2-v127-ae5b-manifest | 原提交 ae5b555f（已有远端或历史归档可达）；非源码材料在本地归档 | `ae5b555f` |
| DSPidle2-v127-ci-validation | 原提交 448a2b00（已有远端或历史归档可达）；非源码材料在本地归档 | `448a2b00` |
| DSPidle2-v127-web-android-release | 原提交 dab2ff50（已有远端或历史归档可达）；非源码材料在本地归档 | `dab2ff50` |
| DSPidle2-v127-windows-performance | 原提交 b7ca5b8d（已有远端或历史归档可达）；非源码材料在本地归档 | `b7ca5b8d` |
| DSPidle2-v129-release-candidate | 原提交 0521eb63（已有远端或历史归档可达）；非源码材料在本地归档 | `0521eb63` |
| DSPidle2-v129-release-operations | 原提交 afcd11c5（已有远端或历史归档可达）；非源码材料在本地归档 | `afcd11c5` |
| DSPidle2-v129-shared-performance | 原提交 afcd11c5（已有远端或历史归档可达）；非源码材料在本地归档 | `afcd11c5` |
| DSPidle2-v145-space-station | [codex/archive-20260912/v145-space-station](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/v145-space-station) | `769fd1d6` |
| DSPidle2-web-first-plan | 原提交 9aad92c7（已有远端或历史归档可达）；非源码材料在本地归档 | `9aad92c7` |

## 全部远端归档分支

下面的历史分支保存原开发链，不能批量合并回 main。恢复某项工作时，从对应分支新建工作树，再检查与当前主线的差异和测试。

- [codex/archive-20260912/approximate-offline](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/approximate-offline)
- [codex/archive-20260912/audit-pure-idle-construction-block30](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/audit-pure-idle-construction-block30)
- [codex/archive-20260912/audit-pure-idle-construction-fix](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/audit-pure-idle-construction-fix)
- [codex/archive-20260912/belts-candidate-7c378e0](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/belts-candidate-7c378e0)
- [codex/archive-20260912/blueprint-reconcile-audit-86f1db2](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/blueprint-reconcile-audit-86f1db2)
- [codex/archive-20260912/blueprint-reconcile-audit-91a321a](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/blueprint-reconcile-audit-91a321a)
- [codex/archive-20260912/divergence-diag-2645578](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/divergence-diag-2645578)
- [codex/archive-20260912/divergence-parent-4cca590](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/divergence-parent-4cca590)
- [codex/archive-20260912/generation-kw-order](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/generation-kw-order)
- [codex/archive-20260912/hk-presence-fix](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/hk-presence-fix)
- [codex/archive-20260912/json-map-preserve-order-exp](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/json-map-preserve-order-exp)
- [codex/archive-20260912/main](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/main)
- [codex/archive-20260912/native-blueprint-rename-audit-tmp](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/native-blueprint-rename-audit-tmp)
- [codex/archive-20260912/native-power-event-source](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/native-power-event-source)
- [codex/archive-20260912/native-pure-idle-construction-audit-tmp](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/native-pure-idle-construction-audit-tmp)
- [codex/archive-20260912/native-renewable-gate](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/native-renewable-gate)
- [codex/archive-20260912/release-1.0.46-62104eb](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/release-1.0.46-62104eb)
- [codex/archive-20260912/release-1.1.2-48d70aa](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/release-1.1.2-48d70aa)
- [codex/archive-20260912/root-main](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/root-main)
- [codex/archive-20260912/runtimeworld-2](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/runtimeworld-2)
- [codex/archive-20260912/system-station-native-commands](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/system-station-native-commands)
- [codex/archive-20260912/v115-dev](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/v115-dev)
- [codex/archive-20260912/v115-release-candidate](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/v115-release-candidate)
- [codex/archive-20260912/v117-belt-fix](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/v117-belt-fix)
- [codex/archive-20260912/v118-memory-optimization](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/v118-memory-optimization)
- [codex/archive-20260912/v119-windows-performance-layer1](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/v119-windows-performance-layer1)
- [codex/archive-20260912/v123-windows-native-performance](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/v123-windows-native-performance)
- [codex/archive-20260912/v145-space-station](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/v145-space-station)
- [codex/archive-20260912/history-codex-1.0.40-leaderboard-ranking](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-1.0.40-leaderboard-ranking)
- [codex/archive-20260912/history-codex-1.0.44-canvas-viewport-connect](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-1.0.44-canvas-viewport-connect)
- [codex/archive-20260912/history-codex-1.0.44-save-catalog](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-1.0.44-save-catalog)
- [codex/archive-20260912/history-codex-1.0.47-feedback-fixes](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-1.0.47-feedback-fixes)
- [codex/archive-20260912/history-codex-1.0.47-release-record](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-1.0.47-release-record)
- [codex/archive-20260912/history-codex-1.1.1-cloud-upload-p0](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-1.1.1-cloud-upload-p0)
- [codex/archive-20260912/history-codex-1.1.3-web-cloudfix](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-1.1.3-web-cloudfix)
- [codex/archive-20260912/history-codex-1.1.6-proxy-counter-fix](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-1.1.6-proxy-counter-fix)
- [codex/archive-20260912/history-codex-1.1.6-pure-idle-conservative](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-1.1.6-pure-idle-conservative)
- [codex/archive-20260912/history-codex-1.1.8-release-record](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-1.1.8-release-record)
- [codex/archive-20260912/history-codex-1.2.4-web-pwa-artifact-fix](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-1.2.4-web-pwa-artifact-fix)
- [codex/archive-20260912/history-codex-1.2.6-release](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-1.2.6-release)
- [codex/archive-20260912/history-codex-belt-conflict-profiler-16e5583](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-belt-conflict-profiler-16e5583)
- [codex/archive-20260912/history-codex-con-u1-native-construction-center](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-con-u1-native-construction-center)
- [codex/archive-20260912/history-codex-con-u2-native-construction-writes](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-con-u2-native-construction-writes)
- [codex/archive-20260912/history-codex-fix-native-construction-direct-cache](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-fix-native-construction-direct-cache)
- [codex/archive-20260912/history-codex-leaderboard-review-api-release-20260821](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-leaderboard-review-api-release-20260821)
- [codex/archive-20260912/history-codex-native-belt-conflict-parallel](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-native-belt-conflict-parallel)
- [codex/archive-20260912/history-codex-native-blueprint-readmodel](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-native-blueprint-readmodel)
- [codex/archive-20260912/history-codex-native-blueprint-rename-reconcile](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-native-blueprint-rename-reconcile)
- [codex/archive-20260912/history-codex-native-campaign-galaxy-ui](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-native-campaign-galaxy-ui)
- [codex/archive-20260912/history-codex-native-construction-automation-intents](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-native-construction-automation-intents)
- [codex/archive-20260912/history-codex-native-csr-wake-candidate](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-native-csr-wake-candidate)
- [codex/archive-20260912/history-codex-native-galaxy-account-race-fix](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-native-galaxy-account-race-fix)
- [codex/archive-20260912/history-codex-native-lazy-scan-candidate](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-native-lazy-scan-candidate)
- [codex/archive-20260912/history-codex-native-material-hub-audit-fixes](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-native-material-hub-audit-fixes)
- [codex/archive-20260912/history-codex-native-material-hub-oactive](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-native-material-hub-oactive)
- [codex/archive-20260912/history-codex-native-operations-projection-active](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-native-operations-projection-active)
- [codex/archive-20260912/history-codex-native-operations-thin-ui](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-native-operations-thin-ui)
- [codex/archive-20260912/history-codex-native-orbital-contract-authority](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-native-orbital-contract-authority)
- [codex/archive-20260912/history-codex-native-parallel-block](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-native-parallel-block)
- [codex/archive-20260912/history-codex-native-planet-metrics-oactive](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-native-planet-metrics-oactive)
- [codex/archive-20260912/history-codex-native-power-state-snapshot](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-native-power-state-snapshot)
- [codex/archive-20260912/history-codex-native-power-view-candidate](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-native-power-view-candidate)
- [codex/archive-20260912/history-codex-native-production-oactive](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-native-production-oactive)
- [codex/archive-20260912/history-codex-native-pure-idle-construction-deterministic](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-native-pure-idle-construction-deterministic)
- [codex/archive-20260912/history-codex-native-pure-idle-parallel-cert](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-native-pure-idle-parallel-cert)
- [codex/archive-20260912/history-codex-native-pure-idle-parallel-cert-p1](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-native-pure-idle-parallel-cert-p1)
- [codex/archive-20260912/history-codex-native-research-boundary-oactive](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-native-research-boundary-oactive)
- [codex/archive-20260912/history-codex-native-station-fleet-ui](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-native-station-fleet-ui)
- [codex/archive-20260912/history-codex-next-feedback-fixes](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-next-feedback-fixes)
- [codex/archive-20260912/history-codex-oactive-runtime-block](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-oactive-runtime-block)
- [codex/archive-20260912/history-codex-release-0.7.0](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-release-0.7.0)
- [codex/archive-20260912/history-codex-release-1.0.27](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-release-1.0.27)
- [codex/archive-20260912/history-codex-release-1.0.30](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-release-1.0.30)
- [codex/archive-20260912/history-codex-station-definite-rejection](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-station-definite-rejection)
- [codex/archive-20260912/history-codex-system-station-durable-host-block](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-system-station-durable-host-block)
- [codex/archive-20260912/history-codex-system-station-thin-ui-block](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-system-station-thin-ui-block)
- [codex/archive-20260912/history-codex-system-station-workspace-projection](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-system-station-workspace-projection)
- [codex/archive-20260912/history-codex-windows-native-black-hole-toggle](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-windows-native-black-hole-toggle)
- [codex/archive-20260912/history-codex-windows-native-pause-lifecycle](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-windows-native-pause-lifecycle)
- [codex/archive-20260912/history-codex-windows-native-pure-idle-terminal-tail](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-windows-native-pure-idle-terminal-tail)
- [codex/archive-20260912/history-codex-windows-native-station-fleet-conservation](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-windows-native-station-fleet-conservation)
- [codex/archive-20260912/history-codex-windows-native-station-fleet-intents](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-windows-native-station-fleet-intents)
- [codex/archive-20260912/history-codex-windows-native-station-readmodel](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-windows-native-station-readmodel)
- [codex/archive-20260912/history-codex-windows-native-station-slot-intents](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-windows-native-station-slot-intents)
- [codex/archive-20260912/history-codex-windows-native-station-slot-thin-ui](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-windows-native-station-slot-thin-ui)
- [codex/archive-20260912/history-codex-windows-native-timewarp-ejector](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-windows-native-timewarp-ejector)
- [codex/archive-20260912/history-native-belt-transfer-hotspot](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-native-belt-transfer-hotspot)
- [codex/archive-20260912/history-native-dyson-runtime](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-native-dyson-runtime)
- [codex/archive-20260912/history-native-next-serial-hotspot](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-native-next-serial-hotspot)
- [codex/archive-20260912/history-codex-1.0.37-release-record-pre-github-filter-source-only](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-1.0.37-release-record-pre-github-filter-source-only)
- [codex/archive-20260912/history-codex-1.0.38-performance-resource-cap-source-only](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-1.0.38-performance-resource-cap-source-only)
- [codex/archive-20260912/history-codex-1.0.38-release-record-source-only](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-1.0.38-release-record-source-only)
- [codex/archive-20260912/history-codex-1.0.38-timewarp-save-fix-source-only](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/history-codex-1.0.38-timewarp-save-fix-source-only)
- [codex/archive-20260912/release-1.0.38-351c649-source-only](https://github.com/snowsnow0926/DSPONLINE/tree/codex/archive-20260912/release-1.0.38-351c649-source-only)

恢复示例：

```powershell
git fetch origin
git worktree add ../DSPidle2-restore -b codex/restore-approximate-offline origin/codex/archive-20260912/approximate-offline
```
