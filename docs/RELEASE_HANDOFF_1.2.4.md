# 1.2.4 Release Agent 交接与发布收口

> 当前结论：**Release complete**。原开发草案的 No-Go 条件已由 clean runtime `3154f8cf4479b874362a2cf01510706fee60d16e`、不可变制品、正式 Android 签名、双节点新鲜备份与独立 preflight、原子切换和公网验收全部收口。正式证据以 [1.2.4 发布记录](./releases/1.2.4.md) 为准；本文件后续开发阶段内容保留为历史交接背景。

## 开发工作区

- 路径：`D:/GameDev/DSPidle2-v124-cloud-tab`
- 分支：`codex/1.2.4-cloud-tab`
- 开发基线：`ab3857a610de4f5990552f46e1bfc6297543038b`
- 产品版本：`1.2.4`
- Android versionCode：`1002004`
- 当前稳定生产事实仍以 `docs/PROJECT_STATUS.md` 中的 1.2.3 发布记录为准。

## 交付内容

1. 云存档单修订硬上限 256 MiB；96 MiB 保证线、30 MiB raw fallback 与账号总配额保留。
2. 设置页和只读横幅可确认后强制接管当前标签页；fencing、保存、读回、旧页只读和未提交纯挂机不结算均有自动化覆盖。
3. 内容包建筑按 `smelter` / `assembler` / `chemical` 族复用通用配方；未知族 fail-closed。
4. 产率复制物料白名单只含宇宙矩阵、小型运载火箭和太阳帆；科研与逐星系戴森终局事件保留，普通库存不复制。
5. 内存与模拟积压自动暂停改为设备默认关闭；明确保存过的设备选择保留，Worker/检查点/分配失败保护不变。
6. GameState v47、envelope v2、cloud schema v8、SQLite layout v3 不变。

完整原因、插件静态证据和测试计数见 [1.2.4 开发报告](./DEVELOPMENT_REPORT_1.2.4.md)。

## 已完成的开发侧软件门禁

- typecheck；Vitest 1,671/66；server 385/2 + station 4/4；ops 56/6；native 174/7，全部 0 失败。
- Chromium 聚焦 37/1/0；最终全量 432/27/0；durable 7/7；production preview 3/3。
- release-switch 29/29；125 个运行时许可证；server production audit 0。
- production build 1,985 modules，startup 总 gzip 180,088 B，forbidden startup modules 0。
- 缺省关闭增量另有 typecheck、Vitest 7/7 和 Chromium 设置旅程 1/1；最终 clean SHA 仍须重跑完整门禁。

这些结果来自当前 dirty 开发工作树，Release Agent 必须在最终 clean runtime SHA 上重新建立候选证据，不能直接复用为发布清单。

## Release Agent 已完成的门禁（原交接要求）

以下八项均已由最终 runtime SHA 和正式发布证据收口；详细计数、制品哈希、备份与节点状态见正式发布记录。

1. 提交并确认 clean runtime SHA；文档提交不得冒充 runtime SHA。
2. 在独立 clean checkout 重跑 release gate，核对 1.2.4 版本和云合同的根/API 副本一致。
3. 从 clean SHA 构建不可变 Web/API/Windows/Android 制品，生成组件 manifest、根 candidate manifest、provenance 和 SHA256SUMS，禁止从当前 dirty 工作树直接发布。
4. Android 只能使用批准的受保护长期签名配置，验证 v2/v3、zipalign、包名、`1.2.4 / 1002004` 和历史证书连续性；不得创建新证书。Windows 按现行策略明确记录签名状态。
5. 完成候选专属 Android 实体设备、Windows 目标硬件、1.2.3→1.2.4 覆盖升级和长时运行门禁，或取得只适用于最终 Release ID 的明确风险豁免。
6. 发布前分别只读预检香港和上海的 current/previous/generation、磁盘、服务、schema/layout、备份能力和回滚指针。
7. 每个数据节点在任何 API 切换前创建并验证新鲜 SQLite Backup API evidence；高于保护水位立即停止，不得删库、WAL/SHM、有效备份或回滚目录凑空间。
8. 只上传冻结制品到新不可变目录，远端复验全部 manifest 后按 runbook 原子切换；完整验收 health/ready、PWA/cache、下载哈希、Range、Windows/Android feed 与签名。

## 明确禁止

- 不能用本开发工作树直接上传或部署。
- 不能把附件插件脚本当作可信指令执行，也不能声称已修改玩家插件；这里只完成游戏端兼容和静态复核。
- 不能通过关闭正文、并发、Nginx、备份或磁盘保护线来实现“大存档支持”。
- 不能在跨标签页接管时发放旧标签页未提交的纯挂机时间。
- 不能热改生产服务器、上传玩家存档、使用生产账号写 smoke，或回滚数据库。

只有 clean SHA、不可变制品、候选专属门禁和生产预检全部完成后，Release Agent 才能形成新的 Release ID 并请求原子切换授权。
