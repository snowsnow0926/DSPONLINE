# 香港 `nutwg.com` iframe 白名单运维记录（2026-08-26）

## 结果

- 目标节点：香港正式 HTTPS 主站 `https://dsponline.cn`；上海试玩节点、上海下载页、API、数据库和原生包均不在范围内。
- 活动运行时保持 `1.1.9-c3f4eff6cb5a`，没有切换 Web/API `current`、`previous`、canary 或下载指针。
- 游戏 HTML 响应不再发送 `X-Frame-Options: DENY`，CSP 的嵌入边界从 `frame-ancestors 'none'` 精确改为 `frame-ancestors https://nutwg.com`。
- 白名单不包含 `www.nutwg.com`、子域名、HTTP 来源或任何通配符。
- 变更只作用于 SPA 的 `index.html` 响应范围；`version.json` 等非 HTML 响应继续保留 `X-Frame-Options: DENY` 和 `frame-ancestors 'none'`。

## 变更门禁与回滚

- 修改前活动 Nginx snippet SHA-256：`f00a71ca71166720b3aa4c1e4f9c1a17841b97deeb015591adf7b1d4ac48ac7c`。
- 修改后活动 Nginx snippet SHA-256：`6cbd19d0cf8f757ae5af75b62077f844e57381946d8c116bf02dfb6561cb4263`。
- 回滚副本：`dsp-idle-app.conf.pre-iframe-nutwg-20260826T131553Z`；其 SHA-256 与修改前活动 snippet 完全一致。
- 变更前锁定活动 Release ID 与 snippet 哈希，确认 pending switch 不存在、活动 snippet 只被主配置包含一次，并使用独立最小 Nginx 配置完成候选语法检查。
- 安装使用同目录候选文件原子替换，随后通过正式 `nginx -t` 和 reload；脚本带独占运维锁与失败自动恢复上述副本的门禁。
- 本次是纯 Nginx/HTML 响应头变更，不切换 API、不写 SQLite 或玩家数据；按 Web/Nginx-only 边界备份并验证活动配置，没有制造无关的大型数据库快照 I/O。

## 验收

- 公网 `/`、`/index.html` 和一个 SPA fallback 路径均返回 `200`，只有一条 CSP，包含精确 `frame-ancestors https://nutwg.com`，且不再返回 `X-Frame-Options`；HTML 的 `no-cache, no-store, must-revalidate` 保持不变。
- 公网 `/version.json` 返回 `200`，继续发送 `X-Frame-Options: DENY` 与 `frame-ancestors 'none'`，证明非 HTML 防护没有被广泛放开。
- 公网 `/api/health` 与 `/api/ready` 均为 `200`；Nginx、活动 API 和交接代理保持 active，API `NRestarts` 为 `0 → 0`。
- 公网版本仍为 `1.1.9+c3f4eff6cb5a`；收口根盘使用约 `54%`。
- 新浏览器上下文正常渲染 `DSP极简网络` 1.1.9 主菜单和版本弹窗，控制台 error 为 `0`。

## 边界与后续

- 本次只解决浏览器允许 `https://nutwg.com` 作为 iframe 祖先来源。对方站点尚未提供已上线的 DSP极简网络内容页，因此没有在其正式详情页完成端到端 SDK/`postMessage` 验收。
- 第三方 Cookie、对方 iframe `sandbox`/`allow` 属性、移动端布局以及站点 SDK 事件接入属于独立兼容面，不由本次响应头白名单自动保证。
- 当前仓库 Nginx 模板仍保留默认拒绝嵌入策略。后续若重新安装模板，Release Agent 必须先核对本记录与活动 snippet，避免覆盖白名单；模板持久化应由单独的 Development 角色修改测试后交接。
