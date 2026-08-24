# DSP极简网络

[English README](./README.en.md) | 简体中文

《戴森球计划》生产流程的 2D 无限画布挂机工厂游戏。当前稳定版本为 `1.1.5`，使用 `GameState` v47、存档 envelope v2、云 schema v8 和 SQLite layout v3，提供 Web/PWA、Electron 桌面壳、Capacitor Android 应用、云账号、四槽云存档和排行榜。1.1.5 增加终局大存档的 Worker 内稀疏投影与 gzip 导出、保守纯挂机宏观结算，以及五项等权 `balanced-log-v2` 银河综合榜。香港与上海 Web/API、上海下载页、Windows stable 和 Android stable 均已完成 1.1.5 发布；Android 使用批准的长期证书，Windows 安装包按既有策略明确标记为 `NotSigned`。发布证据见 [1.1.5 正式发布记录](./docs/releases/1.1.5.md)，下载入口见 [上海下载节点](https://download.dsponline.cn/)。

正式入口：[https://dsponline.cn](https://dsponline.cn)
源码仓库：[https://github.com/snowsnow0926/DSPONLINE](https://github.com/snowsnow0926/DSPONLINE)

> **许可说明：** 本仓库采用 [PolyForm Noncommercial License 1.0.0](./LICENSE)。源码可以查看、修改和用于非商业用途，但不允许未经书面授权收费销售、付费托管、商业集成或用于其他预期商业场景。本项目是 **source-available（源码公开）**，不是 OSI 意义上的开源软件。详见 [商业使用说明](./COMMERCIAL_USE.md)。

## 当前能力

- React 19 + React Flow 2D 无限画布，支持桌面、手机横竖屏和 PWA。
- 确定性生产、电力、传送带、物流、科研、离线结算、戴森工程和银河终局模拟。
- 8 个恒星系、22 颗行星、78 个物品、78 条配方、37 类建筑和 67 项科技。
- 本地存档、备份、快照、三个手动槽位、蓝图和内容包。
- 用户名账号、可选邮箱、四槽云存档、修订历史、冲突保护和排行榜。
- 简体中文与 English 可随时切换，语言偏好仅保存在当前设备；深色、亮色和跟随系统主题覆盖桌面及两套手机界面。
- 多级递归制造支持高级配方回退、物流运输船和建筑制造中心；生产资料库可跨行星定位并高亮真实上游产线。
- Electron 桌面打包、Capacitor Android 工程及 Stable/Beta/Nightly 更新通道。
- SQLite 云服务、备份/恢复、Nginx/systemd 模板和双节点发布工具。

完整且持续更新的功能状态见 [docs/PROJECT_STATUS.md](./docs/PROJECT_STATUS.md)。

## 本地开发

建议使用 Node.js 24。首次安装：

```powershell
npm ci
npm --prefix server ci
```

终端一启动本地云服务：

```powershell
npm run server:dev
```

终端二启动前端：

```powershell
npm run dev
```

浏览器打开 `http://127.0.0.1:4318`。本地服务默认数据库位于 `server/data/cloud.sqlite`，该目录已被 Git 忽略。

如需本地运营后台，设置至少 32 字符且只用于开发的管理员 token：

```powershell
$env:DSP_ADMIN_TOKEN = "replace-with-a-local-random-value-at-least-32-chars"
npm run server:dev
```

访问 `http://127.0.0.1:4318/admin`。不要把真实 token、服务器密钥、玩家数据或生产数据库写入仓库、Issue、Pull Request 或聊天记录。

## 社区构建

普通 Web 开发构建通过同源 `/api` 连接本地服务。社区打包的 Electron/Android 版本默认关闭云 API、账号深链和自动更新，不会连接官方 `dsponline.cn` 服务。

自建实例需要在构建时显式设置自己的 HTTPS 地址。变量和官方/社区边界见 [docs/COMMUNITY_BUILDS.md](./docs/COMMUNITY_BUILDS.md) 与 [.env.example](./.env.example)。不要在社区分支中复用官方域名、签名、更新源或账号入口。

## 验证

```powershell
npm run licenses:check
npm run typecheck
npm test
npm run test:server
npm run test:native
npm run test:ops
npm run build
npm run test:e2e
```

桌面目录包另运行：

```powershell
npm run desktop:pack
```

正式 Windows/Android 制品必须通过长期平台签名门禁；未签名预览包不得进入公共更新源。

## 文档

- [项目现状](./docs/PROJECT_STATUS.md)：当前版本、功能、部署、质量基线和已知风险。
- [系统架构](./docs/ARCHITECTURE.md)：前端、模拟器、存档、云服务和部署边界。
- [玩法与系统](./docs/GAMEPLAY_SYSTEMS.md)：稳定玩法规则和内容规模。
- [内容包 Mod 指南](./docs/MODDING.md)：JSON 格式、字段、依赖、导入流程、存档边界和可用示例。
- [测试与发布](./docs/TESTING_RELEASE.md)：按风险选择测试及正式发布清单。
- [部署与运维](./docs/DEPLOYMENT_OPERATIONS.md)：双节点、备份、发布和回滚。
- [社区构建](./docs/COMMUNITY_BUILDS.md)：自建 API、原生构建和更新地址配置。
- [GitHub 公开检查单](./docs/GITHUB_RELEASE_CHECKLIST.md)：上传前后仓库安全设置。
- [路线图](./docs/ROADMAP.md)：后续计划。
- [版本记录](./CHANGELOG.md)：产品版本更新摘要。

## 参与和安全

提交修改前请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)。安全漏洞不要创建公开 Issue，应按 [SECURITY.md](./SECURITY.md) 使用 GitHub 私密漏洞报告。

官方服务的数据处理和使用规则见 [PRIVACY.md](./PRIVACY.md) 与 [TERMS.md](./TERMS.md)。第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。项目名称和 Logo 的使用规则见 [TRADEMARKS.md](./TRADEMARKS.md)。

## 许可证

原创项目代码、文档和资产按 [PolyForm Noncommercial License 1.0.0](./LICENSE) 提供。未经维护者单独书面授权，不得商业使用。

第三方组件继续适用各自许可证，完整运行时通知文本随构建保存在 [`public/THIRD_PARTY_LICENSES.txt`](./public/THIRD_PARTY_LICENSES.txt)。
