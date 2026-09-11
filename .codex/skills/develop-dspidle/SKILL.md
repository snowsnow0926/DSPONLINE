---
name: develop-dspidle
description: Maintain and extend the DSPidle2 / DSP极简网络 repository across feedback triage, deterministic gameplay and UI development, save migration, cloud accounts, rankings, PWA/Electron packaging, testing, documentation, and Hong Kong/Shanghai release operations. Use when analyzing player reports, implementing or reviewing a change, building artifacts, deploying a verified release, updating the download page, or performing authorized server maintenance.
---

# Develop DSPidle

以当前工作树为事实来源。保护玩家数据和已批准的确定性语义，在现有架构上扩展。详细角色合同、测试矩阵和运维流程分别只在对应引用中维护。

## 适用与非目标

**适用：** 玩家反馈分诊、本地调查与修复、玩法/UI/存档/云账号/排行榜开发、相关测试、文档、PWA/Electron/Android 包装，以及已明确授权的香港/上海发布运维。

**非目标：** 未经需求批准新增战斗或黑雾；把审阅当成开发授权；把本地开发当成生产授权；为改 Skill 而改 `authorityEligible` / `authority_eligible`、玩家数据或生产发布门禁；用更强模型为理由删除数据保护。

## 授权与连续执行

开始时确认角色，见 [references/agent-roles.md](references/agent-roles.md)。未声明时只从无歧义请求推断：审阅/分析 → feedback；直接实现或修复 → develop；发布/生产操作 → release。跨角色时停在边界并产出交接，不静默切换。

- 审阅保持只读。
- 用户直接提出的本地实现或修复请求，或已批准的开发交接，都是开发依据。不要额外索要反馈交接书。
- 已授权开发中的调查、必要修改、相关测试和结果汇报属于同一任务，不逐步重复询问。
- 发布需要明确目标与发布指令。开发结果不是部署许可。
- 同会话从审阅转为开发、默认提交范围等放宽项不是本文件授权；提案只在 `docs/feedback/skill-v2-permission-proposals.md`。

先用项目证据消除歧义。低风险、可撤销且不改变验收目标的细节可记录假设后继续。玩法、持久化语义、权限、真实数据、生产目标或显著新范围不明确时，先澄清相关部分。

存在阻塞时，暂停依赖它的步骤，继续独立且已授权的工作。数据完整性未知、目标身份不明等会影响后续动作安全时，停止整条相关操作链。

## 最小上下文

1. 确认角色并阅读 `references/agent-roles.md` 中对应清单。
2. 确认仓库根目录含 `package.json`、`src/`、`server/`、`deploy/`。
3. 运行 `git status --short`。已有改动和其他 Agent 的工作一律保护；cherry-pick/rebase/merge 进行中时不要 abort/continue/skip 他人序列。
4. 需要陈述当前功能或部署事实时，读 `docs/PROJECT_STATUS.md` 的最新摘要，不要读完整版本史。
5. 按任务打开 canonical 文档和 [references/project-map.md](references/project-map.md)：
   - 架构/跨模块：`docs/ARCHITECTURE.md`
   - 玩法规则：`docs/GAMEPLAY_SYSTEMS.md`
   - 测试/包装：`docs/TESTING_RELEASE.md`、`docs/NATIVE_APPLICATIONS.md`
   - 规划：`docs/ROADMAP.md`
   - 服务器或生产：`docs/DEPLOYMENT_OPERATIONS.md` 与 [references/deployment.md](references/deployment.md)
6. 先核对实现和测试，再改代码或文档。实现与文档冲突时，先判断是代码错误还是说明过时。

## 必须保留的不变量

- `GameState` 是持久玩法真相。React Flow 节点/边、UI 投影、缓存、Worker 影子结果和 Rust 影子结果不能形成未受控双写。按实际运行模式识别唯一权威状态所有者。
- 同一状态和同一 elapsed seconds 下 `advanceSimulation()` 必须确定；随机性来自持久种子。
- 玩家可见库存为非负整数。分数只留在隐藏进度累加器。
- 连续发电机是电源，不伪造生产循环。采矿、生产、加工、科研、物流使用周期进度。
- 配方变更、升级、拆除、迁移和加载必须保留输入、输出、燃料、在途和施工库存。
- 建筑和物流槽允许多条有效线路。不得假定第一条连接拥有整个实体。
- 保留显式配方和槽位选择。只对未配置且兼容的目标自动配置。
- 传送带画在建筑卡片之下；卡片指针事件不得穿透到后方传送带。
- 鼠标与触摸模拟相同。共享 UI 检查竖屏、横屏和 80/100/125/150% 字体。
- 含扩展 ID 的存档先启用内容包再迁移。内容包兼容按真实注册表处理。
- 未解锁施工默认隐藏，除非需求明确改变。
- 公开存档契约与平台私有保存实现分开管理。只有持久化结构或语义变化才升级 `GameState.version` 并扩展 `migrateGame()`；回归、确定性和兼容验证仍要做。envelope 版本与 game-state 版本分开。
- 不为修改 Skill 而改变 `authorityEligible` / `authority_eligible` 或其他玩家数据、生产发布门禁。
- 不覆盖用户与其他 Agent 的未提交工作。
- 迁移、恢复或性能优化中不得静默清档、丢库存、改历史产出、复制收益或回滚玩家进度。
- 生产、物流、研究、离线和时间扭曲保持已批准的确定性、物料与取整语义。
- 不新增 Dark Fog 或战斗，除非用户明确重开该范围。

## 安全底线

- 不要把 `clearGame()` 当作迁移捷径，也不要从普通导航、新游戏、菜单或更新路径调用它。
- 不要删除、初始化、替换或向 `/var/lib/dsp-idle-cloud` 上传测试数据。
- 不要暴露私钥、口令、token、证书、用户存档正文或备份内容。
- 后端/schema/持久化部署前，用 Backup API 创建并验证 SQLite 备份。
- 代码回滚与数据回滚分开。恢复旧库只作为明确灾备，且先备份当前库。
- 香港生产节点与上海遗留节点独立。不要把上海重定向或代理到香港。
- 非本地 HTTP 页面禁用云凭证。不要削弱 `src/game/cloud.ts` 以支持不安全登录。
- 使用临时数据库与隔离测试目录；不对生产账号或玩家数据做写测试。
- 缺少签名、备份、权限或主机密钥时，停止依赖该能力的动作。不索取无关凭据，不改用弱验证绕过。
- 旧豁免、旧签名策略和旧回滚目标不得自动用于新版本。
- 不能通过删除失败测试、放宽断言、篡改数据或虚报结果完成任务。
- 本轮候选规则不得被执行者用来取得原本没有的权限。

## 实施路由

按任务类型选择最小改动面，细节见 project-map：

- **玩法/内容：** 同步 ID、定义、来源用途、建筑、科技、施工、手搓可见性、规划、迁移和测试。跑目录与 progression 审计。不要加仅展示内容。
- **模拟/物流：** 优先纯函数和既有引擎命令。覆盖正常、缺料、堵输出、停电、多线路、整数结算、离线和确定性哈希。
- **UI：** 复用现有选择器、hooks、图标、工作区和响应式模式。相关项检查指针捕获、穿透、拖拽预览、缩放端口、触控、溢出、reduced motion 和方向。
- **存档/内容包：** 结构或语义变化才升版本。从上一生产状态扩展 `migrateGame()`，内容包启用时保留未知但合法的扩展 ID，并加迁移夹具。
- **云/服务端：** 验证认证、体积、来源、限流、冲突、持久化、重启和错误响应。测试用临时 SQLite。
- **发布：** 只在 release 角色且用户明确授权后，遵循 [references/deployment.md](references/deployment.md)。账号导出、排行榜处置、VPN 出口和历史回退 URL 的具体步骤不在本文件展开。

手工编辑使用精确、可审查、不覆盖无关修改的等效工具；不绑定特定补丁命令名称，也不突破执行器审批。

## 测试与交付

读 [references/testing.md](references/testing.md)，按影响选择检查。不能用“按比例验证”削减存档、模拟、认证或正式发布本来必需的检查。

| 完成档 | 要求 | 不要求 |
| --- | --- | --- |
| 日常开发 | 相关类型检查、受影响测试、说明未跑项 | 完整不可变 Web/API/native 制品、安装器、生产探测 |
| 本地候选 | 风险对应的测试矩阵、可追溯提交、已知缺口 | push、签名、生产切换 |
| 发布候选/正式发布 | 完整门禁、不可变制品与清单、备份、原子切换、健康与回滚 | 用历史豁免或未跑检查冒充通过 |

文档或 Skill 改动：相关链接检查、`git diff --check`；Skill/指令改动另跑 [scripts/check-skill-docs.mjs](scripts/check-skill-docs.mjs)。不要为纯文档任务跑无关 Cargo 或完整浏览器套件。

普通开发结束于开发交接或本地结果说明。不要 SSH、改生产 symlink、改 live Nginx/systemd，或更新公开下载页。发布 closeout 只根据观察结果写 `docs/releases/<version>.md` 并核对现状文档。

## 受保护能力触发

仅当当前任务真正需要 Android 签名或香港/上海传输时，读 [references/protected-release-access.md](references/protected-release-access.md)，并用已有 `-Capability` 参数预检**该目标**。无关能力缺失不是本任务阻塞。能力不等于授权。

| 触发 | 入口 | 权限 |
| --- | --- | --- |
| Android 正式签名 | [scripts/invoke-protected-android-release.ps1](scripts/invoke-protected-android-release.ps1) | 明确发布授权；Windows 保持 `NotSigned` |
| 香港/上海 SSH | [scripts/invoke-protected-ssh-script.ps1](scripts/invoke-protected-ssh-script.ps1) | 明确目标与运维授权 |
| 单账号只读云档导出 | [scripts/export-hk-cloud-save.ps1](scripts/export-hk-cloud-save.ps1) | 只读；流程见 [deployment.md](references/deployment.md#single-account-read-only-cloud-save-export) |
| 单账号排行榜动作 | [scripts/invoke-hk-leaderboard-action.ps1](scripts/invoke-hk-leaderboard-action.ps1) | 默认 dry-run；流程见 [deployment.md](references/deployment.md#single-account-leaderboard-only-action) |
| 夜间只读复核报告 | [scripts/report-hk-leaderboard-reviews.ps1](scripts/report-hk-leaderboard-reviews.ps1) | 只读；检测与处置分离 |

本地 `npm run server:dev`、Playwright 临时 Vite、临时 SQLite 测试不是生产 server action，不产生生产授权。
