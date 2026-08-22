# 2026-08-22 下一批玩家反馈开发交接

## 状态与边界

- 角色：develop；本交接只包含本地代码、测试和文档，不包含 VPS、生产数据、玩家存档、下载页或发布切换。
- 隔离 worktree：`D:\GameDev\DSPidle2-next-feedback`。
- 基线：`f089088c48b91b471d3bb6a44ed2af83ea9d4cdc`。
- 运行时没有改动存档 schema、云端 payload 或数据库 layout；可以通过回滚本交接提交恢复旧行为。
- 当前候选尚未签名、上传或部署；`dist/` 仅为本地构建输出，发布 agent 必须重新按正式交接生成冻结制品和清单。

## 四项反馈的调查结论与修复

### 1. 批量拉线崩溃/内存峰值（P0/P1 性能稳定性）

根因是连续拉线每增加一条候选，就对累计请求重复执行完整 `GameState` 克隆和校验，导致大批量选择产生 O(n²) 的复制和内存峰值。现在连续预览使用一次隔离 draft，逐条在 draft 上校验/追加；最终确认仍调用 `connectBeltsAtomically()` 做完整、全有或全无复核。重复、非法、库存不足仍只拒绝本次候选，失败不污染原状态。

回归覆盖 10/50/100/500/1000 条请求、孤立 draft 追加、重复/非法/库存不足和原子失败无状态污染。

### 2. 地热发电站蓝图批量补足（P1 兼容性与 UX）

截图同时呈现“位置/行星/资源锚点不兼容”和库存为 0。地热站在没有地热资源的行星上被拒绝是既定规则，不能通过 UI 绕过。合法 `ashen` 行星上的 100 台地热站批量队列和一键补足已验证为原子成功；不兼容目标现在返回明确的“只能部署在有地热资源的行星”原因，库存不足/舰队不足也在按钮标题和施工卡片中给出可操作提示。

### 3. Windows 云存档下载 405（P1）

桌面绝对 HTTPS bridge 路径在普通云存档下载时没有显式传递 GET，旧 bridge/proxy 可能将缺省 method 解释为错误请求。现在 bridge 请求统一规范化 method（缺省为 GET），普通 cloud-save 下载显式走 GET；account archive 等其它传输方法保持原语义。浏览器相对 URL 路径不变。

### 4. 蓝图界面文字错位（P1 UI）

窄宽度双列卡片中标题列被 metadata 的 `auto/nowrap` 挤压，输入框会塌成竖条或与右侧文字重叠。标题列设置可用最小宽度，metadata 允许换行，输入增加省略处理；窄屏规则保持单列可读性。Playwright 在 760px、390px 和 1440px 场景覆盖几何与无横向溢出。

## 变更文件

- `src/App.tsx`
- `src/game/engine.ts`
- `src/game/batchBeltConnection.test.ts`
- `src/game/geothermalBlueprint.test.ts`
- `src/game/apiTransport.ts`
- `src/game/apiTransport.test.ts`
- `src/components/BlueprintWorkspace.tsx`
- `src/styles.css`
- `tests/e2e/game-flow-canvas-settings.spec.ts`
- `docs/ARCHITECTURE.md`

## 已通过的门禁

在隔离 worktree 执行：

```text
npm run typecheck -- --pretty false                         PASS
npm exec -- vitest run src/game/batchBeltConnection.test.ts src/game/apiTransport.test.ts src/game/geothermalBlueprint.test.ts src/game/engine.test.ts --reporter=dot
  4 files / 228 tests PASS
npm run test:native                                          24/24 PASS
npm exec -- playwright test tests/e2e/v127-selection-batch.spec.ts --grep "continuous connection mode previews|insufficient new tap|removing any candidate|final atomic revalidation" --project=chromium
  4 PASS
npm exec -- playwright test tests/e2e/game-flow-canvas-settings.spec.ts --grep "box selection copies, pastes, moves and upgrades a production blueprint|blueprint transforms, recipe parameters" --project=chromium
  2 PASS（包含 760px header geometry 断言；测试后恢复 1440px）
npm exec -- playwright test tests/e2e/v121-blueprint-construction.spec.ts --project=chromium
  4 PASS
npm run build
  Vite build PASS；startup budget PASS
```

Playwright 本地开发服务器会记录预期的 `127.0.0.1:65534` analytics/health proxy 连接拒绝和偶发 ResizeObserver warning；不影响上述断言。第一次未恢复 viewport 的调试运行曾在既有 box-select 后半段失败，已修正测试流程恢复 1440px，最终命令 2/2 通过。

## 未通过/未运行门禁

- `npm run test:server`：隔离环境没有安装/解析 `better-sqlite3`，涉及 SQLite 的 server integration tests 无法启动；另有基线中已有的 account-archive 错误码断言失败。
- `npm run test:ops`：同一 `better-sqlite3` 缺口阻断 backup/release-control 相关测试；另报告已有 `server/leaderboard-review-report.mjs` direct-invocation 列表不匹配。此次未修改 server/deploy 文件。
- 未运行真实 Windows 安装包、Android 真机、真实公网 API、VPS、签名和发布门禁；这些必须由 release agent 在独立候选上按项目交接执行。

## 交接与回滚

- 实现提交 SHA：见本文件所在开发提交及 agent 回报；发布 agent 应以提交后的精确 HEAD 和重新生成的 release manifest 为准，不使用旧 `dist/`。
- 回滚边界：回退本开发提交即可恢复旧客户端；没有数据库或存档迁移，因此不需要数据回滚。
- 已知风险：server/ops 完整门禁仍待具备 `better-sqlite3` 的云服务 release 环境复验；桌面真实 Electron 405 需要在打包应用和目标 API 节点做一次端到端下载 smoke。

