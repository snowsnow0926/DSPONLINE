# 1.2.5 Release Agent 交接

> 状态：`1.2.5-a347f1889044` 已完成发布前软件门禁、正式 Android 签名、Windows stable 封装和不可变制品；未访问生产，仍受 Release-ID 专属硬件/真实存档门禁阻断。

## 固定候选

- Runtime commit：`a347f1889044ccbdd1d6119f686eed6d2eb538c5`
- Release ID：`1.2.5-a347f1889044`
- Build ID：`1.2.5+a347f1889044`
- Runtime 分支：`codex/1.2.5-pure-idle-construction`
- Bundle：`artifacts/release-bundle/1.2.5-a347f1889044/`
- Candidate manifest：`artifacts/release-manifests/1.2.5-a347f1889044-candidate.json`
- Provenance：`artifacts/release-manifests/1.2.5-a347f1889044-provenance.json`
- SHA256SUMS：`artifacts/release-manifests/1.2.5-a347f1889044-SHA256SUMS.txt`
- Final report：`artifacts/release-gate/1.2.5-final-report.json`

文档提交发生在制品冻结之后，只用于交接；不得把文档提交 SHA 当作 runtime，也不得重新构建或覆盖上述对象。candidate 为 12 个文件，aggregate SHA-256 `d05d744ae91cc0c468a7144869351467c60dbd238b3f16b98e047a20d86b32e0`。

## 软件门禁结论

- Vitest 1,673/66、server 385/2 + station 4/4、Ops 56/6、release-switch 29/29、native 176/7、Rust 222/222，均 0 失败。
- Chromium 434/27/0、durable 7/7、最终 Web production preview 3/3。
- Web 1,985 modules，startup gzip 180,157 B，forbidden 0；最终 `dist` 与下载页 version 均为 Web 平台。
- API 182 文件逐项布局、生产依赖和隔离 health 200 smoke 通过。
- Android `1.2.5 / 1002005` 为批准长期证书正式包，v2/v3、zipalign、证书连续性通过；APK/AAB 哈希见候选记录。
- Windows setup/unpacked 的版本、Build ID、正式 HTTPS API、stable 更新源和 12 秒隔离启动通过，残留 0；Authenticode 为 `NotSigned`。
- source/Web/API/native/download/Windows 组件清单、六归档读回、candidate 12/12、provenance 3/3 和 SHA256SUMS 20/20 已复验。

完整数字、制品哈希、环境重试和兼容边界见 [1.2.5 候选记录](./releases/1.2.5-candidate.md)。

## Release No-Go 条件

以下证据尚未完成，且当前没有只适用于本 Release ID 的豁免：

1. Android 实体设备；
2. 低配/主流/高配 Windows；
3. Windows 1.2.4 → 1.2.5 覆盖升级；
4. 长时运行；
5. 真实终局玩家档两种纯挂机、建筑制造和 Worker 故障注入。

Release Agent 必须先补齐这些门禁，或取得用户明确针对 `1.2.5-a347f1889044` 的风险接受。不得复用 1.2.3 或其他 Release ID 的豁免。

## 获得授权后的固定发布边界

1. 完整读取 `docs/PROTECTED_RELEASE_ACCESS.md`、`docs/DEPLOYMENT_OPERATIONS.md` 与 `docs/RELEASE_RUNBOOK_CHECKS.md`，先验证本 manifest、provenance 和 SHA256SUMS，不重建候选。
2. 通过受保护配置分别对香港、上海进行只读身份、current/previous/generation/pending、服务、Nginx、容量和备份能力预检；不得输出节点或凭据。
3. 两地分别创建全新 Backup API 快照并验证完整 SHA-256、`quick_check=ok`、schema v8、layout v3、evidence 和保护水位；数据库/WAL/SHM 不随代码复制或回滚。
4. 上传到新的不可变目录，按组件 manifest 逐文件复验；API 只在备份克隆和隔离端口预热。
5. 在同一批次原子切换香港/上海 Web/API、下载页、Windows 与 Android stable；任一目标失败即停止并按现场指针回滚，不留下跨区域半发布。
6. 验收 version/health/ready、PWA/service worker/cache、完整下载哈希、Range 206、Android 签名与证书连续性、Windows `NotSigned`、服务 `NRestarts` 和 current/previous 指针。
7. 观察通过后把 1.2.4 设为 previous-stable；代码回滚只切不可变目录，永不恢复数据库。

本开发会话没有连接生产、创建生产备份、上传制品、修改 DNS/下载页或切换角色。拥有本机签名/连接能力不等于发布授权。
