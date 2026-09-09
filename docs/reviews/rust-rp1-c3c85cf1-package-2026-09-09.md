# Windows Rust：c3c85cf1 冻结包终局入口复验

2026-09-09，Role: develop。完整 Windows Goal 仍 active，未发布；本记录没有修改玩家原档或正式资格。

同源码云端已结束：Windows 全量及 Linux 单元/生产构建/Server/Ops/Native 通过；Linux 浏览器合计 422 pass/33 skip/23 fail/17 flaky。两项启动顺序与精确堆叠路由测试均首次通过，整体浏览器门禁仍失败，见[终态记录](../../artifacts/rust-rp1-loop/cloud-c3c85cf1-terminal-summary.json)。

## 已提交的修复与构建

提交 `c3c85cf1a4b62febc10bf8c33bcd6a0dac29d31f` 已推送开发分支。启动 handoff 检查完成前不会创建普通模拟 Worker；unknown 和持久恢复失败保持保护。源码反例两项均失败，修复后三轮 6/6 通过，属于实际界面协议回归，不是 Native 资格。完整 Native 750 pass/1 skip、游戏 3,176 pass/39 skip、实际 Native 对照 50 pass/1 长测 skip、类型以及覆盖行号补验后的 Web 门禁和画布三轮 9/9 均通过。

[构建收据](../../artifacts/rust-rp1-loop/package-c3c85cf1-receipt.json)绑定干净源码，开发 beta `1.2.7+c3c85cf1a4b6`，75 个制品、78 个冻结文件。Host SHA-256 `7253807b6ccead1ba2f02d0175294d716064d34517c7e05b740530bf5ef9474b`，ASAR `b4aeb16cbade7b751bbf50f09f9041bba6e2de22915935f513708be526d01ff0`。前一 84 冻结目录逐文件未变。

[构建守护](../../artifacts/rust-rp1-loop/build-desktop-c3c85cf1-guard/guard.json)正常 exit 0，64.6311063 秒，最低空闲 6,488,292 KiB，沿用 6/2 GiB。

## 真实终局入口仍失败

[完整入口 v12](../../artifacts/rust-rp1-loop/private-packaged-complete-v12/report.json)为 FAILED：仍未在原 90 秒内达到 active 工厂。使用注册 107,637,967-byte 原档的副本，只更新测试派生信封的 savedAt，保持真实时钟，固定返回 9 秒 Native 精确结果，approximation=0。真实请求 44,783.7883 ms，候选 canonical `6cf99f1d4d8bb0f172448c1c2e790b7cf5acd2cf47de9a6bede3e28a5ee8f96b`，与此前一致。

截止超时前只观察到一个 factory-simulation Worker：85.47 秒创建、87.16 秒发送 205,666,648 bytes 的零秒初始化；没有此前恢复挑战导致的终止/重建。窗口的菜单 seed 关闭与失败后关闭均正常 exit 0，未强制清理。这个结果证明本次观察中消除了重复 Worker，但不代表终局入口通过，也不能推断完整启动收益比例。

尚未执行成功进入后的独立完整 JS 对照、持久主档检查、手动暂停保存与两次重开，因此这些项目不能计通过。原注册档字节、mtime 和 SHA-256 均未变。

[执行守护](../../artifacts/rust-rp1-loop/private-packaged-complete-v12-guard/guard.json)exit 1，117.7312253 秒，最低空闲 4,309,184 KiB，无内存或总时限守护终止。始终隐藏离屏、静音、不可聚焦，实际 show/focus 事件均 0；没有可见游戏窗口，也没有增加原入口/关闭时限。

## 后续

继续压缩开档校验、精确模拟、保存和 Worker 初始化的全流程成本；正在验证量子物流准入借用已解析设备记录的优化。Rust 实时资格、实际单所有者、完整玩法、线程/内存/长测/Windows 安装升级回退仍需逐项完成。单个请求速度与一次正常关闭不能替代这些门槛。
