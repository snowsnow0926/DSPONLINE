# 香港累计玩家固定补偿发布（2026-09-08）

用户明确指定：将 2026-08-14 至昨天 2026-09-07 的历史补偿定为 **3,700**，直接计入界面累计数。香港网页已完成部署，展示为实时 `players.total + 3700`，并标注“含历史补偿 3,700”；提示文字保留完整日期和估算属性。今日与在线人数不加补偿，上海和独立本地 API 不加补偿。没有向数据库添加合成人物、修改匿名身份或按天摊入活跃记录。

## 发布与验收

- 运行时源提交 `fccaa35e6b41`，独立分支 `codex/hk-player-display-3700`，基于此前香港 Web `dab2ff5066b7`。同一源改动已 cherry-pick 回主工作树提交 `3589b7c2`，后续开发发布须携带该补偿。
- 香港 Web `1.2.7-fccaa35e6b41`，Build ID `1.2.7+fccaa35e6b41`；版本号仍为 1.2.7。API 保持 `api-1.2.6-df828869e276`，PID、schema/layout 和玩家存档未变。稳定控制器执行 Web-only dry-run 后切换，generation 49→50，pending 为空。
- 上传包 2,267,541 B，SHA-256 `cfac9566738a590abe4f0ad485a1caa5420e44ff0b0bf5a9162160cdf79cc339`；196 个 Web 文件共 8,626,245 B 逐个校验，manifest aggregate `13016171c58443becc5b47cbcac3f1cbf2e82089d5e4ee3b0d60febcf24e3240`。
- 公网真实 Chrome 验证 API 原值 8,927、页面 12,627、今日 48、在线 11；后续公开只读检查原值增长至 8,928，展示公式对应 12,628。所有浏览器验收拦截了遥测与写请求，没有向生产提交测试玩家。
- 香港/上海模拟节点分别验证累计差额 3,700/0、刷新不累加、真实原值增加 1 后展示只加 1、API 不可用显示 `--`；桌面 1440×900、竖屏 390×844、横屏 844×390 均无指标区域横向溢出。
- 真实公网新 worker active；访问上一稳定版前后当前 `/index.html` 缓存哈希不变，没有 waiting/installing worker，离线重开正式根站成功。根页、version、当前 worker 和 readiness 为 200，旧 worker 被拒绝为 404。

## 本次验证

干净隔离工作树 `npm ci`、typecheck、Web build、启动体积预算、thin-UI、native coverage、196 文件 manifest 复验通过；许可证核对 127 个运行时包通过。

- Vitest 首轮 3,073 通过、96 跳过、3 个耗时失败。独立复跑 Android transport 7/7、benchmark 与资源结算 16/16，三项失败最终均通过，未修改实现或放宽阈值。期间在未改动的 `dab2ff5066b7` 对照树也复现后两项耗时失败，保留日志，不把首轮报告改成全绿。
- 服务端 390 通过/2 可选跳过，station 4/4；Ops 56 通过/6 Linux-only 跳过；native/desktop 617 通过/9 条件跳过。
- Chromium 首轮 447 通过/33 跳过/4 失败，四项原用例单 worker 原样复跑 4/4。最终覆盖 451 个通过用例、33 个条件跳过；首轮失败和复跑日志均保留。
- 上述专项与公网页面/PWA 检查在本次制品上执行，没有借用上一发布的通过结果。

## 备份、回滚与后续发布

这次只替换静态 Web 和上一稳定版入口，不切换 API，不写玩家数据库；备份了活动 Nginx 与原 switch-state，保留此前一致性 SQLite 快照，没有为 Web 展示改动额外触发 4.85 GB 数据库备份。服务器私有运维证据目录为 `/var/lib/dsp-idle-cloud/ops-display-3700-20260908/`，包含 manifest、切换前状态、上传/切换/公网页面探针和 Nginx 候选检查记录。

直接 Web 回滚目录为 `/var/www/dsp-idle/releases/1.2.7-dab2ff5066b7`。使用稳定发布控制器显式指定该 Web release，保持当前 API；回滚前重新核对 generation/current/pending，不恢复数据库。`/canary/previous/` 已以 302/no-store/Vary:* 指向 `/canary/1.2.7-dab2ff5066b7/`；该不可变入口保留当前 API，并阻止旧根 worker 安装。

Nginx 原 SHA-256 `c2265aac2066b8953e4943e53939c2247a0ca02d86e40e44b72cfe60e1530456`，新 SHA-256 `eb1c5156390be5a15419504c4670cdc8cef3b13e8c6c92e38a40b4a20053d83a`；候选独立语法检查、活动检查和 reload 均通过。恢复上一稳定版入口只恢复已记录 Nginx 副本，不自动回滚 Web/API。

这笔数值是用户指定的固定展示估算，不能解释为恢复了 3,700 个真实唯一身份。回访者与补偿可能重叠，已在此前估算说明中披露。本次没有发布 Windows/Android 安装包，旧客户端继续显示 API 原始累计；香港网页更新后显示补偿。后续若改为由 API 提供补偿，必须同时移除前端加数，避免双计。此前 API 偶发慢响应和 analytics/errors 熔断不在本次展示改动的修复范围内。
