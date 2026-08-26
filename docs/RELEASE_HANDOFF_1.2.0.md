# 1.2.0 Release Agent 交接

## 开发交接

- **Task ID / title：** 1.2.0 Windows 原生性能第二/三层与戴森物料守恒 P0
- **Priority：** P0 数据守恒；P1 Windows 性能与存档可靠性
- **Source and attachments：** `codex/1.2.0-windows-native-layers23`；候选记录、两份开发报告、ADR-005/006；真实玩家极限档只读基准，不进入仓库或交付包
- **Reproduction or observed evidence：** 旧保守纯挂机把一秒探针发射量复制到长窗口；76.9 MB 档包含 80,674 实体和 155,746 线路；原生存档/核心实测见开发报告
- **User-visible acceptance criteria：** 时间扭曲不再凭空增加戴森结构；旧档可继续加载/导出/云同步；Windows 大档保存和影子模拟有明确失败关闭与无静默回档边界
- **Compatibility and data-preservation constraints：** GameState v47 / envelope v2 / cloud schema v8 / SQLite layout v3 不变；不自动改历史戴森数据；不删除或覆盖玩家原文件；原生权威门禁不可绕过
- **Target platforms：** Web、Windows、Android 兼容；Windows 为原生性能主目标；Server/API 增加排行榜复核纵深防护
- **Required tests：** `docs/TESTING_RELEASE.md` 的 Save/migration/offline、Server/API/SQLite、Desktop release 高风险矩阵，加 Rust、真实大档、守恒、原生差分和恢复专项
- **Release target and version：** 1.2.0；实际发布节点和平台由用户另行授权
- **Known risks / rollback：** 未完成 24 小时/多硬件 Gate C，原生核心保持邀请 Beta 默认关闭和 JS 权威；签名、物理设备、生产备份/切换仍由 Release Agent 完成；回滚只切应用制品，不回写数据库

## 候选绑定

- **Commit SHA：** 以 `artifacts/release-gate/1.2.0-final-report.json` 的 `release.gitSha` 为唯一值
- **Changed files：** 由候选 source manifest 固定；重点为 `native/`、`desktop/`、`src/game/native*`、纯挂机守恒、服务端排行榜完整性、发布说明和测试
- **Artifact paths：** `artifacts/release-bundle/<release-id>/`、`artifacts/release-manifests/<release-id>-candidate.json`、`artifacts/release-manifests/<release-id>-SHA256SUMS.txt`、独立 API 交付目录
- **Manifest and aggregate hash：** 以候选 manifest 与 final report 为准；Release Agent 必须现场复验
- **Tests with exact counts：** 以 final report 记录的本轮新鲜结果为准，不复用 1.1.8/1.1.9 历史数字
- **Unverified gaps：** 正式签名、Android 实体设备、Windows 10/11 多硬件 24 小时影子、目标 Linux 和公网发布后门禁

## 发布安全边界

1. 开发交付中的 Windows/Android 未签名文件只用于诊断，不能伪装为正式签名 stable。
2. 排行榜守恒异常只进入 `leaderboardReviewQueue`，保留上一份有效成绩；不得自动封禁、禁登、删云档或删除旧成绩。
3. 缺相邻 revision、管理员恢复或旧字段不足时标记无法验证，不能猜测作弊。
4. 发布前任何制品、provenance、source SHA、API smoke、签名或安装门禁失败都应 No-Go，现网保持不变。
5. 不从本工作树连接生产；Release Agent 必须使用受保护入口、不可变目录和独立备份证据。
