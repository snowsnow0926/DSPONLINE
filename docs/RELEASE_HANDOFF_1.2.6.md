# 1.2.6 Release Agent 交接

> 状态：固定候选已完成，生产尚未连接或修改。待用户针对精确 Release ID 完成剩余设备/长时门禁或明确接受风险后，切换到 `Role: release` 执行全量原子发布。

## 固定候选

- Runtime commit：`df828869e276e5d3a67513095a4d1c93d13c500f`
- Release ID：`1.2.6-df828869e276`
- Build ID：`1.2.6+df828869e276`
- Runtime 分支：`codex/1.2.6-release`
- Bundle：`artifacts/release-bundle/1.2.6-df828869e276/`
- Candidate manifest：`artifacts/release-manifests/1.2.6-df828869e276-candidate.json`
- Provenance：`artifacts/release-manifests/1.2.6-df828869e276-provenance.json`
- SHA256SUMS：`artifacts/release-manifests/1.2.6-df828869e276-SHA256SUMS.txt`
- Final report：`artifacts/release-gate/1.2.6-df828869e276-final-report.json`

Runtime 之后的文档提交不得作为重建身份。候选为 12 个文件，aggregate SHA-256 `56e07009689a3c66f8f39178a9e0aa0e1bb61167be728663e6e8920555aad868`。

## 软件、真实档与制品结论

- Vitest 1,719/29、server 385/2 + station 4/4、Ops 56/6、release-switch 29/29、native 182/1、Rust 222/222，均 0 失败。
- Chromium 的 435 个有效用例全部通过；主轮 2 个并发超时均在隔离重跑通过。Durable 7/7、production preview 3/3。
- Web 1,986 modules、startup gzip 180,825 B、forbidden 0；API 182 文件逐项布局、生产依赖和隔离 health 200 smoke 通过。
- 44.5 MB 真实终局档完成 30 天、15× 结算，约 45.1 秒完成并规范重载；白矩阵/科研、火箭/结构和壳面帆均有正向结果，源档未改变。
- Android `1.2.6 / 1002006` 是批准长期证书正式包，v2/v3、zipalign 与证书连续性通过。
- Windows setup/unpacked 的版本、Build ID、正式 HTTPS API、stable 更新源和 12 秒隔离启动通过，残留 0；Authenticode 为 `NotSigned`。
- source/Web/API/native/download/Windows 组件清单、六归档读回、candidate 12/12、provenance 3/3 与 SHA256SUMS 20/20 已复验。

详细数字和哈希见 [1.2.6 候选记录](./releases/1.2.6-candidate.md)。

## 未完成的候选专属门禁

1. Android 实体设备；
2. 低配、主流、高配 Windows；
3. Windows 1.2.5 → 1.2.6 覆盖升级；
4. 长时运行。

只有用户明确指向 `1.2.6-df828869e276` 的风险接受才可替代上述证据。任何旧版本授权或豁免都不可复用。

## Release Agent 固定流程

1. 完整读取 `docs/PROTECTED_RELEASE_ACCESS.md`、`docs/DEPLOYMENT_OPERATIONS.md`、`docs/RELEASE_RUNBOOK_CHECKS.md` 与 Skill deployment reference；复验 manifest、provenance 和 SHA256SUMS，不重建候选。
2. 通过受保护配置分别对香港、上海做只读身份、current/previous/generation/pending、服务、Nginx、容量和备份能力预检；不得输出节点或凭据。
3. 两地分别创建全新 Backup API 快照并验证完整 SHA-256、`quick_check=ok`、schema v8、layout v3、evidence 和保护水位；数据库/WAL/SHM 不随代码复制或回滚。
4. 上传到新的不可变目录，按组件 manifest 逐文件复验；API 只在备份克隆和隔离端口预热。
5. 在同一授权批次原子切换香港/上海 Web/API、下载页、Windows 与 Android stable；任一目标失败立即停止并按现场指针回滚，不留下跨区域半发布。
6. 验收 version/health/ready、PWA/service worker/cache、完整下载哈希、Range 206、Android 签名与证书连续性、Windows `NotSigned`、服务 `NRestarts` 和 current/previous 指针。
7. 观察通过后把 1.2.5 设为 previous-stable；代码回滚只切不可变目录，永不恢复数据库。

本交接不授权绕过新鲜备份、完整哈希、受保护凭据、严格 TLS、原子切换或回滚保护。
