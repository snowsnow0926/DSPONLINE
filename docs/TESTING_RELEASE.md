# 测试与发布基线

> `1.0.43` 超大存档热修已完成香港 Web-only 稳定发布：最终 clean source `fceca3eda51cf7e488e176e23c6119ba104b77fd`，runtime/test tree `6c2df9686031fa1db68b1d862f33364cbbae95a6`，Build ID `1.0.43+fceca3eda51c`。完整 Vitest 为 1,238/18、同 runtime/test tree 完整 Chromium 为 356/8、0 失败；final-tip clean build 为 1,929 modules，production-preview PWA 3/3，Web 归档 122/122。只读真实附件 36,704,109 bytes 的初次检查 437 ms，本机/生产 UI 旅程验证导入预览、确认进入、manual revision/backup、受控返回和重载正确性；源 bytes/SHA 前后不变。香港 generation 13 current 为 `web-1.0.43-fceca3eda51c`，previous 为 1.0.42；API、数据库、上海、原生、下载页和玩家生产数据均未修改。注意：受控 Continue→Pause 仍耗时 20,887 ms，Long Task 峰值 20,291 ms，运行态近乎不可玩的反馈未由 1.0.43 解决，已升级为 1.0.44 P0。

> `1.0.42` 已基于香港最终 1.0.41 热修固定为 `c24e6247d2572e54e30e173d3e16bfd85829b92f / 1.0.42+c24e6247d257`。最终门禁：Vitest 1,231/18、server 356/2、ops 55/6、native 24/24、Chromium 353/9、Firefox/WebKit 2/2、production-preview PWA 1/1，均 0 失败；root/server production audit 0，125 个运行时许可证。production build 为 1,928 模块、startup 185,929 B gzip、menu 281,809 B、forbidden 0。API 162 文件临时 SQLite 启动、Android unsigned bundle/assemble/lint/zipalign、Windows PE/ASAR/48 MiB/4 进程隔离启动均通过。source 214/214、candidate 10/10、provenance 3/3。旧 `8056d2cb…` 候选只作历史诊断且不得发布。

> **当前正式发布基线（2026-08-15）**：香港 Web 为 `1.0.43+fceca3eda51c`；香港 API、上海 Web/API、上海下载 stable、Android/Windows stable 均保持 1.0.42。香港 generation 13 直接 Web 回滚目标为 `web-1.0.42-c24e6247d257`，API PID 与 `NRestarts=0` 保持，pending switch 为空；正式事实见 [1.0.43 发布记录](./releases/1.0.43.md)。1.0.42 的双节点/API/原生/下载基线继续见 [1.0.42 发布记录](./releases/1.0.42.md)。

> `DSPIDLE-1041-HK-GC-HOTFIX` + `DSPIDLE-1041-BLACK-HOLE-STATE` 开发候选（2026-08-14）：根 `npm ci` 安装 456 包并报告 1 moderate/4 high 的全依赖审计项，server `npm ci` 安装 75 包且 0 漏洞；随后根/server `npm audit --omit=dev` 均为 0。typecheck、125 个运行时包许可证和 production build 通过，构建 1925 模块且 startup/menu 预算通过。Vitest 为 136 文件通过/6 文件跳过、1209/18；server 为 355/2；ops 为 55/6（6 条 Linux 专属）；完整 Chromium E2E 为 334/9（343 总项、909.7 秒）；全部 0 失败、0 超时。native clean 首轮因未生成 `android/app/src/main/assets/capacitor.plugins.json` 得到 22 通过/1 跳过/1 失败，先 build 再 `cap sync android` 后复跑为 23/1、0 失败；Android/Windows 不发布。所有服务端写测试使用合成账号与临时 SQLite，没有生产访问。

> 黑洞基线证据来自独立 detached worktree，HEAD 精确为 `32daa4f9438095308e3e6be7a0055268abe01e66`；重新 `npm ci` 后同一 Chromium 保存链 1/1 通过，覆盖运行态 `false/true`、玩家暂停 `true/true`、缺字段安全态 `true/false` 的同步保存、Worker、IndexedDB、导入导出和云正文准备。因此没有复现 1.0.41 投影导致统一暂停，当前改动是 fail-closed 防回归，不是存量修复。云 GC 专项另以 8,287 个逻辑行、32 MiB 无关 direct 行证明启动只返回固定 161 字符投影、单行删除使用 SQLite 复合主键且候选工作量为 1；元数据错配、malformed alias、非 TEXT/BLOB alias、共享引用、最后引用、legacy direct、账号 delete、归档 replace 和 blob cleanup 后故障回滚均进入完整 server 门禁。

> `1.0.41` 固定源码 `32daa4f9438095308e3e6be7a0055268abe01e66` 的开发侧最终门禁：typecheck；Vitest 136 文件通过/6 条件跳过、1208/18；server 347/2；ops 55/6（6 项仅真实 Linux）；native 24/24；Chromium 333/9；Firefox/WebKit 2/2；生产预览 PWA 1/1；production audit 根/server 均 0；125 个运行时包许可证；Web、162 文件 API 展开包、Windows unpacked、Android unsigned APK/AAB 均构建通过。Chromium 的 9 条跳过均为未提供真实玩家/终局夹具或开发服务器模式下的 PWA 条件项，PWA 已用生产预览单独 1/1 通过；本轮没有读取玩家存档。所有写入测试使用合成账号和临时 SQLite。由于本机没有 WSL/Docker，真实 systemd/Nginx、UID/GID、flock 和故障切换矩阵没有执行，不能把 Windows 结果记为发布通过。

> **历史 1.0.41 发布基线（已由 1.0.42 取代）**：香港 Web/API 曾使用 `1.0.41+2e43f5644241`，上海曾使用原始 `1.0.41+32daa4f94380`。两端数据边界均为 GameState v46、envelope v2、cloud schema v7 和 SQLite layout v2。完整历史见 [releases/1.0.41.md](./releases/1.0.41.md)。

> `1.0.39` API 热修在 2026-08-11 完成开发与正式发布门禁：typecheck、clean Vite build、Vitest 107 文件通过/6 文件跳过且 950 项通过/18 项跳过、服务端 75/2、运维 6/6、原生工具 8/8、128 个运行时许可证、根与 server 生产依赖审计 0。Playwright 最终完整全量为 282 通过/11 条显式条件夹具跳过/0 失败（293 总项）；首次既有用例瞬时超时后，目标与随后完整全量均通过。source 163/163、candidate 2/2、Web 128/128、API 35/35，以及两地发布前备份、各自副本隔离、原子切换、真实云 PUT、完整公网字节、Range/cache、6 场 Chrome 和 PWA 均通过。所有写入 smoke 仅使用合成账号与临时/备份副本 SQLite，不使用生产或玩家数据。

> `1.0.40` P0-02 开发门禁（2026-08-13）：全量 Vitest 为 108 文件通过/6 文件条件跳过、957 项通过/18 项跳过；多标签页专项 Chromium 9/9，和既有 IndexedDB 恢复套件联合运行 13/13；typecheck 与生产 build 通过。专项覆盖 IndexedDB v1→v2 原地升级且正文逐字节不变、未来版本关闭旧连接、Web Locks/BroadcastChannel 双双不可用、BroadcastChannel 实时刷新、CAS 拦截旧客户端式无 revision 写入、普通/速通槽位、删除 tombstone、保留持久版本、采用候选和租约过期后的显式接管。测试只使用合成状态与浏览器临时 IndexedDB。

> `1.0.40` P0-01 开发门禁（2026-08-13）：typecheck、Web/Windows/Android 生产 build、许可证检查通过；全量 Vitest 112 文件通过/6 文件条件跳过、989 项通过/18 项跳过；server 78/2、ops 10/10、native 13/13。客户端 1/7/8/20/28/30 MiB 矩阵 7/7，云上传 Playwright 3/3，多标签页与旧存储联合串行回归 13/13；真实临时 SQLite API 完成约 30 MiB direct raw、direct gzip、最坏转义旧包装上传与下载逐字节核对。严格 UTF-8/BOM 拒绝不产生 revision/历史；30 MiB Electron MessagePort 使用真实 Electron 43 按 1 MiB 分片和 ACK 背压双向测试；API 使用真实扁平发布目录和临时 SQLite 启动。最终 1.0.40 候选仍会重跑完整原生制品门禁。所有数据为确定性合成内容，不含玩家账号、玩家存档或生产数据库。

> `1.0.40` 模式感知历史裁剪专项（2026-08-13）：4/4 通过，覆盖 normal/speedrun × main/1/2/3 的当前 revision、最近 20 条历史、过期正文分类和容量统计；`speedrun:*` 不再进入 `invalidSlot`。完整 server 门禁为 79 项通过、2 项可选真实夹具跳过、0 失败。

> `1.0.40` P1-01 原子持久化开发门禁（2026-08-13）：专项 15/15，完整 server 94 项通过/2 项可选夹具跳过，ops 10/10，云客户端与传输 33/33，typecheck 和生产 build 通过。专项覆盖 `SQLITE_FULL/IOERR/BUSY/READONLY`、真实 SQLite `query_only`、五个 transaction failpoint、失败后同进程/重启不可见、后续写不复活、显式重试单 revision、并发 expectedRevision 一次 200/一次 409、注册/改密/删除/恢复/排行榜/管理员/邮件副作用回滚、readiness 失败与恢复、operation receipt 重启后幂等重放，以及 `server.close()` 等待暂停事务。全部使用合成 v46 存档、合成账号和临时 SQLite。

> `1.0.40` P1-06 发布切换专项（2026-08-13）：本地合成门禁 17/17 通过，覆盖备份证据与篡改拒绝、dry-run、幂等、候选启动/health/readiness、Nginx test/reload、单写锁、新实例启动、显式故障注入和代码回滚。一个在途 PUT、一个排队 PUT 与连续 30 次 GET 穿越 `drain/hold/forward` 时只观察到 200，502/504 为 0。API 发布目录 3/3、Node 与 Bash 语法通过。所有数据均为本地合成夹具；Linux systemd/Nginx 实例级演练仍是 Release Agent 安装模板前的强制门禁，不能用 Windows 控制器测试冒充生产通过。

> `1.0.38` clean source `351c649af9eedb22f56f47a6cd06c14cedce6221` 在 2026-08-11 完成正式门禁并发布：typecheck、Vitest 107 文件通过/6 文件跳过且 950 项通过/18 项跳过、服务端 70/2、运维 6/6、原生工具 8/8、128 个运行时许可证，以及最终 Playwright 280 项通过/11 条显式条件跳过/0 失败（291 总数）。首次全量有一条 90 秒瞬时超时，目标用例与随后完整全量重跑均通过。根项目与服务端生产依赖审计均为 0。专项覆盖 Worker 可转移保存/槽位/快照、可信信封拒绝、生产 Worker 导入边界、稀疏 v46 往返、持久传送带账本复用、量子原地/不可变等价、单极磁石一→二硬上限与零物资、200% 桌面/移动 Canvas 有界矩阵；1.0.37 客户端读取候选普通/速通稀疏档 2/2 通过。

> 1.0.39 没有构建或发布新原生包。当前 stable 原生证据继续来自 1.0.38：Android 长期证书 v2/v3、API 36.1 模拟器 `1.0.37 → 1.0.38` 原地升级和 Windows `NotSigned` setup 隔离启动。1.0.39 发布重新复验下载 9/9 完整公开哈希、APK/EXE Range 206、香港/上海/下载页桌面与手机 6 场 Chrome，以及访问固定 1.0.37 previous-stable 前后只有当前 1.0.39 worker active、缓存 HTML 哈希不变和正式根页离线重开。正式证据见 [1.0.39 发布记录](./releases/1.0.39.md)。

> `1.0.34` 已完成历史唯一巨构堆叠、Android raw 云上传、gzip 编码拒绝单次回退、纯挂机冻结停止/重试、实际吞吐榜、全星区名义吞吐聚合和拉线卡片高亮的完整门禁，并完成双节点、下载页和原生应用正式发布。吞吐回归覆盖三星球切换、旧根指标回退、非法/溢出数值、名义与实际结算隔离，以及 20,164,029 字节真实存档的只读本地服务核验。开发证据见 [1.0.34 开发交接](./RELEASE_HANDOFF_1.0.34.md)，生产证据见 [releases/1.0.34.md](./releases/1.0.34.md)。

> `1.0.35` 最终 clean 候选在 2026-08-09 通过：typecheck、Vitest 98 文件通过/5 文件跳过且 887 项通过/16 项跳过、服务端 70 项通过/2 项跳过、运维 6/6、原生工具 8/8、128 个运行时许可证，以及 Playwright 255 项通过/11 条显式真实夹具跳过/0 失败（266 总数）。根项目与服务端 `npm audit --omit=dev` 均为 0。矩阵新增纯挂机 1/4/8/12 倍、满/近满缓存、堵带、满量子仓、有限/无限矿脉、30 天常数时间边界、精确回退科研单结算，以及普通/速通并发自动保存、导入、复制、云同槽隔离、SQLite 迁移重启和排行榜资格。

> `1.0.36` clean source `e0ad49062fa329040b379375b595ba74b7d23daf` 在 2026-08-10 通过：typecheck、Vitest 101 文件通过/6 文件跳过且 918 项通过/17 项跳过、服务端 70/2、运维 6/6、原生工具 8/8、128 个运行时许可证，以及 Playwright 259 项通过/11 条显式条件跳过/0 失败（270 总数，772.2 秒）。根项目与服务端生产依赖审计均为 0。新增矩阵覆盖 1/2/4/自定义并联线路、材料原子失败、桌面/经典移动/新版移动及 80%～200% 字号、可燃冰与旧燃料、休眠线路唤醒、物流堵塞缓存、Canvas 空间命中/点击/回退、存档字段审计，并在 1/4/12/60/600 秒、1 小时和 1 天上完成优化路径与扫描 oracle 的完整 GameState 深比较。

> 两份原始终局存档只读验收：9,089,328 字节档 60 秒精确模拟 8.75 秒、单秒 P95 228ms；20,164,029 字节档为 12.19 秒、P95 247ms。两档玩法哈希与 60×1 秒一致、非法数量为 0，原文件 SHA-256 前后未变。生产构建 P6 画布在 4,084 实体/10,410 线路星球暂停/运行 P95 为 7/13.8ms，在 946 实体/2,220 线路星球为 7/7ms；后一档堆峰值约 164MB，前一极端档仍约 407MB，且存在 1.15～3.89 秒偶发长帧。约 19.2 MiB 档整段未达到 7～9 秒目标，必须保留为灰度风险。完整数据见 [1.0.36 开发报告](./DEVELOPMENT_REPORT_1.0.36.md)。

> `1.0.36` 的历史正式发布曾以源码 `e0ad49062fa329040b379375b595ba74b7d23daf` / Build ID `1.0.36+e0ad49062fa3` 完成两地备份、未激活目录、备份副本隔离启动、原子切换、9 文件公网下载、APK/EXE 完整哈希、Range/cache、当时的当前/上一版资源和五场 Chrome smoke。当时的 PWA Cache Storage/离线恢复与上一稳定版 1.0.35 worker 隔离均通过。Android 使用批准长期证书；Windows 为 `NotSigned`。用户只豁免该候选的 Android 真机、低配 Windows 和覆盖升级门禁，不能替代实机结论。生产证据见 [releases/1.0.36.md](./releases/1.0.36.md)。

> 同机、同 Node 运行时、只读副本的 60×1 秒终局对照：约 7.3 MB 存档总模拟 `4411.92 → 4217.35 ms`（提升 4.41%），P95 `168.20 → 152.18 ms`（下降 9.52%）；约 20 MB 存档 `17820.81 → 14370.11 ms`（提升 19.36%），P95 `1023.36 → 697.08 ms`（下降 31.88%）。两档最终权威状态哈希分别保持 `3346205b`、`281189b2`，重载校验有效且非法数量为 0。一次 60 秒与 60×1 秒只在生产历史采样桶数量上不同，玩法权威字段一致。该数据不是 Android 或低配 Windows 真机结论。

## 1. 当前自动化覆盖

| 层级 | 命令 | 当前规模 | 覆盖重点 |
| --- | --- | ---: | --- |
| 类型检查 | `npm run typecheck` | 全部前端 TS | 严格类型、Vite 配置 |
| 单元/领域 | `npm test` | `1.0.43` runtime：1,238 项通过、18 项条件跳过、0 失败；第二轮返修相关 129/129 | 引擎暂停边界、递归制造守恒、Worker/稀疏存档与导入边界、O(E+B) 迁移、manual/return revision、增产剂重载、模式存档隔离、v1-v46 存档和云同步等 |
| 浏览器 E2E | `npm run test:e2e` | `1.0.43` 同 runtime/test tree：Chromium 356/8、0 失败；production-preview PWA 3/3 | 大档租约/冲突、Worker 导入、revision/backup、当前/历史公告、PWA/version 和完整既有回归 |
| 云服务 | `npm run test:server` | `1.0.42`：356 项通过、2 项可选夹具跳过；两节点远端结果相同 | 云槽、schema/layout、原子写入、大正文、排行榜和恢复保护 |
| 运维工具 | `npm run test:ops` | 候选 55/6；代理热修后 56/6；两节点 Linux 各 59/2 | SQLite 一致性快照、异地恢复、Nginx、节点探针、发布备份证据、稳定交接代理、单写锁和切换故障回滚 |
| 原生配置与发布工具 | `npm run test:native` | 24/24 | 社区更新源默认关闭、HTTPS 通道、Android/桌面更新清单、调试 APK 拒绝、显式发布基址、桌面包内元数据和静态下载页清单门禁 |
| 第三方许可证 | `npm run licenses:check` | 125 个运行时包 | 根项目/云服务 lockfile、直接依赖通知、完整许可证文本和 public 法律文件一致性 |
| 生产构建 | `npm run build` | clean source `fceca3e`：1,929 modules，startup gzip 185,923 B，Build ID `1.0.43+fceca3eda51c`，无 `.dirty` | `tsc -b`、Vite chunk、独立 save-inspection Worker、普通离线/宏观 Worker 和 PWA 资源 |
| Windows setup | `npm run desktop:dist` | 1.0.42 setup；FileVersion/ProductVersion 1.0.42；隔离启动 4 个进程；`NotSigned` | Electron 启动、包内 Build ID、正式 API/更新地址和稳定清单 |
| Android release | `npm run android:release` | 1.0.42 / 1000042；APK v2/v3、zipalign、批准证书和正式 URL 通过 | applicationId、versionCode、SDK、签名连续性、模拟器升级和稳定清单 |

1.0.18 专项回归覆盖量子上传/下载独立全局预算、轨道采集器供应端、无量子塔时零额度、本地运输机兼容、逐物品 1 万至 100 亿容量、调低容量保留超额库存、五秒流量摘要、v44→v45 守恒迁移，以及英文、390×844 和 200% 字号量子库存界面。完整门禁和线上证据见 [releases/1.0.18.md](./releases/1.0.18.md)。

1.0.36 的完整 clean 提交、不可变制品、原生签名、双节点隔离启动、备份、原子切换、下载哈希、Range、缓存、PWA 和回滚证据见 [releases/1.0.36.md](./releases/1.0.36.md)。

1.0.37 的开发证据、真实大档性能边界和条件交接见 [1.0.37 开发报告](./DEVELOPMENT_REPORT_1.0.37.md) 与 [1.0.37 Release Agent 交接](./RELEASE_HANDOFF_1.0.37.md)；生产备份、原子切换、下载、公网 smoke、豁免和回滚证据见 [1.0.37 正式发布记录](./releases/1.0.37.md)。

1.0.38 的 Worker/批处理/存档瘦身、单极磁石一→二功能、真实大档证据和条件交接见 [1.0.38 开发报告](./DEVELOPMENT_REPORT_1.0.38.md) 与 [1.0.38 Release Agent 交接](./RELEASE_HANDOFF_1.0.38.md)；生产备份、原子切换、下载、公网 smoke、豁免和回滚证据见 [1.0.38 正式发布记录](./releases/1.0.38.md)。

1.0.39 的 v46 稀疏云上传修复、模式化排行榜复核 revision、固定源码与候选制品见 [1.0.39 Release Agent 交接](./RELEASE_HANDOFF_1.0.39.md)；双节点备份副本、原子切换、真实云 PUT 观察、下载 1.0.38 不变、6 场 Chrome、1.0.37 PWA 回退隔离与回滚证据见 [1.0.39 正式发布记录](./releases/1.0.39.md)。

Playwright 使用本机 Google Chrome，串行执行，并在隔离的 `127.0.0.1:4319` 自动启动临时 Vite 服务，避免复用玩家正在试玩的 `4318` 进程或其旧模块缓存。失败时保留截图和 trace；GitHub CI 对单个失败用例最多重试 1 次，本地开发保持 0 次重试，持续性回归仍会使门禁失败。

## 2. 日常开发最小矩阵

### 纯文档或 Skill

```powershell
git diff --check
```

再检查 Markdown 链接和 Skill validator。修改许可证、依赖或公开政策时还要运行 `npm run licenses:check`。无需因纯文档改动重跑浏览器测试。

### 样式或单个面板

```powershell
npm run typecheck
npm run build
npm run test:e2e -- --grep "相关场景名称"
```

同时用 Playwright 截图检查桌面、手机竖屏和手机横屏。字体设置相关改动必须覆盖 80%、100%、125%、150%、200%。

### 内容、配方、科技或 progression

```powershell
npm run typecheck
npm test
npm run build
npm run test:e2e -- --grep "matrix|technology|fabrication|campaign"
```

必须特别运行内容闭合审计、白糖 progression audit、手搓与对应矩阵产业链场景。

### 引擎、物流、电力或存档

```powershell
npm run typecheck
npm test
npm run build
npm run test:e2e
```

存档结构变化还必须增加旧版本 fixture 的迁移测试，验证库存、设备、线路、科技、蓝图、队列和行星状态不丢失。

### 云服务

```powershell
npm run test:server
npm run test:ops
npm run typecheck
npm run build
```

新增 API 要覆盖成功、未认证、无效输入、冲突、限流/体积边界和持久化重启。不要在生产服务上运行写入测试。

### 正式发布

```powershell
npm ci
npm --prefix server ci
npm run licenses:check
npm run typecheck
npm test
npm run test:server
npm run test:native
npm run test:ops
npm run build
npm run test:e2e
```

桌面发布另加：

```powershell
npm run desktop:pack
# 需要安装包时
npm run desktop:dist
```

## 3. 关键回归清单

### 存档不丢失

- 继续游戏优先读取有效主存档。
- 主存档损坏时按备份、快照顺序恢复，并显示来源。
- 导入先预览版本、完整性和摘要，再由玩家确认。
- 云下载前创建本地快照；冲突不静默覆盖任一端。
- 更新后可以读取上一正式版本状态。
- 清空存档按钮不得被普通导航、开始新游戏或退出菜单间接触发。

### 生产正确性

- 相同 state + seconds 得到相同哈希。
- 库存、托盘、节点输入输出最终为非负整数。
- v32 两项建筑缓存设置默认均为 1,000,000；预设、自定义边界和非法输入必须覆盖。
- 熔炉/采集器使用生产上限，仓储/分流/物流站使用仓储物流上限；多输入、多输出和每个物流槽分别计算。
- 降低上限或减少堆叠不裁剪已有与在途库存；超额时停止新输入和派遣，调高后恢复。
- 配方切换、设备回收和升级会返还或保留所有物资。
- 无电、低电、缺料、堵塞、缺燃料状态与真实行为一致。
- 离线推进与前台推进使用同一规则。

### 线路正确性

- 同一建筑可建立第二、第三条合法输入/输出线路。
- 物流站不同槽位分别生效。
- 自动配方/物品匹配不覆盖已有明确配置。
- 字体倍率与缩放后，边端点仍贴合 handle。
- 节点移动时线路实时跟随，卡片拦截后方线路点击。
- 连接虚影、吸附、成功和失败反馈在鼠标与触摸端可见。

### 响应式与可访问性

- 360 px 以下顶栏仍可通过 overflow 到达全部工作区。
- 手机竖屏和横屏不发生施工栏、顶栏和抽屉互相遮挡。
- 方向切换保留视口、选中节点和打开面板。
- `Escape`、`Space/P`、`Ctrl/Cmd+K` 和焦点恢复正常。
- `prefers-reduced-motion` 与游戏内减少动效设置都能停用非必要动画。

## 4. 性能验收

- 运行 500 设备、1000 线路 E2E 场景。
- 运行 60 秒确定性基准和 2/8/24/72 小时挂机套件。
- 离线 Worker 覆盖 1 小时、8 小时、9 小时、24 小时、7 天与 30 天，并与同步路径逐字段或状态哈希等价。
- 后期样本存档至少运行 Chrome 与目标兼容浏览器各 30 分钟；记录强制 GC 后活跃堆、DOM、监听器、Worker、Renderer 和 GPU 趋势，不能用开发构建结果代替生产构建。
- 对比构建 chunk 大小，不接受无解释的显著增长。
- 测量正式入口冷加载、缓存加载、TLS 成功率和静态资源压缩。
- 检查 Worker 是否 active；回退到主线程时界面仍正确但应记录诊断。

Web 发布应至少记录：构建 ID、入口 HTML、主 JS/CSS 体积、压缩后体积、首屏请求数和目标网络的加载时间。

入口拆分还应直接检查 `dist/index.html`：主菜单不得 preload `FactoryRuntime`、`flow-vendor` JavaScript、`game-core` 或 `storage`。React Flow 基础 CSS 可以合并到首屏样式，但必须位于自定义画布样式之前，避免端口尺寸和位置被默认规则覆盖。

## 5. 版本发布清单

1. 工作树中的发布内容已经提交，提交可以完整重建产物。
2. 更新 npm SemVer，不直接使用 `GameState.version` 作为产品版本。
3. 任何状态变化都有迁移和兼容测试。
4. 生成生产构建并记录构建 ID、Git SHA 和发布时间。
5. 在隔离环境导入真实结构的脱敏旧存档。
6. 创建并验证生产数据库备份。
7. 先发布一个节点，完成烟测后再发布另一个节点。
8. 保留上一前端、后端发布目录和回滚命令。
9. 发布后观察错误、延迟、备份、磁盘和云冲突。
10. 只有验收完成后才创建正式标签和发布说明。
11. 源码公开制品包含项目许可证、Required Notice、隐私/条款和第三方许可证文本；社区原生构建在空配置下不连接官方 API 或更新源。

## 6. `0.2.0` 正式验收记录

以下结果针对最终发布提交 `e6e7daf113dc` 和 release ID `0.2.0-e6e7daf113dc`，不是沿用旧构建的历史结论：

| 检查 | 结果 |
| --- | --- |
| `npm ci` | 通过 |
| `npm run typecheck` | 通过 |
| `npm test` | 228/228 通过 |
| `npm run test:server` | 16/16 通过 |
| `npm run test:ops` | 5/5 通过 |
| `npm run build` | 通过 |
| `npm run test:e2e` | 83/83 通过 |
| Release manifest | 75 个文件验证通过 |

生产烟测覆盖 80%、100%、125%、150% 字体，390×844 手机竖屏、844×390 手机横屏、主菜单与工厂加载、上海 HTTP 云功能禁用、管理端点 `401` 保护、两地 schema v5 健康检查以及 JS/CSS gzip。发布证据与产物哈希见 [releases/0.2.0.md](./releases/0.2.0.md)。

## 7. `0.3.0` / v26 正式验收

以下结果针对已部署源码提交 `78881c908d70` 和 release ID `0.3.0-78881c908d70`：

| 检查 | 结果 |
| --- | --- |
| `npm ci` | 通过，0 个已知漏洞 |
| `npm run typecheck` | 通过 |
| `npm test` | 27/27 文件、241/241 通过 |
| `npm run test:server` | 16/16 通过 |
| `npm run test:ops` | 5/5 通过 |
| `npm run build` | 通过 |
| `npm run test:e2e` | 86/86 通过，串行约 4.1 分钟 |
| Release manifest | 80 个文件验证通过 |
| `git diff --check` | 通过 |

专项覆盖 v24 真实工厂迁移、v25→v26 无损迁移、非默认种子确定性、16 种生态目录、8 系 22 星、恒星亮度、独立戴森系统、中转路径、全域供电、科研预接线、科技建筑赠礼、递归小锤子、建筑制造中心、配送枢纽、线路框选升级、两次删除确认、移动载荷高亮、公告关闭、200% 字体、390×844 竖屏和 844×390 横屏。香港与上海均完成发布前一致性备份、远端后端 16 项复测、原子切换、schema v5 健康检查、管理端点 `401` 保护、JS/CSS gzip、桌面/手机横竖屏 Chrome 烟测；上海 HTTP 页面继续不提供密码输入。完整证据见 [releases/0.3.0.md](./releases/0.3.0.md)。

## 8. `0.4.0` / v28 / 云 schema v6 正式验收

以下结果针对已部署源码提交 `c77d76223f67` 和 release ID `0.4.0-c77d76223f67`：

| 检查 | 结果 |
| --- | --- |
| `npm ci` | 根项目与服务端通过，0 个已知漏洞 |
| `npm run typecheck` | 通过 |
| `npm test` | 27/27 文件、254/254 通过 |
| `npm run test:server` | 22/22 通过 |
| `npm run test:ops` | 5/5 通过 |
| `npm run build` | 通过 |
| `npm run test:e2e` | 93/93 通过，串行约 4.7 分钟 |
| Release manifest | 93 个文件验证通过 |
| 视觉检查 | 1280/1440 桌面、390×844 竖屏、844×390 横屏通过 |

专项覆盖第三批的矿机供电显示、双击缩放、生产区域、自动传送带、科研暂停和科技树滚动，以及第四批的 v27→v28 托盘上限迁移、巨构赠礼排除、星图工作区互斥、小型储物仓端口、80%-200% 字号布局、手机边缘拖动、四向分流器高/标准/低顺序与堵塞回退、旧账号邮箱绑定、四槽云存档隔离、十分钟主存档自动同步与冲突停机。邮件发送器关闭时，浏览器回归同时验证注册与找回入口显示开发中，现有账号仍可登录并进入云存档冲突处理。

香港与上海均完成发布前一致性备份、真实备份副本 schema `5→6` 隔离迁移、远端后端 22/22 复测、分阶段原子切换、schema v6 持久化检查、生产记录不减少审计、管理端点 `401` 保护、JS gzip 和桌面/手机横竖屏 Chrome 烟测。上海 HTTP 页面继续不渲染邮箱或密码输入框。完整证据见 [releases/0.4.0.md](./releases/0.4.0.md)。

## 9. 测试结构改进

- 将 3000 多行 E2E 文件按 `menu-save`、`core-loop`、`logistics`、`mobile`、`endgame`、`operations` 分拆。
- 为云服务增加独立 API 测试文件和临时 SQLite 重启测试。
- 对存档 v1-v31 建立不可变 fixture 集，而不是只依赖测试内构造对象。
- 对关键视觉状态建立少量稳定截图基线，避免只检查元素存在。
- CI 同时运行前端单元、服务端测试和浏览器关键路径；当前完整 113 项可作为合并或夜间门禁。

## 10. 第五批 / v29 本地验收（未发布）

本节记录第五批 v29 阶段性验收，不代表香港或上海已经更新；线上仍是 `0.4.0` / v28。

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 27/27 文件、258/258 通过 |
| `npm run build` | 通过 |
| `npm run test:e2e` | 95/95 通过，串行约 5.1 分钟 |
| `git diff --check` | 通过 |
| 视觉检查 | 1440×900、390×844、844×390；制造中心覆盖 80%-200% |

专项覆盖原生菜单拦截及输入白名单、灰锤单击递归定位、采矿/原油/抽水设备按量回收、第一指按建筑后第二指接管、移动画布节流与真实帧率降级、建筑制造中心真实 2× 节点、三颗指定外星球原油补充、殖民前哨完整需求，以及科技树纵向/斜向/边界滚轮隔离。v28→v29 fixture 验证重复加载不重复生成油井，并保留自定义旧油井储量。

当前机器未连接 Android 或 iPhone 真机，且没有 ADB；因此 Android Chrome 与 iPhone Safari 各连续 30 分钟的耗电、温度、帧率和卡顿对比尚未完成。Chrome 触摸仿真通过不能替代该发布前真机门禁。

## 11. `0.5.0` / v30 正式验收

以下结果针对已部署源码提交 `5b3a468c94d0` 和 release ID `0.5.0-5b3a468c94d0`。正式构建在独立干净 worktree 中完成，未中断玩家本地 `4318/4320` 开发服务。

| 检查 | 结果 |
| --- | --- |
| `npm ci` | 根项目与服务端通过，0 个已知漏洞 |
| `npm run typecheck` | 通过 |
| `npm test` | 27/27 文件、268/268 通过 |
| `npm run test:server` | 22/22 通过 |
| `npm run test:ops` | 5/5 通过 |
| `npm run build` | 通过 |
| `npm run test:e2e` | 97/97 通过，串行约 4.9 分钟 |
| Release manifest | 93 个文件验证通过 |

专项覆盖堆叠建筑逐台回收、星际站本地翘曲器自动补充、配送枢纽默认低优先级、生产区域八向桌面/触摸缩放、快速锤三态一致性，以及存档轻量化、自动/手动快照隔离、5 MiB 配额清理、QuotaExceeded 重试、读回校验和持续导出告警。真实 v26 附件从 1,365,050 字节的格式化 JSON 保存为 210,764 字节的紧凑 v30 JSON；原 189 个实体全部保留，按既有迁移规则补入 2 个确定性油井，119 条传送带以及库存、科研、物流和戴森状态保持一致，只有 180 条运行时生产曲线按设计清空。

香港与上海均通过 SQLite Backup API 创建并验证发布前一致性备份；两地上传的 Web、API 与 manifest 哈希均与本地制品一致。Web/API 已原子切换到 `0.5.0-5b3a468c94d0`，上一安全代码版本均保留为 `0.4.0-c77d76223f67`，数据库继续保持相互独立。两个服务均为 active、`NRestarts=0`，健康接口为 HTTP 200、SQLite schema v6，管理端点无凭据返回 401；香港 `www` 保持 301，两个节点的 JS/CSS gzip 与 hashed asset immutable 缓存正常，发布观察窗内没有 DSP 5xx。

正式入口浏览器烟测覆盖 1440x900 桌面、390x844 手机竖屏和 844x390 手机横屏。香港 HTTPS 登录表单可用且邮件能力继续明确标注“正在开发中”；上海 HTTP 页面不渲染密码输入框。真实 v26 附件还在隔离浏览器上下文中通过正式域名完成导入与保存，得到 211,891 字节的 v30 存档、191 个实体和 119 条传送带；该检查只写入隔离浏览器本地存储，没有使用生产账号或上传云存档。

尚未完成的质量记录仍是 Android Chrome 与 iPhone Safari 各连续 30 分钟的温度、耗电和真机帧率测试；本次已有玩家本地验收、Chrome 触摸仿真和正式域名横竖屏烟测，但不能把这些结果冒充真机长时间测试。完整制品、备份和回滚证据见 [releases/0.5.0.md](./releases/0.5.0.md)。

## 12. 手机新版壳层阶段 0-3 本地验收（未发布）

本节记录 2026-07-23 工作区中的 opt-in 移动壳层，不代表香港或上海已更新，也不改变 `GameState` v30 或存档格式。

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run build` | 通过 |
| `npm test` | 27/27 文件、268/268 通过 |
| `node --test server/analytics.test.mjs` | 3/3 通过 |
| 新版 focused Playwright | 9/9 通过 |
| 既有触摸/字体/工作区重点回归 | 8/8 通过 |
| `git diff --check` | 通过 |

新版用例覆盖 320×568、360×640、390×844、430×932、844×390、768×1024，80/100/125/150/200% 字体，经典/新版切换、五项导航、三档抽屉、移动建造/物资/检查器、44px 放置步进器、显式连续放置与布局模式、命令面板返回、详情层级与滚动恢复、全屏工作区首帧不透明、横竖屏世界中心与选中状态。既有回归另外覆盖单指平移、双指缩放、第二指从节点接管、56px 端口吸附、生产区域手柄、移动统计、星际工作区和大型工作区按需加载。截图输出包括：

- `artifacts/qa/mobile-next-desktop-1440.png`
- `artifacts/qa/mobile-next-portrait-390.png`
- `artifacts/qa/mobile-next-landscape-844x390.png`
- `artifacts/qa/mobile-next-font-200-390.png`
- `artifacts/qa/mobile-next-font-200-hub-390.png`
- `artifacts/qa/mobile-next-font-200-build-390.png`
- `artifacts/qa/mobile-stage2-build-390.png`
- `artifacts/qa/mobile-stage2-factory-390.png`
- `artifacts/qa/mobile-stage2-inspector-full-390.png`
- `artifacts/qa/mobile-stage3-technology-detail-390.png`
- `artifacts/qa/mobile-stage3-recipe-detail-390.png`
- `artifacts/qa/mobile-stage3-statistics-390.png`
- `artifacts/qa/mobile-stage3-star-system-390.png`

Chrome 桌面触摸仿真通过不等于 Android Chrome 或 iPhone Safari 真机门禁；阶段 4 的真机连续游玩、温度/耗电比较、低端设备长期性能和默认切换仍未完成。

## 13. `0.6.0` 第七批与新版手机界面正式验收

以下结果针对已部署源码提交 `ae779d297011` 和 release ID `0.6.0-ae779d297011`。应用 SemVer 为 `0.6.0`，GameState 仍为 v30、存档 envelope 仍为 v2、云 schema 仍为 v6。香港已发布，上海按本轮范围保持 `0.5.0`。

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 27/27 文件、272/272 通过 |
| `npm ci` | 根项目与服务端通过，0 个已知漏洞 |
| 服务端测试 | 本地与香港新 release 均为 22/22 通过 |
| 运维工具 | 5/5 通过 |
| `npm run build` | 通过 |
| `npm run test:e2e` | 108/108 通过，2 workers 约 5.0 分钟 |
| 新版手机 focused Playwright | 9/9 通过 |
| 正式制品清单 | `0.6.0-ae779d297011`，干净来源，98 个文件本地与香港复验通过 |

专项覆盖殖民费用从当前行星托盘与全局随身载具分源读取、缺载具零扣料、运输机与运输船消费、玩家主动满仓放下整组载荷、自动入库继续限容、有限/枯竭/真实无限资源统一判定、节点/检查器/统计一致显示、手机配方与物流目录不自动聚焦、桌面继续聚焦、小型储物仓 200% 字体输入输出分栏，以及七分区生产资料库、建筑实际配方速率、Mk.I/Mk.II/Mk.III 传送带 1/2/4 层吞吐和跨详情返回。

视觉检查包括：

- `artifacts/qa/production-library-building-1440.png`
- `artifacts/qa/mobile-stage7-building-codex-390.png`
- `artifacts/qa/mobile-stage7-library-844x390.png`
- `artifacts/qa/finite-resource-reserve-1440.png`
- `artifacts/qa/storage-mk1-font-200-1440.png`
- `artifacts/qa/release-notes-2026-07-23-v060-390.png`

正式构建在独立干净 worktree 中完成，没有结束或复用玩家当前的 `4318/4320` 进程。香港切换前通过 SQLite Backup API 创建 59,940,864 字节的 schema v6 一致性备份，并以全新 Web/API release 目录原子切换；当前回滚点为 `0.5.0-5b3a468c94d0`。公网根域名、健康接口、`www` 跳转、管理员 `401`、gzip、immutable/no-cache 边界以及桌面、新旧手机横竖屏均通过。上海公开 manifest 仍为 `0.5.0-5b3a468c94d0`，没有执行上传或切换。

Android Chrome 与 iPhone Safari 的 30 分钟真机温度、耗电、FPS、软键盘和 PWA standalone 仍未完成，因此新版继续 opt-in，不切为默认。完整制品、备份、回滚和生产截图证据见 [releases/0.6.0.md](./releases/0.6.0.md)。

## 14. `0.7.0` / v31 物流与工作区体验正式验收

以下结果针对已部署源码提交 `8bf16d91d82d` 和 release ID `0.7.0-8bf16d91d82d`。应用 SemVer 为 `0.7.0`，香港 GameState 升至 v31，存档 envelope 仍为 v2、云 schema 仍为 v6。香港已发布，上海保持 `0.5.0` / v30。

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 27/27 文件、282/282 通过 |
| `npm ci` | 根项目与服务端通过，0 个已知漏洞 |
| `npm run test:server` | 本地与香港新 release 均为 22/22 通过 |
| `npm run test:ops` | 5/5 通过 |
| `npm run build` | 通过 |
| 先前失败的物流/经典手机 focused Playwright | 7/7 通过 |
| `tests/e2e/v31-workspaces.spec.ts` | 5/5 通过 |
| `npm run test:e2e` | 113/113 通过，3 workers 约 5.3 分钟 |
| `git diff --check` | 通过 |
| 正式制品清单 | `0.7.0-8bf16d91d82d`，干净来源，98 个文件本地与香港复验通过 |

专项覆盖供需两端载具调度和归属、旧 `stationProgress` 首航迁移、逐行星视口、三种主题、建筑制造中心递归任务、分拣器退款迁移、科技树精简布局、所有主工作区再次点击关闭、堆叠容量以及物流站五槽顺序自动配置。完整 E2E 同时回归经典/新版手机、80%-200% 字体、线路端点、星图互斥、旧存档迁移、有限资源、云存档和大型工作区。

视觉检查产物：

- `artifacts/qa/v31-light-theme-1440.png`
- `artifacts/qa/v31-light-factory-1440.png`
- `artifacts/qa/v31-technology-compact-light-1440.png`
- `artifacts/qa/v31-light-mobile-390.png`

香港切换前通过 SQLite Backup API 创建 59,940,864 字节的 schema v6 一致性备份，并验证 SHA-256、权限和可读性。Web/API 上传到全新 release 目录，服务器逐项复验 98 个 manifest 文件和 5 个入口资源后由固定工具原子切换；当前回滚点为 `0.6.0-ae779d297011`。公网根域名、`www` 跳转、健康接口、管理员 `401`、gzip、immutable/no-cache 边界以及桌面、新版手机横竖屏均通过，最近两个 access log 各 500 条没有 5xx，云服务 `NRestarts=0`。上海公开 manifest 仍为 `0.5.0-5b3a468c94d0`，没有执行上传、切换或数据库操作。

完整 E2E 的 Vite 测试服务器在两个页面卸载时报告过非阻断的 `ResizeObserver loop completed with undelivered notifications`，全部 113 项断言和进程退出码仍为成功。生产浏览器烟测使用全新隔离上下文并拦截匿名 presence/analytics 写入，不使用生产账号、不上传云存档，也不清理玩家浏览器存档。完整制品、备份、回滚和截图证据见 [releases/0.7.0.md](./releases/0.7.0.md)。

## 15. `0.8.0` / v32 模拟、离线与缓存治理正式验收

以下结果针对源码提交 `2af7dc15eebbd5aa240213d7c40ab36ce8430844` 和 release ID `0.8.0-2af7dc15eebb`。GameState 升至 v32，存档 envelope 仍为 v2、云 schema 仍为 v6；同一制品已发布到香港与上海独立节点。

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 31/31 文件、320/320 通过 |
| `npm run test:server` | 23/23 通过，包含 v32 两项缓存值云端范围验证 |
| `npm run test:ops` | 5/5 通过 |
| `npm run build` | 通过；独立离线 Worker 与实时模拟 Worker 均生成生产 chunk |
| `npx playwright test --workers=1 --reporter=line` | 118/118 通过，约 6.3 分钟 |
| v32 缓存设置 focused Playwright | 2/2 通过；桌面、经典手机、新版手机和 80%-200% 字体 |

缓存专项覆盖默认 100 万、1万/10万/100万预设、自定义最小/最大值、空值、小数、负数、指数、非数字与越界错误；生产/仓储物流分类、多输入/多输出逐项容量、物流槽手动上限、降限超额、升限恢复、减堆、采矿/原油/抽水、在途物流、v31→v32 迁移、主存档、手动槽和导入导出。服务端拒绝缺字段、非整数和超范围 v32 云存档。

离线 Worker 对 1 小时、8 小时、9 小时、24 小时、7 天和 30 天与同步路径逐字段等价；取消用例确认不会保存半成品。后期样本存档仅在隔离本地浏览器中只读加载，报告位于：

- `artifacts/performance/memory-chrome-production-30m.json`
- `artifacts/performance/memory-360-production-30m.json`

Chrome 147 的强制 GC 活跃堆从 14.06 MiB 到 16.23 MiB（+2.17 MiB），Renderer 工作集从 323.40 MiB 到 321.99 MiB；360/Chromium 132 从 17.31 MiB 到 19.18 MiB（+1.87 MiB），Renderer 工作集从 541.11 MiB 到 574.29 MiB且中途峰值约 685 MiB后回落。两者 DOM、监听器增量均为 0，Worker 始终为 1。现有 30 分钟证据未显示持续 JS/DOM 泄漏，但 360 原生/GPU 占用仍需更长时间和真实玩家环境继续观察，不能宣称所有内存风险已经消失。

缓存设置截图：

- `artifacts/qa/v32-buffer-settings-desktop-font-80.png`
- `artifacts/qa/v32-buffer-settings-desktop-font-200.png`
- `artifacts/qa/v32-buffer-settings-desktop-custom-font-200.png`
- `artifacts/qa/v32-buffer-settings-legacy-font-80.png`
- `artifacts/qa/v32-buffer-settings-legacy-font-200.png`
- `artifacts/qa/v32-buffer-settings-legacy-custom-font-200.png`
- `artifacts/qa/v32-buffer-settings-next-font-80.png`
- `artifacts/qa/v32-buffer-settings-next-font-200.png`
- `artifacts/qa/v32-buffer-settings-next-custom-font-200.png`

完整 E2E 的 Vite 测试服务器仍可能在页面卸载时报非阻断 `ResizeObserver loop completed with undelivered notifications`；118 项断言和最终进程退出码均成功。Android Chrome 与 iPhone Safari 真机温度、耗电和 30 分钟交互门禁仍未完成。

正式发布清单包含 100 个文件，聚合 SHA-256 为 `0557dfb7ba5a7cf08e7a95dec73dca560a409e8fa4398d94a7a2ba760341e273`。香港与上海收到的 Web/API 归档哈希均与本地一致，解包后均通过逐文件复验；新 API release 在两地分别再次通过 23/23 服务测试。

两地切换前均使用 SQLite Backup API 创建一致性备份并通过 `quick_check`。切换后备份与当前库的 schema、账号、会话、云存档和修订记录没有减少；上海匿名玩家与错误记录保持一致，香港只出现发布窗口内正常新增匿名玩家。两地均由固定工具原子切换，香港回滚点为 `0.7.0-8bf16d91d82d`，上海回滚点为 `0.5.0-5b3a468c94d0`，数据库未恢复、替换或初始化。

公网验收中，两地根页面、manifest 与健康接口均为 200，SQLite schema v6；香港 `www` 为 301，管理员端点无凭据为 401。两地 JS 返回 gzip 与 immutable 缓存，HTML 和 `sw.js` 保持 no-cache；云服务均为 active、`NRestarts=0`、近期 journal 无 warning，DSP 专用 access log 最近 500 条均无 5xx。上海仍由本机独立提供 Web/API，公开 HTTP 页面继续禁用云账号凭据传输。完整证据见 [releases/0.8.0.md](./releases/0.8.0.md)。

## 16. `0.8.1` / 云 schema v7 账号与云存档正式验收

以下结果针对源码提交 `db8beebf9ef4a3433c0245897fe217ff9096eb58` 和 release ID `0.8.1-db8beebf9ef4`。GameState 保持 v32、存档 envelope 保持 v2，云 schema 从 v6 升至 v7；同一制品已发布到香港与上海独立节点。

| 检查 | 结果 |
| --- | --- |
| 根目录 `npm ci` | 402 个包，0 个已知漏洞 |
| 服务端 `npm ci` | 76 个包，0 个已知漏洞 |
| `npm run typecheck` | 通过 |
| `npm test` | 31/31 文件、320/320 通过 |
| `npm run test:server` | 23/23 通过 |
| `npm run test:ops` | 5/5 通过 |
| `npm run build` | 通过 |
| `npm run test:e2e` | 119/119 通过，约 5.5 分钟 |
| `git diff --check` | 通过 |

服务端专项覆盖用户名注册、大小写唯一、无邮件发送器时的全部四槽云存档、主槽历史恢复、注册限流、旧邮箱登录、无邮箱账号凭主云存档提交排行榜、schema v3→v7 归一化及重启持久化。浏览器专项会真实创建本地主存档和三个本地槽，完成注册、退出及重新登录后逐字比较四份 localStorage 数据，确认账号操作不改写或清除本地进度。

香港和上海分别在 schema v6→v7 前、最终修订切换前及上线后通过 SQLite Backup API 创建一致性快照。隔离迁移审计确认旧账号身份字段及全部云存档 payload 哈希不变，账号、会话、主存档、三个手动槽、历史、排行榜和匿名玩家记录没有减少。上线过程中没有恢复数据库、上传测试存档或使用生产账号执行写测试。

两地 Web/API 均指向 `0.8.1-db8beebf9ef4`，安全回滚点均为 `0.8.1-3ca6ae3876d5`。两个服务均为 active、`NRestarts=0`，健康接口报告 SQLite schema v7 和 disabled 邮件 provider；正式根域名、上海入口、manifest、gzip、immutable/no-cache、管理员 401、近期 error/5xx 日志和 390px 无横向溢出均通过。上海 HTTP 页面继续不渲染密码输入框。完整制品、备份哈希和回滚证据见 [releases/0.8.1.md](./releases/0.8.1.md)。

## 17. `0.9.0` / v33 正式验收

以下结果针对源码提交 `47a97f2c565ec5f6803cf7c9c71f47f24f414125` 和 release ID `0.9.0-47a97f2c565e`。应用 SemVer 为 `0.9.0`，GameState 从 v32 升至 v33，存档 envelope 保持 v2，云 schema 保持 v7；同一制品已发布到香港与上海独立节点。

| 检查 | 结果 |
| --- | --- |
| 根目录 `npm ci` | 通过，0 个已知漏洞 |
| `npm run typecheck` | 通过 |
| `npm test` | 38/38 文件、408/408 通过，1 项可选物流基准跳过 |
| `npm run test:server` | 27/27 通过 |
| `npm run test:ops` | 5/5 通过 |
| `npm run build` | 通过 |
| `npm run test:e2e` | 126/126 通过 |
| 离线等价 | 1 小时、8 小时、9 小时、24 小时、7 天、30 天全部通过 |
| `git diff --check` | 通过 |

生产刷新专项覆盖自动、100、200、500、1000、1500 和 3000 ms 七档。偏好保存在设备本地，不进入 GameState 或云存档；固定档不会被自动系统覆盖，实体与线路合计达到 180 时也不再强制切到 3 秒。模拟 Worker 继续按真实时间推进，状态发布和视觉动画独立；库存数字只使用真实状态，生产进度在相邻快照之间插值，选中实体和检查器使用优先发布路径。

后期样本短测使用当前星球 56 个节点、84 条线路，全部档位保持单 Worker，Worker 往返中位数为 11.6～18.3 ms。8 秒采样中的主线程任务占比与强制 GC 堆变化受启动、GC 和页面活动噪声影响较大，不能据此宣称刷新间隔带来线性 CPU、内存或耗电收益；原始结果保存在 `artifacts/performance/refresh-profiles-v090.json`。

物流索引在 10、50、100、500 塔规模上与旧扫描路径状态哈希一致。500 塔中位数从 3915.63 ms 降至 768.45 ms，P95 从 4693.25 ms 降至 1076.01 ms；候选扫描从 21,205,000 次降至 597,220 次，路线经济计算从 533,481 次降至 78,251 次。该数据是本机确定性基准，不等同于所有玩家设备的帧率提升。

现有生产内存证据仍采用 Chrome 与 360 各 30 分钟强制 GC 趋势：活跃堆分别增加 2.17 MiB 与 1.87 MiB，DOM 和监听器均无增长；360 Renderer 私有内存仍需更长时间观察。当前没有 Android 或 iPhone 真机，因此真机温度、耗电、Safari/PWA standalone 和连续 30 分钟交互仍是明确门禁缺口。

正式发布清单包含 105 个文件，聚合 SHA-256 为 `a9506c676f7db42e70bef2c655646cc726d2d929edb892c8098bc42374ad6da7`。两台服务器收到的 Web/API 归档哈希均与本地一致，解包后逐文件复验通过；新 API release 在两地分别再次通过 27/27 服务端测试，并用各自发布前备份的临时副本在隔离端口确认 schema v7 和活动关闭状态。

两地切换前后均使用 SQLite Backup API 创建一致性快照并通过 `quick_check`。香港发布窗口内账号、会话、主云存档和修订只发生正常新增，没有减少；上海账号与云存档仍为空，匿名玩家和错误记录保持一致。两地均由固定工具原子切换，安全代码回滚点均为 `0.8.1-db8beebf9ef4`，数据库未恢复、替换或初始化。

公网验收覆盖正式根域名、`www` 跳转、上海独立入口、manifest、健康接口、管理员 `401`、gzip、immutable/no-cache、活动关闭、服务 active、`NRestarts=0` 和专用访问日志 5xx。隔离 Chrome 上下文覆盖 1440×900 与 390×844，两地均无横向溢出或页面错误；香港 HTTPS 显示密码登录，上海 HTTP 不渲染密码输入框。截图位于 `artifacts/qa/production-0.9.0/`，完整制品与备份证据见 [releases/0.9.0.md](./releases/0.9.0.md)。

## 18. `0.9.1` 联合空间站活动正式验收

`0.9.1` 保持 GameState v33、存档 envelope v2 和云 schema v7。正式制品来自提交 `d3a90c389ed4743b0a1e907c351f1c624e50162c`，release ID 为 `0.9.1-d3a90c389ed4`；同一制品已发布到香港与上海独立节点。

| 检查 | 结果 |
| --- | --- |
| `npm ci` | 通过，402 个包，0 个已知漏洞 |
| `npm run typecheck` | 通过 |
| `npm test` | 38/38 文件，410/410 通过，1 项可选基准跳过 |
| `npm run test:server` | 28/28 通过 |
| `npm run test:ops` | 5/5 通过 |
| `npm run build` | 通过 |
| `npm run test:e2e` | 127/127 通过 |
| 巨构制造/活动专项 | 175/175 Vitest、4/4 活动服务测试和 focused Playwright 通过 |

专项浏览器路径覆盖桌面施工托盘制造与部署、点击巨构直达银河任务页、任务页暂停/恢复和定位入口、新版手机搜索/放置/点击任务页、44px 控件和横向溢出。更新公告覆盖 1440 桌面、390×844、844×390 和 360×480/200% 字体。截图位于 `artifacts/qa/v091-*` 与 `artifacts/qa/release-notes-2026-07-24-v091-*`。

服务端活动测试锁定四项各 10 亿全服模拟目标、四项各 100 万个人目标、精确 72 小时、确定性单调曲线、结束冻结和非法配置拒绝。HTTP 安全测试确认匿名 `/public-status` 可读，但账号会话仍拒绝在非本地 HTTP 页面建立。

正式清单包含 104 个文件，聚合 SHA-256 为 `81b16a02919bebce116542bcd618406575aa6922523a02af9916fa913dc537c7`。两地未激活目录分别通过 28/28 服务测试、逐文件清单复验和发布前备份副本隔离启动，随后由固定工具原子切换；安全代码回滚点均为 `0.9.0-47a97f2c565e`。

两地切换前后均通过 SQLite Backup API 创建一致性快照并完成 `quick_check`。香港发布窗口内账号、会话、云存档和修订只发生正常新增，没有减少；上海记录保持不变。数据库没有被恢复、替换、初始化或写入测试存档。

活动 ID 为 `union-station-2026-07-v1`，revision 为 `e227b03a6fbd4d148b3f07ad`，两地 UTC 起止时间一致且相差精确 259,200,000 ms。公网状态已从 `scheduled` 自动切换为 `active`，全服模拟曲线开始单调增长。

公网验收覆盖正式根域名、`www` 跳转、上海独立入口、manifest、健康接口、管理员 `401`、gzip、immutable/no-cache、服务 active、`NRestarts=0` 和最近 500 条访问日志 5xx。隔离 Chrome 使用香港 1440×900 桌面和上海 390×844 新版手机实际完成“放置巨构 → 点击巨构 → 打开任务页 → 开始提交”，没有发出生产写 API；手机触控目标不小于 44px且无横向溢出。截图位于 `artifacts/qa/production-0.9.1/`，完整证据见 [releases/0.9.1.md](./releases/0.9.1.md)。

## 19. `1.0.0` / v34 正式验收

正式源码提交为 `01492dea3c513392fb3336daae24c742aac320ce`，release ID 为 `1.0.0-01492dea3c51`。应用 SemVer 为 `1.0.0`，GameState 从 v33 升至 v34，存档 envelope 保持 v2，云 API schema 保持 v7；SQLite 内部存储从单行 layout v1 升至元数据/正文分离的 layout v2。

| 检查 | 结果 |
| --- | --- |
| 根目录 `npm ci` | 457 个包，0 个已知漏洞 |
| `npm run typecheck` | 通过 |
| `npm test` | 42/42 文件、431/431 通过，1 项可选物流基准跳过 |
| `npm run test:server` | 31/31 通过，包含 v34 云存档范围、layout v1→v2 和历史正文裁剪 |
| `npm run test:ops` | 5/5 通过 |
| `npm run test:native` | 2/2 通过 |
| `npm run build` | 通过；最终 `dist/` 为普通 Web 构建 |
| `npm run test:e2e` | 131/131 通过，约 5.8 分钟 |
| v34 focused Playwright | 3/3 通过 |
| `npm run benchmark:logistics` | 5/5 通过，10/50/100/500 塔状态哈希一致 |

500 塔三秒模拟中，旧全扫描路径中位 7825.22 ms、P95 7844.72 ms；索引路径中位 2533.66 ms、P95 2589.05 ms，中位改善 67.62%。候选检查从 20,000,000 降至 562,560，路线经济计算从 500,482 降至 78,375。该结果是本机确定性基准，不等同于所有设备的帧率或耗电改善。

视觉门禁覆盖 1920×1080、1536×864、1280×720、1024×768、960×540、390×844、430×932、844×390、768×1024 和 100%～200% 字体；重点确认两座终局巨构、戴森规划固定命令条、1.0 公告、横屏建造搜索结果、触控尺寸和无横向溢出。截图位于 `artifacts/qa/v100-*.png` 与 `artifacts/qa/release-notes-2026-07-24-v100-*.png`。

Windows `release/win-unpacked` 已生成，EXE 产品版本为 `1.0.0.0`，但 Authenticode 为 `NotSigned`。Android unsigned Release APK 为 4,103,392 字节，AAB 为 3,917,492 字节；包名 `cn.dsponline.network`、versionName `1.0.0`、versionCode `1000000`、minSdk 24，`apksigner` 正确拒绝 APK。两类制品只用于本地编译门禁，不得进入 VPS 公共更新源。

完整 E2E 仍出现已知非阻断 Vite `ResizeObserver loop completed with undelivered notifications` 卸载提示，但 131 项断言和最终退出码成功。Windows 正式证书、Android 长期 keystore、物理 Android/iPhone 各 30 分钟温度耗电和 PWA standalone 仍是明确缺口。

发布清单包含 115 个文件，聚合 SHA-256 为 `fcf72ad88bc6a8d610715f496931d359ade4aa4b32be4f8c74bd533d6485cc97`。Web/API 归档哈希分别为 `82fe7d3da12e20b56264978d31662bcee3696bb0a411bc7f0fe568757b1af721` 和 `2ccf439bad6bc662b9713298fde8d45c3317e621e201e811d6f7783644a00c92`；两地未激活目录分别通过 31/31 服务测试和 115 文件逐项复验。

香港真实备份副本迁移后，551 个修订正文与元数据逐键、大小和 SHA-256 一致，`app_state` 从 136.8 MB 降至约 2.55 MB。正式观察 240 秒内 24/24 健康请求成功，最大 10.407 ms、`NRestarts=0`、RSS 约 133～162 MB；上海 140 秒内 14/14 成功，最大 1.506 ms、`NRestarts=0`、RSS 约 65～66 MB。两地上线后备份均为 layout v2 且元数据修订数与正文行数一致。

公网验收覆盖香港根域名、`www` 301、上海独立入口、两地健康接口 layout v2、管理员 401、gzip、immutable/no-cache、活动 revision、服务/timer active、journal warning 和最近 500 条访问日志 5xx。旧 API 不能读取 layout v2 正文，因此两地回滚目标只回退 Web，API 固定保留当前实现。完整证据见 [releases/1.0.0.md](./releases/1.0.0.md)。

## 20. `1.0.0` 排行榜资格热修复验收

本次热修复保持应用版本 `1.0.0`、GameState v34、存档 envelope v2、云 schema v7 和 SQLite layout v2。两地 release ID 为 `1.0.0-leaderboard-01492dea3c51`，构建 ID 为 `1.0.0+01492dea3c51.leaderboard`。

| 检查 | 结果 |
| --- | --- |
| `npm run build` | 通过，包含 TypeScript 严格检查 |
| `npm test` | 42/42 文件、431/431 通过，1 项可选基准跳过 |
| `npm run test:server` | 31/31 通过 |
| `npm run test:ops` | 5/5 通过 |
| `npm run test:native` | 2/2 通过 |
| 排行榜 focused Playwright | 2/2 通过 |
| `npm run test:e2e` | 131/131 通过 |
| 远端服务端测试 | 香港 31/31、上海 31/31 |

服务端专项覆盖匿名提交 `401`、缺少主云存档 `409`、无邮箱且未验证账号凭主云存档成功提交、分数重算和历史赛季约束。浏览器专项覆盖未登录只读、服务端成功后才记录提交、未验证邮箱账号提交以及隐私账号撤榜。完整 E2E 仍有既有非阻断 `ResizeObserver` 卸载提示，最终退出码成功。

两地均先通过 SQLite Backup API 创建发布前快照，在未激活目录安装依赖并通过测试后使用固定工具原子切换，再创建发布后快照。四份快照均通过 `quick_check`，生产账号、会话、云存档和修订没有减少；没有使用生产账号执行写测试。公网验收确认两地根页和健康接口为 200、香港 `www` 为 301、活动 revision 不变、gzip/immutable/no-cache 正常、服务 active、`NRestarts=0`、journal 无 warning 且最近 500 条 DSP 访问日志无 5xx。完整证据见 [releases/1.0.0-leaderboard.md](./releases/1.0.0-leaderboard.md)。

## 21. 主云存档自动排名正式验收

本次发布保持应用 `1.0.0`、GameState v34、存档 envelope v2、云 schema v7 和 SQLite layout v2。两地 release ID 为 `1.0.0-ranking-auto-b61ce8f2c54f`，构建 ID 为 `1.0.0+01492dea3c51.ranking-auto.b61ce8f2c54f`。

| 检查 | 结果 |
| --- | --- |
| `npm ci` | 根目录 457 个包；生产依赖审计 0 个已知漏洞 |
| `npm run typecheck` | 通过 |
| `npm test` | 42/42 文件、431/431 通过，1 项可选基准跳过 |
| `npm run test:server` | 32/32 通过 |
| `npm run test:ops` | 5/5 通过 |
| `npm run test:native` | 2/2 通过 |
| `npm run build` | 通过 |
| `npm run test:e2e` | 131/131 通过 |
| 远端服务端测试 | 香港 32/32、上海 32/32 |
| Release manifest | 115 个文件验证通过 |

服务端专项覆盖主槽上传自动入榜、手动槽不影响、客户端伪造指标被忽略、历史峰值保留、服务启动回填、退出后主槽继续同步但不重新加入、重新加入后立即从主存档恢复，以及无主存档拒绝刷新。浏览器专项覆盖匿名访客读取真实玩家、只发送赛季 ID 的“立即刷新排名”、账号级退出/恢复和在线空榜。

两地均先通过 SQLite Backup API 创建发布前一致性快照，在未激活目录完成依赖安装、32/32 服务测试和 115 文件复验后原子切换，再创建发布后快照。香港首次回填 88 份主存档，重复启动备份副本时变更为 0；上海没有主存档，排行榜保持为空。账号、会话、主存档和有效修订没有减少，没有恢复或替换数据库，也没有使用生产账号执行写测试。

公网验收确认香港和上海根页及健康接口为 200、香港 `www` 为 301、schema v7、layout v2、活动配置、服务 active 和 `NRestarts=0` 均正常。香港五个榜单分类各返回 89 名真实玩家，上海五类均为 0；两地手机 390×844 均无横向溢出。最近访问日志无 5xx；香港切换窗口仅出现一次预期的上游短暂拒绝连接，服务启动后未再发生。完整证据见 [releases/1.0.0-ranking-auto.md](./releases/1.0.0-ranking-auto.md)。

## 22. `1.0.1` 界面与物流回归

`1.0.1` 使用 GameState v35、存档 envelope v2、云 schema v7 和 SQLite layout v2。v34→v35 只为实体补充默认关闭的交互锁；服务端同步验证锁值类型及 1,000～100,000,000 的行星托盘上限，不迁移生产数据库布局。

专项回归覆盖：Portal 精确值提示的鼠标/键盘/触摸生命周期；深色/亮色和异步工作区；储物仓/储液罐在 80%～200% 下的端口布局；锁定实体的移动、删除、批量命令和蓝图；检查器分区排序偏好；三级翘曲补仓；50 艘运输船及多塔公平/故障切换；1 亿托盘上限；制造中心长时推进；生产进度 fill/text/ARIA 同步；Mk.II 线路 12/s、下游 11/s、上游 10.6667/s 三种限制，以及非整数 Worker chunk 和 5 模拟秒近期窗口。

完整浏览器回归固定单 worker 执行，避免多个大型确定性工厂并发争用 CPU 造成假超时。视觉证据位于 `artifacts/qa/v101-*.png` 和 `artifacts/qa/release-notes-2026-07-25-v101-*.png`，覆盖 1920×1080 深/亮主题 80%～200%、390×844 经典/新版手机、844×390 横屏、768×1024 平板及生产资料库、储物节点、进度与 Tooltip 场景。

本次发布的最终命令、制品哈希、远端测试、备份和公网验收记录见 [releases/1.0.1.md](./releases/1.0.1.md)。

## 23. `1.0.1` Windows 与 Android 安装包

Android 稳定 APK 使用与 `1.0.0` 相同的长期发布证书签名，包名为 `cn.dsponline.network`，版本为 `1.0.1` / `1000001`，APK Signature Scheme v2/v3 均通过。API 36.1 模拟器先安装 `1.0.0`、启动后再用 `adb install -r` 覆盖到 `1.0.1`，升级成功且 `firstInstallTime` 不变。AAB 已构建，但因严格 JAR 校验出现 bundle entry 兼容警告而未进入公共下载源。

Windows x64 安装程序版本为 `1.0.1`，内置云 API 和稳定更新地址均已核验，`latest.yml` 的 SHA-512 与安装程序一致。Authenticode 状态仍为 `NotSigned`，因此只作为带显式未知发布者提示的公开测试包；取得可信代码签名证书之前不能视为正式签名发布。

| 检查 | 结果 |
| --- | --- |
| `npm run test:native` | 6/6 通过 |
| `npm run typecheck` | 通过 |
| Android APK | 4,206,410 字节；SHA-256 `27611a9eaf64ecb586c7d9da3a42510b060a86245152baa2f984c55f06210e0f` |
| Windows 安装程序 | 112,084,006 字节；SHA-256 `db849b10f6e151d5228f5202250d4a7131b9eb7f5d308b6cee98b07f8c5108e2` |
| 下载站归档 | SHA-256 `f2ea3baf56d5420fd7eec98f722517e48df60ffcc00413c5f66ea327be888d17` |

上海下载站完成新目录上传、校验和原子切换；当前目录为 `/var/www/dsp-idle-downloads/releases/1.0.1-f4e2a5501435-dirty`，上一目录为 `/var/www/dsp-idle-downloads/releases/1.0.0-01492dea3c51`。公网首页、Android JSON、桌面 YAML 和二进制均返回 `200`，Range 请求返回 `206`，二进制为 immutable，清单为 no-cache；香港 `/downloads/*` 返回到上海下载域名的 `302`。桌面与 390×844 下载页截图位于 `artifacts/qa/native-1.0.1/`。

## 24. `1.0.2` 英文版与亮色主题回归

`1.0.2` 不升级 GameState v35、存档 envelope v2、云 schema v7 或 SQLite layout v2。语言使用独立的 `dsp-idle-network.locale.v1` 设备偏好；测试确认切换语言不会创建或改写游戏存档。

单元测试覆盖中英文目录的 ID 对齐、英文名称/说明完整性和常用搜索别名。浏览器专项覆盖 `?lang=en`、开始菜单和游戏内切换、英文目录懒加载、桌面核心工作区无可见中文、经典/新版手机导航、亮色表面不透明度、横向溢出、更新公告关闭与持久化，以及生产构建 `pagehide` 保存路径。

本地完整回归为 451/451 Vitest、143/143 Playwright、32/32 服务端、5/5 运维、6/6 原生工具，类型检查、128 个运行时包许可证校验和生产构建通过。截图位于 `artifacts/qa/v102-english-light-*.png` 与 `artifacts/qa/release-notes-2026-07-25-v102-*.png`，覆盖 1440 桌面、390×844 竖屏、844×390 横屏及 200% 字体。最终制品、签名、备份和公网结果见 [releases/1.0.2.md](./releases/1.0.2.md)。

正式制品来自干净提交 `df7bee45e60a`，两台未激活目录均通过 32/32 服务测试与 124 文件聚合哈希复验，并在真实备份副本上用隔离端口启动 schema v7/layout v2。Android `1.0.2` / `1000002` 使用既有证书、APK v2/v3 通过，模拟器从 1.0.1 原地升级且 `firstInstallTime` 不变；Windows FileVersion/ProductVersion 为 1.0.2，Authenticode 仍为 `NotSigned`。

上线后两地 Web/API 和上海下载站均指向 `1.0.2-df7bee45e60a`，上一目录为 `1.0.1-f4e2a5501435-dirty`。两地根页/API 为 200、香港 `www` 为 301、下载二进制 Range 为 206、服务 `NRestarts=0`、最近 500 条 DSP 日志无 5xx；公网桌面、390×844、844×390及英文亮色桌面/竖屏截图烟测通过。

## 25. `1.0.3` / v36 递归制造与生产定位回归

`1.0.3` 将 GameState 从 v35 升至 v36，存档 envelope v2、云 schema v7 和 SQLite layout v2 不变。v35→v36 增加建筑制造中心随身载具目标、`fleet` 入库步骤和递归配方决策，旧建筑目标、库存、线路、物流、科研、制造 WIP、活动和戴森状态保持不变。

专项单元测试覆盖高级配方优先与基础配方回退、分形硅→晶格硅、铁矿石→铁块→钢材、多需求竞争回溯、物流运输船递归快制及建筑制造中心目标、失败原子性、轨道采集器自供能、舰队全忙诊断、喷涂拆卸返还、有限资源零储量重载，以及 4x/5x/6x 各 60 秒真实产量与活动墙钟隔离。

Playwright 专项覆盖鸿蒙中文组合输入在状态刷新/横竖屏下保持、关闭建造面板后清空；物品产线定位、上游节点/线路高亮、多目标切换与清除；仓储端口 80%～200%；320×568 与 844×390/200% 托盘删除操作区；枯竭资源入口、喷涂拆卸、390×844 递归运输船以及英文亮色产线定位。截图位于 `artifacts/qa/v103-*.png` 和 `artifacts/qa/release-notes-2026-07-26-v103-*.png`。

| 检查 | 结果 |
| --- | --- |
| `npm ci` | 根目录与服务端通过；服务端 0 个已知漏洞 |
| `npm run licenses:check` | 128 个运行时包一致 |
| `npm run typecheck` | 通过 |
| `npm test` | 47/47 文件，467/467 通过，1 项可选基准跳过 |
| `npm run test:server` | 32/32 通过 |
| `npm run test:native` | 6/6 通过 |
| `npm run test:ops` | 5/5 通过 |
| `npm run build` | 通过；入口 HTML 未 preload 工厂、React Flow、游戏核心或存档 chunk |
| `npm run test:e2e` | 149/149 通过，单 worker 约 8.6 分钟 |
| `git diff --check` | 通过 |

根目录 `npm ci` 的完整开发/打包依赖审计仍报告 16 个既有高危项，集中于 Electron 构建链；本轮没有新增依赖，也没有执行可能破坏锁文件的 `npm audit fix --force`。服务端生产依赖审计为 0。完整 E2E 仍记录既有非阻断 Vite `ResizeObserver` 卸载提示，但最终退出码成功。

Windows 与 Android 源码版本元数据同步到 `1.0.3 / 1000003` 以保持版本门禁一致；本轮没有构建、签名、上传原生二进制，也没有修改上海稳定更新清单，公开安装包继续为 `1.0.2`。

正式 Web/API 制品来自干净提交 `6d59252f4f15`，release ID 为 `1.0.3-6d59252f4f15`。Manifest 包含 125 个文件，聚合 SHA-256 为 `3bdb6a019cafc77ca071e6493f8368df84f14c96f1ebfacbb1e7f8386a62dec8`；两台未激活目录均通过 32/32 服务测试、125/125 文件复验和发布前备份副本隔离启动。

香港和上海在切换前后分别通过 SQLite Backup API 创建一致性快照并通过 `quick_check`。香港账号、会话、主云存档、有效修订、排行榜、反馈和错误聚合记录没有减少；上海账号与云存档继续为空，匿名玩家记录保持 19。两地数据库没有被恢复、替换、初始化或写入测试存档。

两地 Web/API 已原子切换到 `1.0.3-6d59252f4f15`，共同回滚目标为 `1.0.2-df7bee45e60a`。公网根页、manifest、健康接口、香港 `www` 301、schema v7、layout v2、活动 revision、gzip、immutable/no-cache、服务 active、`NRestarts=0` 和最近 500 条 5xx 均通过；隔离 Chrome 覆盖两地桌面、390×844 和 844×390，无页面错误或横向溢出。完整证据见 [releases/1.0.3.md](./releases/1.0.3.md)。

## 26. Android `1.0.3` 云存档兼容发布

本次不升级 GameState v36、存档 envelope v2、云 schema v7 或 SQLite layout v2。服务端专项明确接受 Android 1.0.2 的 v35 和 1.0.3 的 v36 存档；Android WebView `https://localhost` 的 GET/PUT 预检通过，未知 origin 保持 403。1.0.3 Android 独立发布时香港生产 unit 尚未安装新 origin 模板；该模板已随 1.0.4 部署并完成生产预检。

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 49 个文件，472 项通过，1 项可选基准跳过 |
| `npm run test:server` | 35/35 通过 |
| `npm run test:ops` | 6/6 通过 |
| `npm run test:native` | 6/6 通过 |
| `npm run licenses:check` | 128 个运行时包一致 |
| `npm run build` | 通过 |
| `npm run test:e2e` | 148/149；唯一既有 Tooltip hover 时序失败，原用例独立重跑 1/1 通过 |
| Android release | `1.0.3 / 1000003`，APK v2/v3，批准证书一致 |
| 覆盖升级 | API 36.1 模拟器从正式 1.0.2 `adb install -r` 成功，`firstInstallTime` 不变 |

APK 为 4,255,736 字节，SHA-256 `b8d43072b17de16079f12e458bd2dc264e20273dde41b176fcbc7da80622f32f`。上海下载站最终原子切换到 `1.0.3-android-b8d43072-r2`，上一 1.0.3 目录和 1.0.2 目录均保留；稳定清单 no-cache、新旧 APK 200、新 APK Range 206/immutable 和公网完整下载哈希均通过。完整记录见 [releases/1.0.3-android.md](./releases/1.0.3-android.md)。

## 27. `1.0.4` 物流并联与终局管理发布

`1.0.4` 保持 GameState v36、存档 envelope v2、云 schema v7 和 SQLite layout v2，不增加迁移或修改游戏状态结构。传送带并联数量调整、手机无限科技目录和制造中心 100,000 目标上限均有单元与浏览器回归。

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 50 个文件，477 项通过，1 项可选基准跳过 |
| `npm run test:server` | 35/35 通过 |
| `npm run test:ops` | 6/6 通过 |
| `npm run test:native` | 6/6 通过 |
| `npm run licenses:check` | 128 个运行时包一致 |
| `npm run build` | 通过；为 Web、Windows 和 Android 分别重建 |
| `npm run test:e2e` | 152/152 通过 |
| 双节点未激活目录 | 香港和上海均通过服务端 35/35、运维 6/6、127/127 文件复验和各自备份副本隔离启动 |

正式清单包含 127 个文件，聚合 SHA-256 为 `e0fb648523352f42ed555e5f09183fa54f889a084348c72297db1f4d237841bb`。香港和上海切换前后均使用 SQLite Backup API 生成备份并通过 `quick_check`；两个生产库均没有被替换、恢复或写入测试存档。两地 Web/API 均指向 `1.0.4-9ca10b44507a`，回滚目标均为 `1.0.3-6d59252f4f15`；服务 active、`NRestarts=0`，最近 500 条 DSP 访问日志无 5xx。

Windows 1.0.4 安装程序为 103,129,814 字节，SHA-256 `1cc01e21522afa48ab49f69f033d46faab3b98d1dfee3c285ec1919d12fcd4a8`，Authenticode 为 `NotSigned`。Android 1.0.4/1000004 APK 为 4,261,343 字节，SHA-256 `7ad998fdcd620562421f482e39dd14a8e65854c24408143baa7be9f1e55553d4`，v2/v3 和长期证书均通过。API 36.1 模拟器从正式 1.0.3 覆盖升级后 `firstInstallTime` 不变，启动无致命异常。

上海下载站已原子切换到 `1.0.4-9ca10b44507a`，上一目录为 `1.0.3-android-b8d43072-r2`。公网完整下载哈希与本地制品一致，清单 no-cache、二进制 immutable、Range 206 和香港 302 跳转均通过。下载页桌面与 390×844 截图无横向溢出，证据位于 `artifacts/qa/v104-download-*.png`。

香港发布前后备份分别为 366,043,136 与 366,149,632 字节。账号 179、云存档 148、排行数据 148、反馈 7 和错误聚合 1000 没有减少，云修订 1610→1611、匿名玩家 2584→2585 是发布窗口内的正常新增。Android `https://localhost` GET/PUT 预检为 200/204，未知 origin 为 403；活动 revision 保持 `e227b03a6fbd4d148b3f07ad`。完整证据见 [releases/1.0.4.md](./releases/1.0.4.md)。

## 28. `1.0.5` / v37 星际物流、戴森扩容与矿脉科技回归

`1.0.5` 将 GameState 从 v36 升至 v37，存档 envelope v2、云 schema v7 和 SQLite layout v2 不变。v36→v37 为固体矿脉增加 0～9 的十分之一消耗余数；旧人造恒星超额燃料只在本行星托盘可接收时退回，剩余超额原位保留；旧戴森球壳按新容量系数重算且不删除已吸附帆；旧蓝图缺失载具目标时保持零目标。服务端接受 v35、v36 和 v37，拒绝非法矿脉余数。

专项回归覆盖：引力矩阵 `1→8` 翘曲配方及递归回退；物流塔目标数量、忙碌载具和蓝图部分装载；配送枢纽超过旧 900 缓存继续输送；线路单条/整网同步 `lanes` 的物资守恒；同恒星系不预留翘曲器与跨系正常扣除；人造恒星超额燃料迁移；标准球壳 10,000 容量；玻璃真实行星加成；原矿缺料导航；拖动后立即保存世界坐标；矿脉 Lv.1～Lv.10 消耗、分段确定性和有限资源预算。

最终提交 `af8593bc5de48a88ad11cf5ee0264f9ddc1cef28` 的完整结果为：51 个 Vitest 文件中 492 项通过、1 项可选基准跳过；154/154 Playwright；35/35 服务端；6/6 运维；6/6 原生发布工具；类型检查、128 包许可证检查、生产构建和 `git diff --check` 通过。正式 manifest 包含 127 个文件，聚合 SHA-256 为 `d4383deb72ec72ed68fab4a228e3ceb6fe85f44b61895ad0b06600d1ed745706`。

香港和上海未激活目录均通过 35/35 服务端、6/6 运维、127/127 文件复验和各自生产备份副本隔离启动。两地发布前后备份均通过 `quick_check`，账号、云存档、排行榜和有效修订没有减少；数据库未恢复、替换、初始化或写入测试存档。Web/API 已原子切换到 `1.0.5-af8593bc5de4`，共同回滚目标为 `1.0.4-9ca10b44507a`。

Android `1.0.5 / 1000005` APK 为 4,267,825 字节，SHA-256 `1d9b918e621b187e9f97d6f01c822d4b35943a112fda9ff420985d70cfd9fb7c`，v2/v3 与长期证书通过；从正式 1.0.4 覆盖升级后 `firstInstallTime` 不变。Windows 1.0.5 安装程序为 112,039,520 字节，SHA-256 `12ca09de705a72830c7a224bcc8a756ae43f5ba6532cfc8eec4a85e615dc3220`，隔离启动通过，Authenticode 仍为 `NotSigned`。上海下载站已原子切换，公网清单 no-cache、二进制 immutable/Range 206、香港 302 和完整下载 SHA-256 均通过。

公网烟测确认两地根页和健康接口为 200、香港 `www` 为 301、schema v7/layout v2、服务 active、`NRestarts=0`、近期 journal 无错误匹配且最近 500 条 DSP 日志无 5xx；正式桌面、390×844 手机和下载页截图无页面错误。完整记录见 [releases/1.0.5.md](./releases/1.0.5.md)。

## 29. `1.0.6` / v38 高容量产线与采矿蓝图回归

`1.0.6` 将 GameState 从 v37 升至 v38，存档 envelope v2、云 schema v7 和 SQLite layout v2 不变。v37→v38 为建筑制造中心补充非负安全整数的 `destroyedByproducts`，并让旧蓝图默认没有资源锚点；旧实体、线路、库存、物流载具、科研、WIP、活动和戴森工程不重建。

专项单元测试覆盖紫色矩阵仅 1 个粒子宽带的单周期生产、1～4,096 并联边界与恶意存档退款、制造中心产氢副产物在满托盘时不阻塞、取消和重载守恒、101→1 批量减堆、物流塔忙碌载具保持，以及矿脉锚点匹配、缺失跳过和重复部署幂等。可选 `npm run benchmark:v106-belts` 在同一条线路 2,000 步下测得 64/256/1,024/4,096 并联分别约 690/600/591/591 ms；并联只改变容量，不扩成多个线路对象。

正式提交的本地最终结果：

| 检查 | 结果 |
| --- | --- |
| `npm ci` | 根目录与服务端通过；服务端 0 个已知漏洞 |
| `npm run licenses:check` | 128 个运行时包一致 |
| `npm run typecheck` | 通过 |
| `npm test` | 52 个文件、503 项通过，2 项显式可选基准跳过 |
| `npm run test:server` | 35/35 通过 |
| `npm run test:native` | 6/6 通过 |
| `npm run test:ops` | 6/6 通过 |
| `npm run build` | 通过 |
| `npm run test:e2e` | 157/157 通过，单 worker 517 秒 |
| `git diff --check` | 通过 |

重点截图为 `artifacts/qa/v106-desktop-1440x900.png`、`artifacts/qa/v106-mobile-next-font200-390x844.png` 和 `artifacts/qa/v106-mobile-classic-font200-390x844.png`。根项目依赖审计仍报告 16 个集中在 Electron 开发/打包链的既有高危告警；服务端生产依赖为 0，本轮没有新增依赖或执行破坏 lockfile 的强制升级。

正式提交 `a4086d0dfc94f1a92ace66d25f050c69f825068f` 的 manifest 包含 127 个文件，聚合 SHA-256 为 `dee7d1ce8cabba2700b5b4457335e40f27779dea8bac7475504b6e4658ae5fc0`。香港和上海未激活目录均再次通过 35/35 服务端、6/6 运维、127/127 文件复验和各自生产备份副本隔离启动；前后备份均通过 `quick_check`，账号、主云存档、修订和排行榜记录没有减少。

Android `1.0.6 / 1000006` APK 为 4,273,649 字节，SHA-256 `90bc8fa9934ce04f25bcce63b8c0b0d2d31033ed459956068213a2b7521df0cc`，v2/v3 与长期证书通过；从正式 1.0.5 覆盖升级后 `firstInstallTime` 与应用数据标记保持。Windows 1.0.6 安装程序为 103,053,096 字节，SHA-256 `74d0e357eff5c44709c5b0345955c04984b36c181e356eb1d4eab49cf5e81397`，隔离启动通过，Authenticode 仍为 `NotSigned`。

两地 Web/API 与上海下载站已原子切换到 `1.0.6-a4086d0dfc94`，共同代码回滚点为 `1.0.5-af8593bc5de4`。公网根页、健康接口、公告桌面/手机截图、gzip、immutable/no-cache、Range 206、香港下载 302、Android origin 200/204、未知 origin 403 和完整二进制 SHA-256 均通过；DSP 专属日志最近 500 条无 5xx。完整记录见 [releases/1.0.6.md](./releases/1.0.6.md)。

## 30. `1.0.7` / v38 建筑制造中心 WIP 急救回归

`1.0.7` 保持 GameState v38、存档 envelope v2、云 schema v7 和 SQLite layout v2。专项失败用例先复现必要铁块 `1,080,000/1,000,000` 时旧固定阈值阻止步骤结算，再验证移除阈值后完整进入钢材阶段。测试继续覆盖自动制造暂停、全局暂停、实际断电、满托盘时只销毁非必要产物、成品只结算一次，以及 10 秒单次推进与 10 个 1 秒分段推进等价。

存档回归把制造中心任务 WIP 设置为 `180,000,000` 并执行 JSON 往返与 `migrateGame()`，确认任务库存不再套用普通建筑缓存的 1 亿上限。界面 selector 同时验证每项 WIP、累计销毁副产物和暂停/断电/缺料状态可读。此次没有新增 GameState 字段、迁移段、服务端 schema 或依赖。

正式发布结果：

| 检查 | 结果 |
| --- | --- |
| `npm ci` / `npm --prefix server ci` | 通过；服务端 0 个已知漏洞，根目录仍为 16 个既有 Electron 开发/打包链高危告警 |
| `npm run licenses:check` | 128 个运行时包一致 |
| `npm run typecheck` | 通过 |
| `npm test` | 52 个文件、504 项通过，2 项显式可选基准跳过 |
| `npm run test:server` | 35/35 通过 |
| `npm run test:native` | 6/6 通过 |
| `npm run test:ops` | 6/6 通过 |
| `npm run build` | 通过 |
| `npm run test:e2e` | 最终 157/157 通过，单 worker 519 秒 |
| `git diff --check` | 通过 |

原生工程版本元数据同步到 `1.0.7 / 1000007` 以保持发布工具门禁一致，但本轮不构建、不上传、不切换 Windows/Android 制品或上海下载清单；公开安装包在独立原生发布前继续为 1.0.6。

正式提交 `6d54901d8080bb68f9ffb860e043aa4893f95b15` 的 manifest 包含 126 个文件，聚合 SHA-256 为 `851b3d02ec9f173a3491c81ab38f398bcdfd83abdbc30ee3bac721e3937ebcdd`。香港和上海未激活目录均再次通过 126/126 文件复验、35/35 服务端和 6/6 运维测试，并用各自发布前备份副本在随机本机端口完成 schema v7/layout v2 健康烟测。

两地 Web/API 已原子切换到 `1.0.7-6d54901d8080`，共同回滚点为 `1.0.6-a4086d0dfc94`。发布前后四份备份均通过 `quick_check`；香港账号 280→281、主云存档 235→235、修订 2691→2697，上海账号和云存档继续为 0，均无记录减少。两个服务 active、`NRestarts=0`，稳定观察窗口最近 100 条 DSP 访问无 5xx；香港 Android Origin GET/OPTIONS 为 200/204，未知 Origin 为 403。公网桌面和 390×844 截图确认 1.0.7 公告操作区完整可达。完整记录见 [releases/1.0.7.md](./releases/1.0.7.md)。

## 31. `1.0.8` / v39 存档完整性、配送端口与性能诊断回归

`1.0.8` 将 GameState 从 v38 升至 v39，存档 envelope v2、云 schema v7 和 SQLite layout v2 不变。v38→v39 只为物资配送枢纽增加三个稳定 `deliverySlots` 并为既有输入线路分配 `targetPortIndex`；迁移测试固定端口顺序、其他线路不变和重复加载幂等。客户端保存、导出和云上传复用相同 envelope 校验，服务端用无浏览器依赖实现独立重算并拒绝过期校验值。

存档专项覆盖生成后自检、写入读回复核、异常云上传拒绝、真实摘要保留、不可救援结构、原件导出、两次确认和救援后重签。用户样本只在本机只读验证，修复前后均保持 12,143.1581 秒、149 个实体、50 条线路和 30 项科技，修复后迁移为校验有效的 v39；原文件未修改且未上传。

配送枢纽测试覆盖 auto/manual/disabled 三模式、独立端口、旧线路迁移、需要确认的断开、并联施工库存退款、缓存/在途物资保护性返还、蓝图与服务端字段边界。性能监控测试确认默认关闭、60 秒有界样本、匿名报告不含存档正文、Worker 八阶段与未测开销归因，以及 profile 开启/关闭状态哈希完全一致。离线等价继续覆盖 1 小时、8 小时、9 小时、24 小时、7 天和 30 天。

本地发布矩阵：

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 53 个文件通过、1 个可选基准文件跳过；510 项通过、2 项跳过 |
| `npm run test:server` | 36/36 通过 |
| `npm run test:ops` | 6/6 通过 |
| `npm run test:native` | 6/6 通过 |
| `npm run licenses:check` | 128 个运行时包清单一致 |
| `npm run build` | 通过 |
| `npm run test:e2e` | 162/162 通过，单 worker 561.1 秒 |
| `git diff --check` | 通过；仅提示既有 `theme.css` 行尾转换 |

Playwright 新增存档救援、配送端口、性能监控、亮色制造栏、经典手机与新版手机 200% 字号场景。人工检查 `v108-performance-desktop-1440x900.png`、`v108-light-fabrication-1440x900.png`、`v108-mobile-delivery-font200-390x844.png`、`v108-classic-mobile-delivery-font200-390x844.png`，以及 360×480 200% 与 844×390 的 1.0.8 公告；操作区、对比度、换行和横向边界均通过。

正式提交 `528455cdfc2bd6d7f5bd64352820626f76a1ca53` 的 manifest 包含 130 个文件，聚合 SHA-256 为 `9f3ca8f3128352d3291241fca7d851ec909848b6c41c68647df605eda4de9aa8`。Web 包为 776,883 字节、SHA-256 `a2ca88f1405c03626aa781c9a206e6f44ebb42df59c2a2adc50b082ad6b473bc`；API 包为 71,133 字节、SHA-256 `dac9c19dae6d15ba9cc4fb21247066daa1e2e3c5a0a6e86e7f6a53e364e7277d`。香港和上海未激活目录均通过 130/130 文件复验、36/36 服务端、6/6 运维测试和生产备份副本隔离启动。

Android `1.0.8 / 1000008` APK 为 4,288,466 字节，SHA-256 `9869c15942123197765d0f1ffdabf1f8da8b09f4321f77316d0745a3250c24c6`，v2/v3 签名和长期证书连续性通过；从正式 1.0.6 使用 `adb install -r` 覆盖升级后 `firstInstallTime` 与应用数据标记保持，启动无 Fatal/ANR。Windows 1.0.8 安装程序为 103,067,374 字节，SHA-256 `66e9f87b4e09831e1222d56c0007ac1ff5cc5e8ee82035cdf0c324846fbc76f9`，隔离启动通过，Authenticode 仍为 `NotSigned`。

两地 Web/API 已原子切换到 `1.0.8-528455cdfc2b`，共同回滚点为 `1.0.7-6d54901d8080`；上海下载站也切换到 1.0.8，下载回滚目录为 `1.0.6-a4086d0dfc94`。发布前后备份均通过 `quick_check`：香港账号 296→296、主云存档 250→250、正文修订 2,924→2,929、排行榜记录 250→250；上海账号和云存档继续为 0、匿名玩家记录保持 22。两个服务 active、`NRestarts=0`，公网根页和健康接口均为 200，构建 ID 正确；香港 Android Origin 为 200、未知 Origin 为 403。更新清单 no-cache、二进制 immutable、Range 返回 206，香港 `/downloads/*` 继续 302 到上海。

## 32. `1.0.9` / v40 IndexedDB、内容包与公平线路回归

`1.0.9` 将 GameState 从 v39 升至 v40，存档 envelope v2、云 schema v7 和 SQLite layout v2 不变。v39→v40 增加 `settings.beltBufferLimit`、精确 `contentPacks` 引用，并把已有空间站活动有效期迁移为长期开放；实体、线路、缓存、在途货物、物流载具、科研、制造 WIP、戴森和本地活动贡献不重建也不删除。

存档专项覆盖 localStorage→IndexedDB 验证迁移、主档/备份/快照/三槽读回校验、配额错误、急救镜像恢复、手动快照批量管理、账号注册登录不改写本地状态、缺失内容包阻止载入、云存档 v35～v40 边界和服务端内容包校验。线路专项覆盖三条同级输出公平、高/标准/低优先级、堵塞回退、10 秒/30 秒步长等价、来源缓存小于线路吞吐及整数物资守恒。

| 检查 | 正式发布结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 55 个文件通过、1 个可选基准文件跳过；523 项通过、2 项跳过 |
| `npm run test:server` | 37/37 通过 |
| `npm run test:ops` | 6/6 通过 |
| `npm run test:native` | 6/6 通过 |
| `npm run licenses:check` | 128 个运行时包一致 |
| `npm run build` | 通过 |
| `npm run test:e2e` | 166/166 通过，单 worker 557.9 秒 |
| `git diff --check` | 通过；仅既有行尾转换提示 |

Playwright 覆盖移动组合输入、320×568 主页语言切换、200% 字体、英文亮色、长期活动旧截止点、IndexedDB 配额失败与账号本地存档守护。人工检查 `v109-language-menu-desktop-200.png`、`v109-language-menu-mobile-320x568-font200.png` 及 1.0.9 公告的桌面、390×844、360×480 200% 与 844×390 截图。

Android API 36.1 模拟器从正式签名 1.0.8 原地升级到 1.0.9，`firstInstallTime` 保持，旧版创建的本地工厂可继续进入且无 Fatal/ANR。两节点未激活目录分别通过 37/37 服务端、6/6 运维和生产备份副本隔离启动；Web/API 已原子切换，上海下载清单、APK 和 Windows 安装程序已切换，Range、缓存、Origin、构建 ID 与公网健康检查通过。详细证据见 [releases/1.0.9.md](./releases/1.0.9.md)。

## 33. `1.0.10` / v40 终局工厂性能基础回归

`1.0.10` 不升级 GameState、存档 envelope、云 schema 或 SQLite layout。`SimulationAdvanceSession` 增加只读运行时索引，生产与供电阶段按行星集合推进，线路端点和容量预留复用索引；画布只派生当前行星实体和线路。legacy 全扫描路径保留为测试 oracle。

P50/P95/Max 合成 fixture 分别包含 300/380/569 个实体、300/500/1,160 条线路和 45/80/128 座物流站。相同状态推进 4 个模拟秒时，旧路径与索引路径的状态哈希和 JSON 大小完全一致；本机中位耗时分别由 103.3/328.7/803.1 ms 降至 33.1/131.2/256.7 ms。fixture 只由公开目录和固定参数生成，不含玩家存档正文、账号、昵称或 token。

| 检查 | 正式发布结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 56 个文件通过、1 个可选基准文件跳过；529 项通过、2 项跳过 |
| `npm run test:server` | 37/37 通过 |
| `npm run test:ops` | 6/6 通过 |
| `npm run test:native` | 6/6 通过 |
| `npm run licenses:check` | 128 个运行时包一致 |
| `npm run build` | 通过 |
| `npm run test:e2e` | 166/166 通过，单 worker 550 秒 |
| `git diff --check` | 通过 |

正式提交 `41cbf7ccb07e1cfb8e8e0d26067a3c92b01fb211` 的 manifest 包含 131 个文件，聚合 SHA-256 为 `1f079010c3dab2a329b5ee9ae27f7ea972215cb2573480810316ed59ea206581`。两节点未激活目录均通过文件复验、37/37 服务端、6/6 运维和生产备份副本隔离启动；隔离前后账号、云存档、修订和玩家计数一致。

Android API 36.1 模拟器从正式签名 1.0.9 原地升级到 `1.0.10 / 1000010`，`firstInstallTime` 保持且旧本地主存档继续识别，日志无 Fatal/ANR。Windows FileVersion/ProductVersion 与稳定通道为 1.0.10，Authenticode 仍为 `NotSigned`。两地 Web/API、上海下载页和稳定清单均已原子切换，公网哈希、Range、缓存、Origin、构建 ID 与发布后备份通过。详细证据见 [releases/1.0.10.md](./releases/1.0.10.md)。

## 34. `1.0.11` / v40 终局批次与排行榜完整性回归

`1.0.11` 不升级 GameState、存档 envelope、云 schema 或 SQLite layout。燃料和能量枢纽保留 legacy 逐项 oracle；建筑制造中心额外保留 `batchConstructionAutomation=false` 的逐步 oracle。复杂递归计划被编译为托盘消耗、WIP、返还、副产物销毁、累计产出和工作秒数事务，已有部分 WIP 继续走旧步骤语义。

聚焦测试覆盖部分燃料、500 万蓄电单元、50,000 个直接制造任务、10,000 个含副产物递归任务、复杂高级配方、多目标、多制造中心、长步/分段和完整状态哈希。匿名玩家同形与 2 倍终局夹具分别覆盖 600/1,200 个实体、1,250/2,500 条线路、100/256 座物流站和 150/300 万并联；1x、4x、11x 六组 optimized/legacy 状态哈希一致且无未完成模拟债务。

服务端测试覆盖内部处置状态归一化、同名候选拒绝、当前综合榜第一唯一解析、envelope/SHA-256/主档修订一致性、官方矿脉不变量、五榜过滤、刷新/可见性稳定错误码、上传/历史恢复/启动回填防重建、云档能力保留、账号注销清理和 SQLite layout v2 幂等事务。运维 CLI 默认只读并启用 `query_only`；写入必须提供已验证备份和服务停止确认，后验必须证明主档修订、历史数量和正文行数不变。

正式发布已运行：

| 检查 | 正式发布结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 57 个文件通过、1 个可选基准文件跳过；546 项通过、3 项跳过 |
| `npm run test:server` | 42/42 通过 |
| `npm run test:ops` | 6/6 通过 |
| `npm run test:native` | 6/6 通过 |
| `npm run licenses:check` | 128 个运行时包一致 |
| `npm run build` | TypeScript 与 Vite 生产构建通过 |
| `npm run test:e2e` | 166/166 通过，单 worker 约 540.5 秒 |
| 玩家同形基准 | 1x/4x/11x 约 34/58/116 ms，哈希一致 |
| 2 倍终局基准 | 1x/4x/11x 约 278/401/745 ms，哈希一致；首次路线缓存约占 227 ms |
| 原生覆盖升级 / 双节点发布 | Android 1.0.10→1.0.11 保档覆盖升级、Windows 隔离启动、双节点和上海下载站公网验收通过 |

正式提交 `f88462df53262d1b4d9ac1893a372a209d7b979a` 的 manifest 包含 134 个文件，聚合 SHA-256 为 `0e9a5ae566c3be83fc9674c8b0b062be78b53a3393a85f1ec79908ea1b0aa429`。两节点未激活目录均通过 134/134 文件复验、42/42 服务端、6/6 运维和生产备份副本隔离启动；隔离检查没有写入生产数据库。

Android API 36.1 模拟器从正式签名 `1.0.10 / 1000010` 原地升级到 `1.0.11 / 1000011`，`firstInstallTime` 和旧本地主存档保持，日志无 Fatal/ANR。Windows FileVersion/ProductVersion 与稳定通道为 1.0.11，隔离启动通过，Authenticode 仍为 `NotSigned`。两地 Web/API、上海下载页和稳定清单均已原子切换到 `1.0.11-f88462df5326`；公网 Build ID、文件哈希、Range、immutable/no-cache 和 Android Origin 边界通过。

发布前后四份 SQLite Backup API 备份均通过 `quick_check`。香港排行榜处置先按综合榜排序锁定唯一第一名，再核对受保护显示名、主档 revision、SHA-256、envelope 和矿脉不变量；首次同名 dry-run 安全中止且未写数据，修复解析器后事务删除 1 条公开 submission、写入 1 条内部限制。账号、主云档、历史和正文行数没有减少，其他同名账号未处理；重启和回填后五榜仍不可见。上海没有执行该数据处置。详细证据见 [releases/1.0.11.md](./releases/1.0.11.md)。

## 35. `1.0.12` / v41 轨道与物流交互回归

`1.0.12` 将 GameState 从 v40 升至 v41，存档 envelope v2、云 schema v7 和 SQLite layout v2 不变。迁移只为已有电磁轨道弹射器补齐所在恒星系的活动轨道；旧蓝图在部署时使用目标恒星系活动轨道。合法 v41 目标、失效目标、太阳帆输入、发射进度、线路、库存和戴森状态均保持原位。

专项覆盖：

- 弹射器单台与批量换轨、跨恒星系和已删除轨道阻塞、目标轨道实际接收太阳帆、锁定实体保护、蓝图往返及 v40→v41 保存重载。
- 第一条逐项点选网络保持模板；全选/框选要求显式模板；同步预览与成功/跳过/失败报告；并联、堆叠、优先级、形态、监测和路由同步时不改写进度、实时流量、累计运输和在途物资。
- 配送枢纽在 80/100/125/150/200% 字体、390×844 和 768×1024 下保持紧凑，三个真实输入 handle 始终位于卡片边界且命中尺寸不缩小。
- 亮色物流塔的默认、悬停、按下、选中、焦点、配置、禁用与舰队诊断面板保持明确对比；新版手机轨道选择器命中高度至少 44px。

正式发布门禁：

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 57 个文件通过、1 个可选基准文件跳过；548 项通过、3 项跳过 |
| `npm run test:server` | 42/42 通过 |
| `npm run test:ops` | 6/6 通过 |
| `npm run test:native` | 6/6 通过 |
| `npm run licenses:check` | 128 个运行时包一致 |
| `npm run build` | 通过 |
| `npm run test:e2e` | 176/176 通过，单 worker 约 557.5 秒 |
| 原生覆盖升级 / 双节点发布 | Android 1.0.10→1.0.12 保档覆盖升级、Windows 隔离启动、双节点和上海下载站公网验收通过 |

正式提交 `4f149409f433b6400142ed757e177fad8daf9de7` 的 manifest 包含 135 个文件，聚合 SHA-256 为 `cf16046a709ff52368c34709b6e14f4685bf5f1caaf5c89839fa1ba7b8b94b39`。两节点未激活目录均通过 135/135 文件复验、42/42 服务端、6/6 运维和生产备份副本隔离启动；隔离检查没有写入生产数据库。

Android API 36.1 模拟器从正式签名 `1.0.10 / 1000010` 原地升级到 `1.0.12 / 1000012`，`firstInstallTime` 和 19 小时 26 分本地主存档保持，日志无 Fatal/ANR。Windows FileVersion/ProductVersion 与稳定通道为 1.0.12，隔离启动通过，Authenticode 仍为 `NotSigned`。两地 Web/API、上海下载页和稳定清单均已原子切换到 `1.0.12-4f149409f433`；公网 Build ID、文件哈希、Range、immutable/no-cache 和 Android Origin 边界通过。

发布前后四份 SQLite Backup API 备份均通过 `quick_check`。香港账号、主云档、公开 submission、玩家和内部排行榜限制数量没有减少；发布窗口增加的一条修订和正文来自正常在线上传。上海账号和云档继续为 0、玩家记录保持 24。香港首次切换因默认健康窗口短于正常启动时间而自动回滚，确认无崩溃后使用 30 秒健康窗口重试成功；数据库从未恢复或替换。完整证据见 [releases/1.0.12.md](./releases/1.0.12.md)。

## 36. `1.0.13` / v41 画布、物流路径和大数回归

`1.0.13` 不升级 GameState、envelope、云 schema 或 SQLite layout。专项覆盖稳定拓扑缓存、节点/边视觉签名复用、300 实体视口裁剪边界、缩放从 compact 恢复 full、预构建线路诊断索引、跨星系路径缓存、排行榜超 `10^15` 值和中文/SI 大数格式。

正式候选门禁：

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 58 个文件通过、1 个可选基准文件跳过；556 项通过、3 项跳过 |
| `npm run test:server` | 44/44 通过 |
| `npm run test:ops` | 6/6 通过 |
| `npm run test:native` | 6/6 通过 |
| `npm run licenses:check` | 128 个运行时包一致 |
| `npm run build` | 通过 |
| `npm run test:e2e` | 176/176 通过，单 worker 约 555 秒 |
| `npm run benchmark:logistics` | 7/7 通过；10/50/100/128/300/500 站哈希一致 |

视觉检查使用 `artifacts/qa/stress-factory-1440.png`、`factory-phone-portrait-390.png`、`factory-phone-landscape-844.png` 和 `font-200-*.png`。桌面、390×844、844×390 与 200% 字体均恢复完整建筑内容，没有改变线路层级或端口几何。

原生验收：Android APK 为 `1.0.13 / 1000013`，使用与 1.0.0～1.0.12 相同的长期证书并通过 v2/v3；API 36.1 模拟器从正式 1.0.12 使用 `adb install -r` 覆盖升级后 `firstInstallTime` 不变，19 小时 26 分本地主存档继续显示，日志无 Fatal/ANR。Windows FileVersion/ProductVersion 为 1.0.13，包内 Build ID、正式 HTTPS API 和稳定更新地址通过，隔离用户数据目录启动通过；Authenticode 与历史版本相同，仍为 `NotSigned`。

发布状态：香港与上海 Web/API 均已完成备份、未激活目录复验、原子切换和公网健康验收。上海发布前后备份通过 `quick_check`，记录摘要不减少，服务 active 且 `NRestarts=0`；公网 Build ID 为 `1.0.13+694b61fc3a1c`。上海下载站已切换到 `1.0.13-694b61fc3a1c`，回滚目标为 1.0.12；页面、Android JSON、桌面 YAML、公网 SHA-256、Range `206`、manifest no-cache、binary immutable 与香港 302 均通过。下载页桌面和 390×844 截图位于 `artifacts/qa/native-1.0.13/`。

## 37. `1.0.14` / v42 星区资料与物流索引回归

本批新增 v41→v42 元数据迁移、无限采集倍率、十万级蓝图原子部署、派遣方向诊断和索引物流路径。索引只缓存运行时派生结构，传送带沿用存档顺序；真实后期存档单步 legacy/indexed 状态哈希一致，候选检查为 6,105（目标小于 20,000）。

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 59 个文件中 58 个通过、1 个可选基准跳过；563 项通过、4 项跳过 |
| `npm run test:server` | 44/44 通过 |
| `npm run test:ops` | 6/6 通过 |
| `npm run test:native` | 6/6 通过 |
| `npm run licenses:check` | 128 个运行时包一致 |
| `npm run build` | 通过；Web 与 Android 资源同步到 1.0.14 |
| 聚焦 Playwright | 117/117 通过，包含版本公告、离线取消、旧/新版手机壳、双指接管、物流、蓝图、亮暗主题和存档保护 |
| 真实存档夹具 | 旧/索引路径哈希一致；物流约 327ms→66ms，传送带约 282ms→21ms，候选检查 1,045,590→6,105 |

## 38. `1.0.17` / v44 量子接入与暂停画布回归

本批以 GameState v44 为发布基线，不升级存档 envelope、云 schema 或 SQLite layout。量子物流接入改为扫描全局航线账本，并在旧航线安全完成后清零尾货；画布 P1-P5 将交互预览、端口命中、拖动几何和手机缩放与主画布状态分离。星图中的废弃空间站/太空电梯入口移除，量子物流塔升级材料保持为零。

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 67 个文件通过、1 个可选基准跳过；610 项通过、5 项跳过 |
| `npm run test:server` | 本地与两地新 release 均为 44/44 通过 |
| `npm run test:ops` | 6/6 通过 |
| `npm run test:native` | 7/7 通过 |
| `npm run licenses:check` | 128 个运行时包一致 |
| `npm run build` | 通过；1,859 个模块转换完成 |
| `npm run test:e2e -- --workers=1` | 187 个场景完成，命令退出码 0；此前一次长跑末段新版手机加载超时，单独重跑通过，未复现功能失败 |
| 发布清单 | 141/141 文件验证通过；dirty 工作区构建 ID 为 `1.0.17+0383e85d2d9d.dirty` |

发布前后两地均使用 SQLite Backup API 创建快照并通过 `quick_check`。香港发布前后摘要为用户 422、云档 347、修订 4,128、榜单 344、玩家 4,264；上海为用户 0、云档 0、玩家 25、错误 23，均未减少。两地 Web/API release 和上海下载页均原子切换至 `1.0.17-0383e85d2d9d-dirty`，服务 `active`、`NRestarts=0`；公网健康 200、香港下载 302、APK/EXE 哈希、immutable 缓存和 EXE Range `206` 均通过。

Android `1.0.17 / 1000017` 使用长期签名证书，SHA-256 为 `1673a9c5bfefb7c05bd02526cebb67425d855a7bef5257a74802f26bd7db33d0`；Windows 安装包仍为未签名测试包，SHA-256 为 `5348bbb5fc3047fd40ee7780c74873becaa07b135e6c440569cda10a7f41a572`。发布目录、旧安装包、数据库和回滚目标均保留。

## 39. `1.0.18` / v45 量子空间库存与采集网络

本批将量子上传、下载改为两个独立的全星区共享预算，增加轨道采集器只上传接入、逐物品容量和独立量子空间库存面板；量子模式继续保留同一行星的运输机配送。v44→v45 迁移不改变存档 envelope、云 schema 或 SQLite layout。

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 68 个文件通过、1 个跳过；620 项通过、9 项跳过 |
| `npm run test:server` | 本地与两地新 release 均为 44/44 |
| `npm run test:ops` | 6/6 |
| `npm run test:native` | 7/7 |
| `npm run licenses:check` | 128 个运行时包一致 |
| `npm run build` | 1,859 个模块，构建通过 |
| `npm run test:e2e -- --workers=1` | 189/189，耗时约 575 秒 |
| 发布清单 | 143 个源发布文件复验通过；Web 暂存 121 个文件，API/运维暂存 22 个文件 |

Android `1.0.18 / 1000018` 使用历史长期证书，APK v2/v3 通过，SHA-256 为 `7294976ad074e77206d5e35258a4a70d0e4f1a9612987f028d3f174f2882aba3`。Windows 1.0.18 包内官方云 API 和更新地址复验通过，SHA-256 为 `b6b4d6343b82fa8001370dfb01cabb287fe97bffc256ce08ef6412d404c4a4d6`；Authenticode 仍为 `NotSigned`。

两地发布前后备份均通过 `quick_check`，记录摘要无减少，服务 active 且 `NRestarts=0`，代码回滚目标为 1.0.17。上海下载页通过完整 HTTP 下载哈希、清单 no-cache、二进制 immutable、Range 206 和香港 302 验收；香港 COS 加密异地备份在补齐发布目录运维脚本后恢复成功。完整路径、大小和记录摘要见 [releases/1.0.18.md](./releases/1.0.18.md)。

## 40. `1.0.25` / v46 画布交互、生产统计与设置体验

本版稳定 React Flow 状态重派生期间的建筑选择，新增默认关闭的缺料自动跳转、按星球生产统计、当前星球上下游寻线、10 分钟/关闭自动保存、终局节点标题和左右侧栏独立收起。GameState v46、存档 envelope v2、云 schema v7 和 SQLite layout v2 均未改变。

| 检查 | 正式发布结果 |
| --- | --- |
| `npm ci` / `npm run typecheck` | 依赖安装通过；0 个 TypeScript 错误 |
| `npm test` | 76 个测试文件通过、1 个跳过；692 项通过、9 项跳过、0 失败 |
| `npm run test:server` | 本地及香港、上海未激活目录均为 46/46 |
| `npm run test:ops` | 6/6 |
| `npm run test:native` | 8/8 |
| `npm run licenses:check` | 128 个运行时包一致 |
| `npm run build` | 通过；Vite 转换 1,871 个模块 |
| `npm run test:e2e` | 218 项通过、6 项显式本地夹具/基准跳过、0 失败 |
| Release manifest | 本地及两地未激活目录均为 145/145；聚合 SHA-256 `de32de1b491a39f28559b727613dde61361c5fb760ecdd157806996390515982` |

全量 Playwright 首次运行发现 4 个公告与英文翻译回归；修复提交 `628369a93ad7c42fd17764471272da9c7dcbe917` 后从 clean 候选完整重跑通过。Android `1.0.25 / 1000025` 通过 APK v2/v3 和长期证书连续性；Windows FileVersion/ProductVersion、正式 API、稳定更新源和隔离启动通过，Authenticode 继续明确为 `NotSigned`，没有创建新证书。

香港、上海 Web/API 与上海下载页均已原子切换到 `1.0.25-628369a93ad7`，三处回滚目标均为 `1.0.24-019bac527829`。两地备份、生产依赖、备份副本隔离启动、公网 Build ID、健康接口、Android Origin、完整 APK/EXE 下载哈希、Range 206、immutable/no-cache、历史 1.0.24 hashed asset 和浏览器视觉验收均通过。完整证据见 [releases/1.0.25.md](./releases/1.0.25.md)。

## 41. `1.0.26` / v46 主题、设置与交互体验

本版统一亮色/深色语义主题，增加设置分类总览与二级页面，补齐 1.0.0 至 1.0.25 的离线版本历史，并优化科技树横向滚轮和物品悬浮卡的鼠标、键盘与触摸操作。GameState v46、存档 envelope v2、云 schema v7 和 SQLite layout v2 均未改变。

| 检查 | 正式发布结果 |
| --- | --- |
| `npm ci` / `npm run typecheck` | 依赖安装通过；0 个 TypeScript 错误 |
| `npm test` | 698 项通过、9 项跳过、0 失败 |
| `npm run test:server` | 本地及香港、上海未激活目录均为 46/46 |
| `npm run test:ops` | 6/6 |
| `npm run test:native` | 8/8 |
| `npm run licenses:check` | 128 个运行时包一致 |
| `npm run build` | 通过；Vite 转换 1,872 个模块 |
| `npm run test:e2e` | 219 项通过、6 项显式本地夹具/基准跳过、0 失败 |
| Release manifest | 本地及两地未激活目录均为 145/145；聚合 SHA-256 `a0ed27c46eb5a377177da940f06b4e4328193007efd3f296e49aefd5f1674a68` |

正式提交为 `f675a6a11025727419a48c50159eaa5973e88eac`，release ID 为 `1.0.26-f675a6a11025`。Android `1.0.26 / 1000026` 使用批准长期证书并通过 APK v2/v3；Windows Authenticode 继续明确为 `NotSigned`。香港、上海 Web/API 与上海下载页均完成原子切换，三处回滚目标均为 `1.0.25-628369a93ad7`。完整证据见 [releases/1.0.26.md](./releases/1.0.26.md)。

## 42. `1.0.27` / v46 连接交互与批量建造

本版增加连接点尺寸设备偏好、全部建筑制造目标、混合选区原子批量增加和移动端多选刷新稳定性。GameState v46、存档 envelope v2、云 schema v7 和 SQLite layout v2 均未改变。

| 检查 | 正式发布结果 |
| --- | --- |
| `npm ci` / `npm run typecheck` | 依赖安装通过；0 个 TypeScript 错误 |
| `npm test` | 702 项通过、9 项跳过、0 失败 |
| `npm run test:server` | 本地及香港、上海未激活目录均为 46/46 |
| `npm run test:ops` | 6/6 |
| `npm run test:native` | 8/8 |
| `npm run licenses:check` | 128 个运行时包一致 |
| `npm run build` | 通过；Vite 转换 1,875 个模块 |
| `npm run test:e2e` | 226 项通过、6 项显式夹具/基准跳过、0 失败 |
| Source manifest | 本地及两地未激活目录均为 145/145；聚合 SHA-256 `f6cd0d4ebfdfd21330352b54deb5be8e2ac9d23d99eb6d40ab59a2b51f3e9b83` |
| Artifact manifest | 12/12；聚合 SHA-256 `7ea4db6a6b1f80b237fd21145c3259d6bea6d4198a7426667e1a91bbba14503a` |

正式提交为 `b8e6c0f01ea31024f36a99fb11a31cbabb6be32f`，release ID 为 `1.0.27-b8e6c0f01ea3`。Android `1.0.27 / 1000027` 使用批准长期证书并通过 APK v2/v3；Windows Authenticode 继续明确为 `NotSigned`。香港、上海 Web/API 与上海下载页均完成原子切换，三处回滚目标均为 `1.0.26-f675a6a11025`。完整证据见 [releases/1.0.27.md](./releases/1.0.27.md)。

## 43. `1.0.28` / v46 亮色主题、工厂管理与生产统计

本版合并亮色主题与分类设置、堆叠目标、紧凑物流槽位、科研喷涂、重整精炼、异步统计、时间扭曲保护和服务端白糖 `/min` 排行榜。GameState v46、存档 envelope v2、云 schema v7 和 SQLite layout v2 均未改变。

| 检查 | 正式发布结果 |
| --- | --- |
| `npm ci` / `npm run typecheck` | 依赖安装通过；0 个 TypeScript 错误 |
| `npm test` | 85 个文件通过、3 个跳过；738 项通过、12 项跳过、0 失败 |
| `npm run test:server` | 本地及香港、上海未激活目录均为 47/47 |
| `npm run test:ops` | 6/6 |
| `npm run test:native` | 8/8 |
| `npm run licenses:check` | 128 个运行时包一致 |
| `npm run build` | 通过；Vite 转换 1,876 个模块 |
| `npm run test:e2e` | 228 项通过、6 项显式本地夹具/基准跳过、0 失败 |
| Source manifest | 本地及两地未激活目录均为 147/147；聚合 SHA-256 `d536289b6624ad7fffde4550802e7b493ca04292ca32b3d41dfb37cef514fcf8` |

正式提交为 `471529b431b891f3de7e96340d590ec5ef809834`，release ID 为 `1.0.28-471529b431b8`。Android `1.0.28 / 1000028` 使用批准长期证书并通过 APK v2/v3；Windows Authenticode 继续明确为 `NotSigned`。香港、上海 Web/API 与上海下载页均完成原子切换，三处回滚目标均为 `1.0.27-b8e6c0f01ea3`。两地备份、生产依赖、备份副本隔离启动、公网 Build ID、健康接口、Android Origin、未登录云读写边界、完整 APK/EXE/blockmap 哈希、Range 206、immutable/no-cache、历史 1.0.27 hashed asset 和四个生产浏览器场景均完成；完整证据见 [releases/1.0.28.md](./releases/1.0.28.md)。

生产 `page.mouse.wheel` 补充验收发现科技树会横向移动并阻止窗口页面穿透，但树自身仍同时纵向移动且 Chrome 报 passive-listener 警告。现有 `dispatchEvent` 用例不会触发浏览器默认滚动，不能单独证明“纯横向”；后续回归必须使用真实鼠标滚轮输入并断言 `scrollTop` 不变。

## 44. `1.0.31` / v46 玩家反馈批次与高倍率稳定性

本版修复快速离线循环游标崩溃、离线报告布局、科技取消续队列、锁定配方拓扑和零 tick 线路计数；增加有界生产历史曲线、施工库存删除、物品悬浮开关、移动统计滚动和高倍率纯挂机近似治理。GameState v46、存档 envelope v2、云 schema v7 和 SQLite layout v2 均未改变。

| 检查 | 正式发布结果 |
| --- | --- |
| `npm ci` / `npm run typecheck` | 依赖安装通过；0 个 TypeScript 错误 |
| `npm test -- --run` | 87 个文件通过、5 个跳过；778 项通过、16 项跳过、0 失败 |
| `npm run test:server` | 本地及香港、上海未激活目录均为 49/49 |
| `npm run test:ops` | 6/6 |
| `npm run test:native` | 8/8 |
| `npm run licenses:check` | 128 个运行时包一致 |
| `npm run build` | 通过；Vite 转换 1,878 个模块 |
| `npm run test:e2e` | 246 项通过、2 项显式可选夹具/故障注入跳过、0 失败 |
| Release manifest | 本地及两地未激活目录均为 148/148；聚合 SHA-256 `26128cdc8490fac12f99e617d67ff3a8d27f1b4024fefb0c30d2761242c8603f` |

正式提交为 `19040a9d1e453677fde0905d9576bb7b74ae0ec0`，release ID 为 `1.0.31-19040a9d1e45`。Android `1.0.31 / 1000031` 使用批准长期证书并通过 APK v2/v3；Windows Authenticode 继续明确为 `NotSigned`。香港、上海 Web/API 与上海下载页均完成原子切换，三处回滚目标均为 `1.0.30-c6d896ae6911`。

两地备份、生产依赖、49/49 服务测试、备份副本隔离启动、公网 Build ID、健康接口、Android Origin、未登录云读写边界、完整 APK/EXE/blockmap 哈希、Range 206、immutable/no-cache、历史 1.0.30 hashed asset 和四个生产浏览器场景均完成。香港启动后的短时 API 超时在延长观察中恢复稳定，服务未重启；完整路径、耗时和残余风险见 [releases/1.0.31.md](./releases/1.0.31.md)。

## 45. `1.0.32` / v46 宏观纯挂机与反馈修复发布

本版补齐速通面板折叠及设备偏好、递归制造与净产出守恒、科研完成边界幂等自愈、公告历史分页和完整详情，并加入 `pure-idle-macro-v2` Worker、IndexedDB 检查点、心跳、Web Lock/租约、取消和崩溃恢复。后台高倍率宽限固定为 300 秒，剩余墙钟时间交给普通离线 Worker。GameState v46、存档 envelope v2、云 schema v7 和 SQLite layout v2 均未改变。

| 检查 | 正式发布结果 |
| --- | --- |
| `npm ci` / `npm --prefix server ci` | 通过 |
| `npm run licenses:check` / `npm run typecheck` | 128 个运行时包一致；0 个 TypeScript 错误 |
| `npm test -- --run` | 89 个文件通过、5 个跳过；806 项通过、16 项跳过、0 失败 |
| `npm run test:server` / `npm run test:ops` / `npm run test:native` | 49/49；6/6；8/8 |
| `npm run build` | 从最终 clean commit 构建通过 |
| `npm run test:e2e` | 242 项通过、11 项显式可选夹具/故障注入跳过、0 失败 |
| 两份真实终局夹具 | 各 5/5 只读验证通过；源文件 SHA-256 未改变 |
| Release manifest | 149/149；聚合 SHA-256 `26f858bb95a6ba8f95fff8bbcfd81d0bb614dbfbf9f1cf3fd08906b186c18461` |

正式源码提交为 `762bf693becb97a62d8c1ce8de60bf6e9083f0cc`，Build ID 为 `1.0.32+762bf693becb`。Android `1.0.32 / 1000032` 使用批准长期证书并通过 APK v2/v3；Windows Authenticode 继续明确为 `NotSigned`。香港、上海 Web/API、上海下载页和两个稳定应用包均已发布；下载页在补齐 `icon.svg` 后原子切换到 `download-site-1.0.32-762bf693becb-r2`。

两地发布前备份、未激活目录复验、原子切换、公网 Build ID/健康、完整 APK/EXE/blockmap 哈希、Range 206、缓存、当前/历史 hashed asset 和生产浏览器 smoke 均完成。真实生产账号云写入、Android 覆盖升级保档，以及 Edge、Android WebView、Electron 长时真实夹具仍未执行，不能描述为已通过；完整证据和回滚指针见 [releases/1.0.32.md](./releases/1.0.32.md)。

## 46. `1.0.33` / v46 终局快速结算正式发布

`1.0.33` 将快速离线升级为 `fast-30s-v2`，将纯挂机升级为 `pure-idle-macro-v3`，并将实时模拟兼容近似路径升级为 `time-warp-short-calibration-v3`。专项门禁保留有限/无限科研、权威供电倍率、普通/保守宏观分支、30/60 秒现实 deadline、取消、普通离线单次有界重启、纯挂机持久重启上限、旧 v2 恢复记录迁移、正式序列化重载和源夹具 hash 不变。真实玩家存档只在本机只读副本中测试，没有提交、覆盖或上传生产账号。

| 检查 | 正式发布结果 |
| --- | --- |
| `npm ci` / `npm --prefix server ci` | 通过；服务端 0 个已知漏洞 |
| `npm run licenses:check` / `npm run typecheck` | 128 个运行时包一致；0 个 TypeScript 错误 |
| `npm test -- --run` | 91 个文件通过、5 个跳过；825 项通过、16 项跳过、0 失败 |
| `npm run test:server` / `npm run test:ops` / `npm run test:native` | 49/49；6/6；8/8 |
| `npm run build` | 从最终 clean source commit 构建通过 |
| `npm run test:e2e` | 251 项通过、11 项显式可选夹具/故障注入跳过、0 失败 |
| Chrome / Edge 真实终局专项 | 两份只读夹具各 16/16 通过；源文件 SHA-256 未改变 |
| Source / download r2 / bundle r2 manifest | 149/149、9/9、10/10；聚合 SHA-256 分别为 `0f80274b72d24aed0f3060253db7e990c0efe2468aaba1916a14a6f303d268ef`、`5a369e3d21181c5fb11635078a50889ecf0dcb6a28e68530d9b1a92102a78822`、`64a3a51c45b33c51f1c97aa5b08caae9c92696bb2bece57ee94d34bcf236eefc` |

正式 source commit 为 `2bd81de8d7f16040620378d37cb73649cf09dd17`，Build ID 为 `1.0.33+2bd81de8d7f1`。大型真实存档 30 天快速离线约 2.9～3.1 秒、30 天纯挂机约 2.8 秒；Android 36.1 模拟器完成 `1.0.28 → 1.0.32 → 1.0.33` 覆盖启动，Electron 正式包完成隔离启动。Android `1.0.33 / 1000033` 使用批准长期证书并通过 APK v2/v3；Windows Authenticode 继续明确为 `NotSigned`。

香港、上海 Web/API、上海下载页和两个稳定应用包均已发布。最终下载页为 `download-site-1.0.33-2bd81de8d7f1-r2`；完整公网 APK/EXE/blockmap 哈希、Range 206、缓存、当前/1.0.32 hashed asset 和五个浏览器场景均通过。物理 Android/WebView 长时真实存档、Electron 内 30 天真实存档和真实生产账号云写入仍列为未验证；完整证据和回滚指针见 [releases/1.0.33.md](./releases/1.0.33.md)。

## 47. `1.0.34` / v46 云上传、纯挂机与实际吞吐正式发布

本候选兼容历史唯一巨构安全堆叠，修复 Android gzip Blob 上传失败和 Web 明确编码拒绝的单次 raw 回退；纯挂机停止冻结边界并复用已校准 Worker，保存失败保留检查点和重试；普通排行榜用相邻主云修订累计增量计算实际结算吞吐；拉线期间高亮起点与兼容候选建筑。GameState v46、存档 envelope v2、云 schema v7 和 SQLite layout v2 均未改变。

| 检查 | 最终发布结果 |
| --- | --- |
| `npm ci` / `npm --prefix server ci` | 通过；server 生产依赖 0 漏洞；根打包工具链当前有 1 个 high `js-yaml` 审计告警，保留风险记录 |
| `npm run licenses:check` | 128 个运行时包一致 |
| `npm run typecheck` | 通过，0 个 TypeScript 错误 |
| `npm test -- --run` | 842 项通过、16 项跳过、0 失败 |
| `npm run test:server` | 带只读 19 MiB 吞吐夹具为 53 项通过、1 项跳过；两地未激活目录为 52 项通过、2 项跳过 |
| `npm run test:ops` | 6/6 |
| `npm run test:native` | 8/8 |
| `npm run build` | 通过；Build ID `1.0.34+4a7d51241424` |
| `npm run test:e2e` | 254 项通过、11 项显式可选跳过、0 失败 |
| Chrome / Edge 20 MB 真实档 | 30 天快速离线约 23.84s / 最终四段 24.26s～25.01s；30 天纯挂机约 21.29s / 20.96s |
| 原生门禁 | Android `1.0.33 -> 1.0.34` 覆盖升级、APK v2/v3 与证书连续性通过；Electron 隔离启动通过；Windows `NotSigned` |
| Release manifest | source 150/150、download 9/9、bundle 10/10 全部验证 |
| 生产发布 | 两地备份、未激活目录、隔离启动、原子切换、9 文件完整公网哈希、Range/cache、当前/历史资源和 5 场 Chrome smoke 通过 |

正式源码提交为 `4a7d51241424f4289c629377e896ec70f41cbe54`。旧 `9f9714f973b0` 和 partial/diagnostic 制品均未发布。香港启动大库时出现短时 502/504，但最近 15 分钟 5xx 收敛为 0，服务始终 `NRestarts=0`；后续大库发布应继续使用低流量短维护备份并扩大 health 等待。Edge 首轮在 Android 模拟器和 Gradle daemon 资源竞争时有一次 30.527 秒，关闭竞争负载后的相同断言全部通过；不能把 30 秒描述为任意设备硬保证。物理 Android 上的 1/2/7/20 MiB 隔离云上传、真实生产账号云写入和 Electron 内 20 MB 长时结算仍未验证。完整制品、备份、线上验收和回滚证据见 [releases/1.0.34.md](./releases/1.0.34.md)。

## 48. `1.0.36` / v46 传送带与终局性能正式发布

1.0.36 以 clean source `e0ad49062fa329040b379375b595ba74b7d23daf` 发布，GameState v46、存档 envelope v2、云 schema v7、SQLite layout v2 和排行榜协议不变。最终本地门禁为 Vitest 918/17、Playwright 259/11、server 70/2、ops 6/6、native 8/8、128 个运行时许可证、1,888 模块构建和根/server 生产依赖审计 0。

| 发布检查 | 结果 |
| --- | --- |
| Source / archives | source manifest 160/160，Web/API 解包 160/160；两地远端原始哈希和源码逐文件一致 |
| 未激活 API | 两地 `npm ci --omit=dev`，各 70 项通过、2 条受保护夹具跳过；备份副本 14320 隔离启动和关键计数保持通过 |
| Android | `1.0.36 / 1000036`、APK v2/v3、zipalign、批准证书、正式 URL 和公网完整哈希通过 |
| Windows | setup/blockmap/feed、隔离启动和公网完整哈希通过；Authenticode `NotSigned` |
| 下载 | manifest 9/9、bundle 10/10；APK/EXE Range 206、1024 字节、immutable；页面/feeds no-cache |
| 双节点 | Backup API、`quick_check`、schema v7/layout v2、原子切换、活动配置、timers、Nginx 和直接 1.0.35 回滚指针通过 |
| 浏览器 | 香港桌面/手机、上海桌面、下载页桌面/手机 5/5；0 页面错误、0 非预期失败、0 破图、0 横向溢出 |
| PWA / previous stable | 当前 1.0.36 worker 唯一 active；缓存 HTML 哈希与归档一致；离线根页重开；访问 1.0.35 回退前后 Cache Storage 不变 |

用户只对 `1.0.36-e0ad49062fa3` 明确豁免 Android 真机、低配 Windows 和覆盖升级门禁，并接受 20MiB 档 12.19 秒、极端画布约 407MB 的残余风险。不得把这些门禁记为通过，也不得沿用到后续候选。完整生产证据见 [releases/1.0.36.md](./releases/1.0.36.md)。

## 49. `1.0.37` / v46 资源目录、离线决策与批量物流正式发布

1.0.37 以 clean source `853ecdb12795844c484b1415f8e72967a25e343d` 发布，GameState v46、存档 envelope v2、云 schema v7、SQLite layout v2 和排行榜协议不变。最终门禁为 Vitest 936/17、Playwright 277/11、server 70/2、ops 6/6、native 8/8、128 个运行时许可证、1,890 模块构建和根/server 生产依赖审计 0。

| 发布检查 | 结果 |
| --- | --- |
| Source / archives | source manifest 160/160，Web/API 解包 160/160；两地远端原始哈希和源码逐文件一致 |
| 未激活 API | 两地 `npm ci --omit=dev`，各 70 项通过、2 条受保护夹具跳过；备份副本隔离启动和关键计数保持通过 |
| Android | `1.0.37 / 1000037`、APK v2/v3、zipalign、批准证书、正式 URL 和公网完整哈希通过 |
| Windows | setup/blockmap/feed、隔离启动和公网完整哈希通过；Authenticode `NotSigned` |
| 下载 | manifest 9/9、bundle 10/10；APK/EXE Range 206、1024 字节、immutable；页面/feeds no-cache |
| 双节点 | Backup API、`quick_check`、schema v7/layout v2、原子切换、活动配置、timers、Nginx 和直接 1.0.36 回滚指针通过 |
| 浏览器 | 香港桌面/手机、上海桌面、下载页桌面/手机 5/5；0 页面错误、0 非预期失败、0 破图、0 横向溢出 |
| PWA / previous stable | 当前 1.0.37 worker 唯一 active；缓存 HTML 哈希与归档一致；离线根页重开；访问 1.0.36 回退前后 Cache Storage 不变 |

用户只对 `1.0.37-853ecdb12795` 明确豁免 Android 真机、低配 Windows、`1.0.36 → 1.0.37` 覆盖升级和约一小时后台门禁，并接受端到端离线约 36.8 秒、30 天非关键估计误差约 81.5%、16x 关键误差上界 1.0、60 秒精确模拟约 12.75 秒的残余风险。不得把这些门禁记为通过，也不得沿用到后续候选。香港灰度时一次只读管理员大库聚合造成 106 条短暂 502/504；受控重启后 20/20 健康通过、`NRestarts=0`，确认稳定后才继续上海。完整生产证据见 [releases/1.0.37.md](./releases/1.0.37.md)。

## 50. `1.0.41` 最终热修历史基线

香港在 1.0.42 发布前运行 `1.0.41+2e43f5644241`。该热修把云 revision 裁剪的同步全库正文 GC 改为定向 orphan cleanup，并强制微型黑洞两个运行布尔字段进入 v46 稀疏正文。1.0.42 的测试和制品以该提交为父级；原始 `32daa4f…` 没有重新成为最终基线。历史证据见 [1.0.41 发布记录](./releases/1.0.41.md)。

## 51. `1.0.42` UI、恢复与规则补充回归

本版不升级 GameState v46、envelope v2、cloud schema v7 或 SQLite layout v2。旧 `8056d2cb…` 候选已作废；固定运行时 SHA 为 `c24e6247d2572e54e30e173d3e16bfd85829b92f`，Build ID 为 `1.0.42+c24e6247d257`。

附件只读诊断确认玩家文件为 36,704,109 bytes（35.004 MiB），envelope v2、GameState v46 和 checksum 有效，含 27,153 个实体、48,917 条线路，无重复实体/线路 ID 或缺失端点；正式检查约 35.9 秒，足以超过 15 秒租约。附件不得提交仓库或用于写入测试，自动化必须运行时生成脱敏 35 MiB 状态。

新增专项至少覆盖：

- 同一 writer 租约过期仍可提交 35 MiB 正文；owner/fencing token 改变时继续拒绝。
- persisted missing + candidate available 的两个选择、进行中/失败/重试/成功提示、逐字读回和 checksum 校验。
- 候选已写入但清理阶段丢失租约后，副本保留且新租约重试可以完成；真实双标签分叉仍保留双方版本。
- 未提交时间扭曲预算在 journal missing/committed/invalid/unavailable/matching 下的时间线归属；真实 wall time 只结算一次，高倍率 debt 不提交，取消保持原正文。
- 增产剂 1、1,000,000、100,000,000 边界和非法输入；服务端 v33+ 同步校验，旧 v32/v33 存档继续读取。
- 有限/无限矿物速通提交和公开标签；普通模式、手动槽、实验/极限状态仍拒绝，历史缺标签条目按 finite 展示。
- 原 1.0.42 UI 的动态安全区、移动原子导航、焦点/inert、Axe、80%～200% 字号、44px 触控、中文输入和教程 revision 全量回归。

开发侧聚焦证据：typecheck 通过；相关 Vitest 273/273；server/security 60/2；Chromium 聚焦批次 150/1（151 总项），均 0 失败。最终全量为 Vitest 1,231/18、server 356/2、ops 55/6、native 24/24、Chromium 353/9、Firefox/WebKit 2/2、production-preview PWA 1/1，全部 0 失败；根/server 生产依赖审计 0。source manifest 214/214，candidate 10/10，provenance 3/3。完整制品、哈希、兼容边界和回滚方案见 [1.0.42 候选记录](./releases/1.0.42-candidate.md) 与 [Release Agent 交接](./RELEASE_HANDOFF_1.0.42.md)。

## 52. `1.0.42` 正式发布与代理观察回归

两地未激活 API 在各自临时 SQLite/备份边界内运行完整 server 356/2；Linux ops 为各 59/2。生产切换前分别验证 SQLite Backup API、完整 SHA-256、`quick_check`、schema v7/layout v2、独立 preflight 和单 writer。香港 3.2 GiB 大库冷启动实测约 181.060 秒；默认 180 秒首次切换自动恢复旧服务，确认候选兼容后使用 300 秒 readiness 重新执行成功。测试和发布没有向真实玩家账号写入合成数据。

观察期发现 handoff proxy 的复用空闲 socket 可能在尚未收到上游响应时返回 `ECONNRESET`。提交 `d885a9e…` 增加一次严格只读重试，writer 仍单次发送；本地完整 ops 更新为 56/6，聚焦测试在 Windows 连续五轮 4/4、Linux Node 20 和 Node 22 各 4/4，均无失败/告警。两节点替换代理时活动 API PID 保持不变，systemd 原依赖逐字恢复，health/ready、公开版本、排行榜和 1.0.37 PWA 回退通过。

正式 Android APK 使用批准长期证书，v2/v3、zipalign、包名/versionCode、正式 URL 和 API 36.1 模拟器 1.0.38→1.0.42 覆盖升级通过；Windows setup、blockmap、feed、ASAR Build ID、正式 URL、隔离启动和公网完整哈希通过，Authenticode 仍为 `NotSigned`。实体 Android、低配 Windows、iOS standalone 和实体读屏器未实测，必须保留为残余风险。完整证据见 [1.0.42 正式发布记录](./releases/1.0.42.md)。

## 53. `1.0.43` 超大存档导入、迁移与保存热修

本版针对 36,704,109-byte 合法 v46/v2 玩家存档的 UI 冻结，不改变任何持久协议。原实现在线路迁移中对每条 belt 重复 `entities.find`，再用 `filter + belts.includes` 分区，玩家档约触发 49.23 亿次比较；序列化本身约 0.49 秒，并非主因。

必须持续满足以下门禁：

- 实体索引 first-match，且单独保留 first matching material-delivery hub；初始矿脉恢复后才建索引。
- 物质投递端口先对所有 migrated belts 按顺序归一，再验证端点/行星；黑洞端口仅对有效候选按顺序占用。
- 重复 belt id 不去重；缺端点、跨星球、错误 planet 与不同 tier 的逐 lane 退款保持原总量和施工件类型。
- previous 主档只完整检查一次，自签但结构非法的正文不得覆盖有效 backup；legacy missing-checksum previous 仍须持久复制，但 `backupSaved` 保持 false。
- 手动保存 stable flow 只增加一个 primary revision，backup 逐字等于旧 primary；稳定受控返回同样只写一次，保存等待期间状态推进时允许且必须补一次 cleanup。
- 文件导入、菜单云恢复和工厂内云恢复在 Worker 完成 checksum/结构/迁移检查；请求代际阻止较早结果覆盖较新选择，Worker 不可用或 message clone 失败时回退完整同步检查。
- 可选真实夹具必须只读，断言精确 bytes/SHA-256 前后不变，并设置有意义的 <5,000 ms 检查门禁；附件不得进入 Git、制品或写入测试。

主菜单 `savePreview` 的完整 `JSON.parse` 语义在 1.0.43 保持不变。手写 partial scanner 无法安全复制重复 key、嵌套同名字段、截断正文和 fallback 顺序，因此可信 IndexedDB summary index/Worker projection 作为 1.0.44 独立设计，不混入本热修。

正式发布门禁结果：

| 门禁 | 最终结果 |
| --- | --- |
| Source / build | clean `fceca3eda51cf7e488e176e23c6119ba104b77fd`；Build ID `1.0.43+fceca3eda51c`；1,929 modules；startup gzip 185,923 B；forbidden startup modules 0 |
| 不可变制品 | source/Web 归档及 manifest/SHA256SUMS 独立复算；Web 122/122，client 744 B 直接引用 256,220 B inspection Worker；旧 a47 候选保持作废 |
| 完整浏览器 | clean `2ecd5ad1a64d` 的相同 runtime/test tree：364 total，356 passed / 8 explicit env-gated skipped / 0 failed，1,039.2 s；final tip 的 docs-only 差异已独立证明 |
| production preview | PWA/version/current-v143/history-v142 3/3；compiled preview 黑盒精确核对 Build ID、manifest 与 client→worker；一次错误选择 DEV-only `/src` 内省用例的失败作为 harness-incompatible 诊断保留 |
| 香港切换 | generation 9→10 与 11→12 两次均由 guard 安全回滚；第三次 generation 13 成功，current 1.0.43 / previous 1.0.42，API 1.0.42、PID/restarts、proxy 与 pending 状态不变 |
| 公网与 PWA | normal public 36/36、Chrome worker h2+gzip 3/3、physical candidate/control 12/12、live PWA 3/3；最终三轮 root/version/SW/manifest/worker/health/ready 全部 HTTP 200 且哈希/Build ID 精确 |
| 正式附件 UI | import→preview 1,379 ms；confirm→canvas 5,185.4 ms；manual save 2,809.2 ms；return 2,859.7 ms；reload 858.3 ms；revision 0→1→2→3、backup 链逐字正确、mirror/conflict 为空；源文件前后逐字不变 |
| 隐私/零写 | 临时 profile、无 trace/截图/附件副本；cookies/cloud auth 为空；所有预期 API 由严格本地 shim 校验并返回，unknown API/write 0；独立 Nginx 证据为 12 次 GET 200、`/api` 0、non-GET 0 |

正式附件还暴露出本热修范围外的运行态 P0：受控 Continue→Pause 为 20,887 ms，Long Task 峰值 20,291 ms。1.0.43 只证明迁移/初次进入、保存和返回持久化链正确且显著有界，不能据此宣称主动模拟可玩性已恢复；1.0.44 必须以 P0 继续优化。

香港 `manifest.webmanifest` 仍继承 1.0.42 的精确响应契约：HTTP 200、413 B、SHA-256 `fc70a386379d0a32eb71fc17a0694d40ad3b1a5ac9b0b61e81a4aa16da0536bf`、`Cache-Control: no-cache`、`Content-Type: application/octet-stream`。Chrome `Page.getAppManifest` 无错误且 PWA ready/controller/offline/update 通过；这不是 `application/manifest+json`，须作为独立 Nginx 技术债修正，不能改写本次既有生产事实。完整证据与回滚状态见 [1.0.43 正式发布记录](./releases/1.0.43.md)。

## 54. `1.0.44` 连线视口呈现专项（开发态）

本项只使用确定性匿名引擎夹具，不读取玩家附件、账号或生产服务。设备偏好测试覆盖缺失、损坏、写入、重载持久化及 GameState 正文不含该键；功能测试覆盖普通 Ctrl 10 节点、极限 Shift 100 节点、source、candidate、viewport、Enter、Escape、移动长按、完整逻辑节点、实际 DOM 和 Handle 数量，以及 expand-all 只等于活动行星节点数。

门禁结果：focused Vitest 10/10，typecheck 通过；新 Chromium 功能项 3/3（开发服务器，性能项按设计跳过），既有 `v127-selection-batch` 14/14，既有 game-flow 连线回归 4/4。production build 为 1,930 modules，startup 总 gzip 185,978 B、JS 94,813 B、CSS 91,165 B，预算通过。既有 `v124-canvas-performance` 在 production preview 为 4/5：四条画布/监控/小地图/回退用例通过，唯一失败是旧测试仍从已迁移清空的 localStorage 读取 GameState 并得到 `missing`，属于 preview harness 不兼容而非运行时断言失败，未据此修改旧测试。

production-preview Chrome 的匿名活动行星为 106 节点，默认与 expand-all 各运行三轮：

| 模式 | entry ms | frame P95 ms | frame max ms | >50ms | logical full | viewport full | rendered full | Handles |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 默认 viewport | 37.1 / 35.3 / 36.4 | 13.9 / 14.0 / 13.9 | 69.6 / 69.5 / 76.4 | 2 / 2 / 2 | 15 / 15 / 15 | 15 / 15 / 15 | 10 / 15 / 10 | 18 / 33 / 18 |
| expand-all | 16.8 / 15.7 / 15.7 | 7.1 / 7.0 / 7.0 | 111.2 / 111.2 / 111.1 | 1 / 1 / 1 | 106 / 106 / 106 | 18 / 18 / 18 | 10 / 10 / 10 | 18 / 18 / 18 |

默认路径硬门禁为 entry ≤50 ms、组合进入/平移/缩放/取消的 frame P95 ≤33 ms，三轮均通过。max 与 >50ms 保留为原始抖动证据，不以 P95 掩盖；expand-all 逻辑模型明显扩大，设置页必须持续显示卡顿警告，不把该显式兼容路径宣称为性能优化。开发 React validation build 的 entry 为 129～143 ms，因此性能硬门禁只在 production preview 执行，开发服务器仍运行全部功能断言。

## 55. `1.0.44` 密集画布自适应、重叠分组与重叠放置专项（开发态）

本项只使用代码生成的匿名 GameState fixture、本地 API shim 和临时浏览器 profile；没有读取、复制、打印或写回真实玩家附件、账号、云存档或生产服务。`canvasDensityPresentation` 纯函数覆盖 100/500/2,000 可见节点、两组迟滞、受保护成员、告警聚合和 2,000 个 exact-overlap 的线性分组；偏好测试覆盖 auto/false 默认、缺失、损坏、写入与重载。引擎/loader 测试覆盖默认 exact-overlap 拒绝、显式即时/排队部署、queue→fund→place、原 `blueprintVersionId`、多拖相对布局/自身旧位置排除、损坏字段回退，以及 1.0.43 loader 丢失 opt-in 后不兼容队列取消返还全部预留材料且实体不变。

最终 production-preview Chromium 为 9/9：

- 50 个 exact-overlap 成员只绘制 1 个代表卡/halo/badge，49 个后层 proxy 均为 `aria-hidden`、`tabIndex=-1`、opacity 0、无 pointer events；只有 3 个真实线路端点保留隐藏 handle，3 条 edge 均存在。fixture 另含 6 个基础节点，因此 heavy card 总数为 7；隐藏成员可由 badge 键盘循环选中并展开，halo 仍为 1。
- 仅后层成员产生的 1 个告警会聚合为 leader badge `⚠1` 和唯一 alert halo；键盘循环后目标成员成为 selected/full，告警计数和单 halo 保持。
- 500 节点批量框选得到至少 300 个 selected，拖动时 full/heavy 主交互目标不超过 1，提交至少 300 个相对位置；三节点多拖默认 exact-overlap 被拒绝且两成员位置恢复，在设置页开启同一设备偏好后无需重载即允许、形成 `×2` stack，并在 reload 后保持开启。
- compact boundary 下不重载切换连接点放大 50% 与超大命中区，近点连接立即建立；compact 蓝图放置中切换 overlap 后，同一点第一次即时部署、第二次保留当次意图进入施工队列。390×844 下放置开关可见且无横向溢出。
- 2,000 raw-visible exact stack 为 compact、heavy card 0、WorkCycle 0、hidden proxy 1,999、halo 1；分组没有降低 raw visible 压力信号。

暂停/继续控制以 shell 状态变化后第二个 painted frame 为完成边界，不使用 dataset 刚变化的假绿结果：

| 匿名压力 | 控制耗时 | dynamic / stable / changed Node | React commit / layout paint 诊断 | 门禁 |
| --- | --- | --- | --- | --- |
| 500（506 个活动节点） | Continue 16.0 ms；Pause 10.3 ms | 0 / 506 / 0 | 56.2 / 43.2 ms | 两次 second-painted ≤50 ms，通过 |
| 2,000 exact stack（2,006 个活动节点） | Continue 85.3 ms | 0 / 2,006 / 0 | 50.9 / 79.5 ms | second-painted ≤100 ms，通过 |

相同 fit-view、pan 与两次 zoom 手势从 clean production preview 独占运行三轮；默认 auto 是硬门禁，full 与 connect-expand-all 是设置页明确警告的成本对照：

| 模式 | action ms | frame P95 ms | frame max ms | >50 / >100 | 最终 DOM / 逻辑 |
| --- | --- | --- | --- | --- | --- |
| auto | 150.76 / 153.65 / 122.28 | 13.9 / 7.0 / 7.1 | 14.0 / 13.9 / 14.0 | 0/0 · 0/0 · 0/0 | compact；默认门禁通过 |
| full | 1,952.54 / 1,175.50 / 1,551.87 | 347.6 / 160.0 / 104.2 | 347.6 / 389.2 / 361.5 | 12/10 · 7/4 · 10/5 | 显式高成本兼容档，持续警告 |
| connect-expand-all | 646.05 / 528.60 / 584.04 | 55.5 / 55.6 / 76.5 | 104.2 / 69.5 / 76.5 | 2/1 · 2/0 · 2/0 | 每轮 logical full 506；render wrappers/heavy/handles/glow = 503/503/1,503/0 |

最终 commit-tip 独占窗口为 2026-08-15 05:27:10～05:27:48（Asia/Shanghai），端口 4361 前后均空闲，完整 9/9 通过。两日未活动的旧 Node test 树与用户常驻 Chrome 由 root 预先确认 CPU 静止，期间没有新外部 Playwright/Vite/测试树。此前与 runtime aggregation 重叠的采样、因测试直接操作视觉隐藏 checkbox 而功能失败的采样，以及随后未进入最终代码的 bulk-drag 实验 targeted 采样全部作废，没有混入上表。

门禁汇总：focused Vitest 4 files / 316 tests 通过，typecheck 通过；`server.test.mjs` 39/2 通过并证明现网 c24 开放式 v46 queue validator/PUT 接受字面 `allowExactOverlap: true`；production build 1,931 modules，startup 总 gzip 186,944 B、JS 94,934 B、CSS 92,010 B，预算通过。真实 35 MiB / active 4,213 权威门禁不在本分支伪造或替代，仍必须由集成分支使用正确 IndexedDB loader 验证 Continue/Pause second-painted、React commit/layout 与 running pan/zoom；本专项未部署。
