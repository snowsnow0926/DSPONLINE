# Rust RP1 终局保存字节数复用｜2026-09-09

Role: develop。真实终局菜单的 Native 候选返回后仍有保存等待，因此本轮先单独测量保存流程，再减少无必要的大缓冲区分配。没有改变存档格式、内容、模拟规则或原 1–30 秒采用范围，未发布。

## 诊断和边界

来源为已授权的完整 110,042 实体 / 233,300 带存档，107,637,967 bytes，SHA-256 `d64b5646f6117f3c089fba4dc95a95e84bedd9375f75b3c8c917b2e7cf473bc1`。测试在隔离 Chrome headless 页面中运行当前生产 storage 模块，使用真实 IndexedDB 和 Worker，调用原有 orphan timeWarp 恢复后保存；不运行模拟，也不把本测量称为 Windows 实包菜单性能。

旧源码 `7cfcdd60` 的 v6 保存专项为 **13,826.9 ms**，序列化 3,574.1、主档写入 2,702.3、备份 3,480.4、快照 2,970.4 ms，最长已记录主线程任务 2,112 ms。主档与同步序列化预期逐字节相同，上一版本备份保持原文，自动快照状态与主档相同；重新加载目录后再读验证通过，原文件不变。

v7 增加主线程 TextEncoder 大输入计数：一次相同保存流程有 **6 次**大于 1 MiB 的 encode，累计分配 **645,827,812 bytes（约 646 MB）**。这是这类临时缓冲区的累计分配量，不是同一时刻的峰值或整个进程内存。保存 13,793.2 ms；计数只覆盖主线程这个编码接口，Worker 必需的编码没有计入。

v1–v5 初始化失败原样保留：自建诊断 HTML 没有经过 Vite HTML 转换，导致空 profile 初始化时缺少 `__APP_PLATFORM__`；v6 使用正常 HTML 转换流程后通过。中间还纠正了未执行到的恢复返回结构引用。这些不是生产保存失败，不反复修改生产保护来适配诊断。

## 修改

- `saveGameVerifiedOnce` 和快照容量检查直接使用已校验的 Worker UTF-8 长度。容量判断仍保留原 256 KiB 余量、当前占用和 quota 失败行为；非法长度在查询 quota 前拒绝。
- IndexedDB 写入记录复用为同一 payload 刚构建的 catalog 长度；没有传入已测长度的调用仍自行编码测量。
- 仍执行完整 catalog 构建和 checksum 校验、旧档结构/迁移检查、正常备份、主档/备份/快照的精确读回。没有用 catalog checksum 代替旧档可加载性检查，也没有延后备份来缩短结果。

v8 新源码在同一完整来源上保存 **13,561.8 ms**，上述大型 encode **0 次**；主档、备份、快照相等，原文件不变。这里只证明消除了六份不必要的缓冲区；单次新旧总时间差很小，其他阶段存在波动，**不宣称整体等待提速或峰值内存降低**。实际 Windows 完整菜单仍需新包复验。

v9 补齐主档、备份、快照三条真实 IndexedDB record 的 bytes 和对应 catalog.byteLength 与实际 UTF-8 长度逐项比较，**3/3 相同**，全部持久内容仍一致，大型 encode 仍为 0。此次另外显式降低已创建的两个 renderer 优先级，整个保存 20,472.4 ms；它也表明总耗时受运行环境影响，不能把 v8 单次较短结果当作稳定提速。外部守护 44.379 秒、最低可用 5,640,300 KiB、正常退出 0，原文件不变。report SHA-256 `8067b6c88d42d608191770161270c80251c766a7db3a23a6dda5a0f411da1783`。

## 验证与证据

新增容量边界测试使用多字节文本，验证恰好不足/足够、已有占用扣减、不重新编码和非法长度拒绝。四文件专项 **130 pass / 0 skip / 0 fail**，实际项目类型检查通过；完整回归、构建与新 Windows 包尚待完成。

所有证据在开发 worktree `artifacts/rust-rp1-loop/`：`private-save-stages-vN/report.json`、`probe-private-save-stages-vN.mjs` 和对应 `private-save-stages-vN-guard/guard.json`。完整来源仅留在内存和隔离 profile，不进入日志、Git 或云端；所有运行由外部 6 GiB 启动 / 2 GiB 停止守护，低优先级且串行。

| 身份或证据 | SHA-256 |
| --- | --- |
| v7 旧 storage.ts | `0fae573833e731543231f05f492a912a54bb7d360eaf4a1349a9578e7f0c9d27` |
| v7 旧 localSaveStore.ts | `c6d141133a389305e7a6b24f863aa27b2b3e9df146a81e0976aaa82fb0ddf514` |
| v8 新 storage.ts | `ec3851a0252996045ed82e3313537494955a9dc1ef163c3b120235d373a5f52d` |
| v8 新 localSaveStore.ts | `cdecd3d3276ae80f8978440dc52e0aa77bd683401c2f44abd1e1fccc8d4b2cc2` |
| v7 report | `946c95ad50e9a2567ae1b592ea4cbc1170eb4eed6ff87375c5783c3447b79e11` |

源码文件哈希用于区分同一提交工作区中的未提交候选，不能把 v8 当作未修改的 7cfc 包。v6/v7/v8 外部守护耗时分别 47.335/31.556/31.678 秒，最低可用分别 5,131,008 / 5,985,564 / 4,794,788 KiB，全部正常退出 0。最低可用是整机采样，受外部应用和 GC 影响，不作为本优化的峰值内存对照。

此前实际隐藏 Windows 入口仍以[终局等待失败记录](./rust-rp1-endgame-entry-wait-2026-09-09.md)为准；云端旧 0ce 的完整通过项不能替代本次保存源码的回归。
