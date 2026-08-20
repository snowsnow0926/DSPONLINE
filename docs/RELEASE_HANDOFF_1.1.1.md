# DSP极简网络 1.1.1 Release Agent 交接

> 交接状态：开发完成，未发布
>
> Runtime SHA：`a2d64acf1845ad912a9c19c6781b05801d8685e1`
>
> Build ID：`1.1.1+a2d64acf1845`
>
> Release ID：`1.1.1-a2d64acf1845`
>
> 分支：`codex/1.1.1-cloud-upload-p0`
>
> 开发工作树：`D:\GameDev\DSPidle2-v111-cloud-upload-p0`

本文件是开发交接，不授权生产连接、部署、签名、上传、stable/下载页切换或玩家数据修改。Release Agent 必须等待用户明确发布授权，并从固定 runtime SHA 独立复验。

## 1. 发布范围

1. 修复 1.1.0 同任务日已结算空间站合同被重复生成，进而被 API 判为云存档格式无效。
2. 客户端加载时无损过滤重复报价；服务端只兼容“合同身份完全一致 + settledIds 已防重”的精确遗留正文。
3. 修复纯挂机停止、生命周期 cleanup 或长页面停顿后，同一页面保存被误判为跨标签页覆盖。
4. 保留真正其他标签页接管、stale fence、损坏 proof/catalog/revision 时的硬冲突保护。
5. 版本升级为 1.1.1 / Android 1001001；数据格式不升级。

完整根因、附件证据与测试矩阵见 [开发报告](./DEVELOPMENT_REPORT_1.1.1.md)。

## 2. 固定候选与清单

Artifact root：`D:\GameDev\DSPidle2-v111-cloud-upload-p0\artifacts\release-bundle\1.1.1-a2d64acf1845`

| 制品 | bytes | SHA-256 |
| --- | ---: | --- |
| source archive | 6,869,373 | `5aec84f1c3c2525974930b80980b0f146d8dbbfab9cfcb2df9cc60175353e20a` |
| Web archive | 1,797,753 | `1969926399ffdcea0a050181bac6e3b670cfb2e613ca7ba159aba02fb6a9942d` |
| API archive | 670,289 | `b6b95fc1ff4b921ed20b5c0565dce66e426b024d6d1adc04f0222635bb4ca2d9` |
| source manifest copy | 43,214 | `35ee23b51aad853e3e5c5fb39f1efcaff5dfe0d3ff5931e20dc18674d33d5e71` |
| source gate | 176 | `fd3f6ab1f2aeaa4f5aaf10e9764036542111537a06727ec3d9ca839690202747` |
| CycloneDX SBOM | 407,390 | `e64cd68b1d916f1b04aaabecaadeae20f698a39016e72e5841df7d1e8b09c738` |
| conditional skip report | 6,702 | `f34419e52e7ee87976fbdc32ca2234cc0996d03707de5dca8d5f93c39a5e83cf` |

辅助元数据：

- `artifacts/release-manifests/1.1.1-a2d64acf1845.json`：source 254/254，aggregate `918c601f897fcb218f5ee99dfa96debf7d5fd808643046d5eb8e058a85467274`。
- `artifacts/release-manifests/1.1.1-a2d64acf1845-web.json`：Web 158/158，aggregate `31e8db4196d91453172308b622cca21b2bbf2536aa8578d12f59903ca288dc69`。
- `artifacts/release-manifests/1.1.1-a2d64acf1845-api.json`：expanded API 166/166，aggregate `8aaff8110b6edfc25cff3f356c0579f911a3d525e1cf46f344d1499752aae281`。
- `artifacts/release-manifests/1.1.1-a2d64acf1845-candidate.json`：bundle 7/7，aggregate `8497df2d182ba2534a018efb6af6c315d2038060bd373acd0a96d20e28394663`。
- `artifacts/release-manifests/1.1.1-a2d64acf1845-provenance.json`：3/3 subjects verified。

不得重建或覆盖上述冻结 Web/API 制品后继续沿用同一个 Release ID；任何运行时代码变化都必须产生新 SHA、Build ID、Release ID 和全套清单。

## 3. 开发门禁

- `npm run typecheck`：通过。
- Full Vitest：190 files passed / 16 skipped；1,514 passed / 29 skipped。
- Full server：363 passed / 2 skipped；station 3/3。
- Ops 56/6；release switch 29/29；native tools 24/24。
- Final Chromium：431 passed / 28 explicit conditional skipped / 0 failed（459 total）。
- 真实 24 MB 纯挂机附件：两次权威 autosave、快照、精确读回、重载、继续运行、0 conflict。
- Exact cloud attachment：完整性通过；修复后服务端接受原始正文，客户端规范化只删除四个已结算重复报价。
- clean-SHA Web build：1,972 modules；startup 195,381 B gzip；menu 286,632 B；Build ID 正确。
- expanded API：166 files；临时 SQLite health 200，schema v8 / layout v3。

## 4. 格式与安全边界

- GameState v47、envelope v2、cloud schema v8、SQLite layout v3、IndexedDB records 不变。
- 不执行数据库 migration，不重写现有云正文，不重算排行榜，不改合同奖励。
- 服务器兼容必须与 Web 修复一起发布；不得通过热改生产源码或放宽为通用重复 ID 接受。
- 玩家附件不是发布制品，不得上传服务器、打包、写入仓库或用于生产写测试。
- 原始附件 SHA 仅用于证明只读：云上传附件 `a4830a56...11cff`；挂机附件 `19a18164...d6d2`。

## 5. 原生状态

当前候选没有 Windows/Android 制品。正式发布前：

1. 从 runtime SHA `a2d64acf...` 的 clean checkout 构建原生包。
2. Android 只可使用批准的受保护加载器瞬时注入现有长期签名配置；不得复制、输出或新建证书。验证 APK v2/v3、AAB、证书连续性、package `cn.dsponline.network`、versionName 1.1.1、versionCode 1001001。
3. Windows 若仍无证书，继续按历史策略明确标记 `NotSigned`，不得伪造签名。
4. 原生包、stable feed、下载站和 component manifest 必须重新生成并逐字节复核；Android 实机/覆盖升级等缺口必须明确记录或取得用户针对具体候选的豁免。

## 6. Release Agent 操作顺序

1. 从 runtime SHA 建立隔离 clean checkout；重算 candidate/source/Web/API manifest 与 provenance。
2. 复核开发门禁，尤其是 station compatibility、authoritative persistence、纯挂机终态和真实大档 0 conflict。
3. 独立读取香港、上海 current/previous/canary、release-control、systemd/Nginx、磁盘和数据库 schema/layout；不要沿用旧交接中的瞬时状态。
4. 每个数据节点在任何 API/数据相关切换前创建并验证新鲜 SQLite Backup API snapshot，要求 hash、quick_check、schema/layout、容量阈值和回滚指针全部通过。
5. 只上传冻结 bundle 内容到新的不可变目录，远端复核 manifest；API 先隔离安装依赖和临时 SQLite 启动。
6. 按 runbook 原子切换 Web/API，分别验证本机与公网 health/ready、版本、Build ID、云上传、PWA/service-worker/cache 和观察窗口。
7. 原生签名、下载页、stable feeds、完整下载 SHA-256、Range 206、缓存头全部通过后才形成正式发布记录。
8. 任一备份、签名、哈希、健康、切换或回滚门禁失败即停止该完整发布，不做跨区域/原生部分发布；代码回滚不得恢复或降级数据库。

## 7. 未验证项

- 正式 Windows/Android 构建、签名与证书连续性。
- Android 真机、覆盖升级与低配 Windows 长时运行。
- 香港/上海生产备份、容量、原子切换与公网观察。
- 下载页、native feeds、Range/cache 和 previous-stable/canary 实际指针。

这些项目必须由获得用户明确发布授权的 Release Agent 完成。本开发任务没有提前创建正式 `docs/releases/1.1.1.md`。

