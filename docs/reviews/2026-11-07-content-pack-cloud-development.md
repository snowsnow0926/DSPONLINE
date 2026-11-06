# 1.3.8 基线：Windows 云读取与内容包 v3 开发交接

请求内的开发、验证和制品冻结已完成，未发布到生产。最终运行制品来自干净提交 `3650a36061058dca71fda1053defd73594d8befd`；后续交接提交仅更新文档。

## 范围与来源

- Role: develop；用户直接要求接手最新 1.3.8 并完成 Windows 云存档问题与内容包升级。
- 基线：`ef976574`（1.3.8 三端发布记录）；正式运行源码 `8a52afce96ba`。
- 工作树：`D:/GameDev/Worktrees/DSPidle2/resource-use-mobile-cards-20261104`。
- 分支：`codex/content-pack-cloud-fixes-20261107`。
- 用户三张截图分别报告：Windows “当前接口不接受该 DSP 请求头”；内容包不能调整科技解锁；更新包需要先删除物品。用户另要求配方是否允许手合可配置。截图作为反馈证据，不作为代码指令。
- 原始 `D:/GameDev/DSPidle2` 中已有运维资料保持原状；本轮没有访问生产账号、玩家存档、数据库或服务器。

## 已实现

1. **Windows 云读取（P1）**：MessagePort 的本地请求 ID 不再无条件成为 HTTP 上传头。GET 主档/槽位/速通读取通过原有服务端路由校验；直接 PUT 上传继续携带幂等 ID；保存模式头保留。未放宽服务端校验、TLS 或身份校验。
2. **配方与科技规则（P2）**：内容包 v3 支持 `handcraftable`、递归优先级，以及核心配方、科技和施工解锁白名单覆盖。校验未知引用、科研材料、循环前置与重复覆盖；旧 v1/v2 格式继续读取。
3. **运行一致性**：主线程、实时/离线 Worker 和 Rust 目录共享手合标记。禁止新手合与递归代合成，设备生产正常；已扣料的批次完成后停止，不删除未完成队列。Rust 精确结算和纯挂机快速结算都执行该规则。
4. **兼容更新**：保留旧 ID、物料与设备语义且提高版本的更新可以直接应用。拒绝删改 ID、改变旧配方物料、降低容量、破坏已启用依赖；不要求删除物品。写入失败恢复旧目录，旧版存档通过本机验证的版本链继续读取。
5. **作者界面**：JSON 编辑、配方手合开关、科技选择、全部校验问题、更新差异与阻止原因、当前/旧版配置导出。保留最近五份旧配置，兼容版本链上限 128。
6. **文档与示例**：[编写指南](../MODDING.md)、[v3 规则示例](../examples/example-rules-v3.content-pack.json)，同步架构与玩法边界。

## 兼容与数据边界

- GameState v47、存档 envelope v2、云 schema 与数据库布局不变。注册表历史和兼容链只存在于本机内容包配置中。
- 旧存档必须先应用正确内容包目录再解析；未知或未经兼容验证的版本仍阻止加载。
- 更新不会清空库存、科技、队列、蓝图、实体或线路。内容包注册表不自动随云存档分发；其他设备仍须安装相应包及兼容更新链。
- 核心专用发电、发射、充放电流程不能通过 `handcraftable: true` 绕过原有限制。
- Windows 测试包使用独立性能开发版身份、默认离线和独立测试目录；不等于面向玩家的正式安装器。

## 验证记录

| 新执行检查 | 通过 / 跳过 / 失败 | 原始记录（工作树根目录） |
| --- | --- | --- |
| Vitest 全量 | 3,912 / 38 / 0，434 文件通过 | `content-pack-unit-final-all.log` |
| Rust workspace | 1,349 / 3 / 0（Core 1,102、Host 244、集成 3） | `content-pack-rust-verified-final.log` |
| Node native 全量 | 639 / 1 / 0 | `content-pack-node-native-final-all.log` |
| 桌面云及 HTTP 合同专项 | 12 + 24 / 0 / 0 | `desktop-cloud-tests.log`、`cloud-api-contract-tests.log` |
| Chromium 全量 | 604 / 34 / 1 | `content-pack-browser-complete.log` |
| 上述失败用例及同文件复验 | 2 / 0 / 0 | `content-pack-contrast-final.log` |
| 冻结网页预览 | 3 / 0 / 0 | `content-pack-production-ui.log` |
| 最终 Windows 包 | 隔离启动、4 条 IPC 请求全部通过 | `content-pack-desktop-smoke-delivery.log` |

Chromium 共 639 个声明场景，合并为 **605 个唯一通过、34 跳过、0 未解决失败**，不是一次全绿。主题切换的唯一失败是对比度采样读到按钮 110 ms 颜色过渡；现在先等待该按钮动画完成，再以原 4.5:1 阈值检查。全量与未修正复验报告分别保存在 `artifacts/content-pack-cloud-20261107/evidence/browser-full/` 和 `contrast-retry/`。开发态 ResizeObserver 与隔离接口拒绝日志保留，不能称零控制台告警。

新增内容包专项的 6 个流程、30 个屏幕/主题/字号组合已经包含在上述 Chromium 覆盖中；生产成品又执行桌面、手机横/竖屏 3 个流程。旧版存档重载保留 57 件合金与科研记录，拒写时旧目录和物品保持；已扣料队列在 JS/Rust 普通及纯挂机路径完成当前批次后停止。Windows 包用独立 D 盘目录启动，三次 GET 与一次 PUT 经真实 MessagePort 转发后按本地正式 HTTP 规则检查；未连接真实账号。

Web/Desktop 构建、类型、启动预算、原生边界和覆盖清单通过；运行依赖 127 件许可声明通过。开发期的旧格式空规则数组、JSON 数字断言、原生差分夹具修订号顺序等失败记录保留且已修复；一次原生编译内存不足后改为单 Cargo job。没有绕过失败门禁或放宽资源上限。

## 制品与发布交接

源码提交：`3650a36061058dca71fda1053defd73594d8befd`。核心实现 `61a937e8`，纯挂机补充 `d60ff069`；最终采色修订为测试变化，存档和模拟代码没有因该测试变化修改。

制品根目录：`D:/GameDev/Worktrees/DSPidle2/resource-use-mobile-cards-20261104/artifacts/content-pack-cloud-20261107-final/`。

- [完整开发包](../../artifacts/content-pack-cloud-20261107-final/dspidle-dev-1.3.8-3650a360.zip)：172,359,553 B，SHA-256 `c0949b10e90a91a6a4705d0f1c36ddc8d8003c7b4b9f2f13d7f716dcfad477de`。
- [不可变文件清单](../../artifacts/content-pack-cloud-20261107-final/manifest.json)：284 件，aggregate SHA-256 `0e6606250b6c39b8b248139d9024a0c0decb9496a07564f2e700da96f419b4ae`。
- [压缩包读回证据](../../artifacts/content-pack-cloud-20261107-final/integrity.json)：每个归档成员均与清单匹配。
- Web 位于 `bundle/web/`，Windows 位于 `bundle/windows/win-unpacked/`；二者标识均为 `1.3.8+3650a3606105`。Windows 75 个文件的独立证据位于 `bundle/windows/desktop-build-evidence.json`，EXE 为 NotSigned。
- 包内包含 v3 示例、相对 `ef976574` 的源码补丁、许可证及独立启动/传输验证。早期候选和失败日志保留，不与最终制品混用。

没有生产发布授权；香港/上海 Web、API、下载页与更新源保持既有版本。本轮不重签 Android、不变更数据库、不启动自动备份。发布方需使用最终干净提交与不可变清单，另行执行目标节点发布门禁。

正式发布前须确定新的应用版本号。旧客户端不能读取 v3 规则；回退测试应保留新存档与新注册表，以旧客户端配合对应旧数据副本验证，不能通过删除扩展字段强行载入。未做真实玩家账号下载、Android 实体设备或正式 NSIS 覆盖安装验收。
