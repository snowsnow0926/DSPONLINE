# DSPidle2 1.0.40 Release Agent 交接

> 交接日期：2026-08-13
> 固定运行时源码：`58d3e6f986ec098061a0a2109e149e1065a12c48`
> Build ID：`1.0.40+58d3e6f986ec`
> 开发分支：`codex/1.0.40-leaderboard-ranking`
> 当前生产：Web/API `1.0.39+fb54f2148dd6`；Android/Windows stable `1.0.38`
> 发布状态：**2026-08-13 生产发布 No-Go；精确候选 `1.0.40-58d3e6f986ec` 已撤销，禁止重试**

> Release Agent 于 2026-08-13 获得用户授权后完成本地/远端候选复验、双节点备份和真实 Linux/systemd/Nginx 演练。演练发现发布切换实现存在阻断缺陷；香港灰度未成功激活 1.0.40，并出现用户可见 503/504。两地已完整恢复并复验为 Web/API 1.0.39，上海下载页与原生 stable 仍为 1.0.38，香港 `/canary/previous/` 仍固定指向 1.0.37。完整脱敏证据见 [1.0.40 发布 No-Go 记录](./releases/1.0.40-no-go-2026-08-13.md)。任何修复都会改变运行时源码，必须生成新 Git SHA、新 Build ID、新制品和新交接，不能继续使用本文列出的固定候选。

## 1. 交接结论

1.0.40 总纲中的 BASE、P0、P1、P2、P3 和开发侧 FINAL-01 已全部完成。固定运行时提交来自 clean 工作树，完整自动化为 0 失败；Web/API/source、Windows unpacked 诊断包、Android unsigned APK/AAB、source manifest、候选 SHA-256 清单、CycloneDX SBOM 和 in-toto provenance 均已生成并复验。

开发 Agent 阶段没有连接或写入生产服务器/数据库，没有使用真实玩家账号或玩家存档做写入测试，没有修改排行榜 submission/历史，也没有部署、切流、更新下载站或覆盖任何既有制品。Release Agent 后续获得授权并执行了生产门禁；结果是本候选 No-Go，生产数据仍未恢复、替换或用于玩家写入测试。

交接文档位于固定运行时提交之后的纯文档提交。**任何二进制都必须绑定 `58d3e6f986ec…`，不能把后续文档 SHA 当作运行时 SHA，也不能沿用本 Build ID 重建不同源码。**

### Release Agent 生产门禁结论（2026-08-13）

开发侧自动化结论仍然有效，但真实 Linux 发布门禁证明当前发布实现不可用于生产：

1. `api-handoff-proxy.mjs` 通过 `/usr/local/lib/dsp-idle-release/current` 软链接启动时，`directInvocation()` 只比较 `path.resolve`，进程会把自己当作被导入模块并以 0 静默退出。
2. handoff 单元共享 `/run/dsp-idle-cloud`，但没有可靠保留待切换状态；停止旧 writer 后 `active-start.json` 可消失，新 active entry 随后读取尚未发布的 `switch-state.json` 并退出。
3. `release-switch.mjs` 以 root 执行 `flock` 可创建 `root:root 0644` 的 `writer.lock`，而新 writer 以 `ubuntu` 运行，打开锁文件得到 `Permission denied`；`Restart=on-failure` 又造成快速重启循环。
4. 从无 `/api/ready` 的 1.0.39 回退时，恢复路径先等待完整 ready 超时，不能立即按旧版 health 兼容恢复；旧 1.0.39 重启还会触发即时大库 COS 快照，放大不可用窗口。
5. ext4 不支持 reflink 时，preflight 会对约 3.2 GB 备份执行第二次无上限完整复制；实际在线 Backup API 与过慢备份分别造成 I/O 饥饿和 WAL 保留，不能作为香港大库的默认流程。

精确候选没有成功成为任一节点 current；不得把候选目录存在、preflight 通过或 Nginx 曾短暂引导到 handoff proxy 描述为 1.0.40 已发布。开发返修必须覆盖以上五项，并在隔离 Linux 上用真实 systemd/Nginx、真实权限模型和合成大库完成正常切换、全部失败回滚、重复执行和旧版兼容回滚，持续请求 502/503/504 必须为 0。

## 2. 本版功能与修复

### 银河排行榜本人状态

- `GET /api/leaderboard` 保持匿名 Top 100 与旧客户端兼容。
- 认证 `GET /api/leaderboard/me?category=<category>&seasonId=season_01` 在完整公开 submission 集合中计算本人真实 rank，返回 `status/entry/rank/totalEntries/serverMetrics/latestWindowState`。
- `ranked/hidden/restricted/revalidation_required/missing_main_save/missing_adjacent_revision/interval_too_short/elapsed_not_increasing/valid_zero_production/unavailable` 分离。
- 白糖和实际吞吐都使用结构化相邻 revision 窗口；未知显示 `--`，有效零产出显示 0，59/60 秒边界和已观察秒数明确。
- UI 分开显示服务器认证成绩与本地 60 秒最佳值，Top 100 外显示真实名次。本地值不再冒充服务器成绩。
- 只有普通 `main` 进入银河榜；speedrun 与手动槽不串榜。本版不重算或修改既有历史成绩。

### 大存档与跨端云传输

- 单一传输契约保证 30 MiB 明文存档；约 32 MiB 直接正文/单 revision 上限、65 MiB 旧 JSON 包装/单响应兼容边界、15～60 秒动态客户端超时和 70 秒代理/API 边界均有测试。
- 新上传把原始 envelope 文本作为正文，expected revision/requestId 进入有界请求头；Web/Windows/Android 优先 gzip，压缩无收益或不支持时在同一明文上限内回退。
- Windows 使用 MessagePort 1 MiB 有背压分片。Electron 43 不支持该路径的 ArrayBuffer 零拷贝，因此没有声称绝对零复制。
- 取消/超时/未知结果只以目标 revision + SHA-256 + UTF-8 大小确认；不盲目重传。1.0.39 `{payload, expectedRevision}` raw/gzip 继续接受。
- 1 MiB 以上正文转移到 Worker，单次权威 parse 同时返回完整性、模式、结构、摘要、SHA-256 和排行榜投影。原始正文、checksum、revision、历史和下载字节从不规范化。

### 本地多页、本地容量与恢复

- 同一浏览器配置仅 writer lease 持有页可写；其他页面显示只读/接管状态。Web Locks、BroadcastChannel 可用时加速协调，不可用时仍由 IndexedDB lease/storage 事件保护。
- 每个 `mode + slot` 有独立 revision、fencing token、tombstone 和冲突键。陈旧保存、删除/自动保存、导入/自动保存、刷新急救镜像竞争都不能覆盖已确认新档。
- 页面原位刷新沿用同一 tab identity；复制标签页得到新 identity。崩溃发生在急救正文/metadata 两次写入之间时保留 candidate/persisted 原文，玩家明确选择。
- 本地容量统计覆盖主档、自动/手动/保护快照和导入缓存；自动快照有界，保护快照默认不勾选。StorageManager `persist/estimate` 只提示，拒绝不阻止游戏，实际事务失败保留原档。

### SQLite 原子性、云容量与账号归档

- 每个 mutation 从最新已提交状态创建隔离草稿，SQLite metadata、正文与 operation receipt 同事务成功后才发布内存状态。`SQLITE_FULL/IOERR/BUSY/READONLY`、只读库和五个事务故障点均不产生幽灵 revision/排行榜/审计。
- `/api/ready` 区分可写、最近持久化失败、关闭中；优雅关闭停止新 mutation 并等待请求、备份、裁剪和写队列进入明确状态。
- 默认配额：单 revision 33,553,408 B、单槽 256 MiB、单模式 512 MiB、单账号 1 GiB、每槽最多 20 revisions。上传前返回用量、预计新增、裁剪计划和剩余空间。
- 相同 SHA-256 正文按内容寻址只存一份，revision metadata 独立；layout v2 内双读，旧文本行可批量幂等回填，也可 materialize 回旧正文。
- 新账号归档是流式 ZIP + manifest + 分片正文，支持取消/Range；导入先在临时区完成路径、大小、模式、槽位、revision 和 checksum 校验，再原子提交。旧 JSON 归档继续导入，失败不改账号数据。

### 会话、安全、PWA 与体验

- Web 使用同源 `HttpOnly + Secure + SameSite` cookie，保留旧 Bearer 兼容迁移；迁移失败不删旧 token，成功后才清除浏览器副本。
- Android 令牌进入系统安全存储；系统备份/设备迁移只 allowlist `app_webview/Default/IndexedDB`，凭据、cookie、localStorage、偏好、缓存和私有导出均不备份。
- API 对认证、反馈、诊断、云正文分别实施类型/深度/字节上限；CORS/OPTIONS DELETE、`Vary: Origin`、公开榜字段最小化与 Nginx 安全头已覆盖。
- PWA 只清理 DSPidle2 自己的 cache namespace；保留 current 和 previous-stable 壳，根路径/canary/previous-stable key 隔离，版本检查与网络失败状态明确。
- 开始菜单不静态加载 game-core、FactoryRuntime、flow-vendor、storage、legacyTranslations。共享 Dialog/AlertDialog 提供焦点进入/循环、背景 inert、风险化 Escape、关闭后焦点返回和移动触控边界。
- 新设备可直接选择并恢复 speedrun/main；普通存档不能转速通，速通复制普通后失去速通资格。

## 3. 修改文件与模块边界

相对 1.0.39 基线共修改/新增 301 个文件，约 `+48,780/-2,346` 行。详细逐文件列表使用：

```text
git diff --name-status fb54f2148dd64268ee2c2f39c6774b348e6ea437..58d3e6f986ec098061a0a2109e149e1065a12c48
```

关键分组如下：

| 分组 | 主要文件/目录 | 说明 |
| --- | --- | --- |
| 排行榜与 UI | `server/index.mjs`, `src/game/leaderboard*.ts`, `src/components/GalaxyWorkspace.tsx` | `/me`、结构化窗口状态、服务器/本地分栏 |
| 云传输 | `cloud-transfer-contract.json`, `src/game/apiTransport.ts`, `androidApiTransport.ts`, `desktop/cloud-transport.cjs`, `server/upload-inspection-*` | 30 MiB、gzip、取消、Worker 单次检查 |
| 本地保存 | `src/game/localSaveStore.ts`, `localSaveCoordination.ts`, `LocalSaveWriterBanner.tsx` | lease/fencing、IDB v2、容量与冲突双副本 |
| 云持久化/容量 | `server/cloud-quota*`, `cloud-payload-store*`, `cloud-payload-maintenance*`, `persistence-atomicity*` | 配额、去重、回填/回滚、原子可见性 |
| 账号归档/会话 | `server/account-archive-*`, `web-session*`, `src/game/cloudAccountArchive*`, `webSessionMigration*`, `desktop/account-archive-download*` | 流式 ZIP、原子导入、cookie 迁移 |
| Android 安全 | `android/.../SecureSession*`, `AccountArchive*`, `TextExport*`, `res/xml/backup_rules.xml`, `data_extraction_rules.xml` | 安全存储、导出、只备份 IndexedDB |
| PWA/可访问性 | `public/sw.js`, `src/pwa*`, `src/components/AccessibleDialog*`, `GameDialogProvider*`, `src/styles/*` | 原子缓存、共享焦点边界、样式拆分 |
| 服务端规模/运维 | `server/runtime-indexes*`, `runtime-state-persistence*`, `deploy/api-handoff-proxy*`, `release-switch*` | 索引、增量持久化、单写低中断切换 |
| 字段契约/夹具/CI | `save-field-contract.*`, `scripts/generate-synthetic-save-fixtures*`, `scripts/release-gate*`, `.github/workflows/*` | 稀疏字段统一、1/8/20/29 MiB、SBOM/provenance |
| 文档/版本 | `docs/1.0.40_MAJOR_DEVELOPMENT_PLAN.md`, `PROJECT_STATUS.md`, `ROADMAP.md`, `src/i18n/releaseNotes.ts` | 1.0.40 事实、稳定中英 key、交接 |

P3 只拆分本版触达边界：上传检查、HTTP policy、归档、配额、会话、运行索引/持久化、本地协调、共享弹窗和工作区 CSS 均有窄接口及单测；没有为了减行数重写 engine 或改变玩法顺序。

## 4. 存档结构与旧版本迁移

### 持久格式

- `GameState.version = 46`，不新增必须字段；旧档缺模式仍按既有安全规则归为 `normal`，绝不推断为 speedrun。
- envelope v2 不变。导出仍含版本、模式、槽位、时间和完整性；导入先校验，模式不匹配不静默转换。
- `normal/speedrun` 与 `main/1/2/3` 继续参与本地键、云键、历史、删除、恢复和排行榜资格；普通档不能转 speedrun。
- `save-field-contract.json/mjs` 是投影与服务端验证共同契约。v46 belt 缺失 `lanes/tier/progress` 只在验证读取为 `1/1/0`；显式 null、字符串、0/负数/越界仍拒绝。完整性验证前不改正文。

### IndexedDB

- 内部数据库从 1 原位升级到 2，只增加协调 metadata；现有 object store 与已有存档 payload 字节不变。
- 升级遇到旧连接时关闭并重开；没有租约记录时创建首个 lease，不复制、删除或覆盖存档。
- 生命周期急救 localStorage 镜像与权威 IndexedDB 分离；只有 writerId/fencing/revision/mode/savedAt/checksum 连续时自动提交，其他情况转人工恢复。

### SQLite layout v2 内部演进

- cloud schema 7/layout 2 版本号不提升。新增内容寻址 blob、operation receipt、运行增量状态等内部表由幂等 `CREATE IF NOT EXISTS` 建立。
- 旧 `cloud_save_payloads.payload` 全正文行继续直接读取；回填把它替换为包含 SHA-256/大小的短 alias，并保留 blob 原文。下载输出、checksum、revision 不变。
- 回填必须先备份、dry-run、分批执行并逐条校验；回滚前停止新写，把 alias materialize 为原正文，再验证引用/孤儿/哈希。不要恢复生产数据库。
- 旧单值排行榜复核阈值继续作为 normal 兼容别名，普通/速通新阈值独立。

### 账号归档迁移

- 新 ZIP 不自动覆盖现有账号；全部 entry 校验后才提交。
- 旧 JSON 归档继续接受，但仍执行路径、结构、模式、槽位、revision、正文大小和 checksum 检查。
- 无法确定模式的旧内容只按 normal 处理；不允许改名或修改导出文件绕过 speedrun 规则。

## 5. 离线结算、纯挂机与实时模拟非回归

1.0.40 **没有更改离线或时间扭曲纯挂机的倍率、五分钟后台规则、结算算法、模拟顺序或游戏平衡**。变化只在保存生命周期、冲突防护、Worker 数据传输和对话框可访问性：

- 生命周期保存不再因 `beforeunload/pagehide/unmount` 对同一旧状态重复提交；刷新后只恢复通过 lease/revision/checksum 连续性证明的急救镜像。
- 同一时间区间的现有 `lastSettledAt`/待结算幂等语义保持；没有清缓存、跳产量、补物资或修改矿脉扣除规则。
- 匿名合成差分测试覆盖实时主路径/Worker、离线 Worker、纯挂机、分段与整段、有限/无限矿脉、满缓存、传送带、建筑堆叠、电力、物流、量子物流、流体、副产物和递归制造；状态哈希、物资守恒和非负性通过。
- normal/speedrun 与槽位在保存、恢复和云端继续隔离，速通不获得普通离线状态。

Release Agent 仍需在正式原生签名包和实体设备复测约一小时后台/锁屏、返回前台、自动保存与同区间重复恢复。若发现收益丢失、重复结算、矿脉减少但所有可追踪缓存未增加、负库存或异常大数，立即 No-Go；不得通过清缓存、跳过收益或补发物资掩盖。

## 6. 本地/云兼容矩阵

| 组合 | 开发结论 | 发布复核 |
| --- | --- | --- |
| 1.0.39 Web → 1.0.40 API | 公开榜、旧 JSON 云协议和 Bearer 会话兼容 | 在备份副本 API 复验 |
| 1.0.40 Web → 1.0.39 API | 新能力不可用时安全降级；仅明确协议不识别才回退一次 | 现行 1.0.39 API 只读/合成账号验证 |
| 1.0.40 Web → 1.0.40 API | 直接正文、gzip、cookie、`/leaderboard/me`、归档全部支持 | 灰度前完整矩阵 |
| 1.0.39 Windows → 1.0.40 API | 旧协议和原上限内存档兼容 | 旧安装包合成账号验证 |
| 1.0.40 Windows → 1.0.40 API | 30 MiB、分片、取消和动态超时支持 | 正式 setup、低配与覆盖升级 |
| 1.0.38/1.0.39 Android → 1.0.40 API | Bearer/旧云接口兼容 | 正式旧 APK + 合成账号 |
| 1.0.40 Android → 1.0.40 API | 原生 gzip、安全会话、私有导出和备份边界 | 长期证书签名、模拟器/真机 |
| normal/speedrun × 4 槽 | 本地、云、历史、恢复、删除、自动保存隔离 | 多设备交错复验 |

## 7. 完整测试结果

固定 SHA：`58d3e6f986ec098061a0a2109e149e1065a12c48`。

| 命令/门禁 | 结果 | 耗时/说明 |
| --- | --- | --- |
| `npm ci` | 通过 | 456 packages added；开发依赖图 5 项提示，生产图另审计为 0 |
| `npm --prefix server ci` | 通过 | 75 packages added；0 vulnerabilities |
| `npm run typecheck` | 通过 | 约 14.2 秒 |
| `npm test -- --reporter=default` | 通过 | 129 文件通过/6 跳过；1180/18；0 失败；113.49 秒 |
| `npm run test:server` | 通过 | 343/2；0 失败；37.26 秒 |
| `npm run test:ops` | 通过 | 34/34；10.2 秒 |
| `npm run test:native` | 通过 | 24/24；约 2.6 秒 |
| `npm run licenses:check` | 通过 | 125 个运行时包 |
| 根/server `npm audit --omit=dev --audit-level=moderate` | 通过 | 均 0 生产漏洞 |
| `npm run build` | 通过 | Build ID 正确；首屏预算/禁止模块门禁通过 |
| release/synthetic/probe/version tests | 16/16 | 约 21 秒；1/8/20/29 MiB、SBOM/provenance/action pin/version/probe |
| `DSP_E2E_PORT=4355 npm run test:e2e` | 327/2 | 0 失败；329 总数；851.1 秒 |
| `npm run test:e2e:nightly` | 2/2 | Firefox/WebKit；11.9 秒 |
| production preview PWA | 1/1 | 8 秒 |
| `npm run desktop:pack` | 通过 | 正式 URL，隔离 10 秒 4 进程 smoke |
| `npm run android:release:unsigned` | 通过 | 24.8 秒增量复验；含 lintVital |
| Web/API archive | 通过 | manifest 206/206；API 156/156；临时 SQLite health 200 |

两条 Playwright 跳过是需要 `DSP_CONSTRUCTION_STABILITY_SAVE` 的真实玩家夹具验收；本轮按约束未提供、未读取任何玩家存档。核心路径由固定 seed、匿名、确定性 1/8/20/29 MiB normal/speedrun 夹具覆盖。完整条件跳过扫描记录中还列出其他未触发的真实终局/画布/约一小时夹具声明，不能把它们当作自动化通过。

专项覆盖包括：101/150 账号 Top 100 外真实排名；59/60 秒、无前序、计时不增长、有效零产出；普通/speedrun/main/手动槽；1/7/8/20/28/30 MiB raw/gzip/旧包装；超限、BOM、非法 UTF-8、gzip bomb；取消/超时/断连/关闭；两页交错保存、刷新/复制/崩溃接管；SQLite 故障注入；容量边界；归档损坏/缺项/模式错/磁盘失败；PWA 升级/中断/回退；80%～200% 字号、移动弹窗、axe 和键盘焦点。

## 8. 性能影响

- 28 MiB × 8 上传检查本机约 2.63 秒，最大并行 2、等待 6、8/8 完成；RSS 从约 390 MiB 到 452 MiB，但进程预先持有 8 份输入，不能解释为单请求净开销。event-loop max/P99 约 470/446 ms，需灰度监控。
- 10,000 合成账号 presence 心跳/读约 0.075/0.038 ms；排行榜冷重建/失效重建约 8.82/5.70 ms，热读/本人 rank 是 O(1)。
- 10,000 账号增量状态写 184 B、2 rows、约 0.034 ms；整体 app_state 对照约 3.63 MiB/10.34 ms。该内存 SQLite 数字不等同生产 I/O SLA。
- Web/Windows 首屏 gzip 约 181.3 KiB；Android 入口约 183.9 KiB；低于 200 KiB 总预算，且首屏禁止 game-core 等重模块。
- 大存档上传/归档、PWA 和保存临时对象都设有有界队列/流式路径；没有通过降低模拟频率或少算产量换性能。

## 9. 固定源码与不可变制品

### Source manifest 与供应链

- source manifest：`artifacts/release-manifests/1.0.40-58d3e6f986ec.json`
  - 206 文件（Web 118、API source 88）
  - aggregate SHA-256：`38f5fa8bfecb991fbdffe531a0473eb79a668d977131bedf15438e6845b0cc88`
  - 文件 SHA-256：`4fbbc14afd72e2c383c9941bca04087b010be38ecf230572f9520d44344af9e1`
- candidate manifest：`artifacts/release-packages/1.0.40-58d3e6f986ec/candidate-artifacts.json`
  - SHA-256：`ed4133fe2d0fb593e5e60a1c1bd17fa54c5f0c5cc93bec05f14b40f3a0366bee`
- SBOM：`artifacts/release-gate/1.0.40-58d3e6f986ec-sbom.cdx.json`
  - CycloneDX 1.5；544 components
  - SHA-256：`318bb7c3cd92ebb4e051a25730ab4f8746e1bf7d00b19151909d98687e73849b`
- gate report：`artifacts/release-gate/1.0.40-58d3e6f986ec-gate-results.json`
  - SHA-256：`1538a4f27a892a551d56ceffe7aec6bbade4d280981f7b0590558a69a3965782`
- provenance：`artifacts/release-gate/1.0.40-58d3e6f986ec-provenance.intoto.json`
  - 3 subjects 已验证
  - SHA-256：`b3efbe08371be144939cdf7cdb7af931386834c28513418c20e76c12b7bbc497`

### 候选目录

本机路径：`D:\GameDev\DSPidle2-v140-leaderboard\artifacts\release-packages\1.0.40-58d3e6f986ec`

| 文件 | 字节 | SHA-256 | 用途 |
| --- | ---: | --- | --- |
| `1.0.40-58d3e6f986ec-source.tar.gz` | 6,011,733 | `8d8f314d2d6d47073603439b66a8c51d14a802e6db5b987aa6f5d08a2e920978` | 固定源码候选 |
| `1.0.40-58d3e6f986ec-web.tar.gz` | 1,437,923 | `a325124a3acfea97803a8f0569efd53337f96c08d811ebd41f6567f767916a2a` | Web 未激活候选 |
| `1.0.40-58d3e6f986ec-api.tar.gz` | 602,868 | `1254e1e9f38ffde23438ce9c2ff9c254af3c9b61a794d3e0b167253ac53f0969` | API 未激活候选 |
| `1.0.40-58d3e6f986ec-windows-unpacked-diagnostic-unsigned.tar.gz` | 150,129,586 | `cc60c5659226b8a67a5044533643426a73c1e4954dafcc4e5cb7c7243aff03ec` | `NotSigned` unpacked 诊断；禁止 stable |
| `1.0.40-58d3e6f986ec-android-unsigned.apk` | 4,811,674 | `1dde91f0650be9ae02dbe23ffdf900b50ecc35c79baa1a2b66a25bfd24371cb5` | unsigned 诊断；禁止 stable |
| `1.0.40-58d3e6f986ec-android-unsigned.aab` | 4,626,356 | `b382ac4cd04c24a8a6a36e5f513685c36951ecea7a7b1ac3a806f100cd7f5bf1` | unsigned 诊断；禁止 stable |

候选六文件按 LF 规范行聚合 SHA-256 为 `1ad72ee01c3561d1971085f878e41ff942be77a64b2903e912f08c9ca3c0caf0`。逐文件哈希是权威值；不同平台换行拼接聚合时可能不同，不得因此改写文件。

Android `aapt`：`cn.dsponline.network / 1.0.40 / 1000040 / minSdk 24 / targetSdk 36`；zipalign 成功；`apksigner` 按预期返回 `DOES NOT VERIFY`，AAB 签名 entry 为 0。Windows PE：FileVersion `1.0.40`、ProductVersion `1.0.40.0`、Authenticode `NotSigned`；ASAR 内 Build ID、stable 通道、正式 API/更新 URL 正确。

同一 SHA 的早期 `e774a856a7ca`/pre-native 诊断输出已移至 `artifacts/release-packages/obsolete-do-not-use-*` 或 `artifacts/release-staging/obsolete-do-not-use-*`，不在候选清单中，禁止发布或混入哈希。

## 10. 工作包与回滚提交

| 工作包 | 主要提交（短 SHA） |
| --- | --- |
| BASE 排行榜 | `4a78ae7`, `24d54c1` |
| P0-02 多页保存 | `deae59a`, `19889af`, `e774a85` |
| P0-01 云传输 | `f518d34`, `45397bf` |
| P1-01 原子持久化 | `7a2cf6c` |
| P1-02 配额/去重/归档 | `c452cef`, `113752d`, `92929bd`, `9aa37f6`, `3347f35`, `e99074e`, `69b0e72`, `76de7ab`, `6fcd792`, `de6c31b` |
| P1-03 单次检查 | `acf64ed`, `9a0b76a` |
| P1-04 HTTP 安全 | `d6fbb81`, `f50152e`, `1eac4c0` |
| P1-05 会话/Android | `d789356`, `268f9b7`, `306df04`, `2207d60`, `949cab7`, `58d3e6f` |
| P1-06 发布切换 | `a6fd8bd` |
| P1-07 本地容量 | `4de39ac` |
| P1-08 速通恢复 | `4e771a2`, `0610f30` |
| P2-01 PWA | `e215c84`, `d715165`, `5859a63` |
| P2-02 启动/内存 | `57b0d91`, `d0868f9`, `5ecce2f` |
| P2-03 可访问性 | `39cba4a`, `6e75599`, `41fcf72`, `8d26daf`, `ecf9639`, `e774a85` |
| P2-04 服务规模 | `e9d220e`, `d06355a` |
| P2-05 字段契约 | `d19d05a`, `7217f98` |
| P2-06 CI/合成夹具 | `a9cf933`, `1c29ae2`, `02d88c4` |
| P2-07 版本/探针 | `7e074bb`, `c27fde7`, `cb8c76b` |
| P3 有界拆分 | `0d8ffe3` 及上述模块提取提交 |

不要整体 revert 数据安全工作包后直接启动旧 API；按依赖从最末工作包逆序回滚，并先用临时 SQLite/合成档通过双读验证。

## 11. Release Agent 原始必做步骤（已停止）

> 本节保留候选交接时的原始发布清单，仅用于审计。2026-08-13 已在第 3～4 步的真实 Linux 门禁中触发 No-Go；不得继续执行后续步骤，也不得用同一 SHA/Build ID 重试。

1. 从 `58d3e6f986ec098061a0a2109e149e1065a12c48` 创建全新 clean worktree；复验 source manifest、candidate manifest、6/6 制品、SBOM 和 provenance。禁止从文档提交重建并复用 Build ID。
2. 把 Web/API 只解包到香港、上海不可变未激活目录；安装 API 生产依赖并使用临时 SQLite 检查 `/api/health`、`/api/ready`、schema 7/layout 2、邮件未配置状态和 activity 配置。
3. 在隔离 Linux 节点使用真实 systemd/Nginx 演练 handoff proxy、writer lock、backup evidence 和 release switch：正常、候选失败、ready 超时、proxy reload 失败、在途上传/导出、重复执行；持续请求 502/504 必须为 0。
4. 发布前在香港和上海分别生成加密/权限正确的生产备份；记录大小、mtime、SHA-256、`quick_check`、schema/layout，只在备份副本隔离启动。生产数据库不得复制回开发机，不做玩家写入测试。
5. 对备份副本做 layout v2 双读/回填 dry-run、模式/槽位/历史/正文引用计数、排行榜数量一致性；不在生产原库先跑回填。
6. 运行兼容矩阵：1.0.39 Web/Windows 与候选 API、候选 Web 与 1.0.39 API、1.0.38/1.0.39 Android 与候选 API；全部使用合成账号/临时槽位，不用真实玩家身份。
7. Android 使用批准的历史长期证书从固定 SHA 重建 APK/AAB。验证 v2/v3、证书 SHA-256 连续性、zipalign、正式 URL、backup rules，并完成 `1.0.38 → 1.0.40` 模拟器与实体设备覆盖升级；普通/速通本地档、cookie/token、离线待结算和自动保存均保留。禁止创建或替换证书。
8. Windows 构建正式 setup/feed，记录 Authenticode/SmartScreen；核对 FileVersion/ProductVersion、Build ID、官方 URL、隔离 profile、1.0.38→1.0.40 覆盖升级和低配设备。本文 unpacked tar 不是 stable 制品。
9. 实体设备验收 80%～200% 字体、390×844/桌面、PWA 在线/离线/升级中断、多个标签页、同槽 normal/speedrun、云冲突/历史/删除、归档下载取消/续传、约一小时后台纯挂机/离线、满缓存/堵带/量子满仓/有限与无限矿脉。
10. 取得用户明确发布授权后，先单节点灰度；观察 upload inspection 队列、事件循环延迟、RSS/heap、SQLite commit/ready、quota/prune、session migration、PWA fallback、`/leaderboard/me` 状态和 4xx/5xx。稳定后再切第二节点与下载页/原生 feed。
11. 发布完成后另写 `docs/releases/1.0.40.md`，记录实际生产备份、公网 Build ID、下载哈希、签名、Range/cache、previous-stable 和真实切流结果；不得提前把本交接改称正式发布记录。

## 12. No-Go / 灰度停止条件

- 任一新本地档被陈旧标签覆盖，或冲突未保留双方原始正文。
- API 返回成功但重启后数据不存在；返回失败但同进程可见新 revision/排行榜/审计。
- 原始 payload、checksum、revision、历史或下载正文被静默改写。
- normal/speedrun、main/手动槽、普通/速通复核阈值或排行榜串线。
- 旧合法 v46/1.0.37 稠密或 1.0.38/1.0.39 稀疏档无法读取/上传。
- 离线/纯挂机丢收益、重复结算、负库存/矿脉、矿脉减少但所有可追踪物资未增加。
- Web token 未从 localStorage 安全迁移，Android token/cookie/private export 进入系统备份。
- PWA 混用根/canary/previous-stable，或升级失败后没有稳定壳可启动。
- Android 长期证书不连续、覆盖升级丢档；Windows/Android 正式 URL 或 Build ID 错误。
- 发布切换出现用户可见 502/504、双写、writer lock 绕过或备份证据不完整。
- 任何核心门禁失败、制品哈希不一致或用户尚未授权发布。

## 13. 回滚方案

### 未部署

废弃 `1.0.40-58d3e6f986ec` 候选即可；线上 1.0.39/1.0.38 不变。不要删除旧制品或玩家缓存。

### 已灰度 Web/API

- handoff proxy 进入 hold/drain，等待在途 mutation；原子把代码/upstream 指针切回已验证的 1.0.39（或生产发布记录指定的直接回滚版本）。
- **只回滚代码，不恢复生产数据库。** schema 7/layout 2 向后兼容；先验证旧 API 双读当前行。
- 若已经执行内容寻址回填且旧代码不能读取 alias，先在新代码下停止写入并运行 materialize rollback，核对 checksum/大小/引用，再切旧代码；不回滚数据库快照。
- PWA 继续使用 previous-stable 和不可变 hashed assets；不要求玩家清缓存。

### 原生

- 未更新 stable feed 时直接废弃新包。
- 已更新但未广泛安装时把 feed 指针切回现行正式包；不要覆盖同版本文件。Android versionCode 不能降级安装，修复必须使用新的递增版本；不得用新证书。
- Windows 保留明确的 `NotSigned`/SmartScreen 状态；不要发布本交接 unpacked 诊断包。

### 数据与排行榜

- 不覆盖玩家现有存档，不删云 revision，不补物资，不跳过离线收益，不清理缓存掩盖问题。
- 排行榜历史与人工复核不属于代码回滚；继续使用既有人工恢复流程。本版不得直接修改历史成绩。

## 14. 已知风险

- Android 实体设备、批准证书签名连续性和覆盖升级尚未执行；Windows 低配设备/正式 setup 覆盖升级尚未执行。
- Windows 仍按历史策略 `NotSigned`，会触发未知发布者/SmartScreen；不能描述为可信签名版。
- 28 MiB 八路解析虽有界，但本机 event-loop max/P99 约 470/446 ms；灰度需监控，不承诺生产网络 30 MiB 全链路耗时。
- 发布切换自动化在 Windows/Node 合成环境通过，但真实 Linux systemd/Nginx 门禁已经执行并失败；软链接入口、RuntimeDirectory 生命周期、writer lock 权限、旧版恢复和大库复制策略均需开发返修。
- 账号最大理论逻辑配额 1 GiB；内容去重降低物理占用但不替代磁盘预留、清理策略和备份容量监控。
- 旧 Bearer 是兼容面，不应无限期保留；正式稳定后需要另版给出迁移率与退役计划。
- 排行榜仍是存档结构/相邻 revision 推导，不是完整服务器重演模拟，不能防御所有经过构造但结构合法的数据。
- 玩法模拟算法未改，因此既有长窗口近似误差和 1.0.38 已披露的终局性能风险没有被本版重新承诺消除。
- 真实玩家夹具的 construction stability、终局多 Worker、画布、约一小时离线/纯挂机条件测试按约束未执行；Release Agent 必须使用明确授权的只读副本或实体设备完成，不能把 skip 当 pass。

## 15. 可直接交给 Release Agent 的提示词

> 以下为开发交接时的历史提示词，已由本次 No-Go 作废。不得再次执行；返修后必须生成新的交接提示词。

```text
请复验 DSPidle2 1.0.40 开发候选；在用户明确授权前不要部署或写生产数据。

固定运行时源码：58d3e6f986ec098061a0a2109e149e1065a12c48
Build ID：1.0.40+58d3e6f986ec
候选目录：D:\GameDev\DSPidle2-v140-leaderboard\artifacts\release-packages\1.0.40-58d3e6f986ec
source manifest：D:\GameDev\DSPidle2-v140-leaderboard\artifacts\release-manifests\1.0.40-58d3e6f986ec.json
gate evidence：D:\GameDev\DSPidle2-v140-leaderboard\artifacts\release-gate
交接：D:\GameDev\DSPidle2-v140-leaderboard\docs\RELEASE_HANDOFF_1.0.40.md

先在全新 clean worktree 复验 206/206 source mapping、6/6 candidate SHA-256、SBOM 和 3-subject provenance。Web/API 只能进入不可变未激活目录；Windows unpacked 与 Android APK/AAB 都是未签名诊断制品，禁止进入 stable。Android 必须用现有批准长期证书从固定源码重建并验证 v2/v3、证书连续性和 1.0.38→1.0.40 覆盖升级，不能创建新证书。

在隔离 Linux 节点用真实 systemd/Nginx/临时 SQLite 先演练 handoff proxy、writer lock 和失败回滚。生产发布前分别创建香港/上海备份并只在副本检查 schema 7/layout 2、内容寻址双读、normal/speedrun 四槽、历史和排行榜数量。兼容验证全部用合成账号，不使用真实玩家账号或存档写入。

完成实体 Android、低配 Windows、PWA、80%-200% 字体、多标签页、30 MiB 云传输、normal/speedrun、多设备、约一小时后台/离线纯挂机、满缓存/堵带/量子满仓/有限与无限矿脉验收。任何正文改写、幽灵 revision、串档、收益丢失/重复、物资不守恒、签名异常或切流 502/504 都立即 No-Go。

只有用户明确授权后才按单节点灰度→双节点→下载页/原生 feed 执行。回滚只回滚代码，不恢复生产数据库；不清缓存、不跳产量、不补物资、不覆盖玩家档、不修改排行榜历史。
```
