# Rust RP1 后台桌面验证｜2026-09-09

Role: develop。用户要求不再显示测试窗口或抢焦点。本次代码仅增加隔离开发测试策略，不变更 Rust 算法、玩家存档或离线采用资格，未发布。

仅当原有身份初始化已经验证性能开发版 beta/nightly 的直属系统临时资料目录，且显式 DSP_PERFORMANCE_SMOKE_BACKGROUND=1，才安装 hidden-no-focus-v1。普通启动不修改任何窗口或对话框方法；未验证隔离身份的后台请求拒绝。

窗口仍由实际 main 以 show:false 创建。后台策略关闭可聚焦性和任务栏入口，静音，并阻止显示、恢复、最大化、前台激活等动作。原生文件对话框返回取消；错误/提示仅留下固定方法计数，不记录玩家内容。意外可见或聚焦有不可抹去的计数，紧急隐藏不把违规改记为成功。

隐藏窗口关闭 background throttling，以保持前台式计时与动画调度；新实际驱动会验证 renderer visibilityState、requestAnimationFrame 进展，以及所有窗口始终不可见、未聚焦、静音。驱动在启动 Electron 前校验精确包身份并检查后台策略文件，旧的可见包会被拒绝，不允许先启动再隐藏。

当前专项 6/6；身份/生命周期组合 26 通过/1 条件跳过；完整 Native 工具最终 674 通过/1 条件跳过/0 失败，最终运行使用两并发以控制负载。证据 D:/GameDev/DSPidle2/artifacts/rust-rp1-next/background-policy-{focused-v1,focused-v2,native-full-v1,native-full-v2}.log。完整单元与浏览器结果不在本次重复记为新通过，业务源码未变化。

新包和后台实际流程仍待验收；接下来通过后再做授权终局档的独立完整等待诊断。不得重新执行旧驱动中的 show/focus/bringToFront。旧已验证 dfe0e980 包已完整冻结，不能用其可见 UI 证据证明新后台模式通过。

## 隐藏渲染复验与调整

4627af2d 包三轮实际隐藏驱动均没有显示、聚焦、原生对话框或强制关闭成功，但不能通过动画调度资格：v1 在重开阶段失败；v2 等菜单真正加载后检查，三帧曾耗时 3,002/1,012 ms，第三次重开 5 秒零帧；v3 加 Chromium 官方测试工具的遮挡/计时开关仍失败。v2/v3 的 Rust 候选与完整持久状态相同，但整次重开未通过，约 13 秒观察值不计性能收益。原日志和报告均保留，4627 原包 78 件文件完整冻结。

现改为只在已验证隔离后台模式下设置 offscreen:true、backgroundThrottling:false，使用 60 FPS 离屏绘制，显示/聚焦阻止及静音保持。普通用户窗口仍不启用离屏渲染。策略标识为 hidden-no-focus-offscreen-v2，并记录 paint 事件计数。v4 启动前拒绝旧策略，要求每次菜单就绪后 3 个动画帧不超过 500 ms、真正离屏、已绘制、窗口从未可见或聚焦；比旧探针更严格。

依据为 [Electron 离屏渲染文档](https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering)及已安装 Electron 类型说明；前一尝试的调度开关参考 [GoogleChrome 测试工具文档](https://github.com/GoogleChrome/chrome-launcher/blob/main/docs/chrome-flags-for-tools.md)。离屏 bitmap 绘制与普通前台合成成本有差别，后续完整等待只在相同离屏设置下配对并注明范围，不把图形管线差异当成 Rust 收益；本批不切换软件 GPU 或开启共享纹理试验。
