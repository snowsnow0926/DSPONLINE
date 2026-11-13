# Windows 本地存档空删除冲突修复

本批修复已随 1.3.12 全量发布。正式 Windows 包完成升级保档、冷启动及七项网络隔离冲突检查，公网安装包摘要和更新源验证通过，见[正式记录](../releases/1.3.12.md)。

2026-11-13 开发交接，角色为 develop。

## 范围与版本

| 字段 | 本轮结果 |
| --- | --- |
| 任务 | windows-local-save-conflict-20261113 |
| 优先级 | P1，玩家持续遇到存档冲突和接管入口不可用 |
| 来源 | 用户提供的玩家聊天记录与 `codex-clipboard-05679f31-0920-45df-8d89-406d9c1df3eb.png` |
| 用户补充 | Windows 客户端为最新发布版本，其他环境信息未知 |
| 开发基础 | 1.3.11，接续手机滚动修复与记录 `e2b63edd` / `ab9a5204` |
| 修复提交 | `a9eb3c6682e79b244b07c6974ecae884bb7964d7` |
| 分支 | `codex/mobile-scroll-canvas-controls-20261113` |
| 版本与 Build ID | 1.3.11，`1.3.11+a9eb3c6682e7` |
| 平台 | Windows Electron 与 Web |
| 兼容与数据保护 | GameState v47、envelope v2、IndexedDB v2；使用隔离浏览器、D 盘专用 Electron profile 和合成数据验证 |
| 交付 | 本地修复源码与平台构建，后续发布任务确定正式版本和发布目标 |

## 复现

附件显示当前持久状态为空，候选为删除请求。旧代码在已载入基线之后发现目标正文已经不存在时，把再次删除判为跨标签变化，创建 `candidateDeleted=true`、`persistedMissing=true` 且两个正文均不存在的冲突记录。重新启动会再次读取这些待处理元数据，进入 conflict 角色，继续阻止存档操作。

两个补丁前回归均失败。一项得到 `LocalSaveConflictError` 和空冲突记录，另一项在重启后继续得到 conflict 角色。玩家原设备的最初触发操作仍待回访确认，本地已复现附件中的同款状态和循环。

设置页仅允许 secondary 角色点击强制接管。处于 conflict 时，旧入口仍显示接管文字并被禁用，玩家难以从该位置进入版本选择。

## 实现与验收

- 当前 writer 仍持有有效 fence，且删除目标正文已经不存在时，以持久 revision 生成下一份 tombstone，完成幂等删除。
- writer 已失去 fence 时，空删除返回只读错误，页面可通过既有明确确认流程接管。
- 初始化、广播处理和冲突列表共用空删除判断。仅在两个空状态标记成立、两个副本 key 均不存在时排除该记录。原始元数据保留供审计。
- 存在实际正文、缺失正文的非空声明或元数据矛盾时，保留冲突。版本选择在写入前再次检查副本与标记，矛盾时返回明确错误并保留原文。
- 设置页在 conflict 状态提供可点击的“处理存档冲突”。点击后关闭运营中心并聚焦保留版本按钮。secondary 角色继续使用明确确认、推进 fence、保存和读回的接管流程。

验收覆盖历史空冲突后的新建工厂、空删除幂等、旧 writer 被接管后的拒写、用户确认接管、真实冲突双方保留、无效候选拒绝、选择后的逐字读回和重启恢复。

## 验证

| 检查 | 结果 |
| --- | --- |
| 完整 Vitest | 441 文件通过、16 文件跳过，3,968 项通过、38 项跳过，0 失败 |
| 早期相关单元 | 5 文件、53 项通过 |
| 存档协调最终覆盖 | 23 项通过，包含在完整 Chromium 内 |
| 完整 Chromium | 647 通过 / 34 条件跳过，0 失败、0 flaky，reporter errors 为空 |
| Windows 平台构建 | Rust release host、类型、Vite、启动预算、原生薄界面边界与覆盖检查通过 |
| Web 构建 | 类型、Vite、启动预算、原生薄界面边界与覆盖检查通过 |
| 实际 Electron 入口 | 最终 7 个检查点通过，0 页面异常 |
| 冻结文件 | Web 与 Windows 前端各 200 件，维护脚本逐件校验通过 |

Windows 验证使用实际 `desktop/main.cjs`、预加载桥和生产形态 Desktop 前端，profile 位于本轮 D 盘证据目录。先通过公开界面创建、暂停、保存并返回菜单，再加入两条历史空删除记录。连续三次重载后，主档逐字相同且两条原始元数据仍存在。接管有效的其他 writer 租约后，fence 增加，主档仍逐字相同。真实冲突通过设置页入口选择候选，逐字验证后冷启动仍读取同一正文。另检查提示条位于视口内，并用 Electron 原生 `capturePage()` 核对完整页面。

当前验收包含桌面主进程、IPC 桥和文件来源页面。安装器覆盖升级及玩家原机器回访属于后续验收。

## 文件与成品

运行源码涉及 `src/game/localSaveCoordination.ts`、`src/game/localSaveStore.ts` 和 `src/components/OperationsWorkspace.tsx`。回归位于 `src/game/localSaveCoordination.test.ts` 和 `tests/e2e/v140-local-save-coordination.spec.ts`。

工作树为 `D:/GameDev/Worktrees/DSPidle2/resource-use-mobile-cards-20261104`，证据目录为其下 `artifacts/windows-local-save-conflict-20261113/`。

| 证据 | 内容 |
| --- | --- |
| `baseline-e2e.json` / `.log` | 补丁前两个真实反例 |
| `full-unit.log` | 最终完整单元结果 |
| `full-clean-e2e.json` / `.log` | 完整网页回归 |
| `electron-native-capture-evidence.json` / 对应日志 | 最终真实 Electron 入口、7 检查点与页面异常结果 |
| `windows-native-conflict-choices.png` | 实际桌面版本选择与提示条 |
| `windows-native-cold-reopen.png` | 存档恢复后的冷启动 |
| `desktop-verified-manifest.json` | 最终 Windows 前端 200 件清单 |
| `web-manifest.json` | Web 前端 200 件清单 |

冻结载荷位于 `D:/GameDev/WorkArtifacts/DSPidle2/windows-save-conflict-20261113/`。

- `desktop-verified-dist-a9eb3c6682e7/` 的聚合 SHA-256 为 `292bdef2bc9d693901552bb8b8246cec7593ff3659a0a53ef25f779c81329eee`。
- `web-dist-a9eb3c6682e7/` 的聚合 SHA-256 为 `009f62819b052c3995a2d13e55c693dc90915794a477ccb24f547fcc7c3b8d4b`。

## 阶段问题与回退

首轮协调用例中，新增的设置入口测试在警告已经盖住头栏之后尝试点击设置，被警告拦截。测试调整为先打开设置，再触发冲突，保留按钮可点击、焦点和副本保全断言。

第一轮完整回归的追踪 HTML 写入仓库内，触发 Vite 重载并影响用例。该轮已停止，现场保留在外部证据目录的 `interrupted-watched-output/`，随后把全量追踪输出改到仓库外重新运行。

早期 Electron 驱动分别在待处理冲突中尝试进入工厂，以及在接管的延迟重载之前继续操作，两个驱动失败场景已保留。最终驱动按公开处理顺序执行并等待实际重载。原生截图另解决了 Playwright 在桌面缩放下的默认视口裁剪，最终记录采用 `webContents.capturePage()`。

本地源码可通过撤销修复提交回退。正式发布前使用新的发布版本、对应平台制品和发布检查。最近的正式发布记录为 [1.3.11](../releases/1.3.11.md)，前一批手机修复见[开发记录](./2026-11-13-mobile-scroll-canvas-status.md)。
