# 部署与运维手册

> 公开仓库脱敏说明：本文及 `deploy/` 模板中的节点地址、证书主机名和对象存储标识均使用示例占位符。实际值只应从受保护的运维环境注入，不能提交到 Git。

## 1. 环境边界

| 环境 | 地址 | 主机 | 作用 |
| --- | --- | --- | --- |
| 香港正式 | `https://dsponline.cn` | `hk-origin.example.invalid` | 正式 Web、云账号、云存档、排行榜 |
| 香港别名 | `https://www.dsponline.cn` | 同上 | 301 到根域名 |
| 上海旧节点 | `https://shanghai-node.example.invalid` | `shanghai-node.example.invalid` | 独立旧入口和备用试玩 |
| 上海下载节点 | `https://download.dsponline.cn` | `shanghai-node.example.invalid` | Windows/Android 安装包与稳定更新清单 |
| 本地前端 | `http://127.0.0.1:4318` | 开发机 | Vite |
| 本地 API | `http://127.0.0.1:4320` | 开发机 | Node 云服务 |

硬边界：上海节点必须继续由上海本机提供前端与 `/api`，不得改成香港反代或域名跳转。上海为 HTTP，前端必须继续拒绝云账号密码传输。

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

香港、上海 Web/API 与上海下载站均已切换到 `1.0.26-f675a6a11025` / GameState v46。两地继续使用云 schema v7 和 SQLite layout v2，代码回滚不得恢复数据库；香港 `/downloads/*` 仍重定向上海。1.0.26 Android SHA-256 为 `51b2f7f6217192691ea56535bd180c69917f6b890d8ff6f46659cbbc454caead`，Windows SHA-256 为 `d92f788a8e744caa7c0e2a5d06cd839ccd110fd6c95f7e6175028ddddcbad7f2`（Authenticode `NotSigned` 测试包）。香港发布前 1,749,057,536 字节 Backup API 快照与上海发布前 151,552 字节快照均通过 `quick_check`；Web/API 和下载回滚目标均为 `1.0.25-628369a93ad7`。公网健康、下载页、完整下载哈希、Range、缓存头和上一版 hashed chunk 回退均通过。1.0.26 不含 schema/layout 迁移，为避免重复高 I/O，没有追加香港发布后手工快照。完整证据见 [releases/1.0.26.md](./releases/1.0.26.md)。

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

上海客户端下载页是独立的静态发布目录，不依赖游戏 `assets/*` 或运行时 JavaScript。准备好 APK、Windows 安装包、`stable.json`、`latest.yml` 和 `release.json` 后，在发布目录生成页面并复验包清单：

```powershell
npm run download:page -- --release release/download-site-<build-id>
Get-FileHash release/download-site-<build-id>/downloads/android/*.apk -Algorithm SHA256
Get-FileHash release/download-site-<build-id>/downloads/desktop/stable/*.exe -Algorithm SHA256
```

`npm run download:page` 会校验两个清单中的文件大小和 SHA-256，再把版本、构建号、下载链接、签名提示和精确哈希写入 `index.html`。生成后的目录上传到新的 `/var/www/dsp-idle-downloads/releases/<build-id>`，确认首页、两个按钮、稳定清单和旧版本文件存在后，才原子切换 `current`；上一下载目录必须保留作为回滚目标。

前端回滚只需把 `current` 切回上一发布目录，不触碰数据库。

仓库提供 `deploy/switch-release.sh` 原子切换前端与后端代码，并保存上一次代码指向。两台正式节点已将同一脚本安装为 `/usr/local/sbin/dsp-idle-switch-release`；发布或回滚后都会验证 Nginx、云服务和本机健康接口：

```bash
sudo dsp-idle-switch-release --web-release <web-id> --api-release <api-id>
sudo dsp-idle-switch-release --rollback-last
```

`--rollback-last` 只切换 `/var/www/dsp-idle/current` 与 `/opt/dsp-idle-cloud/current`，绝不恢复、替换或初始化数据库。

执行 `--rollback-last` 前必须读取 `/var/lib/dsp-idle-cloud/release-state/previous-release`，确认两个目录存在且后端能读取当前 schema。数据库升级后不能把旧 schema 后端继续留作“一键回滚”目标；应先在当前数据库的一致性备份副本上用隔离端口完成兼容验证。

SQLite layout v2 将云存档正文从 `app_state` 拆到 `cloud_save_payloads`。迁移完成后，旧 layout v1 API 虽然仍能读取元数据，却不能读取或安全新增正文；两地回滚状态因此固定保留当前 API，只允许回退 Web。迁移发布时还必须同时停止 `dsp-idle-healthcheck.timer` 和可能正在执行的 `dsp-idle-healthcheck.service`，否则已经启动的 oneshot 仍可能在维护窗口重启旧进程。

云服务重启后，切换脚本默认在约 10 秒窗口内短轮询本机健康接口。较大的生产数据库可能让 Node 的正常启动超过该窗口；`1.0.12` 香港首次切换因此按设计自动回滚，日志未发现崩溃，随后在保持同一制品和数据库的前提下将健康窗口扩展到 30 秒并成功切换。遇到同类情况应先确认自动回滚已完成、旧服务健康且 journal 没有真实启动错误，再通过 `DSP_HEALTH_ATTEMPTS` 和 `DSP_HEALTH_DELAY_SECONDS` 扩展窗口；不得用延长窗口掩盖持续错误。

### 5.3 后端

1. 上传到 `/opt/dsp-idle-cloud/releases/<build-id>`。
2. 在发布目录执行生产依赖安装和服务端测试。
3. 切换 `current`，重启云服务。
4. 检查 `systemctl status`、journal 和本机 `/api/health`。
5. 再从公网入口验证同源 `/api/health`、登录页面和云存档元数据读取。

后端失败时切回上一代码目录并重启；除非新代码已执行不可逆数据迁移，否则不要回滚数据库。

### 5.4 排行榜数据完整性处置

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

本次爆满原因是历史备份副本而非游戏数据库异常：香港本地 `backups` 曾累积约 25 GiB、35 份 0.16～1.0 GiB SQLite 快照；异地 staging 另有约 1.5 GiB 加密副本；旧 API 发布目录约 0.86 GiB，日志、APT 缓存和新版本备份又叠加约 0.5 GiB。原 COS 挂载为空且每日任务仍按 SCP + 本地保留 14 份运行，导致三天内再次接近满盘。

长期运营规则：

1. 生产盘只保留当前数据库、当前/回滚代码、4 份本地快速恢复副本和 staging 2 份；所有更早快照必须先生成加密对象、manifest 和跨重挂载哈希，再删除本地副本。
2. 每日备份写 COS，保留上海已有异地加密副本作为第二恢复位置；COS 桶设置 30～90 天生命周期和版本控制，避免对象无限增长。任何切换到新桶都要先完成小文件写入、重挂载读取和完整对象计数校验。
3. 磁盘探针将告警阈值设为 80%，硬保护阈值设为 90%；超过 80% 自动暂停非必要发布/快照并提示归档，超过 90% 只允许完成当前备份和清理已验证副本，不能删除数据库或手动恢复点。
4. 每周检查 `cloud.sqlite`、本地快照、staging、发布目录、日志和 COS 对象数量；每月在隔离端口用 COS 密文完成一次恢复演练。密钥应替换为只允许 COS 指定前缀读写的 CAM 子账号，并定期轮换。

## 9. 监控与日常检查

- `dsp-idle-cloud.service`：active，重启次数无异常。
- `dsp-idle-healthcheck.timer`：active，每两分钟运行；探针超时为 60 秒，覆盖大 SQLite 快照启动/备份期间的正常延迟，避免误重启服务。
- Certbot timer：active，定期执行续期演练。
- Nginx access/error log：关注 5xx、429、超时和异常大请求。
- systemd journal：关注数据库写入、备份、Origin 拒绝和崩溃。
- 磁盘：关注发布目录、日志、SQLite WAL 和备份增长。
- `/api/admin/metrics`：验证管理员 token 后检查访问漏斗、错误、P95 延迟、限流、云冲突和备份状态。
- `dsp-idle-node-health.timer`：每五分钟检查正式入口/API 延迟、磁盘可用比例和 TLS 剩余天数；状态写入受保护后台，可选 webhook 仅发送失败检查名称。
- 香港 `dsp-idle-offsite-backup.timer` 与上海 `dsp-idle-restore-drill.timer`：检查最后成功时间、timer 上次结果和报告文件。
- 玩家指标：检查 `players.total`、`players.today`、`players.online` 和 `players.onlineWindowSeconds`；两个节点分别统计，不能直接相加当作严格独立用户数。

这些 oneshot 服务从 `/opt/dsp-idle-cloud/current/deploy` 软链接执行脚本。CLI 入口判断必须比较真实路径；若 unit 显示 `success` 却没有生成对应状态文件，应按空运行故障处理，不能视为监控或备份成功。

匿名在线窗口默认 120 秒，可通过 `DSP_PLAYER_ONLINE_WINDOW_MS` 调整；运营日历默认 `Asia/Shanghai`，可通过 `DSP_METRIC_TIME_ZONE` 调整。修改在线窗口只影响在线口径，不影响累计玩家。部署 schema v7 后端前必须先使用 SQLite Backup API 创建并验证备份，并在隔离副本验证 v6→v7 归一化：每个旧账号获得稳定唯一用户名，原邮箱与验证状态不变，账号、会话、主存档、三个手动槽、各槽历史、榜单、玩家和匿名统计数量不得减少。切换后不得用测试账号或测试存档对生产数据库执行写验证。

## 10. 当前性能事项

香港与上海 `1.0.17-0383e85d2d9d-dirty` 均为 JS/CSS 启用 gzip，hashed asset 保持 immutable，`index.html` 与 `sw.js` 保持 no-cache。主菜单不 preload `FactoryRuntime`、`flow-vendor`、`game-core` 或 `storage`，英文目录同样只在进入工厂后懒加载；页面加载、LCP 和传输体积按隐私分桶进入受保护后台。

香港 layout v1 的 136.8 MB `app_state` 曾使每分钟持久化把 Node 推到约 1.6 GB并阻塞健康接口。layout v2 上线后 `app_state` 约 2.55 MB，云存档正文按修订独立写入；240 秒生产观察中健康接口最大 10.407 ms、`NRestarts=0`、RSS 约 133～162 MB。监控若再次出现内存或延迟上升，应分别检查 `app_state` 大小、`cloud_save_payloads` 行数与历史元数据唯一键数，不能只调大健康超时。

Brotli 仍是可选后续项，应先用真实流量比较 CPU、缓存命中和传输节省。不要用“提高服务器配置”替代静态压缩、缓存和 chunk 体积治理；当前 2 核 2 GB 对首版 Node + Nginx + SQLite 足够。1.0.26 发布后历史 SQLite 备份与旧发布目录仍保留，继续按备份保留/异地归档告警运营，且清理不得删除当前版、回滚版或有效备份。
