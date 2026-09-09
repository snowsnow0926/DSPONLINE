# Windows Rust 保存反馈、启动等待和浏览器验收候选

2026-09-10，Role: develop。完整 Windows Rust Goal 保持 active；本批修复候选未发布，Rust 玩家实时资格仍关闭。

最终进展：清单修复已提交推送 `1cf84cc8`，新云端生产构建成功。50b Windows 已全部成功，完整浏览器为 467 pass / 33 skip / 2 fail / 1 flaky；准确作业、剩余失败与 trace 分析见[接续记录](./rust-windows-native-limit-drafts-2026-09-10.md)。下述运行中/待验描述保留为该批最初取证历史。

UI/启动/Chrome 候选已提交并推送 `50b7af10bcf66ed08f4bc8fa6f99afaeafe563ac`。该候选 CI run `34387948109` 的两个浏览器分片均已成功通过 Chrome 准备并实际开始 E2E；生产构建在旧 Native 覆盖清单的位置过期检查处失败。下述清单修复单独验收，尚不宣称新完整构建通过。

## Native 覆盖清单收口

保存组件插入新行后，覆盖清单的源码行号必须重新生成。进一步运行以前未纳入 `test:native` 的清单单元，发现旧测试把功能分类数当成实际调用数；上次玩法迁移后已是 29 类、45 个直接调用，旧的“分类至少 30”会误报。现在保留至少 30 个受保护操作的底线，按实际入口统计并校验每类出现次数与源码位置一致。

扫描器改用 TypeScript AST，识别换行、引号、JSX 回调以及全部静态条件分支，排除注释和示例字符串，拒绝动态/缺失/多余标签及语法损坏。实际发现原正则漏记 `blueprintPlacementId ? "蓝图部署" : "建筑放置与扩建"` 的一次调用。新清单包含 **29 类、46 处独立调用、47 个标签出现位置**（该条件分支属于两类）。没有增加虚构功能分类、放宽玩家准入或改动玩法实现。

新增/修复的 **5 项**清单测试全部通过，并加入 `test:native`，后续 Windows/Native 回归都会执行。清单来自真实源码重新生成；生成与校验均通过。此前 `save-ui-closeout-v1` 的旧计数失败、`save-ui-metadata-v4` 的条件标签拒绝均保留为诊断过程，未计为通过。

## 问题与改动

1. **保存拒绝操作的提示被覆盖**：原提示拼接到当前阶段文本，下一次 checkpoint/write/readback 状态更新将它丢弃。现在用本次保存 ID 单独保留拒绝事实，在后续阶段及完成提示中显示；下一次保存不继承旧警告。原 E2E 增加“完成后仍告知需重做”和“下次自动保存无旧警告”的断言。
2. **救援测试读取了已释放缓存**：验证 Worker 保存成功后，主线程同步缓存可为空。测试改用独立持久读取，仍要求 v47 及完整封装校验和一致；不改救援实现或玩家存档。
3. **手机统计页横向溢出**：next shell 的 auto 搜索列挤占时间范围控件宽度。候选改为独立行和两列时间范围按钮，并让该工具栏随页面滚动，避免大字号下固定栏占满矮屏。新增 390×844 / 844×390、80/100/125/150/200% 的实际点击、44px 目标、溢出及截图检查，尚待浏览器证明。
4. **施工反馈测试等待互相影响**：将触发离线报告处理器的并发 click/wait 改为依次点击、验证可见提示；保留材料、库存、连放、截图与原测试时限。
5. **冷菜单串行启动等待**：菜单模块下载与存档目录初始化并行，React 仍在持久存档和桌面关闭保护准备完成后挂载。新增阻塞存档模块的真实浏览器测试，要求菜单模块先请求但不能提前挂载。原 29.7/59.4 MiB 目录测试、零正文加载/解析断言和 p95 ≤500 ms 保留；尚无新的性能收益结论。

没有修改 GameState、封装、库存计算、玩家源文件、云数据或 Rust 权威准入。构建缓存和优化级别保持原样。

## 云端 Chrome 环境恢复

22a 的 CI run `34383362950` 两分片首次均在安装 Chrome 的 apt 更新阶段遇到 Google `Packages.gz` Hash Sum mismatch，未执行测试。其他作业结束后只重试失败任务；新 job `102582657707 / 102582657913` 仍在同一安装阶段失败。失败证据保留，不能记为测试通过或新的游戏回归结果。

CI 候选改为：固定路径 `/opt/google/chrome/chrome` 已存在且可执行时，使用 `channel: chrome` 实际无头、静音启动并打开探针页面，记录版本；不存在时仍执行原 `playwright install --with-deps chrome`。探针只允许一次性 Linux CI，失败会阻止后续测试，不更换浏览器、不修改系统仓库或放宽哈希/TLS/安装校验。每次完整 E2E 仍重新运行。

Playwright 支持使用机器上已有的 Chrome Stable 通道，运行机镜像也公开列出预装浏览器；因此这一步通过实际启动检查确认可用性，不依赖一次与测试无关的软件源更新。[Playwright 浏览器文档](https://playwright.dev/docs/browsers#google-chrome--microsoft-edge)、[GitHub Ubuntu 镜像清单](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md)。

## 执行证据与未完成项

- 最终轻量 `save-ui-metadata-v5` **PASS**：绑定相关 **150 pass / 0 skip / 0 fail**、清单 **5 pass / 0 skip / 0 fail**、7 个 TS/TSX 语法转译、Chrome 脚本语法与本机禁止执行检查、CI YAML、Rust 格式和 Skill validator 通过。源码检查前后哈希一致。守护 `PROCESS_EXITED_NORMALLY / exit 0`、无停止原因，17.7410677 秒，最低空闲 **7,204,544 KiB**，仍采用 3/2 GiB。
- 同次文档扫描解析 433 条有效相对链接，新增缺失链接为 0；发现一条 22a 基线已有的 `docs/PROJECT_STATUS.md → releases/1.0.46-no-go-2026-08-19.md` 缺失，单独记录为历史问题，没有虚构该记录或宣称全部旧链接正常。该扫描不等于实际 UI/类型/运行验证。
- 单线程无头静音 `save-ui-browser-v1` 的完整项目类型检查通过；8 项浏览器专项 **7 pass / 0 skip / 1 fail / 0 flaky**，无重试。保存提示、救援持久读取、施工反馈、手机路由/统计、两种屏幕的五级字号操作、阻塞存档时菜单不提前挂载均通过；唯一失败为冷菜单 p95 **892 ms >500 ms**。守护记录正常测试失败退出 1、无停止原因，126.7509309 秒，最低余量 4,831,684 KiB，原 6/2 GiB 未变。这一整组不是 PASS。
- 两个仅用于诊断的冷菜单单例保留相同数据、10 次重载和全部完整性断言：`save-ui-browser-v2` 关闭 trace 时 p95 **155 ms**；随后 `v3` 恢复原 `retain-on-failure` 时 p95 **300 ms**。两者各 1 pass，守护正常退出 0，最低空闲分别 6,230,120 / 6,123,276 KiB。因此不能仅归因于 trace；批量负载差异尚需全量云端结果确认。没有修改原浏览器 trace、重试、时限或 500 ms 门槛，也不将这组诊断称作产品加速比例。
- 已生成十张横竖屏/字号截图，实际复核 200% 的两张：时间范围控件未溢出且布局可滚动，其余尺寸由实际点击、目标大小与溢出断言验证。完整视觉与全量浏览器仍分别记录。
- 本机 `qualification-binding-closeout-v2`、`save-ui-light-v1`、`save-ui-metadata-v1/v2` 均在内存预检结束，未启动 Node；最后一次于 18:14:25 UTC 退出，末次余量 3,047,504 KiB，低于原 3 GiB 启动线。没有游戏、证书安装或后台测试遗留。
- 50b 的云端类型/完整游戏单元作业已 SUCCESS，**3,190 pass / 42 skip / 0 fail**（Linux 条件跳过与 Windows 分开统计）；完整浏览器仍运行。
- 清单修复后 `save-ui-build-v2` 执行完整 `npm run build` **PASS**：项目类型、生产打包、原启动体积预算、Native thin-UI（13 App bindings / 12 dedicated component files）和覆盖清单门禁全部通过。源码前后哈希一致；6/2 GiB 守护正常退出 0、无停止原因，51.298005 秒，最低空闲 **4,720,272 KiB**。这是未冻结工作副本的 Web 构建，不是新的 Windows 包或完整发布通过。
- 上一 22a 的 Windows run `34383362870` / job `102573396629` 已全部成功：核心 1,115 pass / 5 ignored，Host 库 263 pass / 4 ignored，主程序和助手各 3 pass，Native 工具 845 pass / 1 skip，游戏 3,193 pass / 39 skip，均零失败。其真实签名 14 步及清理回执已下载核验，详见[绑定结果](./rust-windows-validation-binding-2026-09-10.md)。新源码不能借用上一 UI 结果；上一实际完整浏览器基线仍为 0657 的 462 pass / 33 skip / 4 fail / 1 flaky。
- 当前桌面冻结包仍是 741，新增绑定及本批 UI 未入包；终局完成入口/两次重开、复杂长离线、可信验证会话和真实 Rust 实时单写者仍待完成。原 6/2 GiB 重任务、3/2 GiB 轻量守护保留，不能靠关闭用户应用或修改时限过关。

[完整执行目标](../rust/windows-full-development.md) · [资格绑定证据](./rust-windows-validation-binding-2026-09-10.md) · [易读报告](../RUST_WINDOWS_FULL_PROGRESS_2026-09-10.md)
