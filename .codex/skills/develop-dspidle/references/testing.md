# Testing Matrix

命令含义以当前工作树的 `package.json` 和脚本为准。历史计数、线上版本和某次发布门禁规模写在 `docs/TESTING_RELEASE.md` 与 `docs/releases/`，不要把它们复制成 Skill 里的“当前基线”。

## 命令实际覆盖

先读脚本再选择。名称不等于覆盖范围。

| 命令 | 本树实际行为 | 能证明 | 不能证明 |
| --- | --- | --- | --- |
| `npm run typecheck` | `tsc -b` | 当前 TS 工程类型 | 运行时行为 |
| `npm test` | `vitest run` | 游戏单元/领域测试 | 服务端、运维、浏览器、Cargo |
| `npm run test:unit:fast` | Vitest `--maxWorkers=4` | 同上，更快但不改变用例集合 | Windows 大套件仍可能受内存约束；正式门禁另有配置 |
| `npm run test:server` | `server` 测试 + `test:station` | API、临时 SQLite、空间站服务测试 | 生产库、真实账号 |
| `npm run test:ops` | `deploy/*.test.mjs` 有界并发 | Nginx 模板、探针、备份工具、切换逻辑的本地合成测试 | 真实 systemd/Nginx 主机 |
| `npm run test:quick` | typecheck + server + ops | 类型、服务端、运维工具 | **不含** 游戏 Vitest、Cargo、E2E |
| `npm run test:changed` | `scripts/run-changed-tests.mjs` | 工作区里**被改动的测试文件**本身 | 源码依赖影响。只改源码、测试文件未变时它会以 0 个测试退出 0，**不等于功能验证通过** |
| `npm run test:native` | Node 测试：`scripts/`、`desktop/`、`android/` 发布与边界工具 | 包装、通道、安全边界、本树列出的 native 工具测试 | **不是** `cargo test`。本树无 `test:native-core` |
| `npm run test:native-core` | 仅当 `package.json` 与 `native/Cargo.toml` 存在 | Rust Core/Host 单元测试 | JS 游戏、E2E、包装签名 |
| `npm run test:e2e` | Playwright | 浏览器旅程 | 未选中的浏览器、未跑的平台 |
| `npm run test:e2e:fast` | grep 子集 | 云/存档/离线/PWA/排行榜相关 E2E | 全量 UI 矩阵 |
| `npm run test:e2e:durable` | 打开 durable 标志的指定 spec | 显式 WAL/recovery 开发路径 | 默认 verified-primary 生产路径 |
| `npm run licenses:check` | 第三方通知一致性 | 许可证文本 | 功能正确 |
| `npm run build` | `tsc -b` + Vite + startup budget | 生产构建与预算 | 安装器、签名、线上健康 |
| `npm run desktop:pack` / `desktop:dist` | Electron 未签名包 | 本机可启动包 | 正式签名或 stable 更新源 |
| `npm run android:debug` / `android:release:unsigned` | 调试或未签名包 | 本机构建 | 正式证书连续性 |
| CI `unit` / `server-ops-native` / `build` / `e2e` | `.github/workflows/ci.yml` | 对应 GitHub 作业 | 本地未跑 CI 时不能抄作业结果 |
| `release-gate.yml` | 发布工作流 | 正式发布门禁 | 未经授权不得触发 |

若后续工作树增加 `test:native-core`，按该树 `package.json` 更新理解：`test:native` 与 `test:native-core` 不能互相替代。

## 按影响选择

| 变更 | 日常开发最小验证 | 发布候选另加 |
| --- | --- | --- |
| 普通文档 | 改动文件的链接、`git diff --check` | 无。不要跑无关 Cargo/E2E |
| 本 Skill / `AGENTS.md` | 上项 + `node .codex/skills/develop-dspidle/scripts/check-skill-docs.mjs` | 无 |
| 本地 UI/样式 | typecheck、build、相关 E2E 或截图 | 桌面 + 竖屏 + 横屏；字体相关加 80/100/125/150/200% |
| 内容/配方/科技 | typecheck、相关 Vitest、内容/progression 审计、相关 E2E | 全量单元 + 构建 |
| 引擎/物流/电力 | typecheck、相关或全量 Vitest、相关 E2E | 全量 E2E |
| 存档/迁移/IPC/恢复 | 全量单元、旧档夹具、相关 E2E；durable 仅在改了该路径时 | 全量 E2E；结构/语义变化才加 migration |
| JS 模拟源码但测试文件未改 | **不要**用空的 `test:changed` 当通过。选相关 Vitest/E2E | 风险对应全量 |
| 服务端/SQLite | `test:server`、新失败路径、`test:ops`、typecheck | 构建；仍用临时库 |
| Rust Core/Host（若存在） | `test:native-core` 与相关 JS 对照 | `test:native`、覆盖清单、权威门禁证据 |
| 本地候选 | 上列风险矩阵 + 可追溯提交 | 制品可选 |
| 正式发布 | `docs/TESTING_RELEASE.md` 的完整门禁 | `npm ci`、typecheck、全量单元、server、ops、native、build、全量 E2E、部署 smoke；适用的签名与下载哈希 |

许可证、依赖或公开政策变更另跑 `npm run licenses:check`。

## 性能与正确性

必须分开记录，不能互相替代：

- 同一输入、相同配置下的核心耗时与端到端收益。
- 单进程内存、完整进程树内存、加载峰值和稳态。
- 稀疏与稠密工厂、合成与真实存档、线程数和运行模式。
- 代码存在、影子模式启用、玩家权威启用、发布资格。

不能通过少算时间、漏算合法工作、放宽浮点容差、减少物料或降低预算得到通过。无法建立可靠对照时报告无可靠结果。

## 失败、缺口与旧结果

- 测试失败保留首轮证据并说明根因。修复后重跑相关检查。
- 无新证据的重复重试不能写成验证。
- 旧结果必须注明所属提交与环境，不冒充本轮。
- 分别记录未执行、失败、跳过、超时、人工检查。
- 一次静态检查不能证明游戏运行正确。一次模型自查不能等同真实行为测试。
- 一项实机或外部验收无法执行时，标记缺口与影响，不虚报通过，也不否定已完成的独立部分。

## 强制回归主题

在相关变更中保留：

- 既有存档加载不丢库存、实体、传送带、科技、蓝图或队列。
- 同一状态与 elapsed time 保持确定。
- 可见库存为非负整数。
- 同一建筑和跨槽位的第二、第三条有效线路。
- 配方变更、升级、拆除保留或退还物料。
- Worker 与主线程 fallback 同规则。
- 节点移动时线路实时更新；建筑卡片挡住点击穿透。
- 移动方向保留视口、选择和面板。
- 云冲突不静默覆盖任一侧。
