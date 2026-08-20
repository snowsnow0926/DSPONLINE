# 1.1.2 开发报告：本地存档协调误报修复

> 日期：2026-08-21
> 状态：开发候选完成，未发布生产
> 运行时提交：`48d70aa5de065704d7360683f5be8cabd5c7c2e6`
> Build ID：`1.1.2+48d70aa5de06`
> Android versionCode：`1001002`

## 问题与根因

1.1.1 的延迟 rolling backup 会在页面 cache 之后推进 durable revision。后续同页手动/生命周期保存只看到 backup revision 变化，无法区分“同一 writer/fence 的完整延续”和“真正另一标签页接管”，于是错误显示跨标签覆盖对话框。截图中的时间顺序和隔离最小复现均确认该结论。

## 实现范围

1.1.2 只改浏览器本地 IndexedDB 协调：

1. same-fence rolling backup 只在 payload、catalog、revision、writer、fencing token、mode/slot、checksum 和 savedAt 连续时 rebase。
2. emergency mirror 先原子取得过期 lease，再验证完整 lineage；验证失败统一保留 current/candidate 双份。
3. 新增同页 deferred-backup 回归、关闭旧窗口 mirror 回归和真实大存档自动保存回归。
4. 版本说明与测试夹具更新到 1.1.2；保留 1.1.1 历史说明。

不改变玩法数值、GameState v47、save envelope v2、cloud schema v8、SQLite layout v3、IndexedDB schema、云端 API、排行榜或原生签名边界。

## 门禁结果

| 类别 | 结果 |
| --- | --- |
| TypeScript/build/budget | 通过；未提高既有预算 |
| Vitest | 190 files：1,514 pass / 29 skip |
| Server + station | 363/2 + 3/3 |
| Ops | 56/6 |
| Native tooling | 24/24 |
| Chromium 专项 | 50 pass / 1 skip |
| 用户附件真实回归 | 1/1 pass；源附件只读 |

完整根因和附件证据见 [反馈证据](./feedback/2026-08-21-1.1.2-local-save-false-conflict.md)。

## 未完成发布门禁

本报告不构成发布授权或发布成功记录。仍缺：独立 clean checkout 复验、冻结 Web/API/native/download manifests、正式 Android 受保护签名与证书连续性、Windows 包验收、目标节点新鲜备份 evidence、原子切换/回滚、公网 smoke、PWA/cache/Range 验收及任何用户要求的真实设备观察窗口。
