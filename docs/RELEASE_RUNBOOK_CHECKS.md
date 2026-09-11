# 发布运行手册核对清单（RELEASE RUNBOOK CHECKS）

> 目标：让每次稳定发布（如 `1.0.45+`）在**半小时内可重复、可验证地完成**，减少不必要的返工与故障时长。
> 适用：香港 Web/API、上海 Web/API、上海下载页、Windows/Android stable 的全量发布。
> 本文件是执行的核对清单；命令模板/拓扑细节见《部署与运维手册 `docs/DEPLOYMENT_OPERATIONS.md`》。版本现状以 `docs/releases/<ver>.md` 与 `docs/PROJECT_STATUS.md` 为准。

## 0. 状态记录约定（本次 1.0.44 最重要的经验）

- **一切「完成」都必须有可落盘、可回读的产物**，不能只看一次终端回显。
- 每次发布在仓库外建立证据目录（示例）：
  `artifacts/release-ops/<releaseId>/`，其中存放：
  - 双节点只读快照（指针/服务/磁盘/evidence）
  - 备份 evidence 与 preflight evidence JSON（在服务器 `release-state/`）
  - 远端 manifest 复算日志（web/api/download-site）
  - 公网 HTTP 状态 + 缓存/Range 头记录
  - 切换前后 generation / current / previous / proxy 指针记录
  - `RESUME_STATE.md`（一旦中断可无缝续跑）
- 文档改动（`docs/*.md`）**写入后必须重新读回确认（如 `grep`）才记为“成功”**，避免编辑工具报成功但未落盘（1.0.44 曾遇此坑）。

## 1. 前置自检（发布前，一次性完成，<10 分钟）

### 1.1 香港单节点快速路径

当用户明确只要求香港 Web 或香港 Web/API 时，先在候选工作树运行本地不可变预检和
目标计划，再连接服务器：

```powershell
npm run release:preflight -- --manifest <candidate.json> --sha-sums <SHA256SUMS.txt>
npm run release:plan -- --manifest <candidate.json> --target hk-web-api
```

Web-only 使用 `--target hk-web`，不创建 SQLite 快照；Web/API 仍必须按第 3 节完成一次
独立 Backup API evidence。归档统一用
`.codex/skills/develop-dspidle/scripts/invoke-protected-release-upload.ps1` 的 SSH
流式上传，远端整文件哈希验证通过后才提升到新不可变文件名。SCP 只能显式 `-Transport
Auto` 回退；该入口不切 `current`。HK-only 路径不等待上海、下载页或原生制品，也不
改变这些目标的 current/previous；第 2、5、6 节仍完整执行香港自己的健康、dry-run、
原子切换、PWA/cache、Range 和回滚验收。

- [ ] 确定发布候选：`Git SHA`、`Release ID`、`Build ID`（示例 `3e580c715a5a / 1.0.44-3e580c715a5a / 1.0.44+3e580c715a5a`）。
- [ ] 确认候选工作树干净；确认候选制品 bundle + 各 sub-manifest（web/api/desktop/native-feed/download-site/native-archive）齐全。
- [ ] 探明并记录**两个节点的确切可达信息**（勿临时补救）：
  - 香港：`43.129.249.102` Key；`-o StrictHostKeyChecking=yes -o BindAddress=<物理IP>`。
  - 上海：`111.229.128.211`（alias `refidle-shanghai`）。
  - 物理出口 IP：从有默认网关、非 `198.18.*` 的网卡取（示例 `192.168.0.210`）。
- [ ] 双方 `ssh <host> "hostname"` 往返一次均通，并核对 host-key 指纹（不弱化 TLS/host-key）。
- [ ] 确认**本轮不触碰**的边界：不改游戏源码/测试/候选制品；不删 live DB、WAL、SHM、有效备份、rollback 指针、COS 归档。
- [ ] 记忆依赖：**下载节点是上海**（`download.dsponline.cn`→`111.229.128.211`），勿 resolve 到香港 IP。

## 2. 只读状态基线（双节点，发布前必做）

在每个节点执行并**落盘**只读快照，核对这些字段：
- 版本指针：`readlink -f /var/www/dsp-idle/current`、`/opt/dsp-idle-cloud/current`、`/var/www/dsp-idle-downloads/current`
- 状态机：`switch-state.json`（generation/current/previous/slot/port）、`api-proxy.json`、`pending-switch.json`（应为空）
- 服务：`dsp-idle-api-active.service`、`dsp-idle-api-handoff-proxy.service`、两个 health timer、node-health `ok=true`
- 本机 health/ready（`127.0.0.1:4330/api/health|ready`）+ 公网 health/ready + 根页 `version.json` Build ID
- 磁盘：`df -h /`（应远离 90%；若逼近需先报告 No-Go）
- 监听归属：`ss -ltnp` 上 4321/4322/4330
- `NRestarts`、`MainPID`、node-health 磁盘余量

> 关键：任何「读不到/漂移」都先停手审计，不凭旧文档盲目继续。

## 3. 备份与证据（切换前强制）

- [ ] 用 SQLite Backup API（`sqlite-snapshot.mjs` 的 `backupSqlite`）创建**本地**一致性快照到 `backups/manual-pre-<rel>.sqlite`。
- [ ] 生成备份 evidence（`release-backup-evidence.mjs --database <snap> --output <evid>`）。
  - 注意：Backup API 产物可能带 `-shm/-wal` 侧车；若 `assertNoActiveSqliteSidecars` 拒绝，可对快照置 `PRAGMA journal_mode=DELETE` 后重验（对备份副本安全，勿动 live DB）。
- [ ] 大库（>512 MiB 且无 reflink）须再生成 **preflight evidence**（`--prepare-preflight --source-evidence ... --bytes-per-second <有界>`）；小库可让 switch 走 boundedCopy。
- [ ] evidence 三个值必须为：`quickCheck=ok`、`schemaVersion=7`、`storageLayoutVersion=2`。
- [ ] 切换完成后删除**disposable 预置副本**（`release-preflight/` 下本版对象），**保留** verified 备份/evidence/COS。

## 4. 上传与远端复算（每个组件、每个节点）

- [ ] 把 web/api/download-site bundle 打成 tarball 上传到目标节点（避免逐文件）。
- [ ] 解压到**新版本目录**（如 `/var/www/dsp-idle/releases/web-1.0.44-3e580c715a5a`、`/opt/dsp-idle-cloud/releases/api-1.0.44-...`、`/var/www/dsp-idle-downloads/releases/download-site-1.0.44-...`）。
- [ ] API 目录执行 `npm ci --omit=dev` 并核对 `better-sqlite3` / ses SDK 可加载。
- [ ] **远端复算 manifest**（对每个文件 sha256+size 比对，再算 aggregate）必须 148/148、162/162、9/9 全 match。

## 5. 原子切换（双节点）

- [ ] 先 `--dry-run`（应 `noOp:false`、给出目标 slot、不改任何状态），通过后再 real。
- [ ] real switch：`sudo dsp-idle-switch-release --web-release web-<rel> --api-release api-<rel> --backup-evidence <evid> --preflight-evidence <pevid>`（大库必带 preflight）。
- [ ] 切后核对：新 generation、current Web/API 版本路径、slot/port、previous（回滚目标）、proxy generation forward 到新 slot、`pending-switch` 为空、API `NRestarts=0`。
- [ ] 下载页（上海）：同样先复算 manifest，再 `ln -sfn` 原子切 `current`，并写 `previous-download-release`（root）为旧目录。

## 6. 公网与缓存验证

- [ ] 逐项 HTTP 200：`/`、`/version.json`、`/api/health`、`/api/ready`、`/sw.js`、`/manifest.webmanifest`、至少一个 hashed asset。
- [ ] `version.json` 内容 = 预期 Build ID。
- [ ] 缓存头：入口 `no-cache,no-store`；hashed asset `public,max-age=31536000,immutable`；`Range` 请求返回 `206`。
- [ ] 下载页（`https://download.dsponline.cn`）：`/`、`/version.json`、`/downloads/android/stable.json`、`/downloads/desktop/stable/latest.yml`、APK、EXE 全 200；核对 `versionName/versionCode`、APK sha256、EXE size/sha512。
- [ ] node-health 复跑后 `ok=true`（大库切换瞬间可能有一次瞬时失败，随后必须自愈，勿当故障掩盖）。

## 7. 回滚与记录

- [ ] 记录 previous / rollback 指针（Web/API 各自、下载页单独）。
- [ ] 全部目标成功**且**验证后，才写 `docs/releases/<ver>.md`（用固定模板：结论/各节点状态/指针/evidence/公网验证/回滚/残余风险）。
- [ ] 更新 `docs/PROJECT_STATUS.md` 的“当前生产与开发基线”与“香港 Web current”两处；`docs/DEPLOYMENT_OPERATIONS.md` 追加/更新“当前生产状态（<ver>）”。**每个文档改后 `grep`/`cat` 回读确认。**
- [ ] `git add` 这些**实际有改动**的文档 → `git commit` → `git log --oneline -1` 确认 HEAD 变化 + `git status` 干净。若某文件编辑不落盘，公开说明、不强行覆盖。

## 8. 已知易踩点（来自 1.0.44 复盘）

- 输出通道/回显可能不可靠：把关键结果**写文件+回读**，不裸信一次回显。
- 大库全量校验（Node/quick_check 经 COSFS）很慢且占盘：切换关键路径只复核身份/元数据，full `sha256sum` 在快照/预置阶段用本地副本完成。
- 每次发布预留 `RESUME_STATE.md`；一旦中断按它续跑，别从头再来。
- 不要在同一关键时刻并行发多个依赖同一结果的写命令（易造成无法归因）。

## 9. 测试运行与并行优化（2026-08-17 起生效）

为把“每次全量测试 20+ 分钟”压缩到可接受范围，以下改动已合入仓库（见 `package.json`、`server/package.json`、`playwright.config.ts`、`.github/workflows/ci.yml`、`scripts/run-changed-tests.mjs`）。

### 9.1 并行策略

| 套件 | 之前 | 现在 | 说明 |
| --- | --- | --- | --- |
| `test:e2e` | `--workers=1`（完全串行） | config 默认：本地 4 / CI 2（`DSP_E2E_WORKERS` 可覆盖） | `fullyParallel: false` 保证单文件内串行；不同文件跨 worker 并行 |
| `test:server` | `--test-concurrency=1` | `--test-concurrency=4` | 集成测试均 `mkdtemp` + `listen(0)` 随机端口，隔离充分 |
| `test:ops` | `--test-concurrency=1` | `--test-concurrency=2` | 多数用临时目录；保守 2 并发 |
| `test`（Vitest） | `maxWorkers: 1` | 本地保持 1；**CI `unit` job 试跑 `--maxWorkers=4`** | Windows 大确定性套件在 V8 fork 并行下会内存崩溃（本地保守）；CI Ubuntu 试跑通过后固化为“CI 并行 / 本地保守”，失败则回退 1 |
| CI `ci.yml` | 单 job 顺序执行 | 拆成 `unit` / `server-ops-native` / `build` / `e2e-shard-1` / `e2e-shard-2` / `e2e-report` 并行 job | 总墙钟从“和”变为“最大值” |
| CI Playwright 浏览器 | 每次现装 | `actions/cache` 缓存 `~/.cache/ms-playwright`（key 随 package-lock） | 每次 CI 省 1–3 分钟浏览器下载 |
| CI E2E | 单 job | `--shard=1/2` 与 `2/2` 双 job 并行 | E2E 墙钟再减半；每 shard 独立上传 JSON 报告 |

### 9.2 新增 npm scripts（开发体验）

| 脚本 | 用途 |
| --- | --- |
| `npm run test:quick` | typecheck + server 并行 + ops 并行；日常改动后快速回归，不跑重 E2E/全量 Vitest |
| `npm run test:unit:fast` | `vitest run --maxWorkers=4`；**仅推荐 Linux/CI**，Windows 可能触发大套件内存崩溃 |
| `npm run test:changed` | 增量测试：只跑本次 Git 改动中实际被修改的测试文件（见 `scripts/run-changed-tests.mjs`）；只改源码时请改用 `test:quick` |
| `npm run test:e2e:fast` | 只跑关键 E2E（cloud/save/offline/idle/PWA/leaderboard），与发布门禁关键子集一致 |
| `npm run test:report:slowest` | 解析 `test-results/playwright-report.json` 输出最慢测试 TOP（默认 20，可 `--limit N`；支持多份 shard 报告合并） |

### 9.3 可观测性

- Playwright reporter 已从 `list` 升级为 `list + html + json`：
  - HTML 报告：`playwright-report/`（失败/耗时/轨迹可视化）
  - JSON 报告：`test-results/playwright-report.json`（`scripts/report-slowest-tests.mjs` 按 `duration` 排序）
- CI 的 `e2e-shard-*` job 分别打印本 shard 最慢 10 个测试并上传 JSON；`e2e-report` job 合并两份 JSON 输出全局 TOP 20，持续定位热点。
- 后续定位热点：`game-flow.spec.ts`（105 个 test / 357KB）**已完成机械拆分**为 6 个功能域 spec（验证 104/105 全量 + 1 项并行偶发超时串行复跑通过），见 [game-flow-spec-split-analysis.md](./game-flow-spec-split-analysis.md)；剩余瓶颈候选为 `v144-runtime-protocol.spec.ts`、`v144-runtime-recovery-store.spec.ts` 等单文件串行大户。

### 9.4 注意事项

- **发布门禁 `release-gate.yml` 保持全量串行**，不做并行化，保证确定性证据链。
- Vitest CI 并行（`--maxWorkers=4`）处于**试跑观察期**：如 CI 出现 OOM/不稳定，按文档回退 `--maxWorkers=1` 再固化结论。
- 本优化不改任何测试逻辑/断言；只改运行编排。若并行后出现偶发失败，请先确认是否为共享资源（固定路径/端口）导致，再决定降级并发。
