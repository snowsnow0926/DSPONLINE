# 匿名玩家统计冻结修复候选（2026-08-24）

## 交接摘要

- **任务标题**：修复匿名玩家人数统计冻结，并为 2026-08-14 至当前日生成可审计的历史估算
- **优先级**：P1（运营统计失真；不影响登录、云存档、玩家存档或排行榜）
- **角色**：Development；本文不是发布授权，也不代表线上已修复
- **运行时版本**：生产当前事实仍以 `docs/PROJECT_STATUS.md` 为准（当前 1.1.5）
- **发布目标/版本**：待业务方指定下一正式版本和目标节点；不得从本候选直接切换生产

## 根因与证据

香港公网 `/api/public-status`、`/api/health`、`/api/ready` 可读，但 2026-08-14 后 `players.today/online` 归零。只读核对活动 Nginx 发现 `/api/presence`、`/api/analytics`、`/api/errors` 的精确 location 仍返回 synthetic `202`，请求没有到达 API。该配置来自历史临时熔断，不是玩家存档或 SQLite 损坏。完整脱敏证据与估算边界见 [调查记录](../feedback/2026-08-24-player-statistics-freeze.md)。

## 已完成的开发变更

1. 四份 Nginx 活动模板显式反代三个 telemetry 路由到本机 API；回归测试禁止再次出现 `return 202`。
2. 新增 `server/player-statistics.mjs`：以聚合日数据构造确定性 `analytics-uv-presence-ratio-v1` 估算计划，带 SHA-256 计划指纹、低置信度标记、故障首日/不完整周同比保护。
3. 新增管理员只读 preview 与受保护 backfill 接口。apply 必须匹配 preview 指纹、精确二次确认和当前进程 24 小时内已验证 SQLite Backup API 时间戳；冲突失败关闭且幂等。
4. 估算只写 `dailyMetrics[*].playersEstimate`、`playersEstimateObserved`、`playersEstimateMeta`，绝不覆盖权威 `players`、累计唯一人数、账号、云存档、排行榜或玩家正文；运行时保留和 SQLite 重启均已覆盖测试。
5. 管理后台将实测与估算分栏显示，并明确“每日估算和不是累计唯一玩家”。

## 建议的历史估算

正式 apply 前必须从生产聚合数据重新 preview，不能盲抄下表。开发样本的 7 日完整基线为 2026-08-07 至 13；估算全部 `low` confidence。详细计算与每日日志见调查记录，且 2026-08-14 的部分实测不会被用作后续周同比源日。

| 日期范围 | 处理方式 |
| --- | --- |
| 2026-08-14 | 保留实测 206，同时以完整基线中位数生成独立估算 |
| 2026-08-15 至当前日 | 同星期前一周完整 UV × 中位 presence/UV；源日不完整或缺失时回退到基线 UV 中位数 |

估算是“每日进入工厂活动”的回溯推断，不是新增唯一玩家；不得把它直接加进 `players.total`，也不得把香港与上海相加宣称为独立用户数。

## 兼容性与验收标准

- GameState、save envelope、cloud schema、SQLite layout 和现有玩家数据格式不变。
- 生产发布前：备份并哈希活动 Nginx；候选 `nginx -t`；原子安装/reload；用合成匿名 ID 验证三个 telemetry 请求确实进入 API；等待两个心跳周期并核对 public status、access log、health/ready、`NRestarts`。
- 历史回填前：独立完成 SQLite Backup API snapshot 的完整 SHA-256、`quick_check`、schema/layout 和磁盘低于 90% 验证；先 preview、人工核对计划指纹，再 apply。
- 回填后：只允许新增 estimate 字段；权威 `players`、账号/会话、云存档/排行榜计数不得减少；保留精确 plan hash 以便审计和按字段回滚。

## 开发验证（当前工作树）

已运行并通过：

- `npm test`：174 个测试文件通过、7 个跳过；1,438 通过、20 跳过
- `npm run test:server`：server 373 通过/2 跳过，station 3/3
- `npm run test:ops`：57 通过/6 个 Linux-only 跳过
- `npm run test:native`：24/24
- `npm run typecheck`
- `npm run build`：Vite 1,962 modules；startup budget 通过（total gzip 194,846 bytes；menu 282,333 bytes）
- `npm run licenses:check`
- `git diff --check`

最后一次微调后的定向回归：`node --test server/player-statistics.test.mjs server/server.test.mjs` 为 44 通过、2 跳过、0 失败；随后对加入未来日期保护前的最终工作树重新运行了完整 Vitest（1,438 通过、20 跳过）、server（373 通过、2 跳过；station 3/3）和 ops（57 通过、6 个 Linux-only 跳过），运行时保留/SQLite 重启测试亦通过。未来日期保护只增加失败关闭校验，发布前仍须对最终不可变制品重跑完整矩阵，不能复用本地 `dist`。

## 制品与发布门禁

- **Implementation commit SHA**：`45fac16ea16a212c2ff794ca773dc2b637b3ba29` + `edb6007`（未来日期失败关闭保护）
- **Immutable Web/API/native artifacts**：尚未生成；当前 `dist/` 仅为本地验证输出，不得上传
- **Manifest/aggregate hash**：unknown
- **未完成门禁**：独立 clean checkout、不可变制品/清单、正式版本号、签名包（如适用）、生产备份、Nginx 原子切换、公网 smoke、历史 preview/apply
- **当前生产状态**：未连接生产写路径，未修改生产 Nginx、数据库、WAL/SHM、账号、存档或统计数据

## 回滚边界

- Nginx 回滚到发布前已哈希的活动 snippet，执行 `nginx -t` 后 reload；不回滚数据库。
- 历史估算只允许按匹配 `planHash` 移除本次新增的 estimate 字段；不得恢复整库或删除权威 `players` 记录。
