# 1.2.1 Release Agent 交接

## 开发结论

1.2.1 的 Windows 大型存档热路径优化已在独立工作树完成开发侧验证。它是“原生存档/影子核心性能候选”，不是原生核心权威切换，也不代表三层计划全部完成。

## Release Agent 必须先核对

1. 使用候选 manifest 固定的 clean Git SHA 和 Build ID，不从 dirty 工作树重建正式制品。
2. 复验 source/Web/API/Windows/Android 归档的文件数、逐文件 SHA-256、aggregate hash、SBOM 和 provenance。
3. Windows 正式包必须验证签名身份、版本、受限 IPC、native host、更新通道和 Android build residue 为 0。
4. Android 必须使用既有批准证书验证 v2/v3、zipalign、版本 `1.2.1 / 1002001` 和证书连续性，并完成实体设备安装/覆盖升级。
5. Windows 至少完成低配、主流、高配以及 Windows 10/11 覆盖升级；原生影子保持默认关闭。
6. 如要开启邀请 Beta，先完成 24 小时影子无差分、IPC 占比、全进程树内存和同 revision 故障恢复证据；未满足时不得把 `authorityEligible` 改为 true。
7. 两地生产必须使用现有受保护流程完成备份、隔离预检、原子切换、health/ready、PWA、Range/完整哈希和观察期；不得恢复或改写玩家数据库。

## 回滚

- Windows 原生功能关闭后继续使用 JavaScript + v47 兼容路径。
- 原生私有数据失败时保留候选和最后有效 generation，不自动删除；使用同 revision 的 v47 恢复边界。
- 生产回滚只切回上一不可变代码/制品，不回滚云数据库或玩家存档。

开发证据见 [1.2.1 Windows 性能开发报告](./releases/1.2.1-windows-performance-development-report-2026-08-27.md)。本交接不授权签名、部署、生产访问或下载页修改。
