# 1.1.4 开发报告

## 结论

1.1.4 已在 clean runtime `7dbc149a016c7f53e5d3648e0fdcb3679309ef73` 上完成开发封装、完整本地门禁、生产 Web/API 构建和不可变开发制品。Release ID 为 `1.1.4-7dbc149a016c`，Build ID 为 `1.1.4+7dbc149a016c`。本报告只证明开发候选，不宣称生产已经切换。

## 修复与优化

1. 建筑制造巨构对可证明闭合的副产物相位聚合批处理；非闭合路径继续走原子任务。多个制造中心共享有界公平预算，第二个中心不会再被第一个饿死。
2. 蓝图部署、排队和需求计算保留模板显式传送带数量；设备自定义 lane 只影响新绘制线路。
3. 普通离线和纯挂机降级先结算最多 1 秒隔离精确前缀，剩余不确定尾段保守冻结；UI 不再把“短窗口未测得”误写成“未运行”。
4. 服务端新增权威复核的运行时 UserLookupIndex，减少认证/账号查找全表扫描，不改变 SQLite、云协议或账号语义。
5. v47 非活动默认字段稀疏化把真实 64.14 MiB 终局档降为 62.26 MB。模拟 Worker 通过 transfer-only 权威检查点交给保存 Worker，避免主线程和 Worker 同时保留第二份完整状态镜像。
6. 云合同统一为 64 MiB 保证、`96 MiB - 1024 B` 单修订硬上限、80 MiB gzip、96 MiB 解压、128 MiB 并发、208 MiB 响应、180 秒客户端上限和 Nginx `112m`。
7. Electron 打包现在读取并校验完整冻结云合同，修复打包脚本仍硬编码旧 48 MiB 合同、会拒绝正式 1.1.4 的发布阻断问题。

## 验证证据

- TypeScript、125 个许可证、174 个 Vitest 文件、server 376/2、station 3/3、native 25/25、ops 56/6 全部通过。
- Chromium 全量为 427 passed / 26 条件夹具跳过；release-switch 29/29 连续五轮通过。
- production build 为 1,962 modules；startup gzip 194,848 B，menu 284,716 B，forbidden startup modules 0。
- API 隔离 health 200，schema v8、layout v3；API archive aggregate SHA-256 `11628d408985eddb014b3d0191bdd07f01904d2e8d04af43d32922e10325e45f`。
- source manifest 260/260；candidate manifest 8/8；provenance 3/3；SHA256SUMS 10/10。
- 真实玩家附件只在本机只读副本运行，未上传生产、未覆盖原件；压缩、校验、连续保存、备份读回与页面重载通过。

完整条件跳过和来源位置保存在冻结 gate report。并发全量 Playwright 压力期间 release-switch 曾有一次超时，但同一工具已经在 ops、前一候选和独立完整套件连续五次 29/29 通过，因此作为主机饱和证据保留，不改写为产品失败，也未放宽超时或增加重试。

## 已知发布门禁

- Android 必须由 release 角色从受保护配置临时加载既有长期证书和 SDK，生成正式 APK/AAB，并验证 v2/v3、zipalign、证书连续性、包名、versionName/versionCode；不得输出或复制密钥材料。
- Windows stable 必须重新生成安装器及更新 feed；按历史策略明确 `NotSigned`，不创建新证书。
- 双节点需分别完成磁盘、备份 readiness、fresh Backup API evidence、远端 manifest、原子切换、健康与公网 smoke。
- 下载页需核验完整哈希、Range、cache/PWA 和两种原生 stable feed。
- previous-stable 只有全部目标成功后才设置为 1.1.3。

## 数据与回滚

本版不升级 GameState v47、envelope v2、cloud schema v8、SQLite layout v3 或 IndexedDB object stores。代码回滚不恢复数据库。超过旧服务容量上限的新云修订在回滚后可能无法再次上传，因此回滚公告必须保留 1.1.3 入口并提示先导出本地档。
