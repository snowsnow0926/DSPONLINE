# Windows 全面性能开发候选 E18/E1a 开发与实测报告

> 报告日期：2026-08-28
> 角色：Develop
> 工作树：`D:\GameDev\DSPidle2-windows-full-native`
> 分支：`codex/windows-full-native-next`
> 产品版本：1.2.3 Windows 性能开发候选
> 状态：未签名、未部署、未连接生产，`authorityEligible=false`
> 最终 clean 制品：`FINAL_CLEAN_PACKAGE_PENDING`

## 1. 结论

E18/E1a 已完成本机能以严格哈希差分闭合的原生热路、确定性多线程、增量存档和单写者安全边界。在同一份 76.9 MB 只读真实存档上，冻结公开 1.2.3 Host 到 E18 的三轮交错、单步 exact A/B 显示：

- 打开耗时中位数从 `9,896.45 ms` 降到 `7,521.43 ms`，降低 `24.00%`；
- 打开峰值从 `2,802,446,336 B` 降到 `1,812,520,960 B`，降低 `35.3236%`；
- 一秒原生精确推进从 `2,631.08 ms` 降到 `1,651.42 ms`，耗时降低 `37.2341%`；
- 推进峰值增量从 `1,327,386,624 B` 降到 `960,110,592 B`，降低 `27.6691%`。

这是明确的单步性能提升，但不是“已实时”。E18 在不同严格测试中仍需约 `1.415～1.651` 墙钟秒推进一个模拟秒。公开基线的三次连续推进还发生了规范哈希分叉，因此完整工作流 A/B 按设计 fail-closed，本报告不给出也不暗示任何“完整 A/B 百分比”。E18 自身的完整工作流以三个独立进程 `3/3` exact 通过。

## 2. 实际完成的开发范围

### 2.1 E5～E18 精确模拟热路

1. E5～E8：紧凑线路拓扑与稀疏调度工作区、精确行 ID 索引、实体原始记录写回、模拟与规范证明提交融合。
2. E9～E12：普通机器确定性并行、线路原始补丁并行、析构延后但同步闭合、检查点记录所有权转移。
3. E13～E15：机器库存既有键原位更新；规范/领域哈希借用字符串和稀疏 rank；线路动态和物料键减少克隆与重插。
4. E16～E18：量子库存、BigUint 和游标原位更新；生产历史使用 HashMap 累加后稳定物化；本地物流取消全站 snapshot，引入 revision 内不可变 peer directory 缓存，只在拓扑命令或 5 秒电梯边界刷新。

所有并行阶段使用固定输入索引、私有输出和稳定顺序安装；完整成功前不替换源状态。关键字符串/库存原位路径有 Unicode、Mod key、插入顺序、缺字段、非有限数和负零回归。

### 2.2 保存、纯挂机与应用边界

- 保留 30 秒有界精确前缀；普通产线尾段只在物料账本能闭合时宏观推进，火箭、太阳帆、戴森结构/壳面、出口、合同与建筑巨构等不安全终端结果冻结，不复制物料。
- 活动 revision 支持脏页存档、失败保留脏状态、WAL、双 superblock、流式 v47 导出和同 revision 回复边界。
- Windows 性能开发版使用独立 appId、EXE、输出目录、`userData` 和 `sessionData`；默认官方 API/更新地址为空。
- E1a 为 durable `normal-main` 增加 admission/publication 双重单写者栅栏、损坏租约 fail-closed、启动检查和 host-only 固定 exact pending-tick 路径。Renderer/preload 没有新增可写 API。

E1a 是未来权威晋升的安全前提，不表示已经完成玩家可见的唯一原生权威。

## 3. 只读真实存档与方法

| 项目 | 值 |
| --- | ---: |
| 源文件大小 | 76,898,141 B |
| 实体 | 80,674 |
| 线路 | 155,746 |
| 每模拟秒线路方向检查 | 311,492 |
| 源 SHA-256 | `ab869c2b52d5f89e1fcbd8bfcb715daa2f5e7b02b4b7d1bd553f12f566531554` |

测试全程只读打开玩家文件，每份性能证据都复核大小、mtime 与 SHA-256 未变。仓库不包含玩家完整存档或其副本。

对比使用不可变的 Host 二进制：

- 冻结公开 1.2.3：SHA-256 `44a92173304f3395286a237a777bfad9f0a669e11f84ab0e3eb336d5f9c7b48f`；
- E17：SHA-256 `0314b0b0fa34fb05738d33f5fe9a626df78435fc32b40d9b0cfc13f012d0e769`；
- E18/E1a：SHA-256 `032534d525bc2a01116c4bd644ab376b122eaeebab5b603403251ce9288b4804`。

性能数据使用多轮交错顺序、独立进程、JavaScript 对照哈希和外部进程采样器。百分比只用于两边共同通过 exact 的可比区间。

## 4. 性能 A/B 结果

### 4.1 冻结公开 1.2.3 对 E18：三轮交错单步 exact

| 指标 | 公开 1.2.3 中位 | E18 中位 | 变化 |
| --- | ---: | ---: | ---: |
| 打开耗时 | 9,896.45 ms | 7,521.43 ms | 耗时降低 24.00% |
| 打开峰值 | 2,802,446,336 B | 1,812,520,960 B | 降低 35.3236% |
| 一秒原生精确推进 | 2,631.08 ms | 1,651.42 ms | 耗时降低 37.2341% |
| 推进峰值增量 | 1,327,386,624 B | 960,110,592 B | 降低 27.6691% |

六个单步样本的双方规范哈希全部与 JavaScript 一致。同一批的 JavaScript 控制仅变化约 `1.77%`，因此不能用当时机器整体变快来解释原生推进的 `37.2341%` 耗时下降。原始证据：[ab-public-v123-vs-e18-exact-3x-auto.json](../../artifacts/performance/ab-public-v123-vs-e18-exact-3x-auto.json)。

### 4.2 E17 对 E18：本地物流 peer directory 取舍

| 指标 | E17 中位 | E18 中位 | 变化 |
| --- | ---: | ---: | ---: |
| 一秒原生精确推进 | 1,534.84 ms | 1,431.98 ms | 耗时降低 6.7017% |
| JavaScript 控制 | 3,421.45 ms | 3,420.79 ms | 耗时降低 0.0193% |
| 推进峰值增量 | 869,060,608 B | 902,545,408 B | 增加 33,484,800 B / 3.853% |

E18 的打开耗时在该五轮小对比中回退 `1.46%`，打开驻留增量多约 `14.57 MB / 5.38%`。这些负向数字是缓存不可变本地物流目录的真实代价，不应被隐藏。其价值在于推进热路稳定缩短 `6.7017%`，而同轮 JS 对照基本不变。原始证据：[ab-e17-vs-e18-local-peer-cache-exact-5x-auto.json](../../artifacts/performance/ab-e17-vs-e18-local-peer-cache-exact-5x-auto.json)。

### 4.3 线程矩阵与剖析

| 线程设置 | 原生一秒推进中位 |
| --- | ---: |
| 1 | 2,233.16 ms |
| 2 | 1,804.98 ms |
| 4 | 1,540.12 ms |
| 8 | 1,437.49 ms |
| auto | 1,415.05 ms |

15/15 样本都输出同一规范哈希。`auto` 相对单线程的吞吐提升为 `57.81%`，等价墙钟耗时降低约 `36.64%`。证据：[thread-matrix-e18-exact-3x-profile.json](../../artifacts/performance/thread-matrix-e18-exact-3x-profile.json)。

E18 三轮 profile 中位为：原生推进 `1,419.74 ms`、JavaScript 对照 `3,144.13 ms`；`state simulate` `1,113.976 ms`、`advance simulate` `1,291.128 ms`、历史 `78.965 ms`、提交 `46.628 ms`。`local-step-directory` 中位为 `0.000 ms`，5 秒边界刷新为 `0.175 ms`。证据：[profile-e18-local-peer-cache-exact-auto-3x.json](../../artifacts/performance/profile-e18-local-peer-cache-exact-auto-3x.json)。

## 5. 完整工作流正确性

### 5.1 E18 候选自身

E18 用三个独立进程完成 `3/3` full workflow，每次都通过 exact 哈希、外部采样器和输入不变检查。中位数为：

| 阶段 | 中位值 |
| --- | ---: |
| 打开 | 6,893.84 ms |
| 单步原生推进 | 1,441.20 ms |
| JavaScript 对照 | 3,367.49 ms |
| 推进+规范证明 | 3,130.83 ms |
| durable 提交 | 3,705.17 ms |
| 重复幂等重试 | 0.83 ms |
| 增量检查点 | 559.66 ms / 3,162,837 变化字节 |
| 三步连续推进 | 6,897.45 ms |
| 工作流采样峰值 | 约 2,102,992,896 B |

证据：[e18-real-save-full-workflow-3x-auto.json](../../artifacts/stability/e18-real-save-full-workflow-3x-auto.json)。

### 5.2 为什么没有“完整 A/B 提升百分比”

完整 A/B 在第一个公开基线样本上中止：基线单步 exact 与 JavaScript 一致，但随后的三次连续一秒推进产生不同规范哈希。工具没有继续混合错误基线和正确候选的性能数字。原始失败证据：[ab-public-v123-vs-e18-full-3x-auto.json](../../artifacts/performance/ab-public-v123-vs-e18-full-3x-auto.json)。

因此可合法引用的只有第 4.1 节“双方都通过规范哈希”的单步 A/B，以及第 5.1 节 E18 自身 `3/3` 工作流。候选不再现公开基线的连续推进分叉，但这不能被换算为完整 A/B 速度改善。

## 6. 当前候选的新鲜验证

| 门禁 | 实际结果 |
| --- | --- |
| Rust workspace | 192 通过 / 0 失败（core 128，host 64） |
| Native JavaScript/工具 | 154 通过 / 1 Windows 权限条件跳过 / 0 失败 |
| 长时原生差分 | 37/37 通过 / 0 失败 |
| Vitest 最终全量 | 198 文件通过 / 13 文件跳过；1,622 测试通过 / 27 跳过 / 0 失败 |
| Server/API/SQLite | 388 通过 / 2 跳过 / 0 失败（main 384/2，station 4/4） |
| Operations | 56 通过 / 6 Linux-only 跳过 / 0 失败 |
| Chromium 最终全量 | 431 通过 / 27 跳过 / 0 失败 |
| TypeScript / Rust 静态门禁 | typecheck、`cargo fmt --check`、`cargo check --workspace --all-targets`、clippy `-D warnings` 通过 |
| Web 生产构建 | `build:web` 通过；startup gzip 179,981 B；预清洁构建的 module 数仅作中间诊断 |
| 许可证 | 125 个运行时包；通过 |
| 生产依赖审计 | 根项目 0 漏洞；server 0 漏洞 |
| Durable E2E | 7/7 通过 / 0 失败 |
| Production preview | Web 构建后 PWA 1/1、connection 1/1、density 独立 1/1；三项组合 2/3，density 一次 P95 41.6 ms > 21 ms |

两类全量测试均保留了首轮失败证据，没有把超时简化成“从未失败”：

- Vitest 首轮为 1,621 通过 / 27 跳过 / 1 失败，唯一失败是未修改的 `src/game/storage.test.ts:239` 在并发负载下触发 5 秒超时。定向用例紧接着在 2.93 秒内通过，随后第二轮全量得到 1,622/27/0。
- Chromium 首轮为 430 通过 / 27 跳过 / 1 失败，唯一失败是 `game-flow-megastructure.spec.ts:1484` 等待短暂 `.interaction-burst` 文字在 5 秒内出现而超时。定向复跑通过，其他并发负载结束后的第二轮全量为 431/27/0。

Production preview 的三项组合运行必须保持 `2/3` 的原始结论：density 在与 PWA/connection 同进程组合时一次 frame P95 为 `41.6 ms`，超过 `21 ms` 原门槛；它在后续独立进程中按同一原门槛 `1/1` 通过，但独立通过不会抹去组合失败。最初将 Electron desktop `dist` 误用为 PWA preview 制品而产生的失败只证明测试制品类型不匹配，不是 Web 构建的 PWA 失败；该诊断同样保留。

## 7. Windows 包状态

### 7.1 已完成的预清洁包（仅中间证据）

| 项目 | 值 |
| --- | --- |
| 目录 | `release-performance-edition-fallback/win-unpacked` |
| 文件 / 总大小 | 77 / 412,739,247 B |
| EXE | `dsp-idle-performance-edition.exe`，225,486,336 B |
| EXE SHA-256 | `748731b26a1864a0777097059caf6fe0517128da19b8417852c84a9556290458` |
| FileVersion / ProductVersion | 1.2.3 / 1.2.3.0 |
| Build ID | `1.2.3+9778ba4cfe4a.dirty` |
| Authenticode | `NotSigned` |
| 打包 Host SHA-256 | `032534d525bc2a01116c4bd644ab376b122eaeebab5b603403251ce9288b4804` |
| 启动冒烟 | 隔离性能 profile 启动 12 秒，进程存活且没有复用稳定版 profile |

该包是用来验证 fallback 打包器、独立身份、打包 Host 和启动路径的中间物。由于 Build ID 带 `.dirty`，它不是最终可交付包，不应发布、上传更新源或放入稳定下载页。

### 7.2 最终 clean 包待回填

| 字段 | 最终值 |
| --- | --- |
| Clean commit SHA | `FINAL_CLEAN_PACKAGE_PENDING` |
| Build ID | `FINAL_CLEAN_PACKAGE_PENDING` |
| unpacked 目录 | `FINAL_CLEAN_PACKAGE_PENDING` |
| 可测 ZIP | `FINAL_CLEAN_PACKAGE_PENDING` |
| EXE SHA-256 | `FINAL_CLEAN_PACKAGE_PENDING` |
| ZIP SHA-256 | `FINAL_CLEAN_PACKAGE_PENDING` |
| manifest / SHA256SUMS | `FINAL_CLEAN_PACKAGE_PENDING` |
| clean 包启动冒烟 | `FINAL_CLEAN_PACKAGE_PENDING` |

上表必须在 clean 提交、Release Host 重建、Windows 重打包、哈希复核和新鲜启动冒烟后由主任务替换；不得把上节的 `.dirty` 哈希复制进来。

## 8. 兼容、数据保护与权威边界

- GameState 仍为 v47，save envelope 仍为 v2，cloud schema 仍为 v8，SQLite layout 仍为 v3；没有新增持久化格式迁移。
- `authorityEligible=false` 不变。JavaScript 仍是玩家可见权威，原生 exact-realtime 只是未公开的实验能力。
- 本任务没有连接香港/上海生产，没有上传、部署、切换稳定指针或修改下载页。
- 玩家原始存档没有被修改、修复、迁移或提交进仓库；它只作为只读输入，前后 SHA-256 一致。
- 性能版 profile 与稳定版 profile 隔离；不自动拷贝、移动、删除或降级玩家数据。
- 预清洁包与后续 clean 开发包均是 `NotSigned`；在没有 Authenticode 与发布授权前只能标记为开发/诊断候选。

## 9. 未关闭的性能与发布门禁

### 9.1 仍可观测的热点

- 这份稠密活动存档报告 `activeQueueEnabled=false`，每模拟秒仍正确执行 `311,492` 次线路方向检查；不能为了速度错误休眠活动线路。
- 一秒推进仍需写回 `140,023 / 155,746` 条变化线路，并对 `80,674` 个实体执行全量 encode；这是距离实时的主要残余结构性成本。
- E18 peer directory 让推进热路变快，但在 E17→E18 小对比中使推进峰值增量增加 `3.853%`，后续应继续压缩目录常驻数据。
- E18 仍约需 `1.415～1.651` 墙钟秒推进一个模拟秒，未达成“1 秒算完 1 个模拟秒”。

### 9.2 仍为 No-Go 的产品/安全边界

1. exact-realtime 没有玩家 UI 入口；只有 Host 内部 capability，不是公开功能。
2. Host 不可用时仍允许打开普通 JavaScript 窗口；尚未完成“原生权威不可用则整个玩家运行时停止”的终态。
3. 没有 public primary writer、main-owned catalog、renderer 薄状态与崩溃后同 revision UI 自动恢复，因此不是公开唯一原生权威。
4. 没有完成 Windows 10/11 低配/主流/高配多硬件 24 小时、Defender、真实磁盘满/只读、覆盖升级、GPU 丢失和长时内存斜率。
5. 没有 Authenticode、安装/卸载双 profile 真机验证、邀请 Beta、灰度或更新源验证。

## 10. 开发交接

- **Task ID / title：** Windows 全面性能开发候选 E18/E1a
- **Priority：** P1 性能；确定性、守恒、存档与无静默回档边界按 P0 验证
- **Source and attachments：** 独立工作树、冻结公开/E17/E18 Host、相对链接中的 A/B 与稳定性 JSON
- **Reproduction or observed evidence：** 第 3～6 节
- **User-visible acceptance criteria：** 可在独立 profile 导入测试；模拟确定；物料守恒；无静默回档；性能数字只引用合法可比区间
- **Compatibility and data-preservation constraints：** GameState v47 / envelope v2 / cloud v8 / SQLite v3 不变；不改玩家原文件；稳定版 profile 隔离
- **Target platforms：** 当前本机 Windows x64 开发候选；多硬件外部门禁待做
- **Required tests：** 第 6 节已完成门禁；clean 包与第 9.2 节外部门禁待闭合
- **Release target and version：** 未指定；本报告不授权部署或更新公开下载
- **Known risks / rollback：** 第 9 节；稳定版与性能版并存，只从同 revision 合法检查点恢复
- **Commit SHA：** `FINAL_CLEAN_PACKAGE_PENDING`
- **Changed files：** 以最终 clean commit manifest 为准
- **Artifact paths：** `FINAL_CLEAN_PACKAGE_PENDING`
- **Manifest and aggregate hash：** `FINAL_CLEAN_PACKAGE_PENDING`
- **Tests with exact counts：** 第 6 节；最终制品专项由主任务回填
- **Unverified gaps：** 第 9 节的外部硬件、签名、灰度和唯一权威门禁
