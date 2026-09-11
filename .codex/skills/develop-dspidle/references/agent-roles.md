# DSPidle Agent Roles And Handoffs

角色是权限边界，不是人格标签。一个角色可以检查完成其工作所需的任何材料，但只能改动下列范围内的文件和系统。

同会话角色转换、默认提交授权、审阅角色写诊断产物等放宽项见 `docs/feedback/skill-v2-permission-proposals.md`。那些提案在获得对相应项目的明确批准前不是生效规则。

## Role declaration

在对话开始声明其一：

```text
Role: feedback
Role: develop
Role: release
```

用户未声明时，只从无歧义请求推断：审阅/分析/分类 → feedback；直接实现或修复 → develop；发布、签名、生产 SSH、下载页或玩家数据操作 → release。请求跨角色时，停在当前边界并产出交接，不要静默做下一角色的工作。

直接实现请求足以作为开发依据，不要求再批准一份反馈交接书。这不等于可以把已经开始的只读审阅自行升级为改代码。

## Shared handoff contract

按相关性填写。允许 `unknown` 或 `not-applicable`，并说明真实缺口。不要为填满表格临时扩大任务。

```text
Task ID / title:
Priority:
Source and attachments:
Reproduction or observed evidence:
User-visible acceptance criteria:
Compatibility and data-preservation constraints:
Target platforms:
Required tests:
Release target and version:
Known risks / rollback:
```

开发交接在相关时追加：

```text
Commit SHA:
Changed files:
Artifact paths:
Manifest and aggregate hash:
Tests with exact counts:
Unverified gaps:
```

不需要安装器或制品的任务，将制品字段标为 `not-applicable`，并说明原因。不要因为缺少安装器而否定文档或 Skill 任务。

发布报告在相关时追加：

```text
Target node(s):
Pre-release backup and verification:
Previous and new release directories:
Atomic switch result:
Health / smoke checks:
Download-page and package checks:
Rollback command or pointer:
Residual risk:
```

## Feedback / analysis role

1. 读 `docs/PROJECT_STATUS.md` 的相关摘要和任务对应的 canonical 文档后再下结论。
2. 只读检查附件、日志、诊断和源码。用存档副本复现；不要上传玩家存档，不要写生产。
3. 分开已确认事实、假设和拟议改动。给出 P0–P3（或解释其他优先级）、范围、兼容性和用户影响。
4. 用共享交接字段写简短实现提示。包含精确复现、验收和最小所属模块。
5. 仅在被要求时写入分析或交接文件，优先 `docs/feedback/` 或对应日期规划文档。不要编辑 `src/`、`server/`、`native/`、发布目录或部署状态。

反馈角色不承诺无证据的修复、性能百分比或发布日期。附件缺失、损坏或不足以复现时必须写明。

审阅角色默认只读。会产生文件、网络或启动脚本副作用的复现，仅在现有规则已明确允许，或用户对本项给出明确授权时执行。未批准的 AUTH-03 不得自行采用。

## Development role

1. 依据已批准交接**或**用户直接提出的本地实现/修复请求。阅读当前状态、相关架构/玩法/测试文档，并运行 `git status --short`。
2. 只改交接所需的源码、测试和 canonical 文档。保护无关用户工作。手工编辑使用精确、可审查、不覆盖无关修改的等效工具；不绑定特定补丁命令名称，也不绕过执行器审批。
3. 保持 `GameState`、云 schema、包签名和发布行为不变，除非交接明确授权迁移。**仅当持久化结构或语义变化时**增加 migration、夹具和确定性测试。普通模拟回归、确定性哈希和兼容验证仍然需要，即使不升存档版本。
4. 迭代时跑最小足够检查，再按风险补齐。报告本次实际的通过、跳过、失败和超时计数；不要把历史结果当作本轮结果。
5. 日常开发交付相关 diff、测试证据和未验证缺口。本地候选在任务确实需要时才构建可追溯制品。正式发布所需的不可变 Web/API/native 制品与清单属于发布候选，不是每个开发任务的完成条件。不要 SSH、改生产 symlink、改 live Nginx/systemd 或更新公开下载链接。

测试或构建失败时在开发中修复，或返回阻塞。不要要求发布角色绕过失败门禁。

已授权开发中的调查、必要修改、相关测试和汇报连续执行，不逐步重复询问。先用项目证据消除歧义。低风险、可撤销且不改变验收目标的细节可记录假设后继续。玩法、持久化语义、权限、真实数据、生产目标或显著新范围不明确时，先澄清相关部分。

一项检查阻塞时，暂停依赖它的步骤，继续独立且已授权的工作。数据完整性未知或目标身份不明时，停止整条相关操作链。不能用“按比例验证”削减存档、模拟、认证或正式发布本来必需的安全与兼容检查。

## Release / operations role

1. 需要明确发布目标（香港、上海、下载页或给定子集）、开发提交、制品清单和用户授权。
2. 读 `docs/PROJECT_STATUS.md`、`docs/DEPLOYMENT_OPERATIONS.md` 和 [deployment.md](deployment.md)。变更前检查 live symlink、服务、Nginx、磁盘和回滚指针。
3. 在隔离目录核验制品哈希和包元数据。API/schema 变更时，在第一次生产 mutation 前创建并验证 SQLite Backup API 快照。写测试不得使用生产账号或玩家存档。
4. 上传到新 release 目录，在该目录安装依赖，跑清单校验，用节点原子切换脚本。保持上一 release 和数据库不动。启动或健康检查失败时让脚本回滚，从日志诊断；不要在服务器上热改新 release。
5. 切换后核验本地和公网健康、版本/build ID、缓存头、静态资源、service-worker、下载清单，以及适用的 APK/EXE 签名与哈希和磁盘余量。只根据观察结果更新发布文档。
6. 报告部署证据、回滚目标、剩余风险，以及因签名或制品门禁不可用而未发布的平台。

服务器密钥、PEM、口令、token、数据库内容和玩家存档正文不得进入交接、发布归档、命令输出、文档或聊天。部署请求含糊时，澄清目标前不发布。
