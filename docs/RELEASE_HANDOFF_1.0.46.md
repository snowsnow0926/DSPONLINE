# 1.0.46 Durable 存档热修开发交接

> 状态：开发候选，未发布；本交接不授权线上部署、回退或下载页修改。
> 分支：`codex/1.0.45-space-station`
> 目标版本：`1.0.46` / Android `1000046`

## Task ID / title

`DSPIDLE-1046-SAVE-RECOVERY`：durable 模拟暂停后无法恢复、纯挂机终态保存偶发要求刷新。

## 用户可见修复

- durable finalize、回执校验或模拟 Worker 异常后，页面保持安全暂停；点击“继续模拟”会在当前页面读取 recovery head 与 pending intent。
- recovery Worker 按原始检查点、journal、pending intent 顺序精确回放，先验证 T1 主存档，再原子建立新的 recovery head，最后重建模拟 Worker。
- pending intent 不会重复执行，未提交模拟时间不会被静默丢弃；恢复后 `data-runtime-recovery`、sequence、revision 和 Worker active 状态连续。
- 主存档检查点发现 revision/head 不一致时，默认保护模式会重新取得一次权威检查点并复核 T1，不再直接进入永久 disabled。
- 纯挂机停止、后台宽限和恢复日志提交后，即使普通模拟 Worker 已被回收，也会在当前页面重建并接管已验证终态。

## Compatibility / data preservation

- GameState v47、save envelope v2、cloud schema v8、SQLite layout v3、IndexedDB records/version 和 durable recovery record schema 均不变。
- 不清理、不覆盖旧 primary、backup、journal 或 pending intent；T1 写入失败时旧 recovery 仍是可恢复边界。
- 不读取或写入生产数据库、玩家附件、线上 symlink 或下载目录。

## Changed files

- `src/App.tsx`
- `src/i18n/releaseNotes.ts`
- `src/components/ReleaseNotesDialog.tsx`
- `src/components/ReleaseNotesDialog.test.ts`
- `tests/e2e/v144-runtime-wal-integration.spec.ts`
- 当前版本元数据：`package.json`、`package-lock.json`、`android/native-version.properties`
- 其余 E2E 固定夹具的当前 release-note id 更新为 `2026-08-17-v1.0.46`

## Required release gates

- `npm run typecheck`
- `npm test`
- durable finalize failure current-page recovery E2E
- runtime protocol / WAL integration E2E
- pure-idle start/stop/recovery E2E（含大档只读夹具时再执行 fixture gate）
- `npm run test:server`
- `npm run test:ops`
- `npm run test:native`
- `npm run licenses:check`
- `npm run build`
- production-preview PWA、空间站专项 E2E、全量 Chromium；Firefox/WebKit 按发布矩阵执行

## Current local evidence

- Typecheck：通过。
- Focused Vitest：3 files / 16 passed。
- Runtime protocol + WAL integration：8 passed / 3 fixture-skipped；新增 current-page durable finalize failure：通过。
- Full Vitest、production build 和全量发布门禁：交接前必须用最终 1.0.46 工作树重新执行，不能复用 1.0.45 历史数字。

## Native / release blockers

- Android 长期证书材料只允许发布会话在受保护环境注入；当前开发 shell 未注入签名变量，不能把 unsigned APK/AAB 交给 stable。
- Windows 现行公开策略为 `NotSigned`；发布会话必须保留该事实并重新生成 1.0.46 feed/hash。
- 必须从最终 clean commit 重建 Web/API/native 制品、manifest、SBOM/provenance，并由发布会话独立核验哈希、备份、健康检查和回滚指针。

## Rollback / handoff boundary

- 本开发会话不执行线上回退或发布；线上版本状态由用户指定的发布会话维护。
- 发布会话只接收 clean commit、不可变制品 manifest/hash、测试计数、签名证据和未验证缺口；缺任何一项即停止发布。
