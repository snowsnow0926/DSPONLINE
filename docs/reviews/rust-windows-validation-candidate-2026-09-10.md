# Windows Rust 十二字段候选身份｜2026-09-10

Role: develop。完整 Windows Rust Goal 的实时接管前置增量。沿用 Electron/React 界面、已有 Host 和签名边界，未变更 GameState、存档/云格式、游戏规则或玩家准入。

## 实现

此前已经独立取得程序九字段和内置目录，但正文中的规则/矩阵摘要还依赖调用者提供。本批明确[规则和矩阵身份合同](../rust/windows-validation-candidate-v1.md)，增加 main/Host 无外部参数的完整候选提供者及实际只读 Host 入口。资格正文的既有十二字段形状保持不变。

规则摘要保守绑定实际 Host、ASAR 与内置目录；固定矩阵把已有十二项 TEST_ONLY 开发证据检查、报告类型及零失败/跳过/flaky 要求绑定成独立摘要。两端分别解析矩阵，实际证据检查器核对固定名单，构建/打包也验证。不得把这个基础矩阵误认为完整生产资格或运行授权。

实包探针新增实际主进程、独立 Host 和父进程的完整候选比较。它仍不创建 BrowserWindow、存档或模拟，也不运行玩家实时会话。

## 本批验证

`artifacts/rust-rp1-loop/validation-candidate-validate-v1/report.json` 为 PASS。160 项相关 Node 检查、正常 release workspace/all-targets 严格 Clippy、Host **278 passed/4 ignored**（43.54 秒，编译另计）、助手/主入口各 **3/3**、正常构建、完整 Native **930 passed/1 Windows 符号链接权限 skip/0 failed**（82.64 秒）、前端目录与摘要 **7/7**、类型与目录漂移验证全部通过。

实际 Host 在隔离安装夹具内独立生成十二字段，与 Node 独立计算一致；额外路径参数拒绝，伪造 cwd 矩阵不影响结果，未创建 SaveStore 或模拟。夹具是公开合成安装元数据，实际冻结应用内验证另列，不能互相代替。

验证前后 12 项源码/生成文件摘要一致。正常 release Host SHA-256 `adb20ed537e55eedd7756166e205db3c8c319a9cd49bb23acbc9ab1410ce8cf8`，助手 `873953fd1bb39a870b8b6f81fdc07d0cf9e732b40a0bb175bf0aefc015917db7`。守护正常 exit 0、无停止原因，401.93 秒，最低可用内存 7,981,652 KiB；6 GiB 启动/2 GiB 停止、BelowNormal 串行。完整核心/游戏/浏览器矩阵未在本批重跑，未改变对应规则或门槛，不将上一批结果作为当前重测。

初版源码 `7cb5dc923fbea5608776b8f4f6247edeb80e9fc4` 已构建冻结，114 项打包前检查通过，构建守护正常退出，121.66 秒；每条命令的 stdout/stderr、结果与摘要已保存，避免上一批只保留命令回执的日志缺口。

但初版 `package-validation-candidate-smoke-v1` **FAILED**：完整候选提供者误用外层 Electron 启动器的 `process.resourcesPath`，从冻结 ASAR 加载时触发 `installed-program-rejected`。这是身份探针的实际失败，不标作通过；子进程正常 exit 1、无强制清理、profile 已清理，守护无停止原因，2.42 秒。7cb 冻结包及失败日志保留。

修复将安装位置从候选模块自身所在 ASAR 推导，再交给同包程序提供者做原有独立路径/文件检查；不接收外部路径、不覆盖进程资源属性、不放宽验签或资格。新增异目录启动器单测；最终 `validation-candidate-validate-v2` **PASS**：161 项相关检查、完整 Native **931 passed/1 skip/0 failed**（82.54 秒）、前端目录/摘要 **7/7**、类型、格式和目录漂移通过。12 项源码摘要前后一致。Rust 源码及 Host/助手实际二进制与 v1 完全相同，因此 Rust 全套及 Clippy 使用同批 v1 的对应证据，没有声称重新执行。守护正常 exit 0、无停止原因，131.68 秒、最低可用内存 8,384,360 KiB。修复后另建新包验证，不改写 7cb 包。

## 最终冻结应用验证

最终运行源码 **0d7e1e01aba0aea29694fbc663e38c70c866b1a2**；从干净源码构建 **1.2.7+0d7e1e01aba0**，performance development / beta / win32 x64，EXE **NotSigned**，未公开发布。`package-0d7e1e01-receipt.json` 为 BUILD_AND_FREEZE_PASS，76 项制品/79 文件一致；9 个构建步骤全部通过并保留 stdout/stderr、结果、耗时和摘要，打包前实际进程/身份检查 **115/115**。Host 与助手字节和上述 v1/v2 相同。构建守护正常 exit 0、122.10 秒，最低可用内存 8,116,184 KiB；原 7cb 冻结文件逐个核对未变。

`package-validation-candidate-smoke-v2.json` 为 **PASS**。实际 Electron 加载冻结 ASAR 的 main 模块；main、独立 Host 和父进程十二字段逐项相同。两端返回 authorityEligible/releaseAllowed=false；实际助手仍拒绝缺失 carrier。记录 **0 BrowserWindow、0 show、0 focus、0 系统弹窗**，正常 exit 0、无强制清理，profile 已清理，冻结文件前后不变。守护 2.49 秒，最低可用内存 8,535,352 KiB，仍按 6/2 GiB 门槛、BelowNormal 运行。

| 身份字段 | 最终值 |
| --- | --- |
| ASAR SHA-256 | `801b4a20b1fa4f237f859bc113c548c85dddbe095f80a433bff699d1461d21e1` |
| 内置目录 canonical SHA-256 | `3cc51a3f95dba83113d57a40e1ad367a4c695d71e72958af451342e3c0e038a8` |
| 规则实现 SHA-256 | `b6cb8ab897fae4f80fd4ed1099082f57616f8a5e9b36e7daf1d7da9da080dfa4` |
| 基础矩阵 canonical SHA-256 | `66cc2a9445a3a30809826589b5d5b9c0ca89aac0f273f28f0fd7a64bd117c96f` |

这是实际包内身份提供者的验证，不是玩家实时运算接管、完整玩法回归、生产资格签发或新增性能收益。第一次失败没有放宽原门槛；源码修复、重新完整 Native 回归及另建新包的过程均保留。

## 剩余工作

独立候选字段齐全之后，仍需补 profile/夹具绑定、可信时间与撤销防回退、生产者认证、完整验收矩阵、验证会话准入和实际单所有者交接。旧终局长离线、浏览器失败、性能/内存、30 分钟/24 小时长测及安装升级回退仍按[完整目标](../rust/windows-full-development.md)推进，不削减完成条件。
