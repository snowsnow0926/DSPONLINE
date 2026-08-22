# 1.1.3 开发报告

状态：候选开发门禁完成；签名、制品和生产门禁已由 Release Agent 完成，正式证据见 [1.1.3 发布记录](./releases/1.1.3.md)。

## 基线与范围

- 生产基线：1.1.2（基线提交 `fe928b4a009a9c385237c0c4f0473fded241e113`）。
- 本候选从 1.1.2 基线隔离工作树构建，移植修复提交 `190b6807c0d32f24221849e548f2f2bc8e15cdae`。
- 运行时不改变 GameState v47、存档 envelope、cloud schema v8、SQLite layout v3 或 IndexedDB records。
- 目标发布版本：1.1.3；previous-stable：1.1.2。

## 修复内容

1. 连续/批量拉线使用一次完整状态复制的隔离草稿，候选逐条在草稿内校验和追加，最终仍整批原子提交；失败不会污染真实状态，避免大批量 O(n²) 状态复制。
2. 合法地热行星允许蓝图施工队列批量补足（包括 100 台及更大目标，只受库存/队列/游戏规则限制）；不兼容行星继续阻止并显示明确原因。
3. Windows/Electron 云存档下载桥接显式传递 GET，避免旧桥接把缺省 method 当成 405。
4. 窄屏双列蓝图卡片保持可用标题列，元数据换行，避免标题竖排错位。

## 门禁结果

- `npm run typecheck -- --pretty false`：通过。
- `npm test -- --reporter=dot`：191 个文件通过，1518 个测试通过，29 个跳过，0 失败。
- `npm run test:server`：服务端 372 通过、2 跳过；station 3/3 通过。
- `npm run test:ops`：56 通过、6 个 Linux-only 跳过，0 失败。
- `npm run test:native`：24/24 通过。
- 相关端到端修复矩阵：74/74 通过（批量/蓝图/云下载及响应式布局覆盖；两项旧版本公告断言更新后复跑通过）。
- `npm run build`：通过；启动菜单 gzip `286698 B`，预算 `286720 B`，禁止静态模块 0。

## 发布前仍需

- 在最终 clean Git SHA 上重新生成 Web/API/desktop/native/download-site 制品和不可变 component manifests。
- Android 必须由受保护签名加载器注入长期签名环境，并验证 APK v2/v3 与历史证书连续性；禁止使用诊断/未签名包进入 stable。
- Windows 按既有策略标记 `NotSigned`，不创建新证书。
- 逐节点执行备份、磁盘、健康、原子切换、公开 smoke、缓存/Range 和回滚门禁；任一失败即 No-Go，不做部分发布。

本报告对应的开发阶段没有连接或修改生产环境；后续正式切换、备份、回滚和公网验收均记录在 [1.1.3 发布记录](./releases/1.1.3.md)。
