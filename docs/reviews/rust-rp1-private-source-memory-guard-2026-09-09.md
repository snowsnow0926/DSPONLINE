# Rust RP1 终局诊断的外部内存监控

Role: develop。此项落实用户的后台及低负载要求，为后续终局档验证做准备；未运行新的私人存档诊断，未产生玩家性能结论。

现有 Node 诊断内部的定时检查不能中断同步 JSON 解析、完整哈希或 JS 参考计算。因此另用独立 PowerShell 进程监控它，通过本次 `Process.Start` 返回的进程句柄停止自己的 Node 及后代；不按名称批量终止进程，不接触其他桌面应用。

私人入口固定要求启动前至少 6 GiB 可用物理内存，每约 500 ms 加一次实际内存查询检查，低于 1.5 GiB 就停止本任务进程树；另有 900 秒诊断总时限。Node、Host 保持低于正常优先级，Host 两线程，全部启动不创建窗口。保留内部 Host 请求 300 秒及 1–30 秒候选限制；外部总时限不是游戏超时。

来源继续使用已登记的原文件，入口要求显式 Host 路径、SHA-256、来源提交和唯一输出名，实际 Node 驱动验证干净源码及运行代码对应关系。监控结束后再次对登记原文件做完整 SHA-256/字节数核验；只有进程正常退出、应用完整报告 PASS、原文件匹配三者同时成立才记为通过。强制停止会保留失败及日志，不冒充应用完成；若 Node 来不及执行清理，不得声称其临时数据已清除。

## 本次实际验证

公开合成自测 **3/3 通过**：

1. 子 Node 启动自己的后代后，在同步等待中阻塞事件循环；独立监控注入低内存读数，确实停止两个自有进程，结果保持 FAILED / memory-floor。
2. 普通子 Node 正常退出，记录 PROCESS_EXITED_NORMALLY，不误判停止。
3. 启动前注入低内存，拒绝执行且不创建证据目录。

自测使用模拟读数，没有制造真实内存耗尽，未打开私人存档或游戏窗口；其通过只验证监控行为。实际私人入口没有注入读数选项，仍查询系统真实可用内存。结果为原工作区 `artifacts/rust-rp1-next/external-memory-guard-public-v1/result.json`，两次执行回执在 `forced-floor/guard.json` 和 `normal/guard.json`。

本地诊断脚本均位于原工作区 `artifacts/rust-rp1-next/`，未加入发布包或上传云端：

| 文件 | SHA-256 |
| --- | --- |
| `invoke-rp1-guarded-node.ps1` | `ef48d6d7f8e99fd5e546af9f517a045010484ec0b3cc2405011dbbe7b779f51e` |
| `run-private-runtime-source-guarded-v1.ps1` | `b1d00f7d07c818f55efa6bc763e801d6c0cbbfdca5795ac40097dba6d08c9f99` |
| `probe-private-runtime-source-v2.mjs` | `9954eb1faf92026e32885e786c69b8cd3cebac1e63dacde44739efdd5511da58` |
| `test-rp1-external-guard-v1.ps1` | `56dbef908c0596c5e6435c3d7925a6971c39556e2dad5f3a44190517dee59240` |

新 Host 和私人验证尚待[读取缓冲阶段](./rust-rp1-v47-read-buffer-2026-09-09.md)的完整云端门禁，以及本机真实资源条件满足。
