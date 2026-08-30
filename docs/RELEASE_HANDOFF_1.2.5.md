# 1.2.5 Release Agent 交接

> 状态：`1.2.5-0a1c6629ced1` 已完成发布前软件门禁、真实终局档验收、正式 Android 签名、Windows stable 封装和不可变制品；未访问生产，仍受本 Release ID 的设备/长时门禁阻断。

## 固定候选

- Runtime commit：`0a1c6629ced1c99ba5ec55c4e4947de7300da4bd`
- Release ID：`1.2.5-0a1c6629ced1`
- Build ID：`1.2.5+0a1c6629ced1`
- Runtime 分支：`codex/1.2.5-real-save-release-fix`
- Bundle：`artifacts/release-bundle/1.2.5-0a1c6629ced1/`
- Candidate manifest：`artifacts/release-manifests/1.2.5-0a1c6629ced1-candidate.json`
- Provenance：`artifacts/release-manifests/1.2.5-0a1c6629ced1-provenance.json`
- SHA256SUMS：`artifacts/release-manifests/1.2.5-0a1c6629ced1-SHA256SUMS.txt`
- Final report：`artifacts/release-gate/1.2.5-0a1c6629ced1-final-report.json`

旧 `1.2.5-a347f1889044` 候选已作废并冻结，只能保留为历史证据。文档提交发生在制品冻结之后，不得把文档提交 SHA 当作 runtime。当前 candidate 为 12 个文件，aggregate SHA-256 `9181a35fa9587bb900915a3fb5d40cc44baa80c3971d3c3c7cf000595b927049`。

## 软件与真实档门禁结论

- Vitest 1,711/29、server 385/2 + station 4/4、Ops 56/6、release-switch 29/29、native 182/1、Rust 222/222，均 0 失败。
- Chromium 434/27/0、durable 7/7、最终 Web production preview 3/3。
- Web 1,985 modules，startup gzip 180,156 B，forbidden 0；API 182 文件逐项布局、生产依赖和隔离 health 200 smoke 通过。
- 44.5 MB 真实终局档通过 15×/10 分钟、白矩阵/火箭/施工、两次启动、停止保存读回和 Worker 故障恢复；源文件未改变。
- Android `1.2.5 / 1002005` 为批准长期证书正式包，v2/v3、zipalign、证书连续性通过。
- Windows setup/unpacked 的版本、Build ID、正式 HTTPS API、stable 更新源和 12 秒隔离启动通过，残留 0；Authenticode 为 `NotSigned`。
- source/Web/API/native/download/Windows 组件清单、六归档读回、candidate 12/12、provenance 3/3 和 SHA256SUMS 20/20 已复验。

完整数字、制品哈希和兼容边界见 [1.2.5 候选记录](./releases/1.2.5-candidate.md)。

## Release No-Go 条件

以下证据尚未完成，且当前没有只适用于本 Release ID 的豁免：

1. Android 实体设备；
2. 低配/主流/高配 Windows；
3. Windows 1.2.4 → 1.2.5 覆盖升级；
4. 长时运行。

Release Agent 必须先补齐这些门禁，或取得用户明确针对 `1.2.5-0a1c6629ced1` 的风险接受。不得复用 1.2.3、1.2.4 或作废候选的豁免。

## 获得授权后的固定发布边界

1. 完整读取 `docs/PROTECTED_RELEASE_ACCESS.md`、`docs/DEPLOYMENT_OPERATIONS.md`、`docs/RELEASE_RUNBOOK_CHECKS.md` 与 Skill deployment reference；复验 manifest、provenance 和 SHA256SUMS，不重建候选。
2. 通过受保护配置分别对香港、上海做只读身份、current/previous/generation/pending、服务、Nginx、容量和备份能力预检；不得输出节点或凭据。
3. 两地分别创建全新 Backup API 快照并验证完整 SHA-256、`quick_check=ok`、schema v8、layout v3、evidence 和保护水位；数据库/WAL/SHM 不随代码复制或回滚。
4. 上传到新的不可变目录，按组件 manifest 逐文件复验；API 只在备份克隆和隔离端口预热。
5. 在同一批次原子切换香港/上海 Web/API、下载页、Windows 与 Android stable；任一目标失败立即停止并按现场指针回滚，不留下跨区域半发布。
6. 验收 version/health/ready、PWA/service worker/cache、完整下载哈希、Range 206、Android 签名与证书连续性、Windows `NotSigned`、服务 `NRestarts` 和 current/previous 指针。
7. 观察通过后把 1.2.4 设为 previous-stable；代码回滚只切不可变目录，永不恢复数据库。

本开发阶段没有连接生产、创建生产备份、上传制品、修改 DNS/下载页或切换生产指针。
