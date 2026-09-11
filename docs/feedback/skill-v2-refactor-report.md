# Skill v2 A 类整理报告

本轮按 `DSPONLINE_Skill_V2_Refactor_Agent_Prompt.md` 实施。没有提交、没有 push、没有生产操作、没有改游戏业务逻辑。

## 1. 实际基线与有效规则

| 项 | 值 |
| --- | --- |
| 仓库 | `D:\GameDev\DSPidle2` |
| 分支 | `codex/1.0.46-save-recovery` |
| HEAD | `4e207c3495ed66ff73f0b5bedca9c4ba1826df28` Harden release probes with disk headroom and bounded concurrency |
| 工作区 | `git status` 开始时 clean；存在 **cherry-pick in progress**（`no-commit`，剩余 `190b680`、`3b6fa4d`） |
| 历史审阅参考 | `857947993538b88952a26feca620565bab1b6726`（1.2.7），未切回 |
| `package.json.version` | `1.0.46` |
| `native/Cargo.toml` | 本树不存在 |

开始时无已暂存/未暂存/未跟踪文件。未 abort、continue 或 skip 该 cherry-pick。未覆盖其他 Agent 工作。

**有效指令：**

- 执行器全局规则（本会话）
- 新增 `AGENTS.md`（Grok 自动加载：已按 Grok 项目规则文档核验）
- 主正文 `.codex/skills/develop-dspidle/`（Grok 对 `.codex/skills` 自动加载：**未验证自动加载**；显式读取该方法）
- 发现指针 `.agents/skills/develop-dspidle/SKILL.md`（Grok Skill 发现：已核验，本会话已列出该 skill）

**未检查或无法当作本项目最高优先级的位置：** 用户主目录递归扫描、会话历史、全局 `~/.codex` / `~/.cursor` 中与本项目无关的 skill（例如 `eve-audit` 属于另一项目）、父目录 `AGENTS.md`。未修改全局 Git/SSH 或执行器审批配置。

## 2. 修改文件与历史线索

### 修改清单

- `AGENTS.md`（新建）
- `.agents/skills/develop-dspidle/SKILL.md`（新建发现指针）
- `.codex/skills/develop-dspidle/SKILL.md`
- `.codex/skills/develop-dspidle/agents/openai.yaml`
- `.codex/skills/develop-dspidle/references/agent-roles.md`
- `.codex/skills/develop-dspidle/references/project-map.md`
- `.codex/skills/develop-dspidle/references/testing.md`
- `.codex/skills/develop-dspidle/references/deployment.md`
- `.codex/skills/develop-dspidle/references/protected-release-access.md`
- `.codex/skills/develop-dspidle/scripts/check-skill-docs.mjs`（新建轻量检查器）
- `docs/feedback/skill-v2-permission-proposals.md`（新建，B 类，未生效）
- `docs/feedback/skill-v2-refactor-report.md`（本报告）
- `docs/TESTING_RELEASE.md`（Skill 检查命令）
- `docs/PROTECTED_RELEASE_ACCESS.md`（按目标 `-Capability`）
- `docs/PROJECT_STATUS.md`（指令入口交叉引用）
- `docs/ROADMAP.md`（入口交叉引用）

未改 `src/`、`server/`、`desktop/` 业务代码、受保护脚本行为、`package.json` 依赖或任何发布脚本。

### 历史线索核对

| 线索 | 本树结论 |
| --- | --- |
| 主 Skill 只提 approved handoff | 仍成立，已统一为直接实现请求或已批准交接 |
| 每会话一个角色阻碍后续修改 | 仍成立；按 AUTH-01 提案，未写入生效规则 |
| 引用文件把旧版本写成当前 | 仍成立：testing.md 写 1.1.5，deployment.md 写 1.0.38 与磁盘占用。已改为引用带日期出处 |
| 所有 state/simulation 都要 migration | 仍成立，已改为仅持久化结构/语义变化 |
| 所有开发都要完整不可变制品 | 仍成立，已拆日常/本地候选/发布 |
| 能力检查默认 All 缺一项就停 | 仍成立，已改为按目标 `-Capability` |
| 普通文档也要不明 Skill validator | 仍成立：原规则点名 validator 但仓库无此工具。已分开验证并补检查器 |
| 硬性 apply_patch | 仍成立（agent-roles），已改为等效精确编辑 |
| project-map 只有旧 JS 入口 | 仍成立。本树无 Rust crate，地图按实际路径补了 Worker/IPC/保存恢复/服务端，并对 `native/Cargo.toml` 存在时给出条件路由 |
| 代码优先被误读成测试服从实现 | 仍成立，已拆三类依据 |
| test:changed / quick / native 误判 | 仍成立，且与 `scripts/run-changed-tests.mjs`、`package.json` 一致；本树无 `test:native-core` |

没有发现这些线索已被其他 Agent 在本工作树修好。1.2.7 参考提交中的 Skill 字节数与本树相同，故未把参考提交当已修复版本。

## 3. 关键修改表

| 位置 | 原规则 | 新规则 | 理由 | 是否改变授权 |
| --- | --- | --- | --- | --- |
| SKILL 开发入口 | consume an approved handoff | 直接实现请求或已批准交接均有效 | 消除与角色细则冲突 | 否；原细则已允许直接实现 |
| SKILL / roles | 每会话一角色且开发必须出制品 | 保持角色边界；制品只要求发布候选 | 日常开发被发布门禁误伤 | 否 |
| roles 编辑 | 必须 `apply_patch` | 精确、可审查的等效工具 | 不绑定命令名，不绕过审批 | 否 |
| roles 迁移 | 任何 state/simulation 都加 migration | 仅结构或语义变化 | 避免无意义升版本 | 否 |
| testing.md | 复制 1.1.5 生产计数；不明 validator | 按脚本写覆盖；文档 vs Skill 分开 | 事实过时、覆盖误判 | 否 |
| protected-access | 默认 All，任一缺项停止 | `-Capability` 按目标；无关缺失不阻塞 | 脚本已有参数 | 否；目标操作验证未降低 |
| deployment.md | 1.0.38 + 磁盘% 写成当前 | 指向 PROJECT_STATUS / releases | 易变事实单源 | 否 |
| project-map | 主要 JS/React | 六工作面 + 三类依据；Rust 按路径存在性 | 与本树和后续 native 树一致 | 否 |
| openai.yaml | 复述声明角色 | 只指向主 Skill | 单一来源 | 否 |
| AGENTS.md | 不存在 | 短入口 | 当前执行器支持 | 否 |

## 4. 验证

### 4.1 自动运行

```text
node .codex/skills/develop-dspidle/scripts/check-skill-docs.mjs
# note: native/Cargo.toml is absent in this worktree; project-map correctly treats JS engine as simulation authority.
# OK

git diff --check
# 无输出，退出码 0
```

检查器覆盖本任务文件的结构、相对链接、角色放宽是否漏进生效入口、`test:changed`/`test:quick` 文案、以及 deployment 是否仍复制 1.0.38 基线。

未运行游戏 Vitest、Cargo、E2E、打包或发布流程。未执行 `test-protected-release-access.ps1`（本轮无生产访问必要）。

### 4.2 人工场景推演

| 场景 | 检查方式 | 预期 | 结果 |
| --- | --- | --- | --- |
| 用户只要求审阅 | 人工读 AGENTS/roles | 不改源文件 | 通过（规则） |
| 用户直接提出本地修复 | 人工读 SKILL/roles | 不额外要交接书，连续调查修复验证 | 通过（规则） |
| 审阅后同会话追加实现 | 人工读 roles + 提案 | AUTH-01 未批准时保持只读 | 通过（规则）；未做真实执行器行为验证 |
| 只改 README 一句话 | 人工读 testing.md | 不跑 Cargo/全量 E2E | 通过（规则） |
| 只改模拟源码、测试文件没变 | 人工读 testing.md + `run-changed-tests.mjs` | 不以空 test:changed 为通过 | 通过（脚本注释与新文案一致） |
| Windows 本地任务缺 Android 凭据 | 人工读 protected-access | 不索取无关凭据 | 通过（规则） |
| Rust 进程在、权威门禁关 | 人工读 project-map | 区分进程/模式/资格，不擅自开门禁 | 通过（规则）；本树无 Rust |
| 别的 Agent 有未提交工作 | 实际 git status + cherry-pick | 保护并隔离 | 通过：未动 sequencer |
| 本地检查通过但无发布授权 | 用户限制 + AGENTS | 不 push、不签名 | 通过（本轮遵守） |
| 存档语义将变 | 人工读 SKILL/roles | 澄清并保留迁移 | 通过（规则） |
| 一项验收无法执行 | testing.md | 标记缺口，不虚报 | 通过（规则） |
| 实现与契约冲突 | project-map 三类依据 | 不直接改测试迎合错误实现 | 通过（规则） |
| 新 Skill 允许更多动作 | 对照提案 | 只进提案 | 通过：AUTH-01/02/03 仅提案文件 |
| 执行器仍要受保护工具审批 | protected-access | 遵守，不绕过 | 通过（规则） |

以上为静态与人工场景检查。**未进行真实隔离 Agent 行为验证**，不能写成“所有 Agent 行为已验证”。

### 4.3 人工语义审阅

- 没有新增默认生产授权。
- 没有把 Playwright/临时 SQLite 写成生产规则。
- 没有把 AUTH-01/02/03 混入 `AGENTS.md` 或主 Skill。
- `.codex/skills` 路径未搬动，受保护脚本引用保持原路径。
- Windows `NotSigned`、Android 证书连续性、备份/原子切换语义保留。

## 5. B 类提案索引

文件：`docs/feedback/skill-v2-permission-proposals.md`

- AUTH-01 同会话 feedback → develop
- AUTH-02 本地提交/分支/工作树默认授权
- AUTH-03 审阅角色临时复现与诊断产物

**未进入生效规则。本轮 Agent 未采用这些权限。**

## 6. 未解决问题与加载缺口

- 本工作树仍处于 cherry-pick in progress；未处理剩余 pick。
- Grok 对 `.codex/skills` **未验证自动加载**。依赖 `AGENTS.md` + `.agents` 指针 + 显式读取。
- 本树无 `native/`。Rust 路由是条件条款；1.2.7 工作树的真实 native 地图未在本树展开为文件级清单，以免杜撰路径。
- `docs/PROJECT_STATUS.md` 自身仍有多份互相覆盖的历史“当前生产”段落；本轮只加了入口说明，没有重写版本史，也没有实测线上。
- 未验证 Cursor/Codex 是否同时自动加载 `AGENTS.md` 与 `.codex/skills`（可能重复进上下文）。若冲突，以 canonical Skill 为准，不要再复制一份正文。
- 无提交权限，故无 commit。审查应看本轮 diff，不要把 cherry-pick 序列中的他人提交算进来。
