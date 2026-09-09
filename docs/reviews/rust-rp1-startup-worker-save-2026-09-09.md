# RP1：菜单入口复用后台凭据保存

状态：开发候选，尚未冻结新包或验证终局完整入口。完整 Windows Rust Goal 保持 active。

## 问题与实现

629 冻结包的 9 秒终局结算仍未在原 90 秒内进入工厂。此前真实 renderer 采样显示保存、目录构建与校验占用主线程；普通菜单入口在 save Worker 序列化后，还会把完整正文带回主线程重复解析。

`StartMenu.enterLoadedGame()` 的普通进入和恢复提交均通过原保存队列请求 `preferWorkerProof`。已初始化 IndexedDB 且主档目录/修订满足原有资格时，完整 `GameState` 只 structured-clone 一次给 save Worker。Worker 在自身线程生成原 v2 信封、绑定摘要、小型目录种子和完整运行态 transfer；既有 persistence Worker 验证绑定、写者 fencing、CAS、主档精确读回及旧档备份。成功后才初始化运行日志并进入工厂。自动快照复用返回的 transfer，沿用主档身份检查与后台排队。

调用者的状态始终保留。Worker 创建失败、崩溃或取消返回保存失败，原主档不受影响；重试重新克隆当前状态。旧版无模式字段、无协调修订、未知目录，以及不支持 Worker/IndexedDB 的环境沿用兼容保存，保留首次模式迁移的原始备份。现有 transfer、envelope、普通保存合并/去重与跨标签页保护继续使用原协议；GameState v47、信封 v2、云协议均未改变。

这是后台保存接入，不是 Rust 实时接管。正常 Host 未改，实时 `authority_eligible=false` 仍保持。没有新增全流程耗时、帧率或全进程内存收益结论。

## 已取得证据

- `startup-proof-save-focused-v1.json`：类型检查通过；保存、模式、快照、证明与序列化客户端专项 **133/133**。其后浏览器启动因本地测试配置引用路径错误而退出 1，未运行浏览器案例；修正仅涉及 ignored 测试配置。
- `startup-proof-save-browser-v2.json` 及 `startup-proof-save-browser-v2-browser-evidence.json`：真实 Chromium **25 expected / 0 skipped / 0 unexpected / 0 flaky**，不重试。新增普通和竞速两例验证完整信封、完整运行态 transfer、精确旧档备份、调用者状态未变、错误身份拒绝、Worker 创建失败保档及重试。合并的重复保存只递增一次修订。保存提交期间，主线程大型 JSON.parse、JSON.stringify、TextEncoder 调用均为零；此为受测公开初始状态的结构性证据，不是终局性能测量。
- `startup-proof-save-full-v1.json`：完整本机游戏 **3,180 pass / 39 skip / 0 fail**，其中实际正常 Host 差分 **50 pass / 1 长测 skip**；Web 构建与 startup budget、thin-UI boundary、coverage 门禁通过。未重编译或重复计数未变化的 Rust/Host/Native 工具。
- `startup-proof-save-compatibility-v1.json`：旧档首次迁移保留原始备份，下一次采用 Worker proof；新主档的到期快照完整状态相同；原生启动顺序与目录修复均通过，共 **5/5**。完整浏览器、新包和终局成功保存/重开待验，旧 629 的失败保留。

所有本机重任务串行、BelowNormal、6 GiB 启动/2 GiB 停止守护。Chromium 显式 headless、静音、单 worker。25 项浏览器守护正常退出 0，47.652 秒，最低空闲 7,362,512 KiB；完整单元/构建守护正常退出 0，422.682 秒，最低空闲 6,553,304 KiB。此次没有运行可见游戏窗口或修改玩家源存档。

## 后续验收

冻结同一源码的隐藏 Windows 包，沿用实际时钟、完整原始工厂、90 秒入口与 25 秒正常关闭门槛，验证 Native 路径、完整持久状态、JS 对照及两次重开。任何跳过、失败或保护中止独立记录；不将 Worker 接入、测试替身或局部耗时作为完整 Windows Rust 资格。

[完整进度](../RUST_WINDOWS_FULL_PROGRESS_2026-09-09.md) · [629 历史实包](./rust-rp1-629accab-package-2026-09-09.md) · [完整执行目标](../rust/windows-full-development.md)
