# Windows 验证会话身份：开发与验证记录

2026-09-10，Role: develop；完整 Windows Rust Goal active，未发布。用户授权完整 Windows Rust 开发；所有本机测试使用无头或零窗口入口、BelowNormal、重任务串行 6 GiB 启动/2 GiB 停止，未操作玩家原档或生产。

## 变更范围

新增 main 隔离目录准备器、固定公开 v47 夹具及生成漂移检查、Windows 目录/文件句柄 lease、实际 Host 与独立 main 助手的会话快照检查。身份绑定 session 根和 profile 的 Windows 文件 ID/卷序列号/创建时间，复制标记文件不能保持原目录身份。普通路径、其他夹具、硬链接、junction、重复/未知参数、权限字段和畸形响应均拒绝。精确边界见[合同](../rust/windows-validation-session-v1.md)。

没有修改 GameState/envelope、游戏玩法、WAL、现有 player authority 门禁或生产发布。只读快照结束就释放锁；持续 main/Host 租约、正文绑定、运行期云隔离及真实接管尚未接入，不能把本模块算作完整可信会话准入。

## 当前源码验证

最终 `validation-session-validate-v3/report.json` 为 PASS：正常 release workspace/all-targets 严格 Clippy、Host 284 pass/4 专用 ignored、助手/主入口各 3 pass、相关 Node 174/174、完整 Native 946 pass/1 Windows 权限 skip/0 fail（83.91 秒）、前端目录/摘要 7/7、全项目类型及两份生成物漂移检查通过。14 个运行源码/生成物/清单摘要前后一致。完整 Host 含新的空目录锁、双 lease、复制/替换、错误/硬链接/超限夹具，实际进程集成含 main 独立助手与 Host 相等、替换后两端同样变更、错误夹具/普通路径/额外参数/junction 拒绝。

守护正常 exit 0、无停止原因，428.84 秒，最低空闲内存 7,387,912 KiB；保持原 6/2 GiB 与既有用例时限。本批没有执行完整核心/游戏/浏览器套件；新 Native suite 内既有实际 Host 回归正常执行，不把旧核心或旧离线包记为本批重测。

当前正常优化 Host SHA-256 `355fd736a3eccfcdb8647387cc7c0fb0ebfe395f8b4b92beeceff16e137be181`；助手 `d263df8a261476fd24670df395c7028969bd6c2c06ba3a94f13c00a840b76071`。公开夹具 90,763 字节，SHA-256 `1c370c309f2f9a4f7e57f6bd69579be2b9483db40c01619d018456fb3385f970`。

## 同源冻结包与实际进程

运行源码 **491201da119f089fd69da5a7da69e72bc2d7ea69**，包 **1.2.7+491201da119f**，performance development/beta/win32 x64，主程序实际 Authenticode 状态 **NotSigned**。本批未发布或签发资格。

`build-desktop-validation-session-v1` 从干净提交重新构建，验证原生文件与 v3 测试字节一致；130/130 打包前检查、类型/Vite/启动预算/thin UI/覆盖清单/平台/pack 共九个步骤全部成功，原始 stdout/stderr、退出码、时长和摘要均保留。冻结清单 76 制品/79 文件逐一相同，旧 0d7 冻结 79 文件前后核对未变。守护正常 exit 0、125.26 秒、最低空闲 7,329,932 KiB，6/2 GiB 门槛。

`package-validation-session-smoke-v1.json` 为 PASS：实际 Electron 的零窗口启动器加载新冻结 ASAR 内模块，main/独立 Host/父进程十二字段候选一致；main 从本包嵌入摘要固定独立助手，双方对新测试目录的 profileId、夹具 SHA 和范围相同。替换 profile 后，独立双方再次一致，但与旧 profileId 不同；profile 未生成存档。实际助手继续拒绝缺失资格 carrier。

探针正常 exit 0、无强制终止，2.39 秒、最低空闲 9,893,224 KiB。`hidden-no-focus-offscreen-v2` 审计为 0 BrowserWindow/show/focus/dialog，0 paint 符合零窗口入口；测试 session 及 Electron profile 均已清理，冻结文件前后未变。只读快照不等于持续租约，未执行新的游戏启动、实时接管或长离线性能测试。

ASAR SHA-256：`7aa305a59916e105020dda07566c04574e2cf950734906d735528b3574b74cdc`。本地证据位于 `artifacts/rust-rp1-loop/package-491201da-frozen/`、`package-491201da-receipt.json`、`validation-session-validate-v3/`、`build-desktop-validation-session-v1-logs/` 和 `package-validation-session-smoke-v1.json`；原始玩家档未作为本批输入。

## 云端范围与剩余工作

上一 e497 源码的 CI run 34427386234 已结束：构建成功；Linux 游戏 3,217 pass/42 skip，服务端 390/2、station 4/0、Ops 60/2、核心 1,118/6、Linux Host 267/1、两个入口各 3、Native 913/19，均无失败。完整浏览器合计 **466 pass/33 skip/3 fail/1 flaky**，原门槛不变：

- 第二组 job 102715465309：226 pass/22 skip/1 fail，23.7 分钟。v144 冷菜单 774/761 ms 超过原 ≤500；v32 字号布局本轮 25.7 秒通过。
- 第一组 job 102715465545：240 pass/11 skip/2 fail/1 flaky，36.5 分钟。v120 暂停画布峰值 866.6/883.3 ms 超过原 <800；v103 星图草稿用例在启动辅助检查中，离线报告预期 1 秒、两次实际 2 秒，尚未定位，不能据此宣称物资结算错误。v101 精确值 tooltip/经典进度的点击首次耗尽原 30 秒，重试通过，计为 flaky。

e497 的 Windows run 34427386233/job 102715423163 已全部 SUCCESS：核心 1,118/6 ignored、Host 278/4 ignored、两个入口各 3、Native 931/1 skip、游戏 3,220/39 skip；严格检查、TEST_ONLY 真实签名步骤、八项基础采集及制品保存均成功。以上两个旧源码流水线均已收齐后才推送本批，未中途取消；没有将 e497 测试当作 491 本批云端结果。旧 68 记录的 v32 失败和本轮通过分开保留，新结果不自动抹除不稳定风险。

最终五份验收/进度文档仅补充已完成结果；运行源码与 491 冻结包保持一致。文档 Skill、链接及 whitespace 单独检查，不因此重复整个运行矩阵。

后续需持续 main/Host 句柄租约、运行期 profile/云网络隔离、正文与可信时间/撤销/生产者上下文、完整矩阵及实际单写者交接；复杂终局长离线、更多瞬态、完整玩法/模式/内容、保存兼容、性能/内存/长测、硬件与签名安装回退仍在完整 Goal 内。未提高时限、减少旧测试负载或通过开关绕过玩家门禁。

## 保留的失败与修复

初轮 `validation-session-validate-v1` 在夹具漂移检查失败，尚未进入 Node/Rust 回归。对两次生成结果逐字段核对，差异仅为轨道合同墙钟确认时间及对应校验和；生成器已显式固定该字段，不修改游戏初始化器。失败日志、首次夹具摘要及差分保留于本地 artifacts。其间一次差分驱动因相对 import 路径多退一级而退出，修复驱动后取得上述差分；未掩盖为产品通过。

第二轮 `validation-session-validate-v2` 已通过 174 项 Node 检查和严格 Clippy，但 Host 库为 282 通过/1 失败/4 ignored：只有目录属性访问权限的句柄未阻止空 profile 被重命名。此前目录替换测试同时持有子文件，漏掉了首次打开成员之前及空目录的情况。共享 `lock_directories` 已增加实际目录读取权限 `FILE_LIST_DIRECTORY`，仍保持不共享写/删除，并新增空目录专项；影响 catalog 验证、安装身份及新会话，须重跑完整 Host/Native 与实际进程验证。第二轮未进入后续构建/Native，不记为通过。
