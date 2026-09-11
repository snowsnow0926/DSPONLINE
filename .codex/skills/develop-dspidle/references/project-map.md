# Project Map

读完 `docs/PROJECT_STATUS.md` 的相关摘要后使用本图。只打开当前任务需要的文件。路径以当前工作树为准；文件不存在时记录缺口，不要杜撰。

## 三类依据

实现与文档冲突时，先判断是代码错误还是说明过时。不得机械修改测试预期以迎合错误实现。

| 依据 | 来源 | 用途 |
| --- | --- | --- |
| 当前行为 | 当前代码、配置、本轮运行证据 | 描述系统现在做什么 |
| 预期正确行为 | 已批准需求、玩法不变量、接口和存档契约 | 判断应保持或应修复什么 |
| 操作权限 | 当前任务授权、有效项目规则、执行器权限 | 判断现在允许改什么、跑什么、部署什么 |

“代码优先于文档”只用于识别当前行为。它不表示测试必须服从错误实现，也不表示有权限执行未授权操作。

## 1. Web / PWA、桌面和手机界面

| 区域 | 主要入口 | 契约或测试 | 跨端边界 |
| --- | --- | --- | --- |
| 启动与 PWA | `src/main.tsx`、`src/pwa.ts`、`public/sw.js` | Playwright PWA / production-preview | PWA 只在 Web 生产注册；Electron/Android 不注册 worker |
| 平台壳 | `src/nativeApp.ts`、`src/components/NativeUpdateCard.tsx` | `android/security-boundary.test.mjs`、`desktop/release-channels.test.cjs` | 生命周期与更新通道是设备 UI，不进 `GameState` |
| 主菜单 | `src/components/StartMenu.tsx`、`src/GameLauncher.tsx` | 存档/云/离线 E2E | Continue、槽位、导入、云冲突 |
| 工厂编排 | `src/App.tsx`、`src/FactoryRuntime.tsx` | 游戏流 E2E | 高冲突；Worker、画布、工作区、保存命令 |
| 节点/线路 | `src/components/FactoryNodes.tsx`、`FactoryEdges.tsx` | 画布与连线测试 | 卡片必须挡住后方传送带命中 |
| 面板与工作区 | `src/components/GamePanels.tsx`、`*Workspace.tsx`、`CatalogPicker.tsx` | 对应 workspace E2E | 复用现有命令和 selectors |
| 手机壳 | `src/components/mobile/`、`src/hooks/`、`src/styles.css` | 竖屏/横屏/字体矩阵 | 设备偏好走 localStorage，不进存档 |
| 构建切分 | `vite.config.ts`、`index.html` | `npm run build`、startup budget | 社区构建默认不注入官方 API/更新源 |

## 2. JavaScript 模拟器、Worker、离线与时间扭曲

| 区域 | 主要入口 | 契约或测试 | 跨端边界 |
| --- | --- | --- | --- |
| 类型与目录 | `src/game/types.ts`、`content.ts` | `content.test.ts`、`progressionAudit.ts` | 核心目录定义优先于展示列表 |
| 引擎 | `src/game/engine.ts` | `engine.test.ts`、`benchmark.ts` | 同一状态 + elapsed seconds 必须确定 |
| 实时 Worker | `src/game/simulation.worker.ts`、`simulationRuntimeProtocol.ts` | `engine.test.ts`、runtime protocol 测试 | Worker 持有权威状态；主线程 fallback 必须同规则 |
| 投影/增量 | `simulationProjection.ts`、`simulationDelta.ts` | 对应 `*.test.ts` | UI 投影不是第二份权威状态 |
| 离线 | `offlineSimulation.ts`、`offlineSimulation.worker.ts`、`offlineSettlementStrategy.ts` | offline `*.test.ts` | 失败从原始副本回退，不发未结算收益 |
| 纯挂机 | `pureIdleMacro.ts`、`pureIdleMacro.worker.ts`、`pureIdleRecovery.ts` | `pureIdleMacro.test.ts`、`pureIdleRecovery.test.ts` | journal 不属于 `GameState`/envelope/云 payload |
| 多核实验 | `multicoreSimulation.ts`、`multicoreSimulation.worker.ts` | `multicoreSimulation.test.ts` | 生产构建默认关闭；影子结果不能双写 |
| 物流/网络 | `network.ts`、`quantumLogisticsNetwork.ts` | `network.test.ts`、quantum 测试 | 多线路、槽位和量子边界 |

本工作树的模拟权威是 JavaScript 引擎与 Worker。Rust 进程存在（若在其他工作树）也不自动成为玩家权威。

## 3. Rust Core、Host、目录注册与跨语言差分

先检查当前树是否存在 `native/Cargo.toml`。本工作树（`package.json` 1.0.46，无 `native/`）没有 Rust crate。

若 `native/Cargo.toml` 存在，按实际文件路由，不要把旧 JS 地图当成 native 所有权：

| 区域 | 主要入口 | 契约或测试 | 跨端边界 |
| --- | --- | --- | --- |
| Workspace | `native/Cargo.toml` | `npm run test:native-core`（`cargo test --manifest-path native/Cargo.toml`） | 与 `npm run test:native` 不是同一层 |
| Core / Host | `native/dsp-native-core`、`native/dsp-native-host` | cargo 测试、host 集成测试 | Host 不是 UI；UI 只发 intent、读投影 |
| 表面所有权 | `native/native-surface-registry.json` | `verify:native-coverage`（若脚本存在） | 实时所有权以注册表为准，不把文件数量写成永久规则 |
| 覆盖清单 | `native/native-coverage-manifest.json` | 生成/校验脚本 | 代码存在 ≠ 玩家权威已启用 |
| 跨语言差分 | 对应 JS/Rust 对照测试 | 同输入哈希/库存对照 | 不能靠放宽容差或漏算合法工作得到通过 |

`authorityEligible` / `authority_eligible` 只能由已批准的覆盖证明和发布门禁产生。Skill 整理或本地开发不得擅自打开该门禁。Rust 进程在跑而门禁关闭时，如实区分进程、模式和资格。

## 4. Electron main/preload、IPC、投影、运行模式、接管与恢复

| 区域 | 主要入口 | 契约或测试 | 跨端边界 |
| --- | --- | --- | --- |
| Main | `desktop/main.cjs` | `desktop/*.test.cjs` | context isolation、sandbox、单实例 |
| Preload | `desktop/preload.cjs` | preload/IPC 测试 | 只暴露 `window.dspDesktop` |
| 云传输 | `desktop/cloud-transport.cjs` | `cloud-transport.test.cjs`、`message-port-transfer-smoke.test.cjs` | 渲染进程不关 Web 安全；大 payload 走 MessagePort |
| 打包/通道 | `desktop/pack.cjs`、`release-channels.cjs` | `release-channels.test.cjs` | 通道写入包元数据，安装后不回落到 stable |
| 账号归档 | `desktop/account-archive-download.cjs` | `account-archive-download.test.cjs` | 不把存档正文打进日志 |
| 前端桥 | `src/game/apiTransport.ts`、`src/nativeApp.ts` | `apiTransport.test.ts` | Web/Android Fetch；Electron 受限主进程桥 |

运行模式由当前构建和设备壳决定。投影、缓存和 IPC 回执不能在 UI 侧提交玩法状态。

## 5. 公开存档、私有保存、WAL、云冲突与内容包

| 区域 | 主要入口 | 契约或测试 | 跨端边界 |
| --- | --- | --- | --- |
| 公开契约 | `save-field-contract.json`、`src/game/saveFieldContract.ts`、`storage.ts` | `storage.test.ts`、`saveFieldContract.test.ts` | 公开 JSON envelope / GameState 与平台私有实现分开 |
| 本地权威存储 | `localSaveStore.ts`、`localSaveCoordination.ts` | `localSaveStore.test.ts`、`localSaveCoordination.test.ts` | IndexedDB writer lease、fencing、冲突双副本 |
| 目录/摘要 | `localSaveCatalog.ts`、`savePreview.ts`、catalog worker | catalog 测试 | 主页不 `getAll()` 大正文 |
| 保存 Worker | `save.worker.ts`、`authoritativeSave*.ts` | authoritative save 测试 | 校验和与读回证明在提交路径上 |
| 运行时协调 | `runtimePersistenceMode.ts` | `runtimePersistenceMode.test.ts` | 默认 verified-primary；打开旧档不得自动启用 durable WAL |
| Durable / WAL | `simulationRuntimeDurable*.ts`、`simulationRuntimeRecovery*.ts` | 对应 `*.test.ts`、`npm run test:e2e:durable` | 仅 `VITE_DURABLE_RUNTIME_RECOVERY=true` 的显式开发验证 |
| 云冲突 | `src/game/cloud.ts`、`CloudSaveConflictDialog.tsx` | `cloud.test.ts`、云 E2E | 冲突不得静默覆盖任一侧 |
| 内容包 | `mods.ts`、`contentPacks.ts` | `mods.test.ts`、`contentPacks.test.ts` | 先启用包再迁移扩展 ID |

私有 native 保存（若后续工作树提供独立磁盘格式）不得偷偷改写公开 envelope。不是每次模拟改动都要升存档版本。

## 6. 服务端、排行榜、临时库测试、构建发布与运维

| 区域 | 主要入口 | 契约或测试 | 跨端边界 |
| --- | --- | --- | --- |
| API | `server/index.mjs` | `npm run test:server`、`server/server.test.mjs` | 只用临时 SQLite；禁止生产账号写测试 |
| 排行榜 | `server/leaderboard-review-report.mjs`、admin dashboard | server 测试、只读 report 脚本 | 检测与处置分离；报告不封禁 |
| 运维模板 | `deploy/` | `npm run test:ops` | 仓库模板不是 live 配置；应用前先对比 |
| 构建 | `npm run build`、`scripts/build-platform.mjs` | CI `build` job、startup budget | dirty 工作树制品不得冒充发布 |
| 原生包装 | `npm run desktop:pack` / `android:*` | `npm run test:native`、`.github/workflows/desktop-release.yml`、`android-release.yml` | Windows `NotSigned`；Android 长期证书 |
| 发布门禁 | `.github/workflows/ci.yml`、`release-gate.yml` | 工作流定义 | 本地检查通过 ≠ 已授权发布 |
| 受保护入口 | Skill `scripts/`、`docs/PROTECTED_RELEASE_ACCESS.md` | `test-protected-release-access.ps1 -Capability <目标>` | 能力预检不是部署授权 |

## Hotspots

高冲突文件包括 `src/styles.css`、`src/game/engine.ts`、`src/App.tsx` 和大型 E2E spec。避免无关格式化和顺手重构。不要把某一时刻的文件行数写成永久规则。

## 文档归属

- 已验证的现在时事实：`docs/PROJECT_STATUS.md`
- 稳定实现边界：`docs/ARCHITECTURE.md`
- 玩家可见不变量：`docs/GAMEPLAY_SYSTEMS.md`
- 操作步骤：`docs/DEPLOYMENT_OPERATIONS.md`
- 测试规模与发布记录：`docs/TESTING_RELEASE.md`、`docs/releases/`
- 未来工作：`docs/ROADMAP.md`
