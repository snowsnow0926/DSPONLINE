# Windows Rust：a6a37b00 冻结包与终局入口复验

2026-09-09，Role: develop。源码 `a6a37b0085f7b93f215947d0a49bbee43dc4ce35`，独立开发分支；完整 Windows Goal 保持 active。校验缓冲优化和前批进程恢复已经提交并推送，本记录区分后续实包的失败与独立 Host 诊断通过。

## 冻结包

[构建记录](../../artifacts/rust-rp1-loop/package-a6a37b00-receipt.json) BUILD_AND_FREEZE_PASS，版本标识 `1.2.7+a6a37b0085f7`，离线 performance development / beta。干净源码调用正常 Host release 构建、类型、Vite、原启动预算/thin UI/coverage/platform 门禁及桌面打包；75 件制品与 78 件冻结文件摘要验证通过，旧 253 冻结副本未变。版本号沿用测试身份，没有发布新 Windows 正式版本。

- Host SHA-256：`ef56b807e5d753e83f7f6bb41c08e2de1a1372dfccb8a071578bce88abddb4f4`。
- ASAR SHA-256：`43b8d7c5ffd713a2a7a9cefe8cb7ecd062ef54b89483a2840277d6b3a740f45e`。
- 构建[守护](../../artifacts/rust-rp1-loop/build-desktop-a6a37b00-guard/guard.json) 正常退出 0，63.2730554 秒，最低空闲 6,555,344 KiB。

## 完整终局入口仍失败

[实际隐藏包记录](../../artifacts/rust-rp1-loop/private-packaged-complete-v8/report.json) FAILED，阶段 `wait-for-active-factory`，TimeoutError。沿用原 90 秒等待门槛，没有延长超时。原始注册终局档 110,042 实体、233,300 带，仅更新隔离测试副本的 envelope savedAt，实际时钟没有伪造，不代表结算玩家原来的累计挂机。

Native 实际返回 10 秒候选，RPC 48,152.5264 ms，exactCalibrationSeconds=10、approximatedSeconds=0，来源已关闭，未调用 coreOpen。观察到保存序列化、快照重包和工厂 shell；但 Worker 在原等待门槛内没有进入 active。后续完整 JS 对照、成功主档独立核验、暂停保存与两次重开均未执行，不能记为通过。这个 10 秒请求与旧包 9 秒采样不构成性能 A/B。

第二次关闭也未在原 25 秒内正常完成：关闭回执 exitCode=null，隐藏策略记录一次被拦截的 message box 请求，脚本执行了所属进程树的失败清理。第一次播种菜单退出 0。两次窗口始终隐藏、不可聚焦、静音、离屏；show/focus 事件为 0，没有显示原生对话框。不能把守护结束或失败清理当成正常关闭通过。

[实包守护](../../artifacts/rust-rp1-loop/private-packaged-complete-v8-guard/guard.json) exit 1，135.6272074 秒，最低空闲 3,664,320 KiB，stopReason=null；没有触发内存停止。原玩家文件大小、修改时间和 SHA-256 均保持不变，测试所属进程已退出。驱动 SHA-256 `3c0040cfde8bdf5b2139e622beed9d96e1aa5aa59fb9da7858a7ee1ba2118e33`。

## 同一冻结 Host 的固定 9 秒诊断通过

[命令行诊断](../../artifacts/rust-rp1-loop/a6a37b00-private-profile-v1/report.json) PASS，使用已有 opt-in Native profile，不启动游戏窗口。固定恢复来源、9 秒 exact 请求、正常关闭退出 0；主档槽位没有被创建。导出 208,891,374 bytes，与此前六次完整 JS 对照的固定导出 SHA-256 `15c91fa1509ad6949d22a2db6a257890992c1dfb9b3bcd635bd8d1ec9c1cb934` 相同，完整候选 canonical SHA-256 也相同。新程序和四份关联源码前后摘要不变，原玩家文件不变，所属临时诊断目录已清理。

该诊断 RPC 为 52,031.508 ms，带 profile 开销且仅一次，不是新增无诊断性能 A/B，也不替代上面的实际菜单失败。9 秒累计精确模拟 23,784.793 ms；其中 power/facilities/machines/miners 4,825.050 ms、construction 3,186.863 ms、输入/输出传送合计 5,250.902 ms。开档 admission 4,084.273 ms、canonical proof 4,350.781 ms。各指标可能包含下级阶段，不能全部求和为总耗时。

[诊断守护](../../artifacts/rust-rp1-loop/a6a37b00-private-profile-v1-guard/guard.json) 正常退出 0，64.3966891 秒，最低空闲 7,581,256 KiB。全程本机重任务串行、低优先级、6 GiB 启动 / 2 GiB 停止，不关闭用户应用。

## 下一步

依据当前实测继续减少精确模拟、开档校验及前端保存/Worker 初始化成本；保留正常关闭失败作为待定位问题。下一次完整入口仍须通过原门槛、独立完整状态、持久写档与两次重开，不能凭 shell 已出现放行。实时可信资格、实际桌面单所有者、完整玩法与长离线、性能/内存和发布矩阵仍按[完整目标](../rust/windows-full-development.md)推进。

云端 `a6a37b00` 当前生产构建和 Linux 单元已通过，其余工作尚在运行；结果按最终账目更新。上一 `4bc` 的浏览器四项失败保留，不能由失败数量波动推导修复。画布堆叠端点的源码追溯发现 `75a223e9` 已改为实际端口测量，但旧堆叠用例仍硬编码 Y=96；这是待用独立 DOM 几何复验的线索，尚未修改或将其判定为测试错误。
