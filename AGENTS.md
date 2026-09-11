# DSP极简网络 / DSPidle2

项目身份、指令路由和硬边界。详细流程只维护在主 Skill 中。

## 身份

戴森球计划风格的 2D 生产网络挂机游戏。仓库根目录同时包含 `package.json`、`src/`、`server/` 与 `deploy/`。当前工作树的 `package.json.version` 只描述本树源码，不代替 `docs/PROJECT_STATUS.md` 中带日期的生产记录。

## 指令路由

| 层级 | 路径 | 作用 |
| --- | --- | --- |
| 本入口 | `AGENTS.md` | 身份、路由、只读/写入边界、未提交工作保护、生产和敏感数据底线 |
| 主 Skill | `.codex/skills/develop-dspidle/SKILL.md` | 唯一正文：授权、不变量、实施/测试/交付路由 |
| 角色合同 | `.codex/skills/develop-dspidle/references/agent-roles.md` | 审阅 / 开发 / 发布边界与交接字段 |
| 职责地图 | `.codex/skills/develop-dspidle/references/project-map.md` | 按任务打开的工作面 |
| 测试选择 | `.codex/skills/develop-dspidle/references/testing.md` | 命令实际覆盖与完成条件 |
| 运维流程 | `.codex/skills/develop-dspidle/references/deployment.md` | 生产、导出、排行榜、VPN、回滚 |
| 受保护能力 | `.codex/skills/develop-dspidle/references/protected-release-access.md` | Android 签名与 HK/SH 传输预检 |
| 发现指针 | `.agents/skills/develop-dspidle/SKILL.md` | 兼容执行器的短入口，不另写规则 |

同一条规则只在上表的主要位置维护。历史提示词、`docs/releases/`、第三方依赖说明和会话记录不是最高优先级指令。

**加载说明：** 当前 Grok 执行器会自动加载仓库根目录的 `AGENTS.md`（已按 Grok 项目规则文档核验）。Grok 的 Skill 发现目录包含 `.agents/skills/`（已核验），**不包含** `.codex/skills/`。`.codex/skills` 仍是正文和既有脚本的单一来源；**Grok 对 `.codex/skills` 的自动加载：未验证自动加载。** 其他执行器（例如历史上的 Codex）可能扫描 `.codex/skills`，不能假定所有模型都会自动读取同一目录。显式读取方法：打开 `.codex/skills/develop-dspidle/SKILL.md`，再按任务打开其引用。

未批准的权限放宽只存在于 `docs/feedback/skill-v2-permission-proposals.md`，不是生效规则。

## 只读与写入

- 审阅、分析、分类请求：只读源码、测试、文档和附件；不修改 `src/`、`server/`、`native/`、发布目录或生产状态。
- 用户直接提出的本地实现或修复请求：按开发角色连续调查、修改、验证和汇报，不额外索要反馈交接书。
- 发布、签名、生产 SSH、下载页和玩家数据操作：需要明确目标与发布授权。开发完成不是发布许可。
- 不得静默把审阅会话升级为修改，也不得把本地开发升级为生产操作。

## 未提交工作

开始前运行 `git status --short`。已有暂存、未暂存、未跟踪改动和其他 Agent 的工作一律视为应保护对象。禁止用 reset、clean、checkout、历史重写或覆盖来制造干净工作树。无关改动不要求整项任务停止；重叠文件先隔离或协调。

本工作树若显示 cherry-pick / rebase / merge 进行中，不要为整理指令而 abort、continue 或 skip 他人序列。

## 生产和敏感数据底线

- 不修改生产环境、账号和真实玩家数据。
- 不读取、打印或提交密钥、口令、token、证书、SSH 目标、存档正文或敏感日志。
- 不执行签名、部署、排行榜处置或玩家云档导出，除非用户对本目标给出明确授权，并且角色是 release。
- 不 push、不打发布标签、不触发远程发布工作流、不操作正式更新源。
- 凭据可用不等于获准操作。代码回滚与数据库回滚不是同一授权。
