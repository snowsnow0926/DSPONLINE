# 1.0.47 Release Agent 交接

> 状态：源码候选与本机开发门禁完成；无发布授权、无正式制品。
> Runtime Git SHA：`aab581cf0c78e480e1d10fe4c7f91e6d6d9311b7`
> Build ID：`1.0.47+aab581cf0c78`
> 分支：`codex/1.0.47-feedback-fixes`
> 隔离工作树：`D:/GameDev/DSPidle2-candidate-d64b9ef85f9d`

## Release scope

- 新增设备级“经典”基础卡片，恢复 1.0.43 的 `224×76` 精简卡结构。
- 修复画布拖动后 Canvas 传送带在后续重绘时与建筑错位。
- 修复连接活动期间建筑因既有聚焦模式偶发半透明。
- 发布说明与版本元数据更新至 1.0.47 / Android 1000047。

## Fixed compatibility boundary

| Boundary | Value |
| --- | --- |
| Product | 1.0.47 |
| Android metadata | 1.0.47 / 1000047 |
| GameState | v47, unchanged |
| Save envelope | v2, unchanged |
| Cloud schema | v8, unchanged |
| SQLite layout | v3, unchanged |
| IndexedDB records | unchanged |
| Runtime source | `aab581cf0c78e480e1d10fe4c7f91e6d6d9311b7` |
| Build ID | `1.0.47+aab581cf0c78` |

## Development evidence

| Gate | Result |
| --- | --- |
| Typecheck / production build | passed / passed |
| Vitest | 173 files passed / 7 skipped; 1,436 passed / 20 skipped |
| Server / station | 363 passed / 2 skipped; 3/3 |
| Ops / release switch / native | 56/6; 29/29; 24/24 |
| Full Chromium | 428 passed / 26 skipped / 0 failed (454 total, 11.4 minutes) |
| New feedback paths | Chromium dev 3/3; production preview 3/3; Firefox 3/3; WebKit 3/3 |
| Build budget | 1,962 modules; startup 194,865 B gzip; menu 283,652 B gzip; forbidden 0 |
| Supply chain | 125 runtime licenses; root/server production audit 0 |

完整波动记录：4-worker 两轮分别在不同既有用例初始 `.game-shell` 等待处发生一次本机资源性超时，两条目标复跑均通过；最终门禁改用 2-worker 稳定全量。Firefox 首轮在专项清理阶段出现一次 `NS_ERROR_FAILURE`，同用例隔离复跑通过。隔离 API 的 `127.0.0.1:65534` 连接拒绝与既有 ResizeObserver 日志均为预期测试诊断。

## Source areas

- 卡片策略与偏好：`src/game/canvasDensityPresentation.ts`、`src/game/uiPreferences.ts`
- 卡片渲染与设置：`src/components/FactoryNodes.tsx`、`src/components/OperationsWorkspace.tsx`、`src/App.tsx`
- 传送带视口同步：`src/components/CanvasBeltLayer.tsx`
- 连线期间聚焦展示：`src/App.tsx`、`src/styles.css`
- 发布说明：`src/i18n/releaseNotes.ts`、`src/components/ReleaseNotesDialog.tsx`
- 回归：`tests/e2e/v144-canvas-density-stack.spec.ts` 及对应 Vitest

## Explicitly absent

- 没有 Web/API release archive、manifest、SBOM 或 provenance 候选制品。
- 没有 Windows Setup、Android APK/AAB、正式签名或实体设备结果。
- 没有生产备份、Linux/Nginx 预检、原子切换、下载页、公开 smoke 或观察窗口结果。
- 没有读取玩家存档或访问生产数据库；没有修改主工作树或 `codex/1.1.0-runtimeworld-2` 工作树。

## Release agent procedure after authorization

1. 以 Runtime SHA 建立全新 clean worktree，确认版本、Build ID、锁文件和 `git diff --check`。
2. `npm ci` 与 `npm --prefix server ci` 后独立重跑发布门禁，构建 Web/API 和获批平台正式制品。
3. 生成并核对 manifest、SBOM、provenance、逐文件哈希；验证 Windows 签名策略、Android 长期证书连续性、versionCode、zipalign 和实体设备安装/升级。
4. 发布前重新读取 1.0.46 正式记录和线上 current/previous；对两地数据库分别创建隔离一致性快照并完成 quick_check、大小、SHA-256、容量和回滚预检。
5. 只在明确授权后按 release-control 原子切换；验证 health/ready、服务状态、重启数、真实云写读、PWA、静态资源、下载完整哈希、Range/cache 和公开浏览器旅程。
6. 观察期通过后再更新正式 `docs/releases/1.0.47.md`；任何签名、备份、回滚或公网证据缺失都应停止发布。

## Rollback boundary

当前生产仍为 1.0.46，本轮没有数据库迁移。代码回滚只切换不可变 release 目录，不得恢复、替换或降级生产数据库；真实 previous 指针和双节点状态必须在执行时重新核对。
