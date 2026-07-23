# 测试与发布基线

## 1. 当前自动化覆盖

| 层级 | 命令 | 当前规模 | 覆盖重点 |
| --- | --- | ---: | --- |
| 类型检查 | `npm run typecheck` | 全部前端 TS | 严格类型、Vite 配置 |
| 单元/领域 | `npm test` | 香港 `0.6.0` 基线 272 项；上海 `0.5.0` 基线 268 项 | 引擎、v1-v30 存档、存档配额急救、殖民载具原子扣料、玩家满仓放下、统一资源储量、四向分流、托盘上限、科研、电力、蓝图、规划、网络、性能与分槽云同步等 |
| 浏览器 E2E | `npm run test:e2e` | 香港 `0.6.0` 基线 108 项；上海 `0.5.0` 基线 97 项 | 从开局到银河终局、生产资料库、移动目录焦点、有限资源、殖民来源、储物仓 200% 字体、新旧手机壳、保存失败和桌面/手机横竖屏回归 |
| 云服务 | `npm run test:server` | 22 项 | 账号验证/绑定/恢复/注销、设备会话、匿名统计、v3→v6 迁移、四槽云存档隔离、腾讯 SES 模板 API、模板变量约束、邮件隐私日志、排行榜和管理员保护 |
| 运维工具 | `npm run test:ops` | 5 项 | SQLite 一致性快照、认证加密、异地复制、隔离恢复、篡改拒绝、Nginx 压缩与缓存边界、端点/磁盘探针和告警载荷 |
| 生产构建 | `npm run build` | 1 次构建 | `tsc -b`、Vite chunk 和 PWA 资源 |
| 桌面目录包 | `npm run desktop:pack` | 按需 | Electron 启动与 Windows 解包 |

Playwright 使用本机 Google Chrome，串行执行，并在隔离的 `127.0.0.1:4319` 自动启动临时 Vite 服务，避免复用玩家正在试玩的 `4318` 进程或其旧模块缓存。失败时保留截图和 trace。

## 2. 日常开发最小矩阵

### 纯文档或 Skill

```powershell
git diff --check
```

再检查 Markdown 链接和 Skill validator。无需因文档改动重跑 86 项浏览器测试。

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
npm run typecheck
npm test
npm run test:server
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
- 对存档 v1-v30 建立不可变 fixture 集，而不是只依赖测试内构造对象。
- 对关键视觉状态建立少量稳定截图基线，避免只检查元素存在。
- CI 同时运行前端单元、服务端测试和浏览器关键路径；当前完整 108 项可作为合并或夜间门禁。

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

## 14. v31 物流与工作区体验本地验收（未发布）

本节记录 2026-07-23 当前工作区结果，不代表香港或上海已经更新。工作区状态版本为 v31，存档 envelope 仍为 v2；香港 `0.6.0` 与上海 `0.5.0` 继续使用 v30。

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 27/27 文件、282/282 通过 |
| `npm run build` | 通过 |
| 先前失败的物流/经典手机 focused Playwright | 7/7 通过 |
| `tests/e2e/v31-workspaces.spec.ts` | 5/5 通过 |
| `npm run test:e2e` | 113/113 通过，3 workers 约 5.3 分钟 |
| `git diff --check` | 通过 |

专项覆盖供需两端载具调度和归属、旧 `stationProgress` 首航迁移、逐行星视口、三种主题、建筑制造中心递归任务、分拣器退款迁移、科技树精简布局、所有主工作区再次点击关闭、堆叠容量以及物流站五槽顺序自动配置。完整 E2E 同时回归经典/新版手机、80%-200% 字体、线路端点、星图互斥、旧存档迁移、有限资源、云存档和大型工作区。

视觉检查产物：

- `artifacts/qa/v31-light-theme-1440.png`
- `artifacts/qa/v31-light-factory-1440.png`
- `artifacts/qa/v31-technology-compact-light-1440.png`
- `artifacts/qa/v31-light-mobile-390.png`

本次没有执行服务器操作、发布构建清单、生产备份、Git 提交或标签。完整 E2E 的 Vite 测试服务器在两个页面卸载时报告过非阻断的 `ResizeObserver loop completed with undelivered notifications`，全部 113 项断言和进程退出码仍为成功；发布前可单独跟踪该浏览器提示，但它不是当前功能失败。
