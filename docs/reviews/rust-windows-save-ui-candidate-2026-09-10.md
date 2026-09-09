# Windows Rust 保存反馈、启动等待和浏览器验收候选

2026-09-10，Role: develop。完整 Windows Rust Goal 保持 active；本批修复候选未发布，Rust 玩家实时资格仍关闭。

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

- 本机 `qualification-binding-closeout-v2`、`save-ui-light-v1`、`save-ui-metadata-v1/v2` 均在内存预检结束，未启动 Node；最后一次于 18:14:25 UTC 退出，末次余量 3,047,504 KiB，低于原 3 GiB 启动线。没有游戏、证书安装或后台测试遗留。
- 本批 UI/启动候选的类型、完整单元、构建、专项/完整浏览器与截图复核尚待执行；文档/Skill 检查单独记录，不冒充运行验证。
- 上一 22a 的 Windows run `34383362870` / job `102573396629` 已全部成功：核心 1,115 pass / 5 ignored，Host 库 263 pass / 4 ignored，主程序和助手各 3 pass，Native 工具 845 pass / 1 skip，游戏 3,193 pass / 39 skip，均零失败。其真实签名 14 步及清理回执已下载核验，详见[绑定结果](./rust-windows-validation-binding-2026-09-10.md)。新源码不能借用上一 UI 结果；上一实际完整浏览器基线仍为 0657 的 462 pass / 33 skip / 4 fail / 1 flaky。
- 当前桌面冻结包仍是 741，新增绑定及本批 UI 未入包；终局完成入口/两次重开、复杂长离线、可信验证会话和真实 Rust 实时单写者仍待完成。原 6/2 GiB 重任务、3/2 GiB 轻量守护保留，不能靠关闭用户应用或修改时限过关。

[完整执行目标](../rust/windows-full-development.md) · [资格绑定证据](./rust-windows-validation-binding-2026-09-10.md) · [易读报告](../RUST_WINDOWS_FULL_PROGRESS_2026-09-10.md)
