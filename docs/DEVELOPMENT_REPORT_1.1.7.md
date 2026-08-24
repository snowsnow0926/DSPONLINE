# 1.1.7 开发报告

日期：2026-08-24  
状态：开发完成候选，未发布、未部署。

## 任务

在不影响正在发布的 1.1.6 的前提下，修复空间站合同重复 ID 导致的云存档拒绝，修复反馈存档的 v30→v47 稀疏上传兼容，并开放安全的内容包自定义建筑托盘目录。

## 工作树与版本

| 项目 | 值 |
| --- | --- |
| 工作树 | `D:\GameDev\DSPidle2-v117-development` |
| 分支 | `codex/1.1.7-contract-mod` |
| 基线 | 1.1.6 commit `4f6d24f` |
| 目标版本 | `1.1.7` / Android `1001007` |
| 协议 | GameState v47 / envelope v2 / cloud schema v8 / SQLite layout v3 |
| 生产状态 | 未访问、未写入、未切换 |

## 根因与实现

### 云存档

- `src/game/stationContracts.ts` 在载入时先规范化 history，再把 history/`settledIds` 合并为奖励 fence；重复 active entries 只保留可领取的一份，已结算奖励不会被重新领取。
- `server/station-profile.mjs` 将合同 ID 唯一性拆为集合内唯一和跨集合语义检查：accepted/history、offer/accepted 或不带结算 fence 的碰撞仍非法；仅允许 exact identity 的旧版 offer/history 重叠。
- `server/index.mjs` 对 v47 量子端点的缺失 `quantumMode` 使用契约默认 `legacy`，显式 `null`、未知字符串和非法 transition 仍拒绝。这样不需要改变正文或 checksum。

### Mod 托盘

- `src/game/content.ts` 导出运行时施工目录和通用安全分类。
- 桌面 `GamePanels.tsx` 与移动 `MobileFactoryPanels.tsx` 移除静态核心白名单，使用同一运行时目录；核心顺序不变，内容包新增条目稳定追加。
- `docs/MODDING.md` 明确 `belts` 与 `kind: "splitter"` 的边界、成本/科技门禁和停用风险。没有开放脚本、端口几何、燃料、采矿目标或新事件。

## 变更文件摘要

- 服务端：`server/index.mjs`、`server/station-profile.mjs`、对应回归测试。
- 游戏逻辑：`src/game/stationContracts.ts`、`src/game/content.ts`、存档/内容包/合同测试。
- UI：桌面和手机施工托盘、1.1.7 发布说明及历史版本入口。
- 工程：版本元数据、E2E 当前 release ID、Mod 文档和本候选记录。

## 实测门禁

以下数字是本候选工作树中实际运行的结果；在最终 clean commit/build 后应再复验一次：

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| focused Vitest（合同、存档、内容包、发布说明、手机托盘等 6 文件） | 127 通过 / 0 失败 |
| full Vitest | 1,466 通过 / 21 条件跳过，0 失败 |
| `npm run test:server`（此前核心套件） | 376 通过 / 2 可选跳过；station 4/4 通过 |
| `npm run test:ops` | 56 通过 / 6 Linux-only 跳过 |
| `npm run test:native` | 25/25 通过 |
| `npm run licenses:check` | 通过；125 个运行时包通知已检查 |
| focused/full Chromium E2E | focused 30 通过；full 428 通过 / 26 条件跳过，0 失败 |

全量 E2E 中出现的 Vite proxy `127.0.0.1:65534` 和 ResizeObserver/React Flow warning 是既有测试环境诊断输出，不是失败。最新服务端测试增量、最终构建和清单会在候选提交后补入本节。

## 新增回归覆盖

- 受影响的重复 `offer`/`accepted`/`history` 形状和历史奖励 fence。
- HTTP cloud upload：v47 缺失 `quantumMode` 接受，显式 `null` 返回 `SAVE_FORMAT_INVALID`。
- 客户端 `migrateGame`/`exportGame` 往返不丢合同历史。
- 内容包自定义 splitter 建筑进入动态目录并归入 logistics。
- 当前发布说明切换为 1.1.7，同时保留 1.1.6 历史页。

## 风险、回滚与未验证项

- 缺少或版本不匹配的内容包仍会阻止存档载入；本候选没有静默删除 Mod 实体。
- 服务端兼容默认只针对 v47 且字段缺失；旧 v45/v46 非法字段行为保持原样。
- 未执行生产部署、真实 Linux/systemd/Nginx 切换、Android 长期证书签名、Windows 签名、公网下载和玩家数据写入；这些由 Release Agent 在独立 clean checkout 完成。
- 回滚为保留 1.1.6 current/previous 指针并不切换本候选；客户端若未安装 Mod，继续沿用既有缺少内容包保护。
