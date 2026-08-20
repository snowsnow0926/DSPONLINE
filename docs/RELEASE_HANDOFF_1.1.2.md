# Release Agent 交接：1.1.2 本地存档误报修复

## 当前状态

这是已完成开发验证的 1.1.2 候选，不是发布授权，也不是生产成功记录。用户后续明确授权发布后，Release Agent 才能继续。

- Runtime SHA：`48d70aa5de065704d7360683f5be8cabd5c7c2e6`
- Build ID：`1.1.2+48d70aa5de06`
- Android versionCode：`1001002`
- 上一稳定运行时：1.1.1 `da53958b860c6e2d26f0a9ab18d36f5f48ee12c1`
- 变更报告：[DEVELOPMENT_REPORT_1.1.2.md](./DEVELOPMENT_REPORT_1.1.2.md)
- 根因证据：[2026-08-21-1.1.2-local-save-false-conflict.md](./feedback/2026-08-21-1.1.2-local-save-false-conflict.md)
- 候选记录：[1.1.2-candidate.md](./releases/1.1.2-candidate.md)

## 交接给发布角色的必做项

1. 在独立 clean checkout 固定 Runtime SHA；确认工作区无未提交改动，并重新运行 typecheck、Vitest、server、ops、native、Playwright 及 build/budget。
2. 从该 checkout 生成不可变 Web/API、Windows 和 Android 制品；生成 component manifest、source provenance、SHA256SUMS 和 release manifest。不得重用旧 1.1.1 制品。
3. Android 只能通过现有受保护签名加载器注入批准长期签名材料；验证 APK/AAB v2/v3、包名、versionCode 和历史证书连续性。不得输出或写入 keystore、密码、token 或证书私密材料。Windows 没有证书时标注 `NotSigned`，不创建证书。
4. 香港、上海和下载页在任何 API/data mutation 前分别完成新鲜 SQLite Backup API snapshot、外部 SHA-256、`quick_check`、schema/layout 和磁盘阈值证据；保留 current/previous/canary、WAL/SHM 与回滚指针。
5. 仅使用新不可变目录和文档化原子切换；依次验收 API health/ready、active writer、Nginx、PWA/service worker/cache、完整下载 SHA、Range、Android/Windows feed 和回滚状态。任一门禁失败立即停止该目标，不热改、不删备份、不回滚数据库。

## 本候选已知证据

- Vitest：190 files，1,514 passed / 29 skipped。
- Server：363 passed / 2 skipped；station：3/3。
- Ops：56 passed / 6 Linux-only skipped。
- Native：24/24。
- Chromium 专项：50 passed / 1 skipped；真实用户附件 fixture：1/1 passed。
- Build budget：startup JS 102,319 B gzip、complete menu 286,650 B gzip，均低于既有预算；未提高限制。

## 安全与数据边界

附件 `dsp-idle-local-backup (1).json` 只读使用，SHA-256 为 `c6247115318bc0691fc0f0aa823f5723cc994a6d71c3b28d3c92b6a173d288ab`；未上传生产、未写回本地附件、未打印正文。开发过程没有访问 VPS 或任何生产账号。
