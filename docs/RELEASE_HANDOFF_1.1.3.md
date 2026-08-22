# 1.1.3 Release Agent 交接

## 授权与目标

用户已授权将已完成的批量拉线、地热蓝图补足、Windows 云下载和蓝图窄屏布局修复作为 1.1.3 发布。默认目标为香港 Web/API、上海 Web/API、上海下载页、Windows stable、Android stable；不得将候选部分切换后宣称完整发布。

- previous-stable：1.1.2
- 运行时基线：`fe928b4a009a9c385237c0c4f0473fded241e113`
- 候选提交：由发布 Agent 在本交接文档提交后填写
- Release ID：`1.1.3-<12 位 clean SHA>`
- Build ID：`1.1.3+<12 位 clean SHA>`

## 交接制品

发布 Agent 必须从最终 clean checkout 生成并核验下列不可变目录/清单（路径中的 `<release-id>` 必须替换为实际值）：

- `artifacts/release-gates/<release-id>/development-handoff.json`
- `artifacts/release-bundles/<release-id>/web/`
- `artifacts/release-bundles/<release-id>/api/`
- `artifacts/release-bundles/<release-id>/native-update-feed/`
- `artifacts/release-bundles/<release-id>/download-site/`
- `artifacts/release-bundles/<release-id>/native-archive/`
- `artifacts/release-manifests/<release-id>-web.json`
- `artifacts/release-manifests/<release-id>-api.json`
- `artifacts/release-manifests/<release-id>-native.json`
- `artifacts/release-manifests/<release-id>-download-site.json`
- `artifacts/release-manifests/<release-id>-root.json`
- `artifacts/release-manifests/<release-id>-SHA256SUMS.txt`

清单必须记录每个文件的大小、SHA-256、组件 aggregate SHA-256、clean Git SHA 和构建门禁；不得把私钥、token、密码或玩家数据放进清单。

## 签名与发布门禁

1. 只使用已审核的受保护 Android 配置加载器，临时注入进程环境；不打印 vault 路径、alias、密码、keystore、证书内容或 SSH 细节。
2. Android 包必须通过 v2/v3、package/version、zipalign 和批准历史证书指纹连续性检查；Windows 按历史政策 `NotSigned`。
3. 连接香港/上海前先执行只读 protected-access preflight：当前/previous/canary 指针、systemd/proxy/timer、local/public health/ready、Nginx、磁盘和回滚边界。
4. 每个会写 API/数据库的目标，在切换前创建并独立验证 SQLite Backup API 快照/evidence（quick_check、schema/layout、SHA-256、磁盘低于保护阈值）；不删除 WAL/SHM、玩家数据或有效备份。
5. 使用新的不可变版本目录上传，远端复核 component manifests 后执行文档化原子切换；保留 1.1.2 previous-stable 和原 canary/rollback 指针。
6. 切换后分别验证 build/version/health/readiness、PWA/service-worker、缓存、完整下载哈希、Range、Android feed 和 Windows feed；全部目标通过后才写成功发布记录。

任一签名、备份、哈希、健康、空间、切换、smoke 或回滚门禁失败，立即记录 No-Go 和当前指针，不热改、不降级、不做部分发布。
