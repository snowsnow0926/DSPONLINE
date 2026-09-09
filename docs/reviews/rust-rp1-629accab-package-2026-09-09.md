# Windows Rust：629accab 冻结包与终局入口

2026-09-09，Role: develop。源码已提交并推送，完整 Windows Goal 继续 active，未发布、未开放实时玩家权威。

## 当前候选

`629accab323b9b191920c26a564156be247a5f61` 使用固定编码缓冲，保持 JS 独立完整与 domain 摘要；终局 JS 证明三对中位少约 9.34%（0.512 秒）。定向 68/1 长测 skip、完整游戏 3,178/39 skip（实际 Native 50/1 长测 skip）、类型及 Web 门禁通过。正常 Rust Host 未变，不能把旧 Rust/Node 检查重复计作本批新执行。详见[证明优化](./rust-rp1-js-proof-buffer-2026-09-09.md)。

[构建收据](../../artifacts/rust-rp1-loop/package-629accab-receipt.json)绑定干净源码与开发 beta `1.2.7+629accab323b`，75 个制品、78 个冻结文件校验通过。Host `dce6af810e191dce7f05f8b3a2c969c7cd9228df0c2cb47ad2e60ae80b493839` 与已验正常程序一致；ASAR `e9db636490d038acef32665ae07c6cf6f888a9418dc9d4c6d77563c7cd606d4c`。前一 863 冻结目录逐文件未变。

[构建守护](../../artifacts/rust-rp1-loop/build-desktop-629accab-guard/guard.json)正常 exit 0，64.4413073 秒，最低空闲 8,037,180 KiB，6/2 GiB。

## v14 真实终局入口：仍失败

[实际 v14](../../artifacts/rust-rp1-loop/private-packaged-complete-v14/report.json)沿用自然 savedAt/真实时钟、原 90 秒入口与 25 秒正常关闭要求，只增加有界失败分类。实际 Native 精确结算 **9 秒、近似 0**，请求 45,361.3387 ms，但截止仍未进入 active 工厂。只创建一个普通模拟 Worker：85.45 秒创建，87.06 秒发送 205,666,648-byte 零秒初始化。

菜单和失败后的两次关闭均正常 exit 0，无强制清理。没有观察到 renderer crash 事件；失败分类为入口等待超时。原档字节数、mtime 与 SHA-256 不变。保持隐藏离屏、不可聚焦、静音，显示/聚焦/原生对话框为零。

尚未执行成功入口后的完整持久状态、完整 JS 对照和两次重开。新局部证明收益不能当作整个入口已加速或稳定达标。[v14 守护](../../artifacts/rust-rp1-loop/private-packaged-complete-v14-guard/guard.json)FAILED/exit 1、stopReason=null，119.9873209 秒，最低空闲 4,312,028 KiB，6/2 GiB，没有内存或总时限停止。

## 云端与下一步

本源码云端尚待终态。前一 863 的完整结果已收齐：Linux 单元/构建/Server/Ops/Native 通过，浏览器 **417 pass/33 skip/29 fail/16 flaky**；Windows Rust core **1,115/5 ignored**、Host **256/1 ignored**、Node Native **750/1 skip** 通过，游戏 **3,175 pass/39 skip/1 fail**。唯一 Windows 失败为原内存采样门禁 `cadence-invalid(p95=101,max=101,target=50)`，见[863 云端终态](../../artifacts/rust-rp1-loop/cloud-863cf76e-terminal-summary.json)。不能称为 Windows 全量通过。

下一步继续减少真实保存校验/目录处理成本，收口相同输入的成功入口与持久保存、正常退出、两次重开；同时修正采样器读取开销叠加固定睡眠的调度，保留真实时间戳、原 p95/max 门槛和原用例时限。采样器代码只用于测试与性能证据，不改变此包的游戏运行代码。完整可信资格、实际实时单所有者、完整玩法、复杂长离线、全流程性能/内存、长测和 Windows 安装升级回退仍待完成。
