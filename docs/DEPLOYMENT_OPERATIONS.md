# 部署与运维手册

> **Android-only 下载切换（2026-09-09）**：使用新上海受保护通道，下载 current=`download-site-1.2.8-aa1f970a677b`，previous=`download-site-1.2.7-dab2ff5066b7`。APK/stable 为 1.2.8 / 1002008，Windows stable 为 1.2.6；Web/API、数据库、服务进程未切换。11 文件远端复算、8 文件公网完整哈希与 3 文件 Range 通过；下载回退独立于 Web/API/数据。见 [完整证据](./releases/1.2.8-android-cloud-hotfix.md)。

> **2026-09-08 香港 Web 展示补偿**：current Web `1.2.7-fccaa35e6b41`，API 保持 `api-1.2.6-df828869e276`，generation 50。用户指定累计界面固定增加 3,700（2026-08-14—09-07），属于客户端展示估算，公开 API 和真实身份记录不加数。后续发布应携带主工作树提交 `3589b7c2`；如迁至 API 计算，须同步删除前端补偿。直接 Web 回滚与 `/canary/previous/` 均保留 `1.2.7-dab2ff5066b7`，新 Nginx SHA `eb1c5156390be5a15419504c4670cdc8cef3b13e8c6c92e38a40b4a20053d83a`。详见 [发布、验收与回滚记录](./releases/ops-hk-player-display-3700-2026-09-08.md)。

> 公开仓库脱敏说明：本文及 `deploy/` 模板中的节点地址、证书主机名和对象存储标识均使用示例占位符。实际值只应从受保护的运维环境注入，不能提交到 Git。

## 1. 环境边界

| 环境 | 地址 | 主机 | 作用 |
| --- | --- | --- | --- |
| 香港正式 | `https://dsponline.cn` | `hk-origin.example.invalid` | 正式 Web、云账号、云存档、排行榜 |
| 香港别名 | `https://www.dsponline.cn` | 同上 | 301 到根域名 |
| 上海独立节点 | `http://shanghai-new-node.example.invalid` | `shanghai-new-node.example.invalid` | 已迁新机的独立 HTTP 入口和备用试玩；不提供账号密码输入 |
| 上海下载节点 | `https://download.dsponline.cn` | `shanghai-new-node.example.invalid` | Windows/Android 安装包与稳定更新清单 |
| 本地前端 | `http://127.0.0.1:4318` | 开发机 | Vite |
| 本地 API | `http://127.0.0.1:4320` | 开发机 | Node 云服务 |

硬边界：上海节点必须继续由上海本机提供前端与 `/api`，不得改成香港反代或域名跳转。上海为 HTTP，前端必须继续拒绝云账号密码传输。

> 当前上海状态（2026-09-08，全业务迁机）：新上海承接原旧上海业务和公开下载，DSP Web/API current 为 `1.2.6-df828869e276`、previous 为 `1.2.5-0a1c6629ced1`，generation 32 / proxy 92，green/4322；下载 current/previous 同为 1.2.6/1.2.5。健康、下载完整哈希、Range、权威/公共 DNS 和节点磁盘监控通过。后续运维必须从受保护 `DSP_SH_NEW_*` 在单个调用子进程内映射到 Shanghai helper；原 `DSP_SH_*` 仍指旧机，不要继续向旧机部署。旧机保留数据、停止写入并设置自动启动保护，到期前仅转发新上海；跨机回退必须先冻结新机并保全新增数据。香港不在此次变更范围，其异地备份 timer 的 inactive 状态需另行核实。完整证据见 [迁移记录](./releases/ops-shanghai-vps-migration-2026-09-08.md)；以下按日期保留的旧发布状态不是迁机后的拓扑。

> 当前生产状态（2026-08-31，1.2.6 已稳定发布）：香港/上海 Web/API current 均为 `1.2.6-df828869e276`，previous 均为 `1.2.5-0a1c6629ced1`；香港 generation 48 / proxy generation 192，上海 generation 32 / proxy generation 92，均为 green / 4322。上海下载页 current 为 `download-site-1.2.6-df828869e276`、previous 为 1.2.5；香港 `/canary/previous/` 302/no-store 到不可变 1.2.5。两地 API/proxy/health timer active、`NRestarts=0`、pending 与 disposable preflight 均为空、health/ready 200、Nginx 有效。香港/上海正式发布快照分别为 4,460,781,568 / 462,848 B，并通过完整 SHA、quick-check、schema 8、layout 3 和文件身份绑定；香港异地备份 timer active，上海恢复演练 timer active。最终磁盘 81% / 77%。`download.dsponline.cn` 的唯一 A 记录已按明确授权回切旧上海，默认线路和 TTL 600 不变；新上海继续在线但不承担当前公开下载。Windows 1.2.6 为 `NotSigned`；Android `1.2.6 / 1002006` 保持长期证书。完整证据与香港到旧上海区域性 TLS 合成探针的残余边界见 [1.2.6 发布记录](./releases/1.2.6.md)。

> 当前生产状态（2026-08-30，1.2.5 已稳定发布）：香港/上海 Web/API current 均为 `1.2.5-0a1c6629ced1`，previous 均为 `1.2.4-3154f8cf4479`；香港 generation 47 / proxy generation 186，上海 generation 31 / proxy generation 89，均为 blue / 4321。上海下载页 current 为 `download-site-1.2.5-0a1c6629ced1`、previous 为 1.2.4；香港 `/canary/previous/` 302/no-store 到不可变 1.2.4。两地 API/proxy/health timer active、`NRestarts=0`、pending 与 disposable preflight 均为空、health/ready 200、Nginx 有效。香港/上海正式发布快照分别为 4,460,781,568 / 462,848 B，并通过完整 SHA、quick-check、schema 8、layout 3 和 inode/mtime 身份绑定；香港异地备份 timer active，上海恢复演练 timer active。发布后磁盘 80% / 76%。Windows 1.2.5 为 `NotSigned`；Android `1.2.5 / 1002005` 保持长期证书。完整证据见 [1.2.5 发布记录](./releases/1.2.5.md)。

> 当前生产状态（2026-08-27，1.2.2 已稳定发布）：香港/上海 Web/API current 均为 `1.2.2-8b9c93e13270`，previous 均为 `1.1.9-c3f4eff6cb5a`；香港 generation 43 / proxy generation 168，上海 generation 25 / proxy generation 71，均为 blue / 4321。上海下载页 current 为 `download-site-1.2.2-8b9c93e13270`、previous 为 1.1.9；香港 `/canary/previous/` 302/no-store 到不可变 1.1.9。两地 API/proxy/health timer active、`NRestarts=0`、pending 为空、health/ready 200、backup idle、node-health 无失败，schema v8/layout v3 未变。香港/上海正式备份分别为 3,772,833,792 / 462,848 字节并通过完整 SHA、`quick_check` 和身份校验；发布后磁盘 60% / 75%。Windows 1.2.2 继续 `NotSigned`；Android `1.2.2 / 1002002` 保持长期证书。回滚与首次香港 control 执行位故障的完整恢复证据见 [1.2.2 发布记录](./releases/1.2.2.md)。

> 当前生产状态（2026-08-24，1.1.5 已稳定发布）：香港/上海 Web/API 均为 `1.1.5-a92c0d3157f3`，香港 generation 35 / proxy generation 135，上海 generation 21 / proxy generation 59；两地 previous Web/API 均为 `1.1.4-7dbc149a016c`。上海下载页 current 为 `download-site-1.1.5-a92c0d3157f3`，previous 保留 1.1.4；香港 `/canary/previous/` 302 到 `web-1.1.4-7dbc149a016c`。两地 API、代理和健康 timer active，`NRestarts=0`，local/public health/ready 200，pending switch 为空。1.1.5 没有恢复或改写生产数据库、WAL/SHM、玩家存档或排行榜；数据库 schema 8 / SQLite layout 3 的正式 Backup API evidence 已保留并通过 quick_check/哈希/磁盘水位。上海切换辅助命令的非零退出已由独立 current/previous 指针、release-control audit、监听器和公网验收覆盖，禁止重复执行。回滚只允许在当前 generation、evidence 和健康条件仍匹配时按发布记录的 Web/API、下载页和原生边界分别执行，不能把 previous-stable 当作 API 或数据库灾备。

> 当前生产状态（2026-08-19，1.0.46 No-Go 回滚后）：香港/上海 Web/API 均为 `1.0.45-8061a002fc59`，switch-state generation 分别为 21/10，云 schema v8 / SQLite layout v3；上海下载页及 Android/Windows stable 为 `1.0.44-3e580c715a5a`。香港 `/canary/previous/` 继续 302 到不可变 `1.0.43-fceca3eda51c`。两地 health/ready 200、API/proxy/node-health 正常、`NRestarts=0`，数据库未恢复或改写。1.0.46 因公网 Service Worker 错误请求 `/assets/assets/*` 而判定 No-Go；release-control 的 current 已恢复 1.0.45，但其 `previous` 当前指向被拒绝的 1.0.46，所以禁止用 `--rollback-last` 作为恢复命令。后续必须用新 SHA/Release ID 显式前进，详情见 [1.0.46 No-Go 记录](./releases/1.0.46-no-go-2026-08-19.md)。

> 当前生产状态（2026-08-15）：香港 Web generation 13 current 为 `web-1.0.43-fceca3eda51c`、Build ID `1.0.43+fceca3eda51c`，直接 previous 为 `web-1.0.42-c24e6247d257`；香港 API、上海 Web/API、上海下载页和 Android/Windows stable 均保持 1.0.42。发布代理继续 forward 到 `api-1.0.42-c24e6247d257`，活动 API `NRestarts=0`，pending switch 为空。两地数据库继续独立使用 schema v7 / SQLite layout v2；本次 Web-only 发布没有 API/数据库/上海/下载/原生写入。香港 `/canary/previous/` 继续 302 到不可变 `/canary/1.0.37-853ecdb12795/`。完整 1.0.43 切换、两次安全回滚、真实附件与观察证据见 [releases/1.0.43.md](./releases/1.0.43.md)；1.0.42 双节点/原生/下载历史见 [releases/1.0.42.md](./releases/1.0.42.md)。

> 当前生产状态（1.0.44）：香港 Web/API、上海 Web/API、上海下载页与 Windows/Android stable 均已切换至 1.0.44。香港 switch-state generation 14：current Web `web-1.0.44-3e580c715a5a`、API `api-1.0.44-3e580c715a5a`，slot green / 4322，previous Web `web-1.0.43-fceca3eda51c`、previous API `api-1.0.42-c24e6247d257`；上海 switch-state generation 5：current Web/API `1.0.44`，slot blue / 4321。上海下载页 `current` = `download-site-1.0.44-3e580c715a5a`（回滚目标 `download-site-1.0.42-c24e6247d257`）；Android stable `1.0.44 / 1000044`、Windows stable setup `1.0.44`。两地发布代理分别 forward 到 `api-1.0.44-3e580c715a5a`，活动 API `NRestarts=0`，pending switch 为空；数据库继续独立使用 schema v7 / SQLite layout v2，本版为代码级稳定发布，无 schema/layout 迁移、恢复或数据写入。下载节点仍为上海（`download.dsponline.cn` → `111.229.128.211`）。**香港上一稳定版回退入口 `/canary/previous/` 已于 1.0.44 观察通过后更新为 302 → `/canary/1.0.43-fceca3eda51c/`**（活动 snippet 新 hash `822389023b94546ca0709afbf959aa8ab606a4545b0311fd48c7171d92efbbab`，回滚副本 `dsp-idle-app.conf.pre-previous-fallback-1.0.43-20260816T175329Z` 原 hash `b230cdf74bc067999e65d33347ab3ed8b860f9506641ca14b70cc2d45bc75cdc`）；`/canary/1.0.37-853ecdb12795/` 保留为历史兼容入口。完整证据见 [releases/1.0.44.md](./releases/1.0.44.md)。

> 1.0.39 API 优先 P0 已发布，1.0.38 Web/Android/Windows 无需清缓存或重装即可恢复上传。Release Agent 已分别创建并验证两节点快照，用各自备份副本合成验证 v46 稀疏普通/速通 main 与手动槽、原始正文/校验/revision、历史恢复、服务重启、v45 稠密兼容与非法值拒绝；普通/速通复核阈值独立、隐藏状态和永久冻结由完整远端服务测试与香港隔离副本覆盖。本版没有 schema/layout migration；回滚只切回 1.0.38 代码并重启，绝不恢复生产数据库。

> 1.0.38 没有升级 schema/layout 或修改排行榜协议。两地发布前备份均通过 SQLite Backup API、`quick_check` 和哈希验证；未激活 API 已在各自备份副本上隔离启动。不得跨节点复制、合并或裁剪数据库。用户只豁免精确候选 `1.0.38-351c649af9ee` 的 Android 真机、低配 Windows、`1.0.37 → 1.0.38` Windows 覆盖升级和约一小时后台/锁屏门禁，并接受已列明性能残余风险；不豁免后续版本、备份、签名、健康或回滚门禁。

## 2. 服务器布局

两个 Linux 节点遵循同一目录约定：

| 路径 | 内容 |
| --- | --- |
| `/var/www/dsp-idle/current` | 当前前端发布目录或软链接 |
| `/opt/dsp-idle-cloud/current` | 当前云服务代码目录或软链接 |
| `/var/lib/dsp-idle-cloud/cloud.sqlite` | 生产 SQLite 数据库 |
| `/var/lib/dsp-idle-cloud/cloud.json` | 旧 JSON 数据，仅用于兼容迁移 |
| `/var/lib/dsp-idle-cloud/backups` | SQLite/JSON 备份 |
| `/var/www/dsp-idle-downloads/current` | 上海客户端下载站当前发布目录或软链接 |
| `/etc/nginx/snippets/dsp-idle-app.conf` | 公共静态与 API 规则 |
| `/etc/dsp-idle-cloud/admin.env` | 仅 root/服务账号可读的管理员 token 与邮件 API 凭据，不进入发布目录 |

服务端绑定 `127.0.0.1:4320`，公网只通过 Nginx 的 `/api` 访问。仓库里的 systemd 和 Nginx 文件是模板，实际安装前必须对照目标节点，不能把香港 Origin 或证书路径直接覆盖到上海。

香港 Web 已切换到 `web-1.0.43-fceca3eda51c`；香港 API 与上海 Web/API 保持 `1.0.42-c24e6247d257`，上海下载站保持不可变 `download-site-1.0.42-c24e6247d257`。两地继续使用 GameState v46、云 schema v7 和 SQLite layout v2，代码回滚不得恢复数据库；香港 `/downloads/*` 仍 302 到上海下载域名，公开 `/canary/previous/` 仍指向 `web-1.0.37-853ecdb12795`。Android 1.0.42 APK、Windows 1.0.42 setup、签名状态及下载哈希均未改变。香港 Web 直接回滚目标为 `web-1.0.42-c24e6247d257`；生产收口磁盘香港约 74%，API PID/restarts 与 proxy generation 保持不变。完整 1.0.43 Web 证据见 [releases/1.0.43.md](./releases/1.0.43.md)，1.0.42 API/上海/原生/下载证据见 [releases/1.0.42.md](./releases/1.0.42.md)。

`1.0.13` 两节点发布都只切换 Web/API 代码，未执行数据库迁移。香港发布前后 Backup API 快照均通过 `quick_check`；前备份为 887,271,424 字节，后备份为 888,795,136 字节。上海发布前后备份均为 122,880 字节并通过 `quick_check`；发布前 SHA-256 为 `a8af0eec173e6f8aad36af09b7e6d8c56b2b00014d76efd53124ddfb81b7e6a7`，发布后为 `8cb0c7bbbb270ac804b7c16909fc1b4274d0b2aed34a4ae7f379f333596cd737`。上海 0 个账号、0 个主云档、24 条玩家记录和 23 条错误记录均未减少，服务 `NRestarts=0`。受限备份传输账号仍只用于异地备份，代码发布使用独立的 `ubuntu` 授权。

`1.0.13` Android APK 使用与 1.0.0～1.0.12 相同的长期发布证书，模拟器从正式 1.0.12 使用 `adb install -r` 覆盖升级后 `firstInstallTime` 和 19 小时 26 分本地主存档保持。Windows 安装程序继续按历史策略作为未签名测试包发布。上海下载站在独立目录完成 6/6 文件哈希和清单复验后原子切换，旧 1.0.12 目录作为回滚点保留。

`1.0.12` 为电磁轨道弹射器增加存档级目标太阳帆轨道，并修复线路同步模板、配送枢纽大字卡片和亮色物流交互状态。v40→v41 迁移不重建或删除太阳帆、发射进度、库存、线路和戴森工程；存档 envelope、云 schema 和 SQLite layout 不变。两节点切换前分别创建并验证 SQLite Backup API 备份，未激活目录完成 135/135 文件复验、42/42 服务端、6/6 运维和生产备份副本隔离启动；Android 从正式 1.0.10 同签名覆盖升级并保留 19 小时 26 分本地主存档后，才切换 Web/API、下载页与稳定清单。

`1.0.11` 在 1.0.10 运行时索引上继续复用稳定物流匹配、路线经济和派遣摘要，并把燃料、能量枢纽及递归制造改为确定性批量结算；同时增加服务器内部排行榜完整性限制。它不升级 GameState、envelope、云 schema 或 SQLite layout。两节点切换前分别创建并验证 SQLite Backup API 备份，未激活目录完成 134/134 文件复验、42/42 服务端、6/6 运维和生产备份副本隔离启动；Android 从正式 1.0.10 同签名覆盖升级并保留本地主存档后，才切换 Web/API、下载页与稳定清单。

`1.0.10` 增加模拟会话运行时索引、按行星生产/供电推进、线路端点快速查找和当前行星画布派生，不升级 GameState、envelope、云 schema 或 SQLite layout。两节点切换前分别创建并验证 SQLite Backup API 备份，未激活目录完成 131/131 文件复验、37/37 服务端、6/6 运维和生产备份副本隔离启动；Android 从正式 1.0.9 同签名覆盖升级并保留本地主存档后，才切换 Web/API、下载页与稳定清单。

`1.0.9` 将浏览器权威本地存储迁入 IndexedDB，增加动态模块恢复、普通来源公平线路分配、1 亿线路转运额度和声明式内容包 v2；空间站收集任务长期开放，主页首屏提供设备级中英文切换。服务端合法客户端上限扩展到 v40，但 envelope v2、云 schema v7 和 SQLite layout v2 不变。两节点在切换前均创建并验证 SQLite Backup API 备份，未激活目录完成 37/37 服务端、6/6 运维和生产备份副本隔离启动；Android 从正式 1.0.8 同签名覆盖升级并保留本地工厂后，才切换 Web/API、下载页与稳定清单。

`1.0.7` 只修复客户端建筑制造中心任务结算和 WIP 显示，不升级 GameState、云 schema、SQLite layout 或服务端存档边界。两地发布前后均通过 SQLite Backup API 备份和 `quick_check`，未激活目录完成 126/126 文件校验、35/35 服务端、6/6 运维及生产备份副本隔离启动。上海下载站和公开原生安装包未切换。

`1.0.8` 把合法客户端状态上限扩展到 v39，但继续使用 envelope v2、云 schema v7 和 SQLite layout v2。服务端开始独立校验上传 payload 的内部 FNV-1a 状态校验值。两节点切换前均通过 SQLite Backup API 创建并验证备份，在备份副本确认旧 v35-v38 云存档仍可读取、异常校验 payload 被拒绝且不会产生新修订；Android/Windows 也已通过签名连续性、覆盖升级、本地数据保留、文件哈希和更新清单验证后切换。

`1.0.6` 把客户端状态上限提高到 v38，但不升级云 schema 或 SQLite layout。两地发布前已验证 v35～v38 合法存档可接受、v38 非法并联/资源锚点/副产物累计会被拒绝，并在生产备份副本上隔离启动；上海下载页只在 Windows 与同证书 Android 制品完整上传、哈希和覆盖升级通过后切换。

该版本会在服务启动时按已有主存档幂等回填排行榜。首次香港回填处理 88 份主存档，重复启动备份副本时变更为 0；上海没有主云存档，因此保持空榜。后续主槽上传、自动同步或历史恢复都会自动更新排名，手动槽不会触发。任何后续排行榜规则变更仍应在切换前使用 SQLite Backup API 创建并验证备份，并在切换后核对账号、主云存档和修订数量不减少。

## 3. 绝对数据保护规则

1. 不得删除、清空、重新初始化或用测试数据覆盖 `/var/lib/dsp-idle-cloud`。
2. 不得把本地 `server/data`、临时 SQLite、测试 fixture 或空数据库上传到生产数据目录。
3. 不得通过直接复制正在写入的 SQLite 主文件制作备份；使用 `deploy/backup-sqlite.mjs` 或 SQLite backup API。
4. 后端、schema 或存档兼容逻辑变更前，先创建带时间戳备份并验证文件可打开。
5. 回滚代码时默认保留当前数据库。只有明确的灾难恢复决定才能回滚数据，而且必须先再备份当前数据。
6. 不得在文档、Git、日志或聊天中写入 SSH 私钥、密码、session token、证书私钥或用户存档内容。
7. 任何可能删除浏览器 `localStorage` 主存档的代码都视为数据迁移，必须有迁移测试和显式用户确认。

## 4. 发布前检查

从干净、可追溯的提交发布：

```powershell
npm ci
npm run typecheck
npm test
npm run test:server
npm run test:ops
npm run test:native
npm run build
npm run test:e2e
```

同时确认：

- `package.json` 版本、Git 提交、构建 ID 和发布记录一致。
- `dist/` 来自当前提交，不复用旧目录。
- `server/package-lock.json` 与服务代码一起发布并使用 `npm ci --omit=dev`。
- 存档格式和 `GameState` 若升级，迁移测试覆盖上一正式版本。
- 香港和上海的 Nginx 配置分别选择正确模板。
- 发布窗口内没有正在进行的数据恢复或数据库维护。

### 4.1 VPN/TUN 开启时的临时出口绑定

发布终端若启用 Clash、企业 VPN 或其他 TUN，VPS SSH 可能在密钥交换前被 fake-IP 或代理规则关闭。无需关闭 VPN，也不要添加永久主机路由；先找出拥有真实默认网关的物理 IPv4 地址，并只对本次进程绑定出口：

```powershell
$physical = Get-NetIPConfiguration |
  Where-Object {
    $_.IPv4DefaultGateway -and
    $_.NetAdapter.Status -eq 'Up' -and
    $_.IPv4Address.IPAddress -notlike '198.18.*'
  } |
  Select-Object -First 1
$bindIp = $physical.IPv4Address.IPAddress
```

- Git OpenSSH 使用 `ssh -b <physical-ip> ...`。
- SCP 使用 `scp -o BindAddress=<physical-ip> ...`。
- 公网探针使用 `curl --interface <physical-ip> ...`；若 TUN DNS 返回 fake IP，再增加 `--resolve <public-host>:443:<secured-origin-ip>`，仍由 TLS 校验公开域名。
- 先执行 SSH 只读命令和 HTTPS health；确认来源、Host/SNI、当前指针和服务都正确后，才允许进入备份或切换阶段。

真实服务器地址、账号和 key 路径只从受保护运维环境解析，不写入命令模板、Git 或发布记录。不得关闭 host-key/TLS 校验，不得把 VPS SSH key 当作应用签名证书，也不得通过持久路由把其他流量长期绕过 VPN。

GitHub 与 VPS 可能需要不同出口：若物理直连无法访问 GitHub 22/443，但 VPN 可以访问，则 Git 操作保留 VPN 路径，并临时使用 GitHub 官方 SSH-over-443 入口：

```powershell
$env:GIT_SSH_COMMAND = '"C:/Program Files/Git/usr/bin/ssh.exe" -o Hostname=ssh.github.com -p 443 -o BatchMode=yes'
git fetch origin main
# 完成 fetch/push 后清除本次进程变量
Remove-Item Env:GIT_SSH_COMMAND
```

不要为一次发布修改全局 SSH 配置或远端 URL。出口绑定只解决本地网络路径，不改变服务器权限、发布门禁、备份顺序或回滚要求。

### 4.2 受保护签名与服务器连接入口

Android keystore、口令、别名、SSH 私钥、真实节点和 `known_hosts` 物理位置不写入本手册。后续 Agent 统一先读 [受保护发布凭据与新会话接管](./PROTECTED_RELEASE_ACCESS.md)，再运行只读能力检查：

```powershell
pwsh -NoProfile -File .codex/skills/develop-dspidle/scripts/test-protected-release-access.ps1
```

Android 正式构建只允许通过 `invoke-protected-android-release.ps1` 将 vault 字段临时注入子进程，并验证 clean SHA、APK v2/v3、zipalign、包名/版本及 APK/AAB 历史证书连续性。香港/上海只接受完整 `DSP_HK_*` / `DSP_SH_*` transport、固定 host key、严格 TLS/SSH 和单命令物理出口。不得把真实值复制到仓库 `.env`、命令模板、发布记录或聊天。能力检查通过也不等于授权连接或发布。

## 5. 推荐的安全发布流程

### 5.1 备份和预检

在目标节点执行只读健康检查，然后使用备份脚本创建 SQLite 备份。备份完成后检查文件大小和打开结果。不要只看命令退出码。

```bash
curl --fail --silent http://127.0.0.1:4320/api/health
cd /opt/dsp-idle-cloud/current
node /path/to/backup-sqlite.mjs \
  /var/lib/dsp-idle-cloud/cloud.sqlite \
  /var/lib/dsp-idle-cloud/backups/manual-YYYYMMDDTHHMMSSZ.sqlite
```

### 5.2 前端

1. 上传到新的时间戳发布目录，例如 `/var/www/dsp-idle/releases/<build-id>`。
2. 检查 `index.html` 引用的所有 hashed assets 存在。
3. 原子切换 `current` 指向新目录。
4. 执行 `nginx -t`，只有成功后才 reload。
5. 验证根页面、service worker、manifest 和一个静态 chunk。

#### 同域 Web-only 测试与上一稳定版回退入口

同一 HTTPS origin 下的根 Service Worker 会控制所有子路径，不能把普通生产 Web 归档直接挂到 `/canary/*` 后就宣称与正式 PWA 隔离。只有用户明确要求 Web-only 并存测试、候选 Web 与当前 API 保持滚动兼容、且不切换 Web/API/download `current` 时，才可采用版本化测试路径；至少满足：

1. 使用不可变路径和全新目录，不建立会漂移的 `latest` 别名。
2. 精确拒绝候选 Build ID 对根 `/sw.js` 的注册，不影响正式 Build ID 的 worker 更新。
3. 测试导航和静态响应返回 `Cache-Control: no-store` 与 `Vary: *`；后者使既有根 worker 的 Cache API 写入失败，避免把测试 HTML 覆盖到正式 `/index.html`。
4. 修改前备份活动 Nginx 配置；候选配置先独立语法检查，再原子替换、正式 `nginx -t` 和 reload。仅 Web 静态目录/Nginx 变更且完全不接触 API、数据库或 `current` 时，备份对应配置状态，不为形式门禁额外制造大型数据库 I/O；一旦涉及 API 切换、数据写入或迁移，SQLite 一致性备份仍是强制项。
5. 公网 Chrome 必须先建立正式 worker，再访问测试入口，核对浏览器只保留正式 active worker、没有 waiting/installing worker、访问前后 `/index.html` 缓存逐字不变，并在断网后重新打开正式根站。
6. 测试入口不得进入 Android/Windows stable feed 或正式下载页；若真机门禁被豁免，文档必须把豁免范围限制在 Web 测试入口。

移除测试入口时只恢复已记录的 Nginx 配置备份并 reload；正式代码回滚、数据库恢复和下载指针切换都不属于该操作。历史 1.0.35 测试实例和浏览器证据见 [1.0.35 香港 Web 测试版发布记录](./releases/1.0.35.md)。

正式 stable 发布及观察窗口通过后，香港还必须把刚被替换的 Web 版保留为上一稳定版回退入口。该机制只处理“新 Web 代码回归而 Nginx 与当前 API 仍正常”的情况，不能承诺覆盖 API、数据库、服务器或网络故障：

1. 只选择与当前 API/schema/存档边界滚动兼容的直接 Web 回滚目录；不确定时不公开入口。
2. 使用不可变 `/canary/<previous-release-id>/`，并让固定用户入口 `/canary/previous/` 以带 `no-store`、`Vary: *` 的 302 指向它；该固定入口不是文件系统软链接。历史兼容地址可以 302 到固定入口，但不可变版本地址不得偷换目录。
3. 精确拒绝上一稳定版 Build ID 对根 `/sw.js` 的注册，同时保证当前 stable worker 仍为 200；回退响应还必须带 `no-store`、`Vary: *` 和 `noindex`。
4. 变更前备份并哈希活动 Nginx snippet，候选独立 `nginx -t` 后原子安装，再执行正式 `nginx -t` 和 reload；不切换 Web/API/download `current`，不触碰数据库。
5. 公网逐字核对回退 HTML 与不可变目录，验证全部入口资源、版本、重定向、当前 API 和新旧 worker；随后在全新 Chrome 上先激活当前 stable，再访问固定入口与不可变入口，确认只有当前 worker active、没有 waiting/installing、访问前后当前 `/index.html` 缓存逐字不变，并能离线重开正式根站。
6. 每次后续 stable 发布都在新版本观察通过后，把该入口更新为刚被替换的版本，记录新的 Nginx 回滚副本和不可变 URL。回退此入口只恢复 Nginx 副本，不切换当前代码或数据库。

上海客户端下载页是独立的静态发布目录，不依赖游戏 `assets/*` 或运行时 JavaScript。准备好 APK、Windows 安装包、`stable.json`、`latest.yml` 和 `release.json` 后，在发布目录生成页面并复验包清单：

```powershell
npm run download:page -- --release release/download-site-<build-id>
Get-FileHash release/download-site-<build-id>/downloads/android/*.apk -Algorithm SHA256
Get-FileHash release/download-site-<build-id>/downloads/desktop/stable/*.exe -Algorithm SHA256
```

`npm run download:page` 会校验两个清单中的文件大小和 SHA-256，再把版本、构建号、下载链接、签名提示和精确哈希写入 `index.html`。生成后的目录上传到新的 `/var/www/dsp-idle-downloads/releases/<build-id>`，确认首页、两个按钮、稳定清单和旧版本文件存在后，才原子切换 `current`；上一下载目录必须保留作为回滚目标。

前端回滚只需把 `current` 切回上一发布目录，不触碰数据库。

仓库提供 `deploy/switch-release.sh` 切换前端与后端代码并保存上一次代码指向。1.0.40 候选增加稳定交接代理：Nginx 固定指向 `127.0.0.1:4330`；代理先让已有上传和导出完成并排队新写请求，再短暂排队全部请求。旧写实例释放共享 `flock` 后，新实例才可在 4321/4322 之一接触生产 SQLite。候选预热只允许使用已经验证的发布前备份克隆，不允许两个写实例同时打开生产库。正式安装时须把控制文件放入不可变 `/usr/local/lib/dsp-idle-release/<build-id>/`，再原子更新 `/usr/local/lib/dsp-idle-release/current`，不得覆盖正在运行的控制文件。

API 切换必须提供与不可变 SQLite Backup API 快照绑定的证据。证据锁定绝对路径、大小、mtime、dev/inode、SHA-256、`quick_check`、schema 和 SQLite layout；切换关键路径只复核身份和元数据，避免重新顺序读取多 GiB 快照。快照创建和独立预置副本生成时完成完整 SHA-256。`--dry-run` 执行同样的证据与目标校验，但不启动服务、不 reload Nginx、不改软链。节点级非密钥配置从 `deploy/dsp-idle-runtime.env.example` 安装到 `/etc/dsp-idle-cloud/runtime.env`；真实凭据仍只放 `admin.env`。

不要假定生产节点安装了 `sqlite3` CLI。创建快照后应优先使用当前不可变 API 发布中固定版本的 `better-sqlite3`/仓库快照检查器执行 `quick_check`、schema/layout 与身份绑定；如果 CLI 缺失但快照已经生成，不得把工具缺失误报为数据库或备份损坏，也不得重新覆盖该快照。仍须完成完整 SHA-256、无活动 sidecar、inode/mtime evidence 和二次元数据复核。

1.0.41 起 pending journal 固定为 `/var/lib/dsp-idle-cloud/release-state/pending-switch.json`，不得放回 `/run`。状态目录必须是 `root:<service-group> 2750`，状态文件是 `root:<service-group> 0640`；active API 只读。阶段依次为 `prepared → publishing → published`，失败或不一致时进入 `recovering`。任何恢复失败都保留 journal 和 proxy hold，禁止手工删除后强行启动 writer。所有参与 unit 保留共享 RuntimeDirectory，并对配置错误 78、锁占用 75 使用 `RestartPreventExitStatus` 和 StartLimit。

ext4 无 reflink 且备份超过 `DSP_RELEASE_PREFLIGHT_INLINE_COPY_LIMIT_BYTES`（默认 512 MiB）时，切换器必须在停止旧 writer 之前立即拒绝。Release Agent 应在低流量窗口提前运行 `release-backup-evidence.mjs --prepare-preflight`，以有界带宽生成独立副本及证据，再通过 `--preflight-evidence` 原子采用。不得在 handoff 关键路径无上限复制多 GiB 数据库，也不得删除或手动处理生产 WAL/SHM。

旧 API 没有 `/api/ready` 时，只有明确 HTTP 404 才可把通过的 `/api/health` 作为兼容 readiness；503、连接错误或 `writable=false` 仍失败。`DSP_CLOUD_BACKUP_WINDOW` 是 interrupted recovery 的必需配置，1.0.41 还默认使用 900000 ms 启动宽限，避免服务恢复时立即生成大备份，同时保留后续低流量窗口备份。

```bash
node /usr/local/lib/dsp-idle-release/current/release-backup-evidence.mjs \
  --database /var/lib/dsp-idle-cloud/backups/<verified-snapshot>.sqlite \
  --output /var/lib/dsp-idle-cloud/release-state/<build-id>-backup-evidence.json
sudo dsp-idle-switch-release --web-release <web-id> --api-release <api-id> \
  --backup-evidence /var/lib/dsp-idle-cloud/release-state/<build-id>-backup-evidence.json --dry-run
sudo dsp-idle-switch-release --web-release <web-id> --api-release <api-id> \
  --backup-evidence /var/lib/dsp-idle-cloud/release-state/<build-id>-backup-evidence.json
sudo dsp-idle-switch-release --rollback-last \
  --backup-evidence /var/lib/dsp-idle-cloud/release-state/<verified-current>-backup-evidence.json
```

`--rollback-last` 走同一备份证据、预热、单写锁、readiness、排队和优雅关闭流程，只回滚代码，绝不恢复、替换或初始化数据库。重复执行同一目标为 no-op，`switch.lock` 阻止两个切换器并行。测试故障注入只有显式设置 `DSP_ENABLE_RELEASE_FAULT_INJECTION=1` 才能启用，生产禁止设置。

#### 1.0.43 香港 Web-only 当前回滚状态

1.0.43 的生产收口状态精确为 generation 13：current Web `web-1.0.43-fceca3eda51c`、previous Web `web-1.0.42-c24e6247d257`、current/previous API 均为 `api-1.0.42-c24e6247d257`、pending switch 不存在、proxy 保持 forward，活动 API PID 与 `NRestarts=0` 未变。只有只读检查仍精确满足这一状态时，`--rollback-last` 才指向 1.0.42；generation 或 current/previous 漂移时必须停手重新审计，不能凭本文盲目回滚。

若需回滚，继续使用发布时已验证的 backup evidence，并要求切换后得到下一 generation、current Web 1.0.42、previous Web 1.0.43、API 仍为 1.0.42、pending 为空；随后逐字验证 `/version.json` 的 1.0.42 Build ID、根页、`sw.js`、hashed asset、health/ready、proxy、Nginx 和 API PID/restarts。回滚不恢复数据库，不删除 1.0.43 不可变目录，不触碰上海、下载页、原生包、账号或玩家存档。

本次 generation 9→10 与 generation 11→12 都是受保护的安全前进/回滚对：第一次由物理绑定出口的单次 TLS 前超时触发，后续 server-local、正常公网、Chrome 与同尺寸 1.0.42 control 证明制品无误；第二次由探针错误要求 `application/manifest+json` 触发，而 1.0.42/1.0.43 实际继承的精确响应均为 413 B、固定 SHA-256、`no-cache`、`application/octet-stream`。第三次只有在把该继承字节/MIME 与 Chrome `Page.getAppManifest` 无错误作为精确契约后才完成 generation 13。未来 MIME 修复必须作为独立 Nginx 变更执行活动配置备份、候选 `nginx -t`、原子安装、正式 `nginx -t`/reload 和回滚；不得把现网响应误记为 `application/manifest+json`。

固定顺序为：验证备份证据 → 候选在备份克隆和 4390 端口达到 health/ready → `drain` 并等待在途写归零 → `hold` 并等待全部请求归零 → 停旧实例 → 验证单写锁空闲 → 启动新实例并等待 readiness → 发布软链与代理 generation。启动、readiness、Nginx reload 或 SQLite 锁失败时恢复旧 unit/upstream 和软链。代理队列默认 512，保护窗口和 Nginx API `proxy_read_timeout` 均为 300 秒；systemd `TimeoutStopSec` 为 90 秒。超过有界窗口时返回明确 503 与 `Retry-After`，不会无限占用内存。

1.0.42 的代理控制提交 `d885a9e…` 修复 keep-alive 空闲 socket 复用时的只读 `ECONNRESET`：只有无请求体、非 writer 的 GET/HEAD 在尚未收到响应时可重试一次；PUT/POST/DELETE/PATCH、云存档和账号原子导入导出必须保持单次发送。`api-handoff-proxy.mjs` 的正式 SHA-256 为 `2f908b40b5a715bf290ee4b5aad55256eae25c1e642abd4bb2677ec90fc16dd0`。

禁止为单独更新代理直接执行普通 `systemctl restart dsp-idle-api-handoff-proxy.service`：active API 对代理有 `Requires=`，普通 restart 会反向停止大库 writer 并触发数分钟冷启动。1.0.42 发布采用的受控流程是：先备份并逐字核验 active unit；临时装入只移除该 `Requires=` 的完整 unit；`daemon-reload` 后确认 API PID 不变且依赖确已移除；原子切换不可变控制目录并仅重启代理；等待 4330 开始监听并通过 health/ready；最后逐字恢复原 unit、再次 reload 并确认依赖、API PID、代理状态和哈希。任一步失败都要在依赖仍临时分离时先切回旧控制目录和旧代理，再恢复原 unit。临时 unit 不能留在 `/run` 或 `/etc`，也不能借此启动第二个 SQLite writer。

执行 `--rollback-last` 前必须读取 `/var/lib/dsp-idle-cloud/release-state/previous-release`，确认两个目录存在且后端能读取当前 schema。数据库升级后不能把旧 schema 后端继续留作“一键回滚”目标；应先在当前数据库的一致性备份副本上用隔离端口完成兼容验证。

SQLite layout v2 将云存档正文从 `app_state` 拆到 `cloud_save_payloads`。迁移完成后，旧 layout v1 API 虽然仍能读取元数据，却不能读取或安全新增正文；两地回滚状态因此固定保留当前 API，只允许回退 Web。迁移发布时还必须同时停止 `dsp-idle-healthcheck.timer` 和可能正在执行的 `dsp-idle-healthcheck.service`，否则已经启动的 oneshot 仍可能在维护窗口重启旧进程。

云服务重启后，切换脚本默认在约 10 秒窗口内短轮询本机健康接口。较大的生产数据库可能让 Node 的正常启动超过该窗口；`1.0.12` 香港首次切换因此按设计自动回滚，日志未发现崩溃，随后在保持同一制品和数据库的前提下将健康窗口扩展到 30 秒并成功切换。遇到同类情况应先确认自动回滚已完成、旧服务健康且 journal 没有真实启动错误，再通过 `DSP_HEALTH_ATTEMPTS` 和 `DSP_HEALTH_DELAY_SECONDS` 扩展窗口；不得用延长窗口掩盖持续错误。

### 5.3 后端

1. 上传到 `/opt/dsp-idle-cloud/releases/<build-id>`。
2. 在发布目录执行生产依赖安装和服务端测试。
3. 切换 `current`，重启云服务。
4. 检查 `systemctl status`、journal 和本机 `/api/health`。
5. 再从公网入口验证同源 `/api/health`、登录页面和云存档元数据读取。

1.0.40 起 `/api/health` 是进程 liveness；发布切换、反向代理接流量和持久化故障告警还必须检查 `/api/ready`。readiness 正常为 200，最近 SQLite 写入失败且尚未恢复、或进程正在关闭时为 503。收到 SIGTERM/SIGINT 后服务拒绝新的 mutation，并等待在途请求、备份、历史裁剪和持久化队列完成；API/proxy/preflight unit 使用 `TimeoutStopSec=90`，不得短于服务端 75 秒强制退出边界。健康定时器只检查稳定代理上的 health 与 readiness，不在切换中擅自 restart 某个槽位。

后端失败时切回上一代码目录并重启；除非新代码已执行不可逆数据迁移，否则不要回滚数据库。

### 5.4 排行榜数据完整性处置

#### 5.4.1 异常检测与人工复核策略

服务端完整性检测（`leaderboard-integrity-v1`）与处置已经分离：检测到高置信度异常时，只在 `leaderboardReviewQueue` 中写入待复核证据（账号、普通主档 revision、校验摘要、发现代码和次数），**不会自动写入 `leaderboardModeration`、禁用登录、删除账号或移除已有排行榜 submission**。异常修订仍保留在云存档中；上一份有效 submission 继续展示，直到管理员完成复核。客户端再次请求发布该修订时返回 `LEADERBOARD_REVIEW_PENDING`，明确告知账号和云存档未被修改。

每天 22:00（Asia/Shanghai）的 `dsp-idle-leaderboard-review-report.timer` 运行只读报告服务，将不含完整校验值和存档正文的摘要写入 `/var/lib/dsp-idle-cloud/leaderboard-review-reports/`；管理员也可通过 `GET /api/admin/leaderboard/reviews` 或后台“排行榜人工复核”面板查看。报告本身不执行处置。人工确认后只能选择：

1. `restrict-leaderboard`：写入内部排行榜限制并移除公开 submission，但保留账号、登录、云存档和全部历史正文。
2. `approve-leaderboard-review`：将当前 revision/finding 指纹绑定为已批准，并重新发布该修订；若证据已变化，服务端拒绝批准并要求重新复核。

上述策略只覆盖服务器完整性异常。玩家主动关闭公开榜、启用内容包等既有明确规则仍按各自接口返回处理；这些路径不等同于账号封禁。夜间报告的时间可由 systemd drop-in 调整，但修改后必须记录观察窗口和管理员通知渠道。

`server/moderate-leaderboard.mjs` 是受保护的运维入口，不是普通管理 API。默认 dry-run 使用只读 SQLite 和 `query_only`；实际写入必须同时提供经过 Backup API 验证的独立备份、有限来源标识和服务已停止确认。目标解析先按服务器综合榜排序锁定唯一第一名，再核对受保护的显示名输入、主档 revision、SHA-256、envelope 和官方矿脉不变量；任何一步不唯一或不一致都必须中止。

处置事务只写入内部 `leaderboardModeration`、删除目标公开 submission 并追加不含 PII 的审计动作。它不能删除账号、主云档、历史正文或其他同名账号。后验必须确认主档 revision、历史数量和正文行数不变，五榜均不可见，服务重启和回填不能重建提交。普通代码回滚保留该内部状态，不恢复旧数据库；撤销处置需要新的审计批准和独立管理员流程。完整边界见 [LEADERBOARD_DATA_INTEGRITY_REMEDIATION_2026-07.md](./LEADERBOARD_DATA_INTEGRITY_REMEDIATION_2026-07.md)。

## 6. 节点配置

### 香港正式节点

- Nginx 模板：`deploy/nginx-dsp-idle-domain.conf` 与公共 snippet。
- systemd 环境模板：`deploy/dsp-idle-cloud-hk.service`。
- 允许 Origin：正式根域名、`www`、Capacitor Android WebView 的精确 `https://localhost` 和明确保留的兼容入口。不得用 `*` 代替；仓库模板完成不代表生产 unit 已同步，部署后必须用带 Origin 的 GET 与 PUT 预检分别验证。
- TLS：Let’s Encrypt，`www` 和 HTTP 均跳到 `https://dsponline.cn`。
- SSH：仅密钥，禁止 root 与密码登录。

### 管理员后台

复制 `deploy/dsp-idle-admin.env.example` 到 `/etc/dsp-idle-cloud/admin.env`，使用 `openssl rand -hex 32` 为每套正式环境生成独立 token，并将文件权限设置为 `0640 root:ubuntu`。真实 token 不得写入仓库或前端环境变量。

```bash
sudo install -d -m 0750 -o root -g ubuntu /etc/dsp-idle-cloud
sudo install -m 0640 -o root -g ubuntu /path/to/admin.env /etc/dsp-idle-cloud/admin.env
sudo systemctl daemon-reload
sudo systemctl restart dsp-idle-cloud.service
```

公开 `/api/public-status` 只提供玩家累计、今日、120 秒在线口径和匿名活动时钟/模拟进度；`/api/admin/metrics` 与兼容路径 `/api/metrics` 必须携带管理员 bearer token。后台入口为 `https://dsponline.cn/admin`。

1.0.35 候选可配置 `DSP_CLOUD_BACKUP_WINDOW=HH:MM-HH:MM`、`DSP_CLOUD_PRUNE_INTERVAL_MS` 和 `DSP_CLOUD_REQUEST_TIMEOUT_MS`。部署前在生产备份副本上验证时间窗跨午夜、重复裁剪和中断恢复；正式节点先只读调用 `GET /api/admin/cloud-history/prune-preview`，确认保留最近 20 条及预览哈希。写入裁剪必须同时提交精确确认文字 `PRUNE_CLOUD_HISTORY` 和当前预览 ID；预览变化返回冲突后必须重新检查，不能复用旧确认。磁盘达到 80% 时停止非必要发布，达到 90% 时云存档 PUT 返回保护性 507，禁止通过删除数据库或未验证备份解除保护。

### 香港 1.0.41 云裁剪 P0 热修边界

`DSPIDLE-1041-HK-GC-HOTFIX` 只授权发布 Web/API 代码，不授权恢复、迁移、重写或手工编辑生产 SQLite。新 API 启动时会对 `cloud_save_payloads` 做一次固定前缀引用审计；这是逐逻辑行工作，但不选择 direct 正文、不调用正文长度，也不解析 blob。普通上传触发第 21 条历史裁剪时，只允许读取被删主键行的固定 alias、更新对应内存 refcount，并按 checksum 主键决定是否删除候选 blob。显式离线 `server/cloud-payload-maintenance.mjs gc` 的全量 alias/blob/正文校验语义保持不变，只能在既有维护流程和已验证备份边界中执行，不能作为在线 PUT 的同步步骤。

如果启动审计发现 malformed alias 或 SQLite `typeof(payload) != 'text'`，自动 cleanup 会 fail-closed 并暂留 orphan；不得用手工 SQL 改成“完整”或直接删除 blob。Release 应在只读备份副本/临时 SQLite 上运行维护审计定位问题，再另行取得数据维护授权。`app_state` metadata checksum 与实际 alias 不一致时，以实际 alias 计入在线引用，metadata 不会被本热修改写。

### 云正文缺失别名的离线恢复

`server/cloud-payload-recovery.mjs` 是专门的事故恢复入口，不属于 `cloud-payload-maintenance.mjs` 的 backfill、materialize 或 GC 功能。默认 dry-run 使用只读 SQLite 和 `query_only`；它只统计普通模式主档历史元数据中缺失的 `(user_id, 'main', revision)` 别名。模式判定必须与服务端一致：显式 normal、没有速通身份标记的旧版无 `mode` 存档都属于 normal，显式或可证明的 legacy speedrun 仍拒绝。每条候选必须同时满足历史 revision/checksum/size、Blob 或源正文大小、SHA-256、envelope v2 完整性与 normal 模式。任何已有逻辑行都跳过，绝不覆盖 direct body 或 alias；缺 Blob、哈希/大小不符、损坏 envelope、非普通模式或没有匹配历史的当前主档一律只报告，不能凭元数据伪造正文。

执行顺序固定为：先在只读副本 dry-run 记录候选数量和确认文字；停止 API 写入服务；创建并验证与停服库 `app_state` 精确一致、`quick_check=ok` 的 SQLite 备份；再以 dry-run 返回的 `RELINK_CLOUD_PAYLOAD_ALIASES:<previewId>` 和 `--service-stopped` 应用。若当前库缺 Blob 但事故前快照有精确正文，必须显式传入 `--body-source <snapshot> --body-source-sha256 <full-sha256> --current-only`；apply 前会重新完整哈希来源、核对停写生产备份和来源/目标 `quick_check`。该路径只对当前普通主档执行，事务内再次核对完整 `app_state` 指纹、候选主键和既有 Blob 内容；只会无冲突插入缺失 Blob 与 alias，绝不写源快照的 `app_state`、用户、排行榜、限制状态或已有正文。若预览后玩家上传了更高 revision，`app_state` 指纹或主键占用会使旧确认被拒绝；该情况下重新 dry-run，而不是覆盖新主档。恢复后重启服务并复核 `/api/ready`，重复执行应报告零候选。

旧 `storageLayoutVersion` 的迁移现在只允许在 `cloud_save_payloads` 和 `cloud_save_payload_blobs` 都为空时执行删除；任一表非空会以 `CLOUD_PAYLOAD_LEGACY_MIGRATION_DELETE_BLOCKED` 中止启动。不要为了通过启动而清空表或手工修改 metadata，应保留原库并走上述专门恢复或经验证备份恢复路径。

SQLite 启动审计及 `/api/ready.currentMainPayloads` 会返回无身份信息的当前普通主档聚合计数（检查数、可寻址正文数、缺失行/Blob、metadata 不匹配等）。这用于发现“元数据仍在但正文无法寻址”的事故；它不暴露账号、revision、checksum 或正文，也不自动解除排行榜限制。该 ready 计数检查 alias/Blob 地址和元数据，不代替离线恢复入口对 Blob SHA-256 与 envelope 的完整验证。

香港 `PUT /api/cloud-save` 维护锁已在 2026-08-14 热修切换、观察和真实上传验证后由 Release 明确解除；当前 telemetry 202 熔断与云存档维护锁相互独立。若后续故障重新启用维护锁，必须保持到以下条件全部满足：不可变 Web/API 制品和 aggregate manifest 复算一致；未激活 API 使用临时 SQLite 通过 health/ready、共享 blob、21 次裁剪和故障回滚 smoke；正式切换后 readiness、backlog、WAL/磁盘、延迟和错误率完成约定观察；Release 再次明确解除。开发完成本身不是解锁授权。代码回滚只切回已验证 API/Web 制品，绝不恢复数据库。上海、下载页、Android 和 Windows 不在该香港热修发布范围；完整状态见 [1.0.41 发布记录](./releases/1.0.41.md)。

账号处置先用 `GET /api/admin/account?accountId=...` 核对精确账号摘要，再向 `POST /api/admin/account/action` 提交 `CONFIRM:<action>:<accountId>`。彻底注销还要求最近 24 小时内的已验证本机备份时间戳；不得用显示名、邮箱模糊匹配或直接编辑 SQLite。速通历史恢复只能离线运行 `server/speedrun-recovery.mjs`：先 dry-run 核对最新主云 revision、元数据/正文哈希、v46 速通身份和百万白糖事实；apply 前停止服务，并提供匹配 `quick_check` 备份及 `RECOVER_SPEEDRUN:<account>:<revision>`。该工具只写内部提交和最小化审计，不改云存档正文；完成后重启并复核一次，重复执行必须无变化。

标准恢复工具禁止从非最新历史修订写榜，该限制不得为方便运营而放宽。只有用户明确提供目标显示名和展示时间、单独授权历史恢复，且只读检查证明唯一账号与唯一修订时，才可走例外审计流程：使用显示名哈希而非明文锁定目标；同时锁定 revision、完整正文 SHA-256、工厂身份、赛季、规则、v46、内容包为空、累计事实、权威小数秒和当前成绩数量；先创建完整 SQLite Backup API 快照和目标修订独立 `0600` 证据库，再在完整备份派生 guard 上执行同一离线事务与幂等复跑。生产 apply 必须停服务、使用乐观锁，且只允许增加目标 submission 和最小审计。人工口述的 `mm:ss` 只用于核对客户端 `Math.floor` 展示，数据库必须保存历史里程碑的权威小数秒，不能人为取整成更快成绩。公开运维记录不得包含显示名、账号 ID、工厂 ID、正文或存档哈希；已验证实例见 [2026-08-09 香港历史速通恢复记录](./releases/1.0.34-speedrun-recovery-2026-08-09.md)。

### 单账号当前主云档只读导出

用户明确授权交付一个香港账号的当前普通模式主云档时，使用 Skill 内维护的 [只读导出工具](../.codex/skills/develop-dspidle/scripts/export-hk-cloud-save.ps1)，不要临时拼接 SQL 或 SSH 命令：

```powershell
pwsh -NoProfile -File .codex/skills/develop-dspidle/scripts/export-hk-cloud-save.ps1 -Username '<username>'
```

用户名必须精确匹配且全库唯一；用户同时提供显示名时追加 `-DisplayName '<displayName>'` 作为第二道精确匹配。工具固定读取香港当前 `normal/main`，以只读 SQLite `query_only` 事务和活动 API 的 `readCloudPayload()` 解析 layout-v2 正文，逐字核对 metadata size/SHA-256、JSON 和 envelope 完整性后直接流式写入本机忽略目录 `artifacts/support-exports/`。它不在 VPS 留临时文件，也不修改账号、元数据、正文、排行榜、审计或数据库。

该入口不支持历史修订、速通模式、手动槽、修复、导入或批量导出。零匹配、多匹配、受保护 SSH 环境/固定主机指纹/物理出口不可用、正文缺失、大小或哈希不符时必须停止；不得猜服务器、降低 host-key 校验、复制 live SQLite 或输出敏感诊断。交付报告只写本地文件链接、revision、大小、SHA-256、envelope/GameState 版本、模式、完整性与游戏时长；账号 ID、邮箱、IP/设备信息、SSH 细节和存档正文不得进入聊天、Git、文档、manifest 或发布制品。完整门禁见 [Skill deployment reference](../.codex/skills/develop-dspidle/references/deployment.md#single-account-read-only-cloud-save-export)。

### 单账号普通排行重新发布

若管理员恢复排行榜后，合法普通主档的当前 revision 恰好等于 `leaderboardResumeAfterRevision`，服务端会按设计等待一次更高 revision；不得直接写分数、伪造上传或修改玩家存档。用户明确授权立即恢复该账号普通排行、且本次窗口已经独立创建并验证完整 SQLite Backup API 快照时，先 dry-run 再执行维护工具：

```powershell
pwsh -NoProfile -File .codex/skills/develop-dspidle/scripts/invoke-hk-leaderboard-action.ps1 -MatchBy Username -Identifier '<username>' -Action RepublishNormal
pwsh -NoProfile -File .codex/skills/develop-dspidle/scripts/invoke-hk-leaderboard-action.ps1 -MatchBy Username -Identifier '<username>' -Action RepublishNormal -Apply -FullBackupVerified
```

该路径只接受唯一精确账号，要求未封榜、登录未禁用、公开可见、当前普通主档及 envelope 合法、没有普通 submission、没有完整性异常，且普通 revision 与复核阈值精确相等。工具先写 root-only `0600` guard，再停健康/快照 timer 和 API writer，以 SQLite 事务、schema/layout 和乐观锁只清除普通模式阈值；速通阈值必须保留。随后启动同一 API，由正式 `backfillLeaderboardFromMainSaves()` 从未修改的当前普通主档生成 submission。账号、会话、云元数据、正文引用/payload 表和速通提交任一摘要变化，或 submission 未生成、健康/ready 未恢复时，工具只回滚 guard 覆盖的 moderation/control/普通 submission 字段并失败关闭。

`-FullBackupVerified` 只是对已经完成的独立备份门禁作确认，不能替代备份；没有本窗口完整备份时禁止传入。公开报告只记录 revision、阈值清除、submission 数量变化、保护字段未变和服务状态，不记录 accountId、正文或排行榜指标。完整边界见 [Skill deployment reference](../.codex/skills/develop-dspidle/references/deployment.md#single-account-leaderboard-only-action)。

### 银河活动配置

活动配置保存在发布目录之外的 `/etc/dsp-idle-cloud/activity.json`，由 `/etc/dsp-idle-cloud/admin.env` 中的 `DSP_ACTIVITY_CONFIG_FILE` 指向。建议权限为 `0640 root:ubuntu`，配置文件不得放入 Web 静态目录。代码发布与活动启用必须分开：先在活动关闭状态完成备份、制品验证、原子切换和公网烟测，再安装经过 `server/activity.mjs` 规则校验的配置并重启服务。

香港与上海参加同一轮模拟活动时必须使用完全相同的活动 ID、UTC 开始/曲线冻结时间、个人目标和全服目标。`endsAt - startsAt` 必须精确为 259,200,000 ms，但这三天只控制假全服曲线；曲线冻结后 `/api/public-status` 仍应返回 `status=active` 与 `openEnded=true`，玩家可长期参与。启用后分别核对 `/api/health` 的活动有效状态，以及 `/api/public-status` 的 revision、时间、目标和长期开放标记。活动配置只提供服务器时钟与模拟全服曲线；`1.0.12` 仍没有贡献提交 API，不能把本地记录描述成服务器已接收。

曲线冻结后保留配置并继续长期开放，不能通过重启或修改冻结时间重跑同一个活动 ID。未来若建立新的独立活动，必须使用新的 ID。

### 账号邮件

个人实名认证账号自 2026-03-02 起不能使用腾讯云 SES SMTP，因此正式节点使用 `SendEmail` API。香港 unit 必须设置 `DSP_PUBLIC_BASE_URL=https://dsponline.cn`；`/etc/dsp-idle-cloud/admin.env` 配置以下私密参数：

```dotenv
DSP_MAIL_TENCENT_SECRET_ID=
DSP_MAIL_TENCENT_SECRET_KEY=
DSP_MAIL_TENCENT_REGION=ap-hongkong
DSP_MAIL_TENCENT_FROM="DSP极简网络 <no-reply@mail.dsponline.cn>"
DSP_MAIL_TENCENT_VERIFY_TEMPLATE_ID=
DSP_MAIL_TENCENT_RESET_TEMPLATE_ID=
DSP_MAIL_REPLY_TO=
```

验证与重置模板分别使用 [deploy/mail-templates/account-verification.html](../deploy/mail-templates/account-verification.html) 和 [deploy/mail-templates/password-reset.html](../deploy/mail-templates/password-reset.html)。模板链接必须固定保留 `https://dsponline.cn` 域名，分别使用 `https://dsponline.cn/?verify={{actionToken}}` 和 `https://dsponline.cn/?reset={{actionToken}}`，只让腾讯替换 URL-safe 的单一 `{{actionToken}}` 变量；不得把整个 `href` 写成变量。两个模板必须审核通过后再填写数值 ID。CAM 应使用独立子账号并只授予 `name/ses:SendEmail`；SecretId/SecretKey 不得使用主账号长期密钥，也不得写入仓库、发布目录、命令历史或聊天。

腾讯配置完整时优先使用 SES API；原有 `DSP_MAIL_WEBHOOK_URL` / `DSP_MAIL_WEBHOOK_TOKEN` 仅作为兼容回退。两种发送器都未配置时，用户名密码注册、登录、四槽云存档、自动同步和排行榜继续开放；邮箱绑定、验证重发和找回密码返回 `503 EMAIL_SERVICE_UNAVAILABLE`。排行榜提交只要求有效登录会话和可校验的主云存档，不要求邮箱验证。邮件上线前必须用专用测试邮箱验证绑定、验证链接、过期链接、忘记密码和重置密码完整链路，并在 `/api/health` 确认 `mailProvider` 为 `tencent-ses`。上海公开入口是 HTTP，前端继续拒绝任何账号密码传输。

### 上海旧节点

- Nginx 使用本机静态目录与本机 `127.0.0.1:4320`。
- 不使用 `nginx-dsp-idle-old-bridge.conf` 或 `nginx-dsp-idle-old-redirect.conf` 作为当前配置。
- 前端可以本地游玩和保存；云客户端因 HTTP 安全策略不可登录。
- 保留独立数据库、备份和上一发布目录，避免将其误当作无状态镜像。

## 7. 发布后验收

### HTTP 与 API

```bash
curl -I https://dsponline.cn/
curl https://dsponline.cn/api/health
curl -I https://www.dsponline.cn/
curl -I https://shanghai-node.example.invalid/
curl https://shanghai-node.example.invalid/api/health
```

期望：正式根域名 `200`、`www` 为 301、上海根页面和本机 API 均为 `200`。不要用生产账号执行自动化写测试。

### 浏览器烟测

- 打开主菜单，继续现有本地存档，不清除站点数据。
- 新建临时游戏并确认不覆盖已有槽位。
- 正式 HTTPS 登录后只读取云端元数据；需要上传测试时使用专用测试账号。
- 检查字体 80/100/125/150/200%、桌面和手机横竖屏。
- 连接至少两条不同物品线路，移动节点确认端点和标签跟随。
- 检查 service worker 更新提示不会陷入刷新循环。

## 8. 备份与恢复

生产配置每 6 小时通过 SQLite Backup API 保存本机快照并保留最多 30 份。仓库另提供以下数据保护工具：

- `deploy/create-offsite-backup.mjs`：创建一致性 SQLite 快照、执行 `quick_check`、使用 RSA-OAEP + AES-256-GCM 加密并通过 `scp`、`rclone` 或已挂载目录传输。
- `deploy/restore-drill.mjs`：核对密文 SHA-256、认证解密、检查记录数量，并在随机本机端口启动临时云服务验证健康接口；明文副本在结束后删除。
- `deploy/dsp-idle-offsite-backup.*`：每日异地备份 service/timer。
- `deploy/dsp-idle-restore-drill.*`：恢复节点每月演练 service/timer。
- `deploy/dsp-idle-leaderboard-review-report.*`：每日 22:00（Asia/Shanghai）只读生成排行榜异常待复核报告；该 service 不写 SQLite。

推荐让恢复节点生成独立 RSA 3072 位密钥；私钥只留在恢复节点，香港生产节点只安装公钥：

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out backup-private.pem
openssl pkey -in backup-private.pem -pubout -out backup-public.pem
chmod 0600 backup-private.pem
```

香港到恢复节点的 `scp` 传输使用独立 SSH key、固定 `known_hosts` 和接收目录受限账号，不使用交互密码。对象存储可改用 `rclone`，生命周期策略负责远端保留期。分别从 `dsp-idle-backup.env.example` 与 `dsp-idle-restore.env.example` 创建权限为 `0600` 的真实配置；私钥、SSH key、对象存储 token 和目标地址不进入 Git。

恢复演练不得占用生产端口、不得修改生产 symlink，也不得让恢复实例接收正式域名流量。成功报告只记录 schema、数量、校验和和耗时，不包含邮箱、token 或存档 payload。安装到生产前先运行 `npm run test:ops`，再用真实生产备份副本执行一次人工演练。

`0.2.0` 发布窗口已经完成首轮生产闭环：香港每日创建认证加密备份并通过固定主机指纹和受限 SFTP 账号传到上海；上海私钥未离开恢复节点，隔离恢复验证 schema v5、账号、会话、云存档、修订和玩家计数一致，结束后明文 SQLite 数量为 0。香港每日 timer 与上海每月 timer 均为 active，上海密文接收目录保留 30 天。

### 香港 COS 归档现状（2026-07-31）

香港服务器的 COSFS 挂载点是 `<COS_MOUNT_PATH>`，实际桶和前缀通过受保护配置注入；挂载凭据文件必须保持 `0600` 权限。公开仓库不记录桶名、账号标识或密钥。变更桶前必须先在控制台确认名称、地域和 CAM 权限。

数据库历史副本使用 RSA-OAEP + AES-256-GCM 加密后写入受保护的 COS 归档前缀。公开仓库不记录对象存储桶名、账号标识或真实对象路径。每份都有独立 manifest、大小和 SHA-256；跨卸载重挂抽样校验通过。生产数据库、云存档正文、账号和玩家数据未删除；本地只保留快速恢复副本。

每日 `dsp-idle-offsite-backup.timer` 已改为写入 `/lhcos-data/dsp-idle-archive/daily/`，`DSP_OFFSITE_BACKUP_KEEP=2`，systemd 只额外允许写入 COS 挂载路径。2026-07-31 手动运行成功，schema v7、账号 376、主云档 312、修订 3,726 等记录摘要未减少；staging 只保留 2 份加密副本，COS 日目录已通过 SHA-256 校验。COSFS 当前使用单并发、多段 10 MiB 和 5 GiB 本地安全阈值。

云服务自身每 6 小时的快速快照也已改为 `DSP_CLOUD_BACKUP_DIRECTORY=/lhcos-data/dsp-idle-archive/auto`，因此不会再把 30 份约 1 GiB 文件写满香港根盘；该目录位于私有 COS 挂载，不代替加密日备份。香港节点探针的 `DSP_MONITOR_MIN_DISK_FREE_RATIO` 已从 0.15 提高到 0.20，剩余空间低于约 8 GiB 时提前告警。

### 2026-08-19 日备份与恢复演练加固

每日加密备份不得把 SQLite Backup API 的明文 staging 直接放在 COSFS。生产配置已恢复为先写香港本机 `/var/lib/dsp-idle-cloud/offsite-staging`，完成 `quick_check`、加密和 manifest 后再通过固定主机指纹及受限账号传到上海；本机只保留两份完整密文。COS 继续承载每 6 小时自动快照和已经逐份验证的历史归档，但不是 SQLite 在线备份的直接写入目标。

备份、恢复演练和节点探针从独立不可变目录 `/usr/local/lib/dsp-idle-ops/releases/<ops-release>` 运行，由 `/usr/local/lib/dsp-idle-ops/current` 原子指向当前运维包，不再依赖应用 `/opt/dsp-idle-cloud/current` 是否包含对应脚本。备份与恢复 service 都设置有限启动/停止超时，并在主进程开始前原子写入 `running` 状态，避免长任务期间继续暴露上一次成功。上海恢复私钥通过 systemd `LoadCredential` 只读注入单次 service，不扩大私钥或父目录权限。

2026-08-19 真实闭环验证使用 schema v7 密文：两端密文 SHA-256 和 manifest 完全一致，上海隔离恢复得到 schema v7；909 个账号、731 个当前云档、8,660 条修订等受保护计数与备份 manifest 一致，随机本机端口健康检查通过，结束后恢复工作目录明文 SQLite 数量为 0。完整证据见 [releases/ops-backup-restore-2026-08-19.md](./releases/ops-backup-restore-2026-08-19.md)。本次只调整运维工具和 systemd 配置，没有发布或切换 1.0.46 应用制品。

本次爆满原因是历史备份副本而非游戏数据库异常：香港本地 `backups` 曾累积约 25 GiB、35 份 0.16～1.0 GiB SQLite 快照；异地 staging 另有约 1.5 GiB 加密副本；旧 API 发布目录约 0.86 GiB，日志、APT 缓存和新版本备份又叠加约 0.5 GiB。原 COS 挂载为空且每日任务仍按 SCP + 本地保留 14 份运行，导致三天内再次接近满盘。

长期运营规则：

1. 生产盘只保留当前数据库、当前/回滚代码、4 份本地快速恢复副本和 staging 2 份；所有更早快照必须先生成加密对象、manifest 和跨重挂载哈希，再删除本地副本。
2. 每日备份先在香港本机完成一致性快照、校验和加密，再传到上海恢复节点；COS 作为独立自动快照/验证归档位置，禁止把在线 SQLite 备份的明文 staging 直接写到 COSFS。COS 桶设置 30～90 天生命周期和版本控制；任何切换到新桶都要先完成小文件写入、重挂载读取和完整对象计数校验。
3. 磁盘探针将告警阈值设为 80%，硬保护阈值设为 90%；超过 80% 自动暂停非必要发布/快照并提示归档，超过 90% 只允许完成当前备份和清理已验证副本，不能删除数据库或手动恢复点。
4. 每周检查 `cloud.sqlite`、本地快照、staging、上海接收目录、发布目录、日志和 COS 对象数量；每月在上海隔离端口用最新的完整密文与 manifest 完成一次恢复演练。密钥和对象存储凭据使用最小权限并定期轮换。

## 9. 监控与日常检查

- `dsp-idle-cloud.service`：active，重启次数无异常。
- `dsp-idle-healthcheck.timer`：active，每两分钟运行；探针超时为 60 秒，覆盖大 SQLite 快照启动/备份期间的正常延迟，避免误重启服务。
- Certbot timer：active，定期执行续期演练。
- Nginx access/error log：关注 5xx、429、超时和异常大请求。
- systemd journal：关注数据库写入、备份、Origin 拒绝和崩溃。
- 磁盘：关注发布目录、日志、SQLite WAL 和备份增长。
- `/api/admin/metrics`：验证管理员 token 后检查访问漏斗、错误、P95 延迟、限流、云冲突和备份状态。
- `dsp-idle-node-health.timer`：每五分钟检查正式入口/API 延迟、磁盘可用比例和 TLS 剩余天数；状态写入受保护后台，可选 webhook 仅发送失败检查名称。
- `dsp-idle-leaderboard-review-report.timer`：每日 22:00（Asia/Shanghai）生成 `leaderboard-review-latest.json`；报告只读，人工确认前不改变账号或排行榜。
- 香港 `dsp-idle-offsite-backup.timer` 与上海 `dsp-idle-restore-drill.timer`：检查最后成功时间、timer 上次结果和报告文件。
- 玩家指标：检查 `players.total`、`players.today`、`players.online` 和 `players.onlineWindowSeconds`；两个节点分别统计，不能直接相加当作严格独立用户数。

玩家计数不能只检查 HTTP 202。2026-09-08 香港调查发现，1.0.41 事故留下的 `/api/presence` 与 `/api/analytics` Nginx 精确规则返回 `accepted:false,deferred:true`，导致 8 月 14 日起上报被丢弃。本次最终只开放玩家计数所需的 presence，analytics/errors 仍保留原熔断。后续发布必须检查有效 Nginx 规则和真实心跳的持久化时间，不能从旧配置副本带回 presence 熔断。只读 `GET /api/presence` 在现役 API 应为 404；若得到临时静态 202，说明请求仍被拦截。写入验证应观察真实玩家流量，禁止制造生产测试玩家。累计为匿名标识去重，今日为当日活跃去重，均不能用注册账号数或请求数代替。历史缺口、承载观察及本次修复验收见 [香港玩家计数修复记录](./releases/ops-hk-player-count-recovery-2026-09-08.md)。

备份、恢复演练和节点探针 oneshot 必须从独立不可变运维包 `/usr/local/lib/dsp-idle-ops/current/deploy` 执行；不得绑定应用 `current` 软链接。CLI 入口判断必须比较真实路径；unit 只有在退出码为 0、最新状态文件为 `ok=true` 且制品/报告存在时才算成功。若 unit 显示 `success` 却没有生成对应状态文件，应按空运行故障处理，不能视为监控或备份成功。

匿名在线窗口默认 120 秒，可通过 `DSP_PLAYER_ONLINE_WINDOW_MS` 调整；运营日历默认 `Asia/Shanghai`，可通过 `DSP_METRIC_TIME_ZONE` 调整。修改在线窗口只影响在线口径，不影响累计玩家。部署 schema v7 后端前必须先使用 SQLite Backup API 创建并验证备份，并在隔离副本验证 v6→v7 归一化：每个旧账号获得稳定唯一用户名，原邮箱与验证状态不变，账号、会话、主存档、三个手动槽、各槽历史、榜单、玩家和匿名统计数量不得减少。切换后不得用测试账号或测试存档对生产数据库执行写验证。

## 10. 当前性能事项

香港与上海 `1.0.42-c24e6247d257` 均为 JS/CSS 启用 gzip，hashed asset 保持 immutable，`index.html`、`version.json` 与 `sw.js` 保持 no-cache；1.0.38 与 1.0.37 入口资源继续位于共享 hashed-asset 回退区。主菜单不 preload `FactoryRuntime`、`flow-vendor`、`game-core` 或 `storage`，英文目录同样只在进入工厂后懒加载；页面加载、LCP 和传输体积按隐私分桶进入受保护后台。

香港 layout v1 的 136.8 MB `app_state` 曾使每分钟持久化把 Node 推到约 1.6 GB并阻塞健康接口。layout v2 上线后 `app_state` 约 2.55 MB，云存档正文按修订独立写入；240 秒生产观察中健康接口最大 10.407 ms、`NRestarts=0`、RSS 约 133～162 MB。监控若再次出现内存或延迟上升，应分别检查 `app_state` 大小、`cloud_save_payloads` 行数与历史元数据唯一键数，不能只调大健康超时。

Brotli 仍是可选后续项，应先用真实流量比较 CPU、缓存命中和传输节省。不要用“提高服务器配置”替代静态压缩、缓存和 chunk 体积治理。1.0.42 发布前，香港 3,284,348,928 字节一致性备份和上海 393,216 字节备份均通过完整 SHA、`quick_check`、schema v7/layout v2；香港大库冷启动实测约 181 秒，正式切换使用 300 秒 readiness 窗口。后续大库发布仍必须在对象存储传输前同时预算源文件、目标对象缓存和即刻启动快照，不能只按最终净空间计算；超过 90% 时不得继续隔离启动或切换。当前收口磁盘约为香港 74%、上海 75%；任何旧本地数据库备份只有在受保护异地对象完整哈希匹配后才能解除，代码回滚仍不得恢复数据库。完整证据见 [releases/1.0.42.md](./releases/1.0.42.md)。
