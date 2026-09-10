# Rust RP1：合并兼容存档导出的磁盘写入｜2026-09-09

Role: develop。继续处理完整终局档返回候选和进入游戏的等待。所有本机任务低优先级串行、6 GiB 启动/2 GiB 停止，未启动桌面游戏；未发布或修改玩家原档。

## 定位和实现

旧 37630d05 实包中，终局 9 秒 `corePrepareOfflineSourceExport` 约 50 秒。检查发现 `write_v47_envelope()` 把实体、传送带和 JSON 分隔符逐片交给 `ExactLengthWriter`，后者直接调用 `File.write()`。这些细小写入没有文件缓冲。

现在 `publish_export()` 使用固定 64 KiB `BufWriter` 合并写入。精确长度限制在缓冲外层，每个片段仍先通过剩余长度检查；回调结束后先核对总长度，再显式 flush 缓冲、`File.sync_all()`、原子 rename 和目录同步。预检、磁盘预算、完整字节数/哈希比较、临时文件清理、重名/目录联接保护保留。

此处只优化临时兼容导出的 I/O，不改变 Rust 产量算法、存档格式、检查点/WAL、离线预算或采用范围。新增内存固定为 64 KiB，不把它写成峰值内存改善。

先前无窗口 JS CPU 采样也已保留：原始完整终局状态的 canonical/domain proof 分别约 1,556/922 ms，采样仅用于定位；本轮未修改 JS proof。证据 `private-proof-profile-v1/`，原档 SHA 与 mtime 不变。

## 本机验证

- 正常 release Host：**252 library + 3 binary = 255 pass / 0 skip / 0 fail**；新增的跨缓冲边界且不显式 flush 的完整读回、过长拒绝、回调失败保留旧导出三项通过。原低磁盘空间/短输出/目录保护案例也在完整 Host 套件中执行。
- 同一新 Host 的五个相关 Native Node 文件 **89 pass / 0 skip / 0 fail**，包含真实 Host 公开来源完整候选及传输/清理；无 Electron 启动。守护 51.192 秒，最低 7,314,360 KiB，6/2 GiB、正常退出 0；日志 `export-buffer-native-v1-guard/`、结果 `export-buffer-native-v1.json`。该专项不是全部 Native 工具或实际桌面入口验收。
- `cargo fmt --all --check`、正常 release workspace/all-targets Clippy `-D warnings`、Host build 通过。未改变编译优化条件；`CARGO_BUILD_JOBS=1`，没有 RUSTFLAGS override。
- 验证与构建守护 251.225 秒，最低可用 6,061,076 KiB，正常退出 0。未重跑未改动的核心完整套件，也尚未取得新桌面包资格。
- 写入源码 SHA-256：`b3788ec275547d8dab2feb35eb306dd286032c28b2759727ed3919f5c889a7b9`；新 Host：`de3dc0edaa558f3c869ee2a1e8581261b869f41304c9d644292ec982094554fa`。旧冻结 Host `6bea5576baac9fe52a6529a4d6e5417d9617f4c776a5e93af821fa4f3afe21f5` 保持不变。

命令与日志位于开发 worktree 的 `artifacts/rust-rp1-loop/validate-export-buffer-v1.mjs`、`export-buffer-validate-v1.json` 和 `export-buffer-validate-v1-guard/`。

## 真实存档对照状态

新旧 Host 的三对 9 秒完整终局请求 **全部通过**。使用同一恢复后的 110,042 实体/233,300 条传送带来源，固定原 savedAt 加 9 秒；每次独立进程，全部字段与完整 JS 参考相同，原文件/来源不变，六次正常关闭 0，无强制清理。测量只覆盖 RPC 内的解析、完整证明、模拟及同步导出，不含实际菜单等待，不能代替成功结算后进入游戏和重开的验证。

| 配对顺序 | 旧 Host RPC | 新 Host RPC |
| --- | ---: | ---: |
| 旧→新 | 54,822.585 ms | 53,161.061 ms |
| 新→旧 | 53,994.741 ms | 52,495.437 ms |
| 旧→新 | 54,257.905 ms | 52,280.979 ms |
| 中位数 | **54,257.905 ms** | **52,495.437 ms** |

同机三对中位缩短约 **3.2%（1.76 秒）**，有小幅收益，但剩余请求成本仍约 52 秒。六份完整导出各 208,891,374 bytes，SHA-256 均为 `15c91fa1509ad6949d22a2db6a257890992c1dfb9b3bcd635bd8d1ec9c1cb934`；候选与独立 JS canonical 均为 `6cf99f1d4d8bb0f172448c1c2e790b7cf5acd2cf47de9a6bede3e28a5ee8f96b`。`export-buffer-private-v4/report.json` 和守护记录 457.821 秒、最低 5,471,028 KiB；每次 Host 启动余量均超过 6 GiB，运行停止线为 2 GiB。

首版驱动在送入 Host 前把流产生的 ArrayBuffer 直接交给 Node 文件写入 API，发生 TypeError；未启动 Host、原档不变、临时目录清理通过，日志保留。第二版按该生产流的实际类型包装为 Uint8Array；游戏代码、比较断言和时限不变。证据 `export-buffer-private-v{1,2}/`、对应守护目录和 `probe-export-buffer-private-v{1,2}.mjs`。

v2/v3 已算出相同完整 JS 参考 hash，但参考结果与源状态并存使首个 Host 的 6 GiB 预检失败；v3 主动 GC 后仍不足，均未启动 Host。v4 改为先把已验证来源写到私有临时目录并释放大状态，再完成六个 Host，最后单独计算 JS 和逐字段比较；保留同一 6/2 GiB 门槛和 600 秒守护，不把未执行的 Host 记作通过。原失败记录完整保留。

## 剩余成本的分段诊断

另一次单独打开现有 Rust 诊断开关的请求通过，完整导出字节与上述六份相同，原档/来源不变、正常关闭 0。只采集固定阶段名称和数值，共 586 条，无玩家内容或新增生产日志。该次 RPC 为 52,131.296 ms，不混入三对无采样性能中位数。

| 现有阶段 | 该次耗时 | 范围 |
| --- | ---: | --- |
| `CoreState::from_records` 建立与校验 | 10,916.433 ms | 含准入 4,078.670 ms、canonical proof 4,308.191 ms，两者不另行相加 |
| `advance-simulate` | 23,839.832 ms | 含实际九步模拟 22,748.835 ms |
| `advance-commit-state` | 289.327 ms | 模拟结果安装，不能代表最终主档保存 |

现有指标没有覆盖完整 RPC 的所有阶段，不能把余下时间统一算成磁盘开销。下一轮优先分析精确模拟及状态证明的重复工作，再验成功结算的实际菜单、持久采用和重进；不减少模拟秒数或关闭完整校验。

诊断 v1 错把进程诊断开关放入 renderer 可配置的 `spawnEnvironment`，构造器按现有白名单拒绝，未启动 Host，原档不变；错误摘要已与该固定 TypeError 核对。v2 改在隔离诊断进程设置现有环境开关，经 Host 原有继承环境读取，生产白名单没有扩大。证据 `profile-export-buffer-private-v{1,2}.mjs` 和 `export-buffer-private-profile-v{1,2}/`；v2 守护 66.892 秒，最低 6,593,768 KiB，沿用 6/2 GiB、正常退出 0。

## 云端和后台边界

上一轮 f427 已收齐：云端生产构建、Linux 单元 **3,170/41 skip/0 fail**、Server **390/2 skip + station 4/4**、Ops **60/2 skip**、Linux Rust **1,113 core/5 ignored + 245+3 Host**、Native **670/5 skip** 均通过；独立 Windows 正常 release Rust **1,365/5 ignored**、Native **674/1 skip**、完整游戏单元 **3,172/39 skip** 均零失败。完整浏览器为 **445 expected / 33 skip / 7 unexpected / 3 flaky**，仍失败。这不覆盖当前 Rust 写入改动。[此前终局入口缺口](./rust-rp1-private-cancel-2026-09-09.md)仍有效，目标继续进行。

复核时没有本任务的遗留游戏进程；其他项目的 Electron 程序未操作。本轮只启动无窗口 Node 和控制台 Host，游戏窗口启动数为零；本机测试一次一个重任务、低优先级、内存守护，玩家原档不变。需要可见界面的旧驱动保持停用，实际桌面复验只允许使用已验证的不显示、不聚焦、静音离屏入口。
