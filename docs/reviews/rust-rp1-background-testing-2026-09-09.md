# Rust RP1 后台桌面验证｜2026-09-09

Role: develop。用户要求不再显示测试窗口或抢焦点。本次代码仅增加隔离开发测试策略，不变更 Rust 算法、玩家存档或离线采用资格，未发布。

仅当原有身份初始化已经验证性能开发版 beta/nightly 的直属系统临时资料目录，且显式 DSP_PERFORMANCE_SMOKE_BACKGROUND=1，才安装 hidden-no-focus-v1。普通启动不修改任何窗口或对话框方法；未验证隔离身份的后台请求拒绝。

窗口仍由实际 main 以 show:false 创建。后台策略关闭可聚焦性和任务栏入口，静音，并阻止显示、恢复、最大化、前台激活等动作。原生文件对话框返回取消；错误/提示仅留下固定方法计数，不记录玩家内容。意外可见或聚焦有不可抹去的计数，紧急隐藏不把违规改记为成功。

隐藏窗口关闭 background throttling，以保持前台式计时与动画调度；新实际驱动会验证 renderer visibilityState、requestAnimationFrame 进展，以及所有窗口始终不可见、未聚焦、静音。驱动在启动 Electron 前校验精确包身份并检查后台策略文件，旧的可见包会被拒绝，不允许先启动再隐藏。

当前专项 6/6；身份/生命周期组合 26 通过/1 条件跳过；完整 Native 工具最终 674 通过/1 条件跳过/0 失败，最终运行使用两并发以控制负载。证据 D:/GameDev/DSPidle2/artifacts/rust-rp1-next/background-policy-{focused-v1,focused-v2,native-full-v1,native-full-v2}.log。完整单元与浏览器结果不在本次重复记为新通过，业务源码未变化。

新包和后台实际流程仍待验收；接下来通过后再做授权终局档的独立完整等待诊断。不得重新执行旧驱动中的 show/focus/bringToFront。旧已验证 dfe0e980 包已完整冻结，不能用其可见 UI 证据证明新后台模式通过。
