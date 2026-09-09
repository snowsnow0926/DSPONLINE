# Rust RP1 大存档校验成本与终局入口｜2026-09-09

Role: develop。承接[导出缓冲](./rust-rp1-export-buffer-2026-09-09.md)与[后台测试约束](./rust-rp1-background-testing-2026-09-09.md)。本轮减少保存文本校验的循环开销，保留全部校验、备份、快照和读回；同时补齐云端暴露的两项 Rust 解析参与测试前提。未发布，完整终局入口仍未通过。

## 实际入口仍有缺口

干净 `253214e4b772008aa40ea9cc33fc04dca30783b0` 已正常构建并冻结 Windows beta `1.2.7+253214e4b772`。Host SHA-256 为 `de3dc0edaa558f3c869ee2a1e8581261b869f41304c9d644292ec982094554fa`；75 件清单、78 件冻结文件逐件通过，NotSigned。构建守护 64.456 秒，最低 6,728,264 KiB，正常退出。

完整私人终局档的真实隐藏菜单 v7 收到固定 9 秒精确候选，RPC 47,460.943 ms、近似秒数为零；完整候选 canonical 与此前独立 JS 参考相同。但仍未在原 90 秒内进入工厂，`wait-for-active-factory` 超时，**成功结算的持久采用及重开未取得资格**。没有调整时钟或放宽该门槛，本次也没有重跑新包取消流程，不能继承 376 包的取消通过。

观察到约 84.990 秒创建快照 Worker、86.340 秒返回约 110.8 MB 结果，随后有约 2.793 秒主线程长任务。两次启动均隐藏、不可聚焦、静音且真正离屏绘制，显示、聚焦和原生对话框事件全部为零；两次正常关闭 0，无强制清理，原档大小、修改时间与 SHA-256 不变。守护 109.420 秒、最低 4,303,896 KiB，退出 1 对应原超时。证据为 `package-253214e4-receipt.json`、`private-packaged-complete-v7/` 及同名守护目录，均在开发 worktree 的 `artifacts/rust-rp1-loop/`。

## 为什么先优化校验

两次独立无头 Chrome 保存诊断均通过主档精确读回、旧档备份相同和自动快照完整状态相同。第二次 CPU 采样中，文本 checksum 在目录匹配和目录构建调用链分别约占 1,823/1,144 ms 主线程 CPU；单次约 107 MB 的 JSON.parse 为约 0.2 秒。采样只保留函数名、调用关系及时间，不含玩家正文；文件字段未成功归因，不能用它证明具体文件行位置。

`private-save-json-cost-v{1,2}/` 保留原结果：保存分别约 13.763/13.564 秒。这些带采样的运行不混入后面的性能配对。首轮新诊断因低于 6 GiB 未启动，资源恢复后才执行；没有降低门槛。生成诊断时曾误覆盖旧的忽略文件 v7 驱动，未执行覆盖后的内容；已根据原会话的可核对创建步骤，从未动过的 v8 逆向还原 v7，原报告/日志未改。新诊断使用独立名称，后续创建前检查路径。

## 当前改动与测量

`computeSavePayloadTextChecksum` 遇到连续四个 ASCII 字符时，按原顺序做四次 FNV-1a 更新，再前进四个字符；Unicode、代理对、无效代理替换、短尾部继续走原 UTF-8 编码规则。返回 checksum 和字节数不变，不增加整份编码缓冲区，不跳过任何调用或保存保护。

旧实现冻结 SHA-256 `4fd0870d1e78ccc2bb4719df03f1c8db8b4e0503bfd33e32e6c5662d7723dee6`，当前实现 SHA-256 `d5ec856e3fedd62e1cb14d84ee5dd7775b2933107c772bd49fc521de78791891`。完整 107,637,967-byte 原文的六次新旧函数输出均等于独立 TextEncoder/字节 FNV 参考。新增回归覆盖 ASCII 起止位置、短尾部、中文、emoji、无效和相邻代理；六文件专项 **42/0 skip/0 fail**。

单函数三对中位 362.453→259.597 ms，缩短约 28.4%；其中第三个新样本 469.433 ms 比配对旧样本慢，不能声称每次都快。独立密集 Unicode 样本中位 8.103→10.455 ms，存在约 2.35 ms 的反向变化。本次针对主要为 ASCII 的 JSON，不宣称所有文本都受益。原型的另一种循环布局曾测得更快，但未进入当前源码，不混用其数字。原文在全部检查后保持不变，证据 `payload-ascii-production-v2/report.json`。

随后使用同一完整原档、固定恢复参考时间、独立临时资料目录和真实保存时钟，在无头 Chrome 按旧→新、新→旧、旧→新顺序各保存一次。Vite 只替换一个校验模块来冻结旧实现，记录实际模块加载和源码摘要；主档、备份、快照、协调写入和所有验证都执行原路径。

| 配对 | 旧保存耗时 | 新保存耗时 |
| --- | ---: | ---: |
| 旧→新 | 13,588.600 ms | 13,145.900 ms |
| 新→旧 | 13,422.600 ms | 13,309.900 ms |
| 旧→新 | 13,444.000 ms | 13,066.400 ms |
| 中位 | **13,444.000 ms** | **13,145.900 ms** |

完整保存步骤的中位等待减少 **298.100 ms，约 2.2%**，不是 28.4%，也不是完整菜单收益。六次均逐份核对主档等于独立生成的预期信封、备份等于原始全文、一份自动快照状态与主档完全相同；原档不变、模块加载检查通过。每次正常关闭隔离浏览器；六个守护均退出 0，最低余量 4,120,964 KiB。证据 `private-save-ascii-v1-{1-baseline,2-candidate,3-candidate,4-baseline,5-baseline,6-candidate}/`，没有把不同真实保存时间的信封宣称为跨次字节相同。

## 云端终态与解析参与前提

253 的 [主 CI](https://github.com/snowsnow0926/DSPONLINE/actions/runs/34311716956) 已结束：Linux 单元 3,170/41 skip、生产构建、Server 390/2 skip + station 4/4、Ops 60/2 skip、Rust core 1,113/5 ignored + Host 248+3、Native 670/5 skip 均零失败。完整浏览器 **440 expected / 33 skipped / 11 unexpected / 4 flaky**，仍失败。两份原 JSON ZIP 按 GitHub SHA-256 校验通过，完整失败标题与重试保留于 `cloud-253-browser-audit-v1.json`，不能从相邻提交的失败数变化推算修复数量。

[Windows CI](https://github.com/snowsnow0926/DSPONLINE/actions/runs/34311716902) 完整核心 **1,112 pass / 1 fail / 5 ignored**；失败为 `construction_entity_parse_is_owned_by_injected_one_two_four_eight_worker_runtime`，配置 2、实际参与 1，原至少两线程断言失败。后续 Host 构建、Native 和游戏单元均跳过，不能报告该次完整 Windows 成功，也不是新堆损坏证据。

现将该解析专项及共用同一参与断言的完整证书目录专项接入已有 `for_test_with_indexed_worker_participation`：只在测试中建立第二个真实 worker 进入映射闭包的有界前提。原实际 worker mask、2 秒同步期限、至少两线程/配置上界断言和小输入串行检查保持，生产调度不变。此与[之前物流参与修复](./rust-rp1-worker-participation-2026-09-09.md)同类，但旧通过不能代替此次完整核心验证。

解析测试修复已提交 `f05e1301`：正常 release 完整核心 **1,113 pass / 5 ignored / 0 fail / 0 过滤**，原两项解析专项及同步边界均通过；fmt、严格 release workspace/all-targets Clippy 通过。证据 `certificate-participation-validate-v1.json` 及守护目录，正常优化编译约 8 分 48 秒、核心运行 152.46 秒，总守护 751.668 秒、最低 4,384,212 KiB、退出 0。本次没有重建 Host 或桌面包，不能继承旧制品资格。

当前类型检查、完整本机游戏单元 **3,173 pass / 39 skip / 0 fail**、Web 构建、startup/thin-UI/coverage 和平台检查通过。证据 `payload-ascii-full-v1.json`、`payload-ascii-full-unit-v1.json` 及守护目录；总守护 416.221 秒、最低 5,718,184 KiB、正常退出 0，实际单元约 370.224 秒。构建保留既有大块体积提示，原门禁没有调宽。

新源码完整云端、浏览器和新 Windows 实包仍待验。本轮后台策略专项另为 6/6，无窗口启动。所有重任务单个、BelowNormal，6 GiB 启动/2 GiB 停止；不关闭用户应用、不上传玩家档、不部署。完整目标仍需终局成功采用/保存/重开和回归收口，Rust 1–30 秒门槛及 JS 实时权威不变。

## 下一轮可测量的候选

对已有 `export-buffer-private-profile-v2/report.json` 的阶段标签与源码计时定义再核对：九步中的建设阶段累计 3,139.610 ms，电力/机器/矿机阶段 4,737.513 ms，传送带输入/输出阶段各 2,785.047/2,574.708 ms。均为既有带采样运行内的局部时间，不是新测量，也不能与包含它们的 23.840 秒模拟总时间重复相加。

`construction::run_centers` 取得 automation、jobs 和 quantumMaterialBuffer 的所有权后，仍通过 `as_object().cloned()` 复制对象；相邻作业路径也有同类操作。这是下一轮可做完整新旧状态与分段配对的候选，还未修改或测得收益，不能认定它解释了全部 3.140 秒。测试夹具中相似的 entities/belts 拷贝不混作生产热点。
