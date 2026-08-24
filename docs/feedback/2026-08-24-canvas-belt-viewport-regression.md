# 画布传送带平移/缩放错位修复记录

## 现象

密集传送带启用 Canvas 批量渲染后，画布平移或缩放期间，线路会暂时或持续偏离建筑端口。截图中表现为线路整体落在端口旁边，而 React Flow 的卡片和交互边仍在正确位置。

## 根因

`CanvasBeltLayer` 的绘制视口由 `onMove` 通过 ref 实时更新；组件的 `viewport` prop 却绑定了只服务蓝图预览的 `pendingBlueprintViewport`。当缩放触发延迟的细节/Lod 重渲染时，旧 prop 重新进入 Canvas 层的同步 effect，把刚完成的平移/缩放视口覆盖回旧值。屏幕空间 Canvas 仍按新视口以外的值绘制，导致线路和端口分离。

## 修复

- 批量 Canvas 层初始/重渲染时读取统一的 `viewportRef.current`，不再回放蓝图专用的旧视口。
- 书签等程序化视口切换在调用 React Flow 前同步 ref、预览状态和 Canvas 层。
- 增加绘制视口诊断属性，便于在浏览器中验证屏幕空间坐标；不包含存档、账号或生产数据。

## 验证

- 新增 `tests/e2e/v116-belt-rendering.spec.ts`：200 条密集多端口线路在初始视图、两次缩放和大幅平移后，源/目标端点均保持在端口边缘 6px 内，并确认 Canvas 不在 React Flow viewport 内。
- 画布专项 E2E：7/7 通过（含极限画布、性能监控和 Canvas 回退）。
- 全量 Vitest：178 个文件通过，1468 个测试通过，21 个跳过，0 失败。
- Server：核心 376/376、空间站 4/4 通过。
- `npm run build` 与启动预算通过。
- Playwright 截图：`artifacts/qa/v117-belt-viewport-initial.png`、`artifacts/qa/v117-belt-viewport-pan-zoom.png`。

本记录对应开发分支提交 `722503b`；尚未生成新发布制品，也未连接或修改生产环境。
