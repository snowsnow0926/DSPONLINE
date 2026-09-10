# Windows Rust 运行生命周期终止修复

2026-09-10，Role: develop。完整 Windows Rust Goal active；独立开发分支，不操作生产或玩家原档。测试后台、静音、无窗口，BelowNormal，重任务串行 6 GiB 启动/2 GiB 停止，轻量 3/2。

## 问题与修复

原 main runtime 在 prepare/activate 等待期间退出后，晚到的成功回复仍可把 phase 改回 active 并启动计时器；排在 Promise microtask 中的命令也可能在退出之后才发送给 Host。三个新负例在未改产品上全部失败，分别为两次“本应拒绝却成功”和一次“预期零次发送，实际一次”，见本地 `artifacts/rust-rp1-loop/runtime-lifetime-red-v1.*`。

现在 shutdown 是不可被旧 transition 覆盖的终态；每个 registry 操作在真正发送时再次检查终止标记，覆盖准备/激活、恢复、tick、命令与各专用意图、历史、暂停/恢复、宏观推进/结束。准备、激活、恢复和历史回复在更新本地状态前也检查；不再接受迟到结果作为旧进程的成功。已发送给 Rust 的操作仍由原持久账本恢复，不撤销或装回旧 JS 镜像。

持续会话 broker 新增从真实 token 取得的 AbortSignal；失联或关闭立即 abort，不等终止确认的 2 秒期限。正常释放也先结束依赖生命周期，且先阻止新 probe，避免同步 abort 回调重入挤占 release。main runtime 可接收该 stop-only signal，立即使用既有进程退出路径取消计时器并拒绝后续工作。signal 不授予覆盖率、资格、所有权或恢复许可；普通 main 启动尚未创建正式验证会话，完整准入仍待接入。

## 验证范围

专项 90/90 通过；扩展 main/broker/交接/保存/恢复相关 202/202。完整 Native 981 pass/1 Windows 权限 skip/0 fail。真实助手正常释放、被终止均能停止实际 main runtime 类并保留最后确认 checkpoint；这些联动用例的 registry 回复明确为 TEST_ONLY，未发送 Native 玩法操作，不能当作真实 Rust 活跃模拟通过。

新增检查覆盖终止前未发送与终止时已经发送的区别、晚到激活/恢复/历史回复、暂停/宏观/历史/恢复 microtask、已失效信号、覆盖率仍拒绝，以及重入释放。旧“已发送命令退出”用例显式等到原发送 microtask 执行，再终止；保留一次真实调用的断言，另一个新用例要求发送前终止必须零调用，未减少工作或放宽门槛。

Rust/core/前端游戏源码未改；正常重建 Host 和助手与 5c801a83 验证字节相同，历史 Rust/严格 Clippy 证据仅因源码与二进制精确未变而保留。本批新客户端重新执行完整 Native、类型和格式，不声称新跑核心/游戏全套。最终类型/whitespace 通过，5 份运行源码前后哈希一致；守护正常 exit 0，127.92 秒、最低空闲 6,255,536 KiB，未触发 2 GiB 停止。冻结包和实际模块验证见下节。

## 交付与未完成项

运行源码 **891e87fa2d9a5987e3129d7ff9b327c491f5d0b6** 已提交；冻结包 **1.2.7+891e87fa2d9a**，performance development/beta/win32 x64，实际签名 **NotSigned**。227/227 打包前检查和九阶段构建通过，76 制品/79 文件逐项一致，旧 5c801a83 冻结文件未变。构建守护正常 exit 0，159.10 秒、最低空闲 7,508,876 KiB。

实际 Electron 从新 ASAR 加载 broker 和 NativePlayerAuthorityRuntime，持续 17 秒自动续期、独立 Host 会话相同、双释放与替换后重新接入均通过；broker 释放信号能把包内真实 runtime 从 idle 终止，之后 activate 被拒绝且 registry 派发为零。该探针刻意没有伪造包内活跃资格；这是包内 idle 停止连接，不是实际 Rust 活跃模拟。

探针正常 exit 0、无强制清理，20.35 秒、最低空闲 9,223,912 KiB；hidden-no-focus-offscreen-v2 为零窗口/show/focus/dialog。临时 session 与 Electron profile 已清理，冻结文件未变。包内 Host/助手仍为 5c801a83 原字节，ASAR SHA-256：`62951ad9976baf48071838baa1cd9e7e2765f363d650d58a38193ae097a0c548`。

证据：`artifacts/rust-rp1-loop/runtime-lifetime-validate-v1/`、`package-891e87fa-frozen/`、`package-891e87fa-receipt.json`、`build-desktop-runtime-lifetime-v1-logs/`、`package-runtime-lifetime-smoke-v1.json`。上一 4f3f9280 的 Windows/浏览器/服务 Native 云端任务仍确认运行，单元与构建成功。本批源码和记录已推送 GitHub 暂存开发分支 `codex/rust-runtime-lifetime`；PR 31 的 `codex/rust-rp1-after-1.2.7` 暂保持 4f3f9280，避免取消旧检查，待终态收齐后再快进同步。本批新源码尚未执行云端完整矩阵；暂存分支没有另建 PR，不把进行中或旧包计为当前通过。

完整目标仍包括真正 Rust 单写者准入、可信资格/时间/撤销/证据来源与完整矩阵、云网络和 profile 隔离、复杂终局长离线及更多瞬态、完整玩法/模式/内容包、数据往返和异常恢复，以及性能/内存、30 分钟/24 小时、硬件/签名/安装升级回退。当前修复不能替代这些验收，也不构成发布许可。

## 浏览器原例本机对照

在 891e87fa 运行源码上，显式 headless/mute、单 worker、零重试执行原冷菜单与字号矩阵两例，2/2 通过。保留原 29.7/59.4 MiB 两组各五次、全部断言及原 500 ms/30 秒门槛：冷菜单 P95 257 ms，字号整例 14,890 ms。没有改 UI、减少字号/客户端模式或提高时限；实际 trace 保留在 `artifacts/rust-rp1-loop/lifetime-browser-baseline-v1/`。

该次本机对照正常 exit 0，40.995 秒，最低空闲 6,705,056 KiB。仅访问临时本地服务，代理固定为本地不可用端口。结果说明本机未复现云端慢例，不能据此宣称云端故障修复；后续应对照云端 trace/CPU 与加载阶段定位差异。
