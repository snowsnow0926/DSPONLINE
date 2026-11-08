# 内容包作者反馈开发交接

状态：开发、回归与冻结交付完成，本地未发布。Role: develop。任务 ID：`content-pack-author-feedback-20261108`，优先级 P1。来源为用户提供的玩家聊天截图 `codex-clipboard-e99e5e45-2bd4-4061-ab73-e45dab5dc5aa.png` 及直接实施指令；仅使用合成存档验证，没有操作真实玩家存档或生产账号。

工作树位于 D 盘，分支 `codex/content-pack-author-feedback-20261108`；基线 `f51240bc6dfb7c82310d945a3906299a72416de2`，干净功能提交 **`d9c4b2b372172b9de9a7f17bfd1ec5b0864b923a`**。后续文档收尾不改变运行成品。源码包版本沿用 1.3.10，Build ID `1.3.10+d9c4b2b37217`。

## 玩家需求与验收

- 资源点或科技触发后无法卸载：原使用检查把自动矿点、研究与历史统计都视作不可移除引用。新增暂停后的“清理残留并移除”，展示预览并单独勾选确认；先保存完整且可验证的卸载前快照，再持久化主档和配置。真实库存、设备/矿机、线路、蓝图、队列和依赖继续阻止移除，说明原因。恰为零的库存索引也可清理；科研材料不返还。
- 更新时 ID 难改：根包 ID 继续作为稳定更新身份。作者工具新增包内物品、建筑、配方、科技和传送带的安全改名，同步引用、生成旧 ID 别名并提高补丁版本；再次改名会将所有历史来源直达最终 ID。现有兼容检查继续拒绝无映射删除、类型或容量破坏。
- 无法重写原版物品和传送带：格式 v5 新增 `itemOverrides`、`beltOverrides`，提供目标选择与表单。物品可改展示及分类；传送带可改真实运输速度、制造成本/产量和科技门槛。原 ID、物态和传送带等级保持，停用后恢复原定义；冲突包拒绝注册。

“一键清空原内容”的范围仍待确认。用户回复“我不清楚我问问”，因此本批没有猜测为清空草稿、禁用原版或删除工厂，也没有新增清除开关。这一设计项仍待用户取得玩家说明。

完整字段、操作与 v5 示例见[作者指南](../MODDING.md)和[覆盖示例](../examples/example-core-overrides-v5.content-pack.json)。v1～v4 包继续读取；公开旧客户端仍不支持 v5，须等待对应新发行版。

## 实现与保档

改动集中在 `contentPackOverrides.ts`、`contentPackAuthoring.ts`、`contentPackRemoval.ts`、注册表、作者/运营界面及 App 保存协调；同时增加有针对性的单元和浏览器测试。完整文件差异位于源码补丁。

卸载持有排他令牌，重新读取权威检查点后再计算候选。快照或主档失败即停止；配置读回失败尝试用原检查点恢复主档，若恢复也失败则明确提示使用已保留快照。最近八份已移除配置只保存在本机，不进入模拟目录或指纹。恢复旧进度时先载入并注册对应配置，再恢复快照；验证中原矿点的有限剩余量 59/77 得到保留。

序列化捕获目标注册表，Worker、同步降级、传输证明及保存合并缓存共用目录；否则界面卸载后主档仍会要求旧包。可选 durable 模式使用事务提前取得的独立暂停检查点，并将 recovery head 绑定同一目标目录；配置失败回滚不把旧 Worker 状态提交到临时新目录日志。摘要缓存有目录代次，忽略旧 Worker 的过期“缺包”结果。

React Flow 切换目录时可能短暂保留上一帧节点。展示层仅保留上一份物品/设备/配方定义，避免删除矿点时小地图读空；模拟、校验和目录枚举仍严格移除旧内容。GameState v47、存档 envelope v2、注册表版本 1、云/API 合同和原生权威保护门槛保持。

## 新执行验证

| 命令或检查 | 通过 / 跳过 |
| --- | --- |
| `npm test -- --exclude src/game/nativeCoreDifferential.test.ts --maxWorkers=4` | 3,897 / 37，439 文件通过、16 文件跳过 |
| `npx vitest run src/game/nativeCoreDifferential.test.ts` | 61 / 1；普通套件与差分合计 3,958 / 38 |
| `node artifacts/content-pack-author-feedback-20261108/run-native-final.mjs` | 原 `test:native` 的相同测试文件，静态 Vite 夹具禁用监听且独立缓存；639 / 1 |
| `npm run test:server` | 主套件 411 / 2，空间站 4 / 0，合计 415 / 2 |
| Playwright `playwright.full.config.ts` | 全 657 项：623 / 34，0 失败、0 flaky，20.4 分钟 |
| Playwright `playwright.final-focused.config.ts` | 最终作者反馈、兼容更新、v4 与 Worker 四文件 24 / 0 |
| Playwright 可选 durable | `playwright.durable-transaction.config.ts` 两文件 17 / 0；新增零库存夹具后 `playwright.durable-zero.config.ts` 10 / 0 |
| 冻结 Web `playwright.frozen.config.ts` | 实际生产文件 4 / 0，含三种视口的深浅色及 80～200% 字号 |
| TypeScript、Web/Windows 构建、预算、原生边界/覆盖、许可 | 通过；运行依赖通知 127 项 |
| 独立 Windows 实际启动 | D 盘隔离数据、v5 覆盖注册、主档/手动槽/速通读取及上传四条真实 MessagePort 传输全部通过本机 HTTP 合同；NotSigned |

原始 JSON 报告及日志位于[证据目录](../../artifacts/content-pack-author-feedback-20261108)。普通单元最终日志为 `unit-transaction-final.log`，真实差分为 `native-differential-final.log`，Node 最终为 `native-tools-corrected.log`。历史日志保留了旧节点渲染、目录未绑定、可选恢复 head 与回滚失败，均在修正后重跑；无限矿/科研默认值等夹具问题、静态夹具替换与文件协议菜单入口修正也保留，没有删掉断言或跳过失败案例。最终全量轮后又执行 24 项相关复验及冻结/可选模式检查，不宣称所有中间运行均一次通过。

Rust 源码本批未改变；优化 Host 已构建并通过新执行的真实差分，没有将历史完整 Rust 计数列为本批结果。没有执行 Android 实体/签名、正式覆盖安装器、生产依赖重装或生产 smoke，不具备新公开发行版的发布资格。

## 冻结制品

- [完整开发 ZIP](../../artifacts/dspidle-content-v5-d9c4b2b3.zip)：180,687,945 B，SHA-256 `1a8797fb7f391b3d02b86a10f9d831644d7afb333aec8df2056c66fd35c15d91`。
- [逐文件清单](../../artifacts/content-pack-author-feedback-20261108/release-manifest.json)：286 件，Web 200、Windows 75、文档/示例/源码 11；聚合 SHA-256 `73f3fda5d6943ae47c7c7bf86ab3f5b75f0d618ca12308df381f798533afa0b0`。
- [压缩包读回证明](../../artifacts/content-pack-author-feedback-20261108/archive-verification.json)：286 件及内嵌清单，共 287 个 ZIP 成员全部核对；完整源码 ZIP 的提交注释匹配功能提交。
- [开发包说明](../../artifacts/content-pack-author-feedback-20261108/bundle/README.md)；[Windows 开发启动程序](../../artifacts/content-pack-author-feedback-20261108/bundle/windows/dsp-idle-performance-edition.exe)。使用独立数据目录且默认离线，非正式安装器。

完整源码归档和基线补丁随包提供，不包含 node_modules、玩家存档、数据库、凭据或测试用户目录。以前的冻结制品保持，原标准开发输出也保留副本。

## 发布、风险与回退

本批仅开发交付；新发行版本和目标待后续发布任务确定。香港 Web、Windows/Android 公开下载、更新源、上海节点和备份设置未操作，不把上一轮 1.3.10 热修授权扩展为本批自动上线。

主档和注册表位于不同存储介质，不承诺跨介质退出/掉电的原子事务。失败路径已覆盖快照、主档、配置与可选恢复回滚；若中断留下不完整切换，应先导出可读副本，恢复对应配置，再使用卸载前快照。配置备份限最近八份，作者仍应保留原文件。源码回退基线为上述 `f51240bc`，代码回退不能替代恢复存档或配置。后续公开发布须从不可变源码/制品重新满足目标平台门禁。
