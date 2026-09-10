# Windows Rust 已验签正文的候选与会话绑定

2026-09-10，Role: develop，开发分支 `codex/rust-rp1-after-1.2.7`。完整 Windows Rust Goal 保持进行中；本批不发布、不启用玩家实时权威。

运行代码已提交 `b410747601674907ad9914ca77a14ae881761968`，证据提交 `22a80a00d2ab7a56f843493dbd2de0dfeaa8c7c5`。对应云端 Windows 完整检查已通过；这是验证专用正文绑定通过，仍不授予玩家实时资格。

## 改动及边界

main 与 Host 增加独立正文绑定器，消费既有不可伪造的验签凭据，对比冻结程序、规则/内容/矩阵、发布者密钥版本、唯一隔离 profile 与合成夹具、只读云范围、时间和撤销条件。固定有界字节合同拒绝未知/重复字段与非规范编码。详见[合同](../rust/windows-validation-body-v1.md)。

新增 76 个共享公开向量，两端分别执行；另验证损坏 UTF-8、凭据与读取回执的隔离。真实 Windows CI 新增签名 `binding` 成员，在 Host 和真实 main 助手中执行相同候选/会话/撤销正反例，并延续信任前、移除信任后拒绝和证书/密钥/夹具清理。

当前合同只支持普通主槽、1×、内建内容、隔离合成存档、禁止云写入的验证专用范围。生产者摘要只是引用；可信时间与撤销的取得、防回退、发布者生产策略、完整资格、实际实时接管仍待完成。JS 回执明确 `producerAuthenticated=false / authorityEligible=false / releaseAllowed=false`；Host 绑定结果不授予权威，普通 Host `authority_eligible=false` 未改。没有 GameState、存档封装、云数据或玩法变化。

## 当前验证

### 最终源码云端结果

[Windows run 34383362870](https://github.com/snowsnow0926/DSPONLINE/actions/runs/34383362870) / job `102573396629` 全部 SUCCESS，对应 PR merge `d28f48b43b1d96c0ac9f0384c9f20abf6008808c`。严格 Clippy、格式、实际签名、优化 Rust、Host 构建、Native 工具、类型和游戏单元全部通过：核心 **1,115 pass / 5 ignored**，Host 库 **263 pass / 4 ignored**、主程序及助手各 **3 pass**，Native 工具 **845 pass / 1 skip**，游戏 **3,193 pass / 39 skip**，均零失败。最终 76 个共享向量已在两端完整检查中执行；下面本机初版记录仅保留过程，不代表最终结果缺失。

签名 artifact `10117124637` 已下载，ZIP SHA-256 `16933a1d6e498a2055a409e01dff686f8c955a856ca02470763f20647c84020f` 与 GitHub 摘要一致。回执 sourceSha 与 merge 一致，**14 步 exit 0、无超时**；Host 新增真实签名绑定正例及程序不符/会话不符/撤销拒绝均通过，main 受信阶段 12 检查通过。信任前及移除后拒绝均通过；个人证书、私钥、测试根与夹具清理四项均 true。结果保持 `TEST_ONLY / authorityEligible=false`。

最终诊断 artifact `10117909600`、Host artifact `10117910938` 已上传，尚未下载/冻结为本机桌面包。22a 的 Linux CI 浏览器两次在 Chrome apt 索引哈希错误处中止，未执行游戏测试；环境准备与 UI 修复另见[下一批候选](./rust-windows-save-ui-candidate-2026-09-10.md)。

### 本机初版与历史基线

- 初版本机轻量专项：**143 pass / 0 skip / 0 fail**，包含初版 69 共享向量、损坏 UTF-8/伪造凭据/拷贝隔离、原 main 助手、开发证据审计、证书 CI 拒绝预检、入口语法与包卫生。
- 复查后修正 JS 正则 `$` 可接受末尾 LF 的边界，追加 7 个公开负例，当前共 76 向量。`qualification-binding-focused-v2-wrapper.json` 记录预检内存不足，未启动 Node 或游戏；143 项初版结果不冒充最终源码通过，最终复验待执行。
- 提交后的 `qualification-binding-closeout-v1-wrapper.json` 在三分钟预检窗口内未达到 3.25 GiB 余量，17:29:52 UTC 终态为 `WRAPPER_FAILED / Insufficient spare memory; no child started.`，未生成 Node 守护或测试结果。最终 150 项轻量专项、文档链接与 Skill validator 均未执行，不能计为通过。`git diff --check` 通过。没有为测试降低 3/2 GiB 轻量或 6/2 GiB 重任务门槛。
- 初版 Rust 全部格式化和签名专项文件格式化正常退出。本机内存尚未达到大型编译/游戏测试启动余量，本批 Rust 编译、76 向量的 Rust 实际执行与新增真实签名场景仍待云端验证，不把格式通过当成编译通过。
- 本机守护 `qualification-binding-focused-v1-guard/guard.json` 为 `PROCESS_EXITED_NORMALLY / exit 0`，用时 9.5105085 秒，最低空闲 4,275,940 KiB，轻量任务采用 3 GiB 启动 / 2 GiB 停止。证据与源码哈希保存在 `artifacts/rust-rp1-loop/qualification-binding-focused-v1.json`。
- 未启动游戏、未安装本机证书；上一冻结包 `7419775d` 保持独立，未将新增 Host 源码宣称已进入该包。终局 v18 被守护中止、v19 未启动的既有缺口未改变。

上一 `0657dc0c` 的 [Windows run 34379306025](https://github.com/snowsnow0926/DSPONLINE/actions/runs/34379306025) / job `102559906724` 已完整 **SUCCESS**，对应 PR merge `cfd17641dacdff3444f86a6fe88d6b763f286354`。严格 Clippy、原签名生命周期、完整优化 Rust、Native 工具、Host 构建与游戏单元通过：核心 **1,115 pass / 5 ignored**，Host 库 **260 pass / 3 ignored**、主程序和助手各 **3 pass**，Native 工具 **766 pass / 1 skip**，游戏 **3,193 pass / 39 skip**，均零失败。诊断 artifact `10116644162`、Host artifact `10116646148` 已上传；尚未下载/逐项复核该 ZIP，不宣称与本机包是同一制品。

该提交 [CI run 34379306065](https://github.com/snowsnow0926/DSPONLINE/actions/runs/34379306065) 的 Linux 类型/单元、构建、Server/Ops/Native 成功；完整浏览器 **462 pass / 33 skip / 4 fail / 1 flaky**，发布门禁仍失败。失败是施工反馈、手机统计溢出、救援读档和冷菜单 p95（685/674 ms，原门槛 500 ms）；保存保护提示首轮失败、重试通过。上一候选的结果不证明新正文绑定代码或新签名场景通过，新源码云端终态另行记录。

## 剩余完整版本工作

继续完成终局进入/取消/持久读回/两次重开、复杂长离线、可信验证会话下实际 Rust 接管、全玩法与普通/竞速/内容兼容、独立 JS 全状态与守恒对照、端到端性能/全进程内存、长测及 Windows 安装升级回退/签名资格。局部绑定器不折算为完整版本百分比或实际玩家性能收益。
