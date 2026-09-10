# Windows 验证会话身份：开发与验证记录

2026-09-10，Role: develop；完整 Windows Rust Goal active，未发布。用户授权完整 Windows Rust 开发；所有本机测试使用无头或零窗口入口、BelowNormal、重任务串行 6 GiB 启动/2 GiB 停止，未操作玩家原档或生产。

## 变更范围

新增 main 隔离目录准备器、固定公开 v47 夹具及生成漂移检查、Windows 目录/文件句柄 lease、实际 Host 与独立 main 助手的会话快照检查。身份绑定 session 根和 profile 的 Windows 文件 ID/卷序列号/创建时间，复制标记文件不能保持原目录身份。普通路径、其他夹具、硬链接、junction、重复/未知参数、权限字段和畸形响应均拒绝。精确边界见[合同](../rust/windows-validation-session-v1.md)。

没有修改 GameState/envelope、游戏玩法、WAL、现有 player authority 门禁或生产发布。只读快照结束就释放锁；持续 main/Host 租约、正文绑定、运行期云隔离及真实接管尚未接入，不能把本模块算作完整可信会话准入。

## 当前源码验证

最终 `validation-session-validate-v3/report.json` 为 PASS：正常 release workspace/all-targets 严格 Clippy、Host 284 pass/4 专用 ignored、助手/主入口各 3 pass、相关 Node 174/174、完整 Native 946 pass/1 Windows 权限 skip/0 fail（83.91 秒）、前端目录/摘要 7/7、全项目类型及两份生成物漂移检查通过。14 个运行源码/生成物/清单摘要前后一致。完整 Host 含新的空目录锁、双 lease、复制/替换、错误/硬链接/超限夹具，实际进程集成含 main 独立助手与 Host 相等、替换后两端同样变更、错误夹具/普通路径/额外参数/junction 拒绝。

守护正常 exit 0、无停止原因，428.84 秒，最低空闲内存 7,387,912 KiB；保持原 6/2 GiB 与既有用例时限。本批没有执行完整核心/游戏/浏览器套件；新 Native suite 内既有实际 Host 回归正常执行，不把旧核心或旧离线包记为本批重测。

当前正常优化 Host SHA-256 `355fd736a3eccfcdb8647387cc7c0fb0ebfe395f8b4b92beeceff16e137be181`；助手 `d263df8a261476fd24670df395c7028969bd6c2c06ba3a94f13c00a840b76071`。公开夹具 90,763 字节，SHA-256 `1c370c309f2f9a4f7e57f6bd69579be2b9483db40c01619d018456fb3385f970`。冻结包及独立云端状态在后续同批验收记录补充；源码通过不等于实包通过。

## 保留的失败与修复

初轮 `validation-session-validate-v1` 在夹具漂移检查失败，尚未进入 Node/Rust 回归。对两次生成结果逐字段核对，差异仅为轨道合同墙钟确认时间及对应校验和；生成器已显式固定该字段，不修改游戏初始化器。失败日志、首次夹具摘要及差分保留于本地 artifacts。其间一次差分驱动因相对 import 路径多退一级而退出，修复驱动后取得上述差分；未掩盖为产品通过。

第二轮 `validation-session-validate-v2` 已通过 174 项 Node 检查和严格 Clippy，但 Host 库为 282 通过/1 失败/4 ignored：只有目录属性访问权限的句柄未阻止空 profile 被重命名。此前目录替换测试同时持有子文件，漏掉了首次打开成员之前及空目录的情况。共享 `lock_directories` 已增加实际目录读取权限 `FILE_LIST_DIRECTORY`，仍保持不共享写/删除，并新增空目录专项；影响 catalog 验证、安装身份及新会话，须重跑完整 Host/Native 与实际进程验证。第二轮未进入后续构建/Native，不记为通过。
