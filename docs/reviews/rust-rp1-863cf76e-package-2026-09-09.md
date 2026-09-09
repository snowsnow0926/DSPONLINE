# Windows Rust：863cf76e 冻结包与终局入口

2026-09-09，Role: develop。完整 Windows Goal 继续 active；源码已提交并推送，未发布、未开放实时玩家权威。

## 当前源码和真实收益

`863cf76e29d0aa02fc7d13ad62983230c9c0d6e1` 复用开档已解析设备供量子物流准入校验。正常 release 核心 1,115 pass/5 ignored、Host 256 pass/1 ignored、fmt/严格 Clippy/build 通过；完整 Native 750/1 skip、游戏 3,176/39 skip（实际 Native 50/1 长测 skip）、类型及 Web 门禁通过。

终局固定 9 秒双线程精确请求三对中位 51.77→49.19 秒，少约 4.99%（2.58 秒），8 份导出一致、正常退出、原档未变；只计该 Native 请求。见[完整量子物流证据](./rust-rp1-quantum-borrowed-admission-2026-09-09.md)。

## 新冻结包

[构建收据](../../artifacts/rust-rp1-loop/package-863cf76e-receipt.json)绑定干净源码、开发 beta `1.2.7+863cf76e29d0`。75 项制品和 78 个冻结文件验证通过；Host SHA-256 `dce6af810e191dce7f05f8b3a2c969c7cd9228df0c2cb47ad2e60ae80b493839` 与已验证的正常 release Host 一致。前一 c3 冻结目录逐文件未变。

[构建守护](../../artifacts/rust-rp1-loop/build-desktop-863cf76e-guard/guard.json)正常 exit 0，66.6756554 秒，最低空闲 6,127,576 KiB，6/2 GiB。

## 无采样完整入口 v13：仍失败

[实际 v13](../../artifacts/rust-rp1-loop/private-packaged-complete-v13/report.json)仍未在原 90 秒内达到 active 工厂。实际 Native 精确结算 **9 秒、近似 0**，请求 44,731.3828 ms，候选 canonical `6cf99f1d4d8bb0f172448c1c2e790b7cf5acd2cf47de9a6bede3e28a5ee8f96b` 与既有 9 秒结果一致。截止前只创建一个普通模拟 Worker，85.64 秒创建，87.30 秒发送 205,666,648-byte 零秒初始化。没有启动恢复导致的终止/重建。

菜单及失败后两次关闭均正常 exit 0，无强制清理、显示、聚焦或原生对话框，保持隐藏离屏、不可聚焦、静音。原注册存档的字节数、mtime 和 SHA-256 未变。成功持久保存、完整 JS 对照和两次重开未执行。

[v13 守护](../../artifacts/rust-rp1-loop/private-packaged-complete-v13-guard/guard.json)为 FAILED/exit 1，stopReason=null，120.4575797 秒，最低空闲 4,031,452 KiB，6/2 GiB；没有触发内存或总时限停止。测试失败不能称为守护成功。

## 采样诊断 v1：不计为 9 秒场景通过

[诊断 v1](../../artifacts/rust-rp1-loop/private-packaged-complete-863cf76e-cpu-v1/report.json)保持真实时钟，实际结算 **8 秒**，请求 43,414.9087 ms，进入运营中心 81,435.1513 ms；随后 capture-committed-offline-state 失败，CPU 采样提取也失败。该流程根据测试派生信封与实际加载时间决定离线时长，因此不能将这条 8 秒样本与 v13 的 9 秒样本作性能比较，不能据此推断同场景稳定通过。

两次关闭均正常 exit 0，原档未变；没有完成持久状态与重开核验。诊断守护 exit 1、stopReason=null，123.7357689 秒，最低空闲 4,773,960 KiB。失败原因尚未确定，不能认定为存档损坏、界面崩溃或仅是测试工具问题。

## 采样诊断 v2：取得热点，仍不授予入口资格

[诊断 v2](../../artifacts/rust-rp1-loop/private-packaged-complete-863cf76e-cpu-v2/report.json)在读取主档前保存 CPU 摘要，并增加有界错误分类。为了不再得到短于 9 秒的诊断样本，等待真实来源年龄至少 9 秒才点击 Continue，没有修改任何时钟或降低工厂规模；实际 Native 结算 **13 秒**、近似 0，请求 55,471.5815 ms，原 90 秒入口仍超时。两次正常关闭，原档未变，无 renderer crash 事件。总守护 exit 1、stopReason=null，124.525372 秒，最低空闲 3,640,340 KiB，6/2 GiB。

[CPU 摘要](../../artifacts/rust-rp1-loop/private-packaged-complete-863cf76e-cpu-v2/renderer-cpu.json)成功保存 60,397 个采样、94.315 秒记录的前 60 个热点。[源码归属分析](../../artifacts/rust-rp1-loop/renderer-cpu-863cf76e-v2-analysis.json)绑定同一冻结 ASAR，按保留样本归类：保存校验/目录/持久操作约 8.089 秒，Native 来源与候选 JS 校验约 7.512 秒，GC 约 1.530 秒。其余包括等待及未归类代码；这里只是保留热点中的部分采样时间，不能当作完整阶段墙钟耗时、可直接省下的时间或全进程内存结论。

已确认热点包含保存 checksum、目录重建以及 Native JS 证明中的频繁 UTF-8 编码。后续固定 64 KiB 缓冲候选保留独立完整摘要，定向 **68 pass/1 长测 skip**、完整游戏 **3,178 pass/39 skip**、类型及 Web 门禁通过；相同终局状态的 JS 证明成本中位少约 9.34%（0.512 秒），只计该局部环节。该新候选不在本冻结包内，见[独立记录](./rust-rp1-js-proof-buffer-2026-09-09.md)。

## 范围与后续

源码对应 CI `34344967913` 已结束：单元、生产构建及 Server/Ops/Native 通过，两组浏览器合计 **417 pass/33 skip/29 fail/16 flaky**，整体仍失败。两项启动顺序与精确堆叠路由仍首次通过，不能由总数波动判断这些具体修复。独立 Windows `34344968101` 已通过 Rust/Native，正在完整游戏检查，见[Linux 终态与当时 Windows 进度](../../artifacts/rust-rp1-loop/cloud-863cf76e-linux-summary.json)。旧 c3 云端全量结果不能替代新源码结果。下一步依据实际诊断处理完整入口和保存，继续可信资格、实时单所有者、完整玩法、线程/内存/长测和安装升级回退。目标没有缩小为本批微优化。
