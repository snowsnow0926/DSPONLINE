# 1.1.7 Release Agent 交接

状态：候选待发布。请把本文与 `docs/releases/1.1.7-candidate.md`、`docs/DEVELOPMENT_REPORT_1.1.7.md` 一起带入独立 clean checkout；不要从 dirty 工作树直接切换线上。

## 交接对象

- 分支：`codex/1.1.7-contract-mod`
- 工作树：`D:\GameDev\DSPidle2-v117-development`
- 基线：1.1.6 `4f6d24f`
- 目标：1.1.7 / Android versionCode `1001007`
- 当前生产：1.1.5；正在发布的 1.1.6 工作树不得合并或重写。
- 候选提交：以 `git rev-parse HEAD` 为准；候选 manifest 的 `git.sha` 必须与之相同。

## 发布内容

1. 空间站合同重复 ID 修复：客户端迁移保护 settled rewards，服务端保留窄兼容边界并拒绝伪造碰撞。
2. v47 sparse cloud upload compatibility：缺失的默认 `quantumMode` 按 `legacy` 解析，显式非法值仍拒绝。
3. 内容包自定义建筑动态托盘：桌面/移动共用目录；有效成本才可部署；`belts` 与普通 `splitter` 语义分离。

## 开发侧已交付制品

在候选提交上已完成并复验以下交接物（`<release-id>` 为提交短 SHA 组成的候选 ID）：

- `artifacts/release-bundle/<release-id>/`：Web、API、source 和 Windows unsigned-unpacked 压缩包，以及 source-gate、gate-report、SBOM。
- `artifacts/release-manifests/<release-id>-candidate.json`：8 个候选文件的大小、SHA-256 和 aggregate hash。
- `artifacts/release-gate/<release-id>-provenance.intoto.json`：3 个 subject，已通过 `verify-provenance`。
- `artifacts/release-manifests/<release-id>-SHA256SUMS.txt`：候选包及全部交接元数据的可重复校验清单。
- `dist/version.json`：由最终 Web build 生成，版本和 buildId 必须与候选 manifest 对齐。

开发侧验收计数：full Vitest 1,468 通过/21 跳过；server 核心 376 通过/2 跳过、station 4/4；ops 56/6；native 25/25；full Chromium 428/26；根目录及 server production audit 均为 0 vulnerabilities。

## Release Agent 必做门禁

在 clean checkout、精确最终 commit 上依次执行：

```powershell
npm ci
npm --prefix server ci
npm run licenses:check
npm run typecheck
npm test
npm run test:server
npm run test:ops
npm run test:native
npm run build
npm run test:e2e
```

随后生成并复验 source/candidate/API/Web manifest、SHA256SUMS、SBOM、provenance 和 version consistency；按既有策略执行 desktop/Android 制品门禁。真实 Linux、两地数据库备份副本、preflight、原子切换、健康/ready、下载 Range/完整哈希、PWA 和观察期是发布必需条件。

## 安全边界

- 不在玩家上传文件上直接原地写回；如需提供修复后的副本，先保留原文件并让客户端迁移生成新 envelope。
- 不把玩家存档正文、账号、token、生产 SQLite 或签名凭据写入 manifest、日志或交接文档。
- 不放宽服务端合同校验到“任意重复 ID”；只允许 settled fence + exact identity 的历史兼容形状。
- 不把 `kind: "splitter"` 宣称为真正 belt；新增 belt 必须经过 `belts` 目录的唯一 tier、速度、成本和升级校验。

## Rollback

发布前任何门禁失败都保持 1.1.6/1.1.5 current 不变，作废本候选制品并保留审计文件。发布后若出现云上传、合同奖励或 Mod 存档异常，按既有不可变目录回滚到上一稳定 release；数据库不做反向数据改写。回滚后仍需验证旧客户端读取既有 v47 存档。
