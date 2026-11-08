# DSP极简网络

[English README](./README.en.md) | 简体中文

《戴森球计划》生产流程的 2D 无限画布挂机工厂游戏。从采矿、供电和第一条产线开始，逐步建立跨行星物流、推进科研与戴森工程；支持浏览器、Windows 和 Android，以及本地存档与云端同步。

[在线游玩](https://dsponline.cn/) · [客户端下载](https://download.dsponline.cn/) · [源码仓库](https://github.com/snowsnow0926/DSPONLINE)

## 当前正式版本

以下版本已于 2026-11-08 核对公网清单，各平台独立更新。

| 平台 | 正式版本 | 入口 |
| --- | --- | --- |
| Web / PWA | **1.3.9** | [在线游玩](https://dsponline.cn/) |
| Windows x64 | **1.3.10** | [下载安装包](https://download.dsponline.cn/downloads/desktop/stable/dsp-idle-1.3.10-x64-setup.exe) |
| Android 7+ | **1.3.9 / 1003009** | [下载 APK](https://download.dsponline.cn/downloads/android/dsp-idle-1.3.9-1003009.apk) |

Windows 1.3.10 修复云存档下载被 DSP 请求头校验拒绝的问题；网页版和 Android 保持 1.3.9。内容包全面升级和存档交互改进见 [1.3.9 发布记录](./docs/releases/1.3.9.md)，Windows 热修、验证及回退信息见 [1.3.10 发布记录](./docs/releases/1.3.10.md)。

Windows 安装包当前为 `NotSigned`，Android 沿用长期发布证书。下载页提供 SHA-256 校验值；完整安装包信息见 [原生应用说明](./docs/NATIVE_APPLICATIONS.md)。

> **许可说明：** 本仓库采用 [PolyForm Noncommercial License 1.0.0](./LICENSE)。源码可以查看、修改和用于非商业用途，但不允许未经书面授权收费销售、付费托管、商业集成或用于其他预期商业场景。本项目是 **source-available（源码公开）**，不是 OSI 意义上的开源软件。详见 [商业使用说明](./COMMERCIAL_USE.md)。

## 当前能力

- **无限画布工厂**：React 19 + React Flow，支持缩放、蓝图、跨行星生产线定位，以及桌面和手机横竖屏操作。
- **完整工业生产链**：采矿、冶炼、制造、电力、传送带、物流、科研、戴森工程与银河终局；实时生产和离线结算遵守相同的物料规则。
- **生产规划与制造**：多级递归制造、建筑制造中心、物流运输船、生产资料库，以及真实上游产线定位与高亮。
- **本地存档保护**：主档、已验证备份、快照、三个手动槽位、换档恢复点、写入失败保护与诊断导出。
- **云端进度**：用户名账号、可选邮箱、四槽云存档、修订历史、冲突处理和排行榜；普通与速通进度独立管理。
- **内容包 v4**：可视化作者工具、手合开关、配方限制、科技实际加成、自定义生产规则和旧 ID 保档迁移。
- **多端界面**：简体中文与 English，深色、亮色和跟随系统主题；字号设置及两套手机布局，语言偏好按设备保存。
- **应用与自建服务**：Web/PWA、Electron Windows、Capacitor Android，以及 SQLite 云服务、备份恢复和独立节点部署工具。

完整且持续更新的功能状态见 [docs/PROJECT_STATUS.md](./docs/PROJECT_STATUS.md)。

## 内容包与作者工具

在游戏的“运营中心 → 内容包 → 可视化作者工具”中创建、校验和导出声明式 JSON 内容包。当前支持：

- 新增物品、建筑、配方、科技与传送带等级，配置图标和分类。
- 设置配方是否可手合、建筑可用配方，以及通过科技统一解锁的配方分组。
- 让已完成科技实际影响生产速度、能耗、采矿效率和输入输出容量。
- 定义燃料热值、发电效率，以及现有行星上的资源矿点和采矿建筑。
- 兼容更新时保留库存、建筑和研究；通过显式旧 ID 映射迁移改名后的内容。

从 [内容包指南](./docs/MODDING.md) 和 [晶体工业 v4 示例](./docs/examples/example-crystal-v4.content-pack.json) 开始。内容包使用经过校验的声明式规则，不执行任意脚本。包配置不会自动随云存档分发，换设备时需安装对应内容包及兼容版本。

## 本地开发

使用 Node.js 24。Windows 桌面构建还需要 Rust/Cargo 和对应的 C++ 构建工具；Android 环境见 [原生应用说明](./docs/NATIVE_APPLICATIONS.md)。首次安装：

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

按改动范围选择检查，完整清单见 [测试与发布](./docs/TESTING_RELEASE.md)：

```powershell
npm run licenses:check
npm run typecheck
npm test
npm run test:server
npm run test:native
npm run test:native-core:serial
npm run test:ops
npm run build
npm run test:e2e
```

原生检查需要 Rust 工具链，浏览器测试默认使用本机 Google Chrome。GitHub 常规 CI 和浏览器兼容性检查采用手动触发。

Windows 本地桌面目录包：

```powershell
npm run desktop:pack
```

`desktop:pack` 用于本地目录包验证。安装包身份、签名、更新清单和正式发布门禁见 [原生应用说明](./docs/NATIVE_APPLICATIONS.md)。可选 Rust 原生核心的支持范围与启用资格也以该文档为准。

## 文档

- [项目现状](./docs/PROJECT_STATUS.md)：当前版本、功能、部署、质量基线和已知风险。
- [系统架构](./docs/ARCHITECTURE.md)：前端、模拟器、存档、云服务和部署边界。
- [玩法与系统](./docs/GAMEPLAY_SYSTEMS.md)：稳定玩法规则和内容规模。
- [内容包 Mod 指南](./docs/MODDING.md)：JSON 格式、字段、依赖、导入流程、存档边界和可用示例。
- [原生应用](./docs/NATIVE_APPLICATIONS.md)：Windows/Android 构建、签名、更新和原生核心边界。
- [测试与发布](./docs/TESTING_RELEASE.md)：按风险选择测试及正式发布清单。
- [部署与运维](./docs/DEPLOYMENT_OPERATIONS.md)：双节点、备份、发布和回滚。
- [社区构建](./docs/COMMUNITY_BUILDS.md)：自建 API、原生构建和更新地址配置。
- [GitHub 公开检查单](./docs/GITHUB_RELEASE_CHECKLIST.md)：上传前后仓库安全设置。
- [路线图](./docs/ROADMAP.md)：后续计划。
- [版本记录](./CHANGELOG.md)：历史变更摘要；最新发布详见 [1.3.9](./docs/releases/1.3.9.md) 与 [1.3.10](./docs/releases/1.3.10.md)。

## 参与和安全

提交修改前请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)。安全漏洞不要创建公开 Issue，应按 [SECURITY.md](./SECURITY.md) 使用 GitHub 私密漏洞报告。

官方服务的数据处理和使用规则见 [PRIVACY.md](./PRIVACY.md) 与 [TERMS.md](./TERMS.md)。第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。项目名称和 Logo 的使用规则见 [TRADEMARKS.md](./TRADEMARKS.md)。

## 许可证

原创项目代码、文档和资产按 [PolyForm Noncommercial License 1.0.0](./LICENSE) 提供。未经维护者单独书面授权，不得商业使用。

第三方组件继续适用各自许可证，完整运行时通知文本随构建保存在 [`public/THIRD_PARTY_LICENSES.txt`](./public/THIRD_PARTY_LICENSES.txt)。
