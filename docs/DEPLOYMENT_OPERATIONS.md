# 部署与运维手册

## 1. 环境边界

| 环境 | 地址 | 主机 | 作用 |
| --- | --- | --- | --- |
| 香港正式 | `https://dsponline.cn` | `43.129.249.102` | 正式 Web、云账号、云存档、排行榜 |
| 香港别名 | `https://www.dsponline.cn` | 同上 | 301 到根域名 |
| 上海旧节点 | `http://111.229.128.211` | `111.229.128.211` | 独立旧入口和备用试玩 |
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
| `/etc/nginx/snippets/dsp-idle-app.conf` | 公共静态与 API 规则 |
| `/etc/dsp-idle-cloud/admin.env` | 仅 root/服务账号可读的管理员 token 与邮件 API 凭据，不进入发布目录 |

服务端绑定 `127.0.0.1:4320`，公网只通过 Nginx 的 `/api` 访问。仓库里的 systemd 和 Nginx 文件是模板，实际安装前必须对照目标节点，不能把香港 Origin 或证书路径直接覆盖到上海。

当前香港正式基线为 `0.7.0-8bf16d91d82d`，Web/API 的 `previous-release` 均指向 `0.6.0-ae779d297011`。上海保持 `0.5.0-5b3a468c94d0`，其 `previous-release` 仍指向 `0.4.0-c77d76223f67`。两地代码回滚继续使用各自的 schema v6 数据库；香港本次完整哈希、生产备份和验收记录见 [releases/0.7.0.md](./releases/0.7.0.md)。

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

前端回滚只需把 `current` 切回上一发布目录，不触碰数据库。

仓库提供 `deploy/switch-release.sh` 原子切换前端与后端代码，并保存上一次代码指向。两台正式节点已将同一脚本安装为 `/usr/local/sbin/dsp-idle-switch-release`；发布或回滚后都会验证 Nginx、云服务和本机健康接口：

```bash
sudo dsp-idle-switch-release --web-release <web-id> --api-release <api-id>
sudo dsp-idle-switch-release --rollback-last
```

`--rollback-last` 只切换 `/var/www/dsp-idle/current` 与 `/opt/dsp-idle-cloud/current`，绝不恢复、替换或初始化数据库。

执行 `--rollback-last` 前必须读取 `/var/lib/dsp-idle-cloud/release-state/previous-release`，确认两个目录存在且后端能读取当前 schema。数据库升级后不能把旧 schema 后端继续留作“一键回滚”目标；应先在当前数据库的一致性备份副本上用隔离端口完成兼容验证。

云服务重启后，切换脚本默认在 10 秒窗口内短轮询本机健康接口，避免把 Node 尚未绑定端口的正常启动窗口误判为发布失败。可通过 `DSP_HEALTH_ATTEMPTS` 和 `DSP_HEALTH_DELAY_SECONDS` 调整，但不得以此掩盖持续启动错误。

### 5.3 后端

1. 上传到 `/opt/dsp-idle-cloud/releases/<build-id>`。
2. 在发布目录执行生产依赖安装和服务端测试。
3. 切换 `current`，重启云服务。
4. 检查 `systemctl status`、journal 和本机 `/api/health`。
5. 再从公网入口验证同源 `/api/health`、登录页面和云存档元数据读取。

后端失败时切回上一代码目录并重启；除非新代码已执行不可逆数据迁移，否则不要回滚数据库。

## 6. 节点配置

### 香港正式节点

- Nginx 模板：`deploy/nginx-dsp-idle-domain.conf` 与公共 snippet。
- systemd 环境模板：`deploy/dsp-idle-cloud-hk.service`。
- 允许 Origin：正式根域名、`www` 和明确保留的兼容入口。
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

公开 `/api/public-status` 只提供玩家累计、今日和 120 秒在线口径；`/api/admin/metrics` 与兼容路径 `/api/metrics` 必须携带管理员 bearer token。后台入口为 `https://dsponline.cn/admin`。

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

验证与重置模板分别使用 [deploy/mail-templates/account-verification.html](../deploy/mail-templates/account-verification.html) 和 [deploy/mail-templates/password-reset.html](../deploy/mail-templates/password-reset.html)，模板中只包含腾讯普通发送允许的单一变量 `{{actionUrl}}`。两个模板必须审核通过后再填写数值 ID。CAM 应使用独立子账号并只授予 `name/ses:SendEmail`；SecretId/SecretKey 不得使用主账号长期密钥，也不得写入仓库、发布目录、命令历史或聊天。

腾讯配置完整时优先使用 SES API；原有 `DSP_MAIL_WEBHOOK_URL` / `DSP_MAIL_WEBHOOK_TOKEN` 仅作为兼容回退。两种发送器都未配置时，服务端会让新注册与邮件恢复返回 `503 EMAIL_SERVICE_UNAVAILABLE`。上线前必须用专用测试邮箱验证注册、验证链接、过期链接、忘记密码和重置密码完整链路，并在 `/api/health` 确认 `mailProvider` 为 `tencent-ses`。上海公开入口是 HTTP，不开放账号邮件入口。

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
curl -I http://111.229.128.211/
curl http://111.229.128.211/api/health
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

## 9. 监控与日常检查

- `dsp-idle-cloud.service`：active，重启次数无异常。
- `dsp-idle-healthcheck.timer`：active，每两分钟运行。
- Certbot timer：active，定期执行续期演练。
- Nginx access/error log：关注 5xx、429、超时和异常大请求。
- systemd journal：关注数据库写入、备份、Origin 拒绝和崩溃。
- 磁盘：关注发布目录、日志、SQLite WAL 和备份增长。
- `/api/admin/metrics`：验证管理员 token 后检查访问漏斗、错误、P95 延迟、限流、云冲突和备份状态。
- `dsp-idle-node-health.timer`：每五分钟检查正式入口/API 延迟、磁盘可用比例和 TLS 剩余天数；状态写入受保护后台，可选 webhook 仅发送失败检查名称。
- 香港 `dsp-idle-offsite-backup.timer` 与上海 `dsp-idle-restore-drill.timer`：检查最后成功时间、timer 上次结果和报告文件。
- 玩家指标：检查 `players.total`、`players.today`、`players.online` 和 `players.onlineWindowSeconds`；两个节点分别统计，不能直接相加当作严格独立用户数。

这些 oneshot 服务从 `/opt/dsp-idle-cloud/current/deploy` 软链接执行脚本。CLI 入口判断必须比较真实路径；若 unit 显示 `success` 却没有生成对应状态文件，应按空运行故障处理，不能视为监控或备份成功。

匿名在线窗口默认 120 秒，可通过 `DSP_PLAYER_ONLINE_WINDOW_MS` 调整；运营日历默认 `Asia/Shanghai`，可通过 `DSP_METRIC_TIME_ZONE` 调整。修改在线窗口只影响在线口径，不影响累计玩家。部署 schema v6 后端前仍必须先使用 SQLite backup API 创建并验证备份，并用真实备份副本验证 v3→v6 归一化：旧账号保持已验证，账号、会话、主存档、历史、榜单、玩家和匿名统计数量不减少，三个手动云槽结构可用。

## 10. 当前性能事项

香港 `0.7.0` 与上海 `0.5.0` 均为 JS/CSS 启用 gzip，并验证 `Content-Encoding: gzip`；hashed asset 保持 immutable，`index.html` 与 `sw.js` 保持 no-cache。主菜单不 preload `FactoryRuntime`、`flow-vendor`、`game-core` 或 `storage`，页面加载、LCP 和传输体积按隐私分桶进入受保护后台。

Brotli 仍是可选后续项，应先用真实流量比较 CPU、缓存命中和传输节省。不要用“提高服务器配置”替代静态压缩、缓存和 chunk 体积治理；当前 2 核 2 GB 对首版 Node + Nginx + SQLite 足够。上海节点 `0.5.0` 发布后约剩 6.7 GiB（文件系统使用率约 89%），发布目录、日志与备份增长应纳入日常磁盘检查。
