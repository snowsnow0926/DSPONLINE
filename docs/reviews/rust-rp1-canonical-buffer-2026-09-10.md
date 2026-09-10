# Windows Rust：终局取消复验与完整校验缓冲

2026-09-10，Role: develop。来源为用户授权的完整 Windows Rust Goal。目标仍 active，玩家实时权威关闭，未发布。本批先复验冻结 `1dfbb57f5dc56cf057474d0cd4735aa977365199`，再开发 Rust canonical 哈希缓冲；两类证据分开绑定。

## 9e17b26a 最终验证与终局对照

本节为后来取得的终态，覆盖下方早先的“待验”描述。源码 `9e17b26a1dcca616815be4f6d9f5d53428a9a0db` 已提交、推送；正常 release 核心 **1,116 pass / 6 ignored / 0 fail**，另行 opt-in 对照 **1 pass**，Rust 2024 格式与严格 workspace/all-targets Clippy 通过。最终字节的公开合成微测中位 **133.402→113.963 ms，减少 14.6%**。完整核心守护正常 exit 0，1,003.6053391 秒，最低空闲 4,694,452 KiB。

重新构建的实际 Host/助手进程集成 **36 pass / 0 fail / 0 skip**，Host SHA-256 `ece575f11977396f8e9687a91045fda8e52a0ddbc0e16876f85c5fe2485443a5`；守护正常 exit 0，196.7237115 秒，最低空闲 6,996,312 KiB。启动器完整 Windows 检查 **16 pass / 0 fail / 0 skip**，包含实际六进程超时后全部结束及私有目录清理，原 8+30 秒和外层 100 秒未改；守护正常 exit 0，78.3739402 秒，最低空闲 7,293,088 KiB。这不证明旧云端失败的具体根因。

完整终局原档副本、固定 9 秒、同一恢复状态与两线程的实际 Host 测量，先各一轮排除的 warmup，再按 AB/BA/AB 六个独立进程样本执行：

| 变体 | 三个计入样本（ms） | 中位（ms） |
| --- | --- | --- |
| 1df 基线 | 49,443.8578 / 49,901.9073 / 50,127.4401 | 49,901.9073 |
| 9e 候选 | 50,900.7176 / 49,017.7771 / 48,718.3315 | 49,017.7771 |

中位少 **884.1302 ms（1.77%）**；样本区间重叠，首对候选更慢，不能宣称稳定或显著的整段提速。测量包含解析、证明、模拟与持久导出，不包含 Windows 菜单、返回工厂及后续保存重开，不是完整游戏或内存收益验收。

全部八轮导出 **208,891,374 bytes** 与前六项完整 JS 对照已通过的参考字节相同，SHA-256 `15c91fa1509ad6949d22a2db6a257890992c1dfb9b3bcd635bd8d1ec9c1cb934`；本轮没有另外重跑一遍独立 JS。完整候选摘要 `6cf99f1d4d8bb0f172448c1c2e790b7cf5acd2cf47de9a6bede3e28a5ee8f96b`，八个 Host 正常 exit 0，无信号；每次启动空闲至少 6 GiB，原档和干净源码保持不变，临时文件已清理。外部守护正常 exit 0、无停止原因，414.3846669 秒，最低空闲 6,259,208 KiB。证据：`native-canonical-buffer-private-ab-v1/report.json` 及对应 guard。

9e 云端已终态：Windows run `34401123960` / job `102632990386` 全部成功，正常优化核心 1,116/6 ignored、Host 库 263/4 ignored、主程序/助手各 3 通过，真实 TEST_ONLY 签名生命周期通过；Native 工具 **851 pass / 0 fail / 1 skip**，Windows 游戏 **3,201 pass / 39 skip / 0 fail**。CI run `34401123908` 的生产构建、Linux 类型/游戏 **3,198/42 skip**、Server/Ops/Native 均成功（Linux Native 工具 835/17 skip）。合并源码 `764ebbcbf5ef5a4cae8b96fa446ef90f77b28cda`，与新安装提供者提交分开记录。

浏览器分片 1 **241 pass / 11 skip / 2 fail / 0 flaky**：v103 星图草稿场景先卡在辅助函数硬编码的附带离线报告“1 秒”，实际为“2 秒”，尚未进入草稿断言；v120 暂停画布峰值帧间隔 850/833.2 ms 超过原 800 ms。分片 2 在 stable Chrome 原 30 秒启动预检失败，**零游戏测试执行**。此前指定 job 重试请求被 GitHub 以“整个 run 仍运行”拒绝，没有实际重跑；此时后续安装身份候选已就绪，改由新提交的完整 CI 验证，不再重跑后立即被新推送取消旧作业。9e 浏览器结果不完整，失败记录保留；1df 的历史完整结果如下。

## 新冻结包与真实终局流程

`package-1dfbb57f-frozen` 从干净源码构建，Build ID `1.2.7+1dfbb57f5dc5`，beta / `windows-performance-development-v1`。schema 2 的 76 项制品、79 个冻结文件一致；新编译的 Host/助手在实际进程集成 36 项通过后核对字节，再冻结入包。类型、桌面构建、启动预算、13 App / 12 组件界限与 Native 清单通过。

- Host SHA-256：`06139a4d9f0967f0a33b28764f28baaaa2f8b6aca2626de37ebdf0a9f581e397`。
- 助手 SHA-256：`5d2bdb4dc0e34908efd3b64f05036013f2b3c52582851014d2b933ec7c5075b6`。
- ASAR SHA-256：`1e325fe45dce5fc57e4aaad7ab694f143d8a641d89169955698a771464e96bbd`。
- 构建守护正常 exit 0、无停止原因，192.4411746 秒；最低空闲 5,433,860 KiB，6/2 GiB 门槛未变。

使用已授权的完整终局原档副本：110,042 实体、233,300 条带，107,637,967 bytes，原文件 SHA-256 `d64b5646f6117f3c089fba4dc95a95e84bedd9375f75b3c8c917b2e7cf473bc1`。只刷新隔离副本 envelope 的 savedAt，实际时钟未修改，不代表结算原档累计的长离线。

| 流程 | 实际结果 |
| --- | --- |
| 完成 v20 | 9 秒精确 Rust 候选约 46.211 秒；进入工厂、确认报告及打开设置约 90.515 秒。后续独立取证传输失败，完整保存/两次重开未通过 |
| 完成 v21 | 14 秒精确 Rust 候选约 67.575 秒；等待可操作工厂超过原 90 秒，失败；不延长门槛、不计整体入口通过 |
| 取消 v21 | **PASS**。10 秒精确候选约 53.947 秒；完整 JS 候选摘要相同，取消保留原主档且未生成 Native 主检查点，原档有效、两次正常重开保持原字节 |

取消 v21 的完整候选摘要为 `4d544ad61a32ec1ef8a9a5f0197ffb1a1b40f6a76d1dd82ebdffcfc5e1b31450`。四次实际启动均隐藏、静音、离屏且不可聚焦；显示、聚焦及对话框事件均为 0，四次正常关闭 exit 0。守护正常 exit 0、无停止原因，206.7719656 秒，最低空闲 4,219,012 KiB。所有终局原文件字节和哈希未变。

本机证据位于 `artifacts/rust-rp1-loop/package-1dfbb57f-receipt.json`、`private-packaged-complete-v20/`、`private-packaged-complete-v21/`、`private-packaged-cancel-v21/` 及对应守护目录。取消通过不替代成功结算后的持久保存、暂停读档和两次重进验收。

## 大存档取证传输

v20 独立读取失败并非已证明的游戏崩溃：当时实际 Electron 窗口仍存活、无 renderer crash，正常关闭 exit 0。Worker 与直接页面两种整档 POST 都使 Playwright 页面连接失效；仅 IndexedDB 元数据读取通过，因此不能把 Worker 认定为根因。

改为本机 nonce 地址上的顺序 4 MiB 分片后，reader v4 完整读回 110,821,048 bytes，SHA-256 `67a4f8dd5b1072187ff1c20cbeb049ba4790746a0d9a846f239b30bb09aa027b`；序号、单片/总大小、UTF-8、总字节数和完整 SHA 双端校验通过。守护正常 exit 0，7.3363025 秒，最低空闲 7,101,184 KiB。只改隔离诊断工具，不改玩家保存协议；底层整档传输失效的精确机制尚未确定。

## Rust 校验优化候选

历史终局诊断的首次 canonical proof 约 4.308 秒。当前候选给单流、双流及对象 canonical 写入增加固定 1 KiB 缓冲，合并细碎 SHA-256 更新；递归遍历顺序、数值/字符串编码、完整字段和摘要算法保持原逻辑，大片段直接传递，不缓存完整工厂。

新增独立字节 oracle 覆盖中文、表情、转义、零值/科学计数法、长记录及不同流前后缀。正常 release 专项 **5 pass / 1 opt-in ignored / 0 fail**；单独执行该 opt-in microbenchmark **1 pass**。六个交错样本中，公开合成记录的 10,000 次双流校验中位 **134.245→114.279 ms，减少 14.9%**，每轮两条摘要相同。该对照在同一程序内比较原 visitor 直写与缓冲写入，不代表实际 Host 或游戏提速。

`canonical-buffer-focused-v1` 守护正常 exit 0、无停止原因，861.5924846 秒，最低空闲 4,930,752 KiB；主要耗时是正常 release 核心及测试程序重新编译（14 分 17 秒）。6/2 GiB 门槛与低优先级不变。**完整 Rust 核心、严格 Clippy、实际 Host 和终局配对测量仍待终态，当前不授予新的游戏性能或实包通过结论。**

随后 `canonical-buffer-validation-v1` 在 Rust 2024 格式检查发现一处 benchmark 输出的换行格式，正常 exit 1，未进入完整核心。已仅修正该格式；`canonical-buffer-validation-v2` 从最终字节重新执行完整核心及 microbenchmark，仍在运行。不会用前一源文件的局部结果代替最终源码的完整验证。

## Windows 启动诊断候选

固定亲和性启动器新增五个固定 stderr 阶段：PowerShell 就绪、Job 类型编译、Job 已附加、即将派发工作负载、工作负载返回。失败报告只保留合法顺序前缀的最后一个固定标签；未知/倒序/重复标签拒绝，不持久化原始 stdout/stderr。阶段记录只用于诊断，不参与性能合格判断或认证。

六进程清理测试保留原 8+30 秒与外层 100 秒，缺少 PID 文件时现在附带上述受限诊断；测试进程优先级改为 BelowNormal。尚未证明该次云端冷启动的根因或已修复，实际 Windows 六进程复验仍待执行。

轻量 `canonical-metadata-v1` 的非 Windows 名称过滤整文件检查在工具层 60 秒截止前没有产出结果，保留失败，不能计为整文件通过。缩至新诊断用例的 `canonical-metadata-v2` **1 pass / 0 fail / 0 skip**，覆盖五组阶段/脱敏输入；语法、Skill、175 个有效链接及 whitespace 检查通过，无新增断链。3/2 GiB 守护正常 exit 0，3.215848 秒，最低空闲 6,025,388 KiB。旧项目现状中的一处历史断链单独记录。

这批候选先提交触发云端完整检查，本机完整核心、实际 Host 和终局配对继续串行执行。提交不等于验收或发布；新的代码与冻结 1df 基线分开记录。

## 1df 完整云端终态

- Windows run `34394194722` / merge `7a0f7221c57dca583635b7556d102958f67766e1`：严格检查、真实 TEST_ONLY 签名、正常优化 Rust 核心 1,115 pass / 5 ignored、Host 库 263 / 4 ignored、主程序及助手各 3 通过。Native 工具 **849 pass / 1 fail / 1 skip**，后续 Windows 游戏全量未运行。
- 失败为 `benchmark-native-core-fixed-affinity-ab.test.mjs:817`：超时、NO_RESULT 和私有 stage 清理断言通过，但六进程夹具的 PID 文件未出现。尚未证明启动失败的具体阶段，也不能称为进程树清理失败；原 8+30 秒与外层 100 秒保持。
- CI run `34394194786`：生产构建、Linux 类型/单元、Server/Ops/Native 成功；Linux 游戏 **3,198 pass / 42 skip**。浏览器分片合计 **465 pass / 33 skip / 4 fail / 1 flaky**，仍无完整发布资格。
- 浏览器失败：手动采矿向通电冶炼器供料；暂停画布进入静默超过原 800 ms；冷菜单 p95 930/945 ms 超过原 500 ms；缓存设置综合用例超时/模式属性未到位。无障碍一项重试通过，保留 flaky。不得借用 50b 的 Windows 游戏通过数。
- 分片 2 失败 ZIP `10121989142` 已下载，SHA-256 `75f442a877bc0a384cafb56b93a423d30625714f8d3e8aeae3727f523afa91ee`。冷菜单 trace 的 reload 约 446–567 ms，后续可见等待约 151–334 ms，未发现该测试读取大存档正文；这只是分阶段观察，不是已修复或完整根因。

完整目标仍包括终局完成、复杂长离线、可信生产者/时间/撤销与实际实时单所有者、普通/竞速及内容全玩法、存档与云兼容、全流程性能/内存、长测/硬件、签名安装升级回退。测试保持后台单个重任务、BelowNormal、6/2 GiB 守护；不关闭用户应用，不修改或上传玩家原档，不操作生产。

[完整目标](../rust/windows-full-development.md) · [易读进度](../RUST_WINDOWS_FULL_PROGRESS_2026-09-10.md)
