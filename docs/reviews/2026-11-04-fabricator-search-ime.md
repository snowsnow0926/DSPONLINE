# 制造搜索打字消失：排查与修复（2026-11-04）

本地修复及针对性验收已完成，尚未发布。当前线上及原生下载仍以 [1.3.6 正式记录](../releases/1.3.6.md) 为准。

玩家截图指向“完整检查器 → 基础制造 → 物品手工”的搜索框。输入丢失按 P1 修复，同时修复测试中确认的横屏最近搜索被底栏遮挡问题（P2）。分支 `codex/fix-fabricator-search-20261104`，复用现有 D 盘工作树；未覆盖主工作区的未提交资料。

## 玩家能看到的变化

- 中文输入法还在拼字、尚未选定汉字时，工厂继续刷新也会保留输入和光标。
- 确认汉字后正常筛选；正常清空、英文输入、最近搜索回填和清除继续可用。
- 横屏历史词列表会选择较宽裕的上下方向，长列表可滚动；搜索和批次数量并排，减少对结果区的占用。

## 复现与原因

使用正式运行 `187ae5bd4d2eefcaf6f1192b51193c04cea54293` 冻结 Web 包，本机隔离预览中打开实际完整检查器，游戏保持运行。向原生输入框放入预编辑缓冲 `dian` 并发出 compositionupdate，刻意让游戏刷新发生在随后 input 事件之前。1.2 秒后的检查发现正文已变成空串。旧包的浏览器失败、截图及 trace 均保留；不是只从源码推测。

原控件虽然用组合输入标志保护状态 effect，仍给 DOM 绑定 React `value={draft}`。浏览器预编辑区先改变而 React 草稿尚未收到 input 时，父层渲染会直接恢复旧的受控值，绕开那层 effect 保护。

输入框和文本域现在用非受控 DOM 保留原生正文；外部值的真实变更在非组合输入时显式同步。仍通过既有 input/compositionend/blur 更新页面草稿及调用方，保持 `commitOnBlur` 和 forwarded ref 的行为。搜索草稿不新增持久化，密码依旧禁止进入共享草稿。

## 同时修复的搜索布局

初次浏览器组合中，桌面和竖屏输入通过，横屏在点击历史第二项时被底部导航挡住。修复根据检查器实际内容区和 visualViewport 计算方向与最大高度，排除横屏标题占用的顶部留白；选项区独立滚动。仅历史展开时监听窗口/面板变化，不加入模拟循环。

搜索边框按内容增高，容纳手机 44px 输入控件；横屏将搜索与批次数量并排，避免工具区过高。回归保留原来失败的历史第二项点击，并新增弹层上下边界、清除按钮和横屏“最大”按钮边界检查，没有使用 force click。

## 本轮最终验证

| 检查 | 结果 |
| --- | --- |
| TypeScript | 通过 |
| components / hooks / i18n 单元 | 55 文件，305 通过，0 跳过，0 失败 |
| 实际网页 Chromium 专项 | 8 通过，0 跳过，0 失败，0 flaky |
| 屏幕与字号 | 3 个视口 × 4 个字号，共 12 组合及 12 张截图 |
| Web 构建、首屏预算 | 通过，首屏 gzip 182,238 B，无禁止的首屏模块 |
| 原生薄界面 / 覆盖清单 | 13 个 App binding、12 个专用组件及覆盖检查通过 |

三个视口为桌面 1440×900、竖屏 390×844、横屏 844×390；字号为 80%、100%、125%、150%。每组检查后台刷新前后的原生预编辑文字、光标与焦点、汉字确认及真实配方结果、可用高度缩小再恢复、最近词选择及清空。额外覆盖既有制造/材料跳转、星图备注、注册字段与密码隔离、蓝图和书签输入。文本域预编辑缓冲、外部回填与清空、ref、失焦提交及草稿恢复也有单元覆盖。

最后一批八项浏览器检查全部在最终源码与同一构建上完成，耗时约 65.8 秒；单元约 71.5 秒。早期的同组通过数不累加。中间一批既有制造用例的全局 `.item-hover-card` 选择器遇到两个短暂共存的卡片；源码本就允许 220ms 关闭宽限。测试改为定位“磁线圈快捷操作”这一真实目标，保留配方材料及用途断言并增加可见性断言，定向及最终完整八项均通过，未改 tooltip 运行代码。

所有验证使用合成状态、本机回环地址和隔离浏览器数据；本机关闭 API 的拒绝连接日志不代表生产云端故障。没有使用真实玩家账号、云存档正文或生产写测试。

## 制品、原始证据与后续发布边界

- [验收摘要及运行源码摘要](../../artifacts/fabricator-search-20261104/verification.json)
- [最终单元结果](../../artifacts/fabricator-search-20261104/ui-unit-results-final.json)、[最终浏览器结果](../../artifacts/fabricator-search-20261104/preview-browser-final.json)
- [旧 1.3.6 复现日志](../../artifacts/fabricator-search-20261104/baseline-browser.log)、[首轮历史遮挡](../../artifacts/fabricator-search-20261104/preview-browser.log)、[中间 tooltip 定位失败](../../artifacts/fabricator-search-20261104/preview-browser-02.log)
- [开发 Web 文件摘要](../../artifacts/fabricator-search-20261104/web-files.json)，198 文件冻结在 `artifacts/fabricator-search-20261104/web-dist`；这是开发预览，不是可直接投产的正式发布包。
- [竖屏 150% 截图](../../artifacts/fabricator-search-20261104/screenshots/fabricator-search-portrait-1.5.png)、[横屏 150% 截图](../../artifacts/fabricator-search-20261104/screenshots/fabricator-search-landscape-1.5.png)、[桌面截图](../../artifacts/fabricator-search-20261104/screenshots/fabricator-search-desktop-1.png)。

没有修改模拟、配方、库存结算、存档格式、后端、发布指针或备份设置，没有重建或替换 Android / Windows 安装器。GameState v47 / envelope v2 / 云 schema v8 / SQLite layout v3 保持。

真实手机的系统输入法和软键盘尚未实机验证；本轮是 Chromium 移动视口及事件时序验证。没有重跑完整引擎、Rust、服务端或整版发布矩阵，也不宣称额外的大档性能百分比。开发预览保留 dirty 构建来源和逐文件摘要；后续正式发版须从已提交源码重建版本与制品，并执行对应完整发布门禁。
