# Windows Rust：安装程序身份提供者

2026-09-10，Role: develop。对应完整 Windows Rust Goal 的 RP2。此前正文绑定要求调用方提供完整候选；本批先把程序身份的九个字段从实际安装资源独立取出。**不是完整候选提供者，不授予实时权威，未发布。**

## 实现与边界

`desktop/pack.cjs` 将该次构建的完整 Git SHA 与 Build ID 放入自己的 `app.asar/package.json`，正常和备用 builder 使用同一组参数；dirty 构建仍能用于已有开发打包，但新提供者拒绝其身份。现有制品校验器在这些字段出现时核对独立预期身份，历史包缺字段仍可检查。

`desktop/native-installed-program.cjs` 只能从所选安装目录自己的 ASAR 加载，支持 Windows x64 / 性能开发版 / beta / 干净构建。读取自己的包元数据与 `dist/version.json`，再计算实际 `native/dsp-native-host.exe` 和 ASAR 完整 SHA-256，输出 version/sourceSha/buildId/editionId/channel/platform/arch/hostSha256/asarSha256。不接 renderer IPC，不从待审资格正文、存档、报告或环境覆盖值反填身份。

读取拒绝非固定目录、链接及祖先重定向、安装文件多硬链接、缺失/空/越界文件、错版本/通道/平台及读取过程中检测到的替换。Host 上限 128 MiB，ASAR 256 MiB，元数据 64 KiB；哈希按 64 KiB 分块，每 1 MiB 向 main 事件循环让位，不把整个安装包读入内存。提供的是采集时安装文件事实，**不证明已经载入的代码连续性、发布者信任、Host 编译来源或对特权 OS 攻击者的防护，也不是可长期复用的运行租约**。

只读 `catalog-package-smoke.cjs` 已接入真实 ASAR 模块采集，核对父进程独立算出的身份；没有 BrowserWindow、游戏模拟或证书安装。`5901ddd8` 冻结包的首次实际执行拒绝，修复与重新冻结的验收继续进行。

## 已执行验证

后台串行专项 `installed-program-unit-v1`：安装身份、包证据、packer 和版别隔离合计 **50 pass / 0 fail / 1 skip**。唯一 skip 是本机无创建跨平台符号链接权限；Windows 目录联接负例通过。新身份提供者的正例是明确 TEST_ONLY 的 VM 文件系统，不能称为新实包通过。

负例覆盖开发目录、其他系统/架构、错 renderer、dirty/missing/source 换行、其他版别/通道、不同安装根、UNC/流路径、硬链接/祖先重定向、超长/空输入、两次读取之间替换；所有已打开描述符都关闭。包内源码字段不符独立候选时拒绝。守护正常 exit 0、无停止原因，6.1600316 秒，最低空闲 9,141,052 KiB，6/2 GiB 门槛未变；没有窗口启动。

## 首次实包发现的问题与修正

`5901ddd87dbbbd9a6cd606f836d5ce65b8285706` 正常构建并冻结，Build ID `1.2.7+5901ddd87dbb`；实际 Host/助手集成 36/36、类型、桌面构建及门禁通过，76 项制品/79 文件一致。Host 摘要保持 9e 的 `ece575f11977396f8e9687a91045fda8e52a0ddbc0e16876f85c5fe2485443a5`，新助手为 `2d373bdef5ac353b3b78eb6c1ca05337464f76a467dfb0d81bc5b145bbd62523`。构建守护正常 exit 0，113.9715016 秒，最低空闲 6,149,276 KiB。

实际 Electron 探针正常 exit 1，错误 `installed-program-rejected`，没有通过。只读诊断确认：Electron `fs.lstat(app.asar)` 返回虚拟目录、size 0；`original-fs` 返回真实普通文件、46,250,971 bytes。故原实现拒绝真实 ASAR 容器，而 VM 普通文件正例没有覆盖 Electron 这一语义。两次探针均正常结束、无强制终止、隔离 profile 已移除；保留首次失败和诊断记录。

新增对应回归在原实现上 **0 pass / 1 fail**。修正后只用 `original-fs` 读取容器、Host 和磁盘祖先，ASAR 成员仍用 Electron `fs`；不放宽普通文件/大小/链接/替换检查。完整同组回归 `installed-program-unit-v2` **51 pass / 0 fail / 1 原权限 skip**，守护正常 exit 0，6.2520042 秒，最低空闲 8,999,768 KiB。新源码尚待重新冻结后的实际 Electron 验收，不能拿 VM 修复通过代替。

## 还需接通

游戏内容、规则和验收矩阵的三个摘要尚无生产级安装提供者；Rust Host 也必须从自身程序位置独立核对。随后仍需 profile 路径绑定、可信时钟与签名撤销/防回退、生产者认证、验证会话准入、持久单写者交接和最终玩家资格。不能将本批九字段事实补上任意三个字符串就视为完整信任链。

原终局成功结算入口、复杂长离线、普通/竞速及内容完整玩法、全流程性能/内存、长测/硬件、签名安装升级回退继续保留。见[完整目标](../rust/windows-full-development.md)、[9e 实际性能测量](./rust-rp1-canonical-buffer-2026-09-10.md)。
