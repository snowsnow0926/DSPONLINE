# Release Agent 交接：1.1.5

## 固定候选

- 运行时提交：`a92c0d3157f3658523d8d4abbbb0ae654dc4fc35`（clean）。
- Release ID：`1.1.5-a92c0d3157f3`。
- Build ID：`1.1.5+a92c0d3157f3`。
- Android：`versionName=1.1.5`，`versionCode=1001005`。
- 隔离候选：`D:\GameDev\DSPidle2-v115-release-candidate`。
- bundle：`D:\GameDev\DSPidle2-v115-release-candidate\artifacts\release-bundle\1.1.5-a92c0d3157f3`。
- candidate manifest：`D:\GameDev\DSPidle2-v115-release-candidate\artifacts\release-manifests\1.1.5-a92c0d3157f3-candidate.json`。
- SHA256SUMS：`D:\GameDev\DSPidle2-v115-release-candidate\artifacts\release-manifests\1.1.5-a92c0d3157f3-SHA256SUMS.txt`。

用户已授权完成 1.1.5 开发后切换角色并执行正式发布。正常完整目标为香港 Web/API、上海 Web/API、上海下载页、Windows stable 与 Android stable；全量成功后将 1.1.4 设为 previous-stable。不得把文档提交 SHA 当作运行时候选，也不得从开发工作树临时重建替换冻结 Web/API。

## 版本内容

- 70+ MiB 存档低峰值保存：Worker 内 gzip、canonical envelope 有界检查、v47 精确默认值稀疏化。
- `.json.gz` 导入/导出和 Android 受限二进制分享；解压后 256 MiB 硬上限。
- 超大终局档纯挂机自动进入保守宏观路径，真实夹具 30 天结算可重载且约 8.27 秒完成。
- 银河综合榜采用五个公开指标等权对数计分 `balanced-log-v2`，去除隐藏探索/殖民加分。
- 延迟 Worker 快照不再让同一生产周期的视觉进度倒退。

完整实现、风险和数字见 [开发报告](./DEVELOPMENT_REPORT_1.1.5.md)。

## 开发门禁

- Vitest：178 passed files / 8 skipped；1,457 passed tests / 21 skipped。
- server：376 passed / 2 optional skipped；station 3/3。
- native tools：25/25；ops：56 passed / 6 Linux-only skipped。
- Chromium E2E：427 passed / 26 conditional skipped / 0 failed。
- production-preview PWA 1/1；durable recovery 7/7；release switch 29/29。
- root/server production audit 均 0 vulnerability；licenses 125 current。
- production build：startup gzip 194,912 B、menu 284,823 B、forbidden startup modules 0。
- 768 MiB renderer 大存档导入、连续 autosave、manual save、backup readback、reload 全通过。
- 真实大存档 30 天纯挂机完成并保持源夹具 SHA 不变。

Android JVM/签名门禁必须在 release 角色通过受保护加载器重跑；不得输出或持久化加载器位置、keystore、alias、口令、证书材料或 SSH 定位信息。Windows 延续历史 `NotSigned` 策略，不创建新证书。

## 冻结制品校验

source manifest 为 261/261，aggregate `1d4e0ae07c3ecafb04a87825ce8a3963b9ab7612a03217bfa045073f2f2563dc`；candidate manifest 为 8/8，aggregate `429b2f57608f96f77f47f4a8015dc94ef68e161ff4fa77c3b4fad227ce7cf8e1`；provenance 3/3、SHA256SUMS 10/10。Web/API/source/Windows tar 均完整读取，source 可重复生成。

| 制品 | 字节 | SHA-256 |
| --- | ---: | --- |
| `1.1.5-a92c0d3157f3-web.tar.gz` | 1,755,794 | `f1f0958134cb875c3eb645ce51d9256bc6fff1e91aec5479284987efbea18b5d` |
| `1.1.5-a92c0d3157f3-api.tar.gz` | 690,119 | `7328bb8b1cdee03fd3a1cda8405248a6b85d49d7a1be8b00d34bb1ea667843c2` |
| `1.1.5-a92c0d3157f3-source.tar.gz` | 6,800,639 | `b456674cbb05e97fe045031fff4ef368819b1dd798f87bc2efc23e4fa552701f` |
| `1.1.5-a92c0d3157f3-windows-unsigned-unpacked.tar.gz` | 150,442,878 | `70fab3b92e78325233dfeb366b39d2b38572c384eb46f46f836584f467d6b272` |

## Release Agent 必须执行

1. 在候选目录再次核验 SHA256SUMS、candidate manifest、provenance、Git SHA 与 clean 状态；禁止覆盖冻结制品。
2. 使用批准的受保护配置瞬时注入 Android SDK/签名环境，重跑 JVM 测试与 signed APK/AAB；验证包名、版本、zipalign、v2/v3 与历史证书连续性。实体设备未通过且没有针对本候选的明确豁免时停止。
3. 从正式 Windows installer 和 signed Android 生成 stable feeds，组装下载站并分别生成 component manifests；Windows 必须明确 `NotSigned`。
4. 按 `docs/DEPLOYMENT_OPERATIONS.md` 对香港、上海做只读预检。API/data-affecting 变更前分别生成并验证 SQLite Backup API evidence，磁盘不得达到 90%。
5. 只向新的不可变版本目录上传冻结内容，远端逐文件验 manifest；API 展开后安装 production dependencies 并以临时数据库 smoke。
6. 使用文档化 release-control 原子切换；保留 current/previous/rollback/canary、数据库/WAL/SHM 和全部有效备份。数据库不随代码回滚。
7. 独立验收两地 version/build/health/ready、PWA/service worker/cache、下载 HEAD/Range/完整 SHA、Windows feed/installer、Android feed/APK/AAB 签名。
8. 所有目标均成功后才将 1.1.4 设为 previous-stable并写成功记录；任一备份、磁盘、哈希、签名、健康、缓存或下载门禁失败即停止相应切换并回滚代码指针，不能写完整成功。

## 明确禁止

- 不得热改服务器源码、数据库或玩家存档。
- 不得删除数据库/WAL/SHM、有效备份、current/previous/canary/rollback 目录。
- 不得绕过 SSH host-key、TLS、签名或 manifest 验证。
- 不得上传 unsigned Android 包，也不得创建新 Android 证书。
- 不得用生产账号做写入 smoke，或把真实玩家存档作为生产 payload。
