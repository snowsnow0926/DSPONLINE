# 2026-08-24 匿名玩家统计冻结与历史估算

## 结论

- 优先级：P1 运营统计失真；不影响玩家存档、云存档、登录或排行榜。
- 真实原因：香港活动 Nginx 仍保留 1.0.41 P0 时的 telemetry 熔断，三个精确路由直接返回 synthetic `202`，请求没有进入健康 API。
- 受影响路由：`POST /api/presence`、`POST /api/analytics`、`POST /api/errors`。
- 已确认边界：`/api/public-status`、`/api/health` 和 `/api/ready` 可读；生产 SQLite schema/layout 正常。没有证据表明玩家数据损坏。
- 数据操作状态：截至本文提交，生产数据库和活动 Nginx 均未修改。

## 只读证据

- 公网状态在 2026-08-24 返回累计实测玩家 `8,884`、今日 `0`、120 秒在线 `0`。
- 活动 API 为 `1.1.5-a92c0d3157f3`，服务、handoff proxy 和健康 timer 均 active。
- 活动 Nginx 对三个 telemetry 路由存在精确 `return 202`；近期 API 访问日志没有收到 presence 请求。
- service daily 的 `players` 在 2026-08-14 为部分实测 `206`，2026-08-15 至 2026-08-24 均为 `0`；analytics daily 只保留到 2026-08-14。
- 1.0.41 发布记录明确写明当时保留 telemetry 202 熔断，后续没有正式解除记录。

## 修复内容

1. `deploy/nginx-dsp-idle-app.conf`、香港/上海 bootstrap 和 standalone 模板显式把 presence、analytics、errors 反代到 API。
2. `deploy/nginx-config.test.mjs` 要求三个活动 telemetry 路由都存在 proxy，并禁止 synthetic `return 202`。
3. `server/player-statistics.mjs` 提供确定性估算、计划 SHA-256、幂等写入和冲突拒绝。
4. 管理员接口提供只读 preview 与受保护 backfill；apply 要求 24 小时内已验证备份时间戳、精确计划指纹和二次确认。
5. `playersEstimate` 与 `playersEstimateMeta` 和权威 `players` 分开；后台明确显示“估算”，不改累计唯一玩家。

## 2026-08-14 至 2026-08-24 估算计划

方法版本：`analytics-uv-presence-ratio-v1`

基线为 2026-08-07 至 2026-08-13 的 7 个完整日：

- service players 中位数：`510`
- analytics uniqueVisitors 中位数：`635`
- presence / UV 日比例中位数：`0.7901`
- 置信度：全部为 `low`

| 日期 | 权威实测 | 估算进入工厂人数 | 说明 |
| --- | ---: | ---: | --- |
| 2026-08-14 | 206 | 510 | 故障首日，部分实测；用完整基线中位数投影 |
| 2026-08-15 | 0 | 500 | 前一周同星期 UV × 中位比例 |
| 2026-08-16 | 0 | 480 | 前一周同星期 UV × 中位比例 |
| 2026-08-17 | 0 | 590 | 前一周同星期 UV × 中位比例 |
| 2026-08-18 | 0 | 569 | 前一周同星期 UV × 中位比例 |
| 2026-08-19 | 0 | 497 | 前一周同星期 UV × 中位比例 |
| 2026-08-20 | 0 | 502 | 前一周同星期 UV × 中位比例 |
| 2026-08-21 | 0 | 502 | 同星期源日不完整，回退到基线 UV 中位数 |
| 2026-08-22 | 0 | 502 | 同星期源日缺失，回退到基线 UV 中位数 |
| 2026-08-23 | 0 | 502 | 同星期源日缺失，回退到基线 UV 中位数 |
| 2026-08-24 | 0 | 502 | 当日尚未结束，低置信度投影 |

这张表是每日活动估算，不是新增唯一玩家，也不能直接相加到累计 `8,884`。正式 apply 时必须重新从生产聚合数据生成 preview；如果计划 SHA 与本文开发样本不同，停止并重新审核，不能强行套用本文数字。

## 发布与回填验收

1. Release Agent 先备份并哈希活动 Nginx snippet，候选独立 `nginx -t`，原子安装后正式 `nginx -t` 与 reload。
2. 使用合成匿名 ID 从节点本机验证 presence/analytics 返回 API 的结构化 `accepted=true`；不得用生产账号或玩家存档。
3. 等待至少两个 45 秒心跳周期，确认 API access log、`players.today` 和 online 指标开始变化；服务 `NRestarts=0`。
4. 在任何 backfill 前创建并验证 SQLite Backup API snapshot：完整 SHA-256、`quick_check=ok`、schema 8、layout 3、磁盘低于 90%。
5. 先调用 preview，保存计划 SHA；人工核对日期、实测值、估算值和置信度，再使用二次确认 apply。
6. apply 后核对 only daily estimate fields changed，`players` map 数量、账号、会话、云存档、payload、排行榜和审计历史数量均未减少。
7. 公网 `/api/public-status` 继续只返回权威实测；管理员后台同时显示实测和估算，并明确估算不能当作累计唯一玩家。

## 回滚

- Nginx：恢复本次变更前已哈希的 snippet，`nginx -t` 后 reload；不切换数据库。
- 估算：只有在新的已验证备份和明确授权下，按 plan hash 精确移除该计划写入的 estimate 字段；不得恢复整个数据库或删除权威 `players` 记录。

