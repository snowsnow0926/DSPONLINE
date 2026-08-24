# Release Agent 交接：1.1.6 纯挂机高倍率修复

## 当前状态

`development-sealed / production-not-switched`。本交接只固定开发运行时提交，不代表线上已经有 1.1.6，也不授权生产上传或切换。

- 基线：线上 1.1.5，Git `63149cc`。
- 运行时修复提交：`137be4db256da1898ecf7e1e171e145f0dbc0c8f`（clean）。
- 开发工作树：`D:\GameDev\DSPidle2-1.1.6-pure-idle`。
- 目标版本标签：1.1.6；当前源码 `package.json`/Android 元数据仍为 1.1.5，必须在独立版本封装提交中同步提升并重新验证。
- 目标 previous-stable：1.1.5（仅为未来发布计划，当前线上事实仍以 1.1.5 为准）。

## 交付内容

修复超大终局存档进入保守纯挂机后生产被冻结的问题：1 秒精确校准、80% 白名单累计速率合同、高倍率时间/科研推进、有限资源边界保护、禁止长尾精确回放、整数饱和隔离和分段余数一致性。详细证据见 [开发报告](./DEVELOPMENT_REPORT_1.1.6.md)。

## Release Agent 必须先做的工作

1. 在独立 clean checkout 固定运行时提交，完成版本封装（Web/API/Desktop/Android 的版本号、release notes、Build ID 和 Android 递增 versionCode 一致）。不得把文档提交 SHA 当作 runtime SHA。
2. 从封装后的 clean SHA 重新跑 typecheck、完整 Vitest、server/station、ops、native、完整 Playwright、build/startup budget 和 release manifest/provenance/SHA256SUMS；任何失败立即停止。
3. Android 只能通过已批准的受保护加载器临时注入 SDK/长期签名配置，验证 APK/AAB v2/v3、zipalign、包名、versionCode 和历史证书连续性；不得输出或复制 keystore、口令、alias、证书内容。Windows 继续按历史策略标记 `NotSigned`，不得创建替代证书。
4. 生产发布如获单独明确授权，按 `docs/DEPLOYMENT_OPERATIONS.md` 对香港、上海、下载页分别只读预检；API/data mutation 前先生成并验证 SQLite Backup API evidence，磁盘低于 90%，保留 current/previous/canary/rollback、DB/WAL/SHM。
5. 只上传冻结不可变 bundle，远端复核清单后再按 release-control 原子切换；分别验收 health/ready、PWA/cache、下载完整哈希与 Range、Windows/Android feed 和回滚指针。失败不得做部分发布或宣称成功。

## 禁止事项

- 不得使用用户真实存档作为生产写入 smoke，不得上传或覆盖玩家云档。
- 不得热改服务器源码、数据库、排行榜、WAL/SHM 或删除有效备份/回滚目录。
- 不得用未签名 Android 包进入 stable，也不得绕过 host-key/TLS/manifest/备份门禁。

## 开发验收摘要

- Vitest 1,461 passed / 21 skipped；server 376 passed / 2 skipped；station 3/3。
- Ops 56 passed / 6 Linux-only skipped；native 25/25；纯挂机 Chromium 套件 17/17；build/startup budget PASS。
- 用户 gzip 终局夹具 30 天、15x、源 SHA 不变且终局累计产出增长。

没有生成或冻结 Web/API/native/download-site 制品，本交接不能单独触发发布。
