# Android 新建工厂缺少 structuredClone

2026-11-13，Role develop，优先级 P1。玩家确认 Android 1.3.12 点击“建立工厂”后显示 `structuredClone is not defined`。手机型号、系统及 WebView 版本暂未知。来源为附件 `codex-clipboard-257465a3-2469-4a4b-a362-2f75dd454990.jpg`。

## 原因与复现

正式 APK 的 SHA-256 为 `d8b78f5c7f5644ffad56be4e5d8382cc0e7b453337ce81fd1c26cef3862f756f`。本机用于复现的 209 个封装资源与该包逐件一致，版本为 `1.3.12+75724d4a0129`。

在隔离浏览器中移除 `globalThis.structuredClone` 后，主菜单能够打开，点击“建立工厂”立即重现相同错误。CDP 捕获到正式 `assets/contentPacks-Ndg68EUH.js:1:10058` 在物品定义复制期间抛出 ReferenceError。调用链为 `StartMenu.startNewGame()` → `loadStorageModule()` / `loadFactoryStartupModules()` → 内容包模块初始化。Promise.all 在新工厂 `saveGameVerified()` 之前失败，错误显示到主菜单。

原生 `structuredClone` 是对象图复制接口，ArrayBuffer 转移涉及原缓冲区分离，兼容处理须覆盖对应语义。接口资料见[MDN structuredClone](https://developer.mozilla.org/en-US/docs/Web/API/Window/structuredClone)。

## 本地修复

运行源码提交为 `d41282234ef5ac21f37676bb637b642a2e8eec58`，后续 `5af0d6b7` 只调整安卓界面回归脚本。公开发布基线为此前的 `1.3.12+75724d4a0129`。

- `src/compat/structuredClone.ts` 接入固定版本 `core-js-pure@3.51.0`，缺少全局方法时同步安装兼容实现。
- 主入口和使用该方法的共享模块接入兼容层，覆盖主界面、内容包、模拟与存档 Worker，以及 React Flow 连接交互。
- 原生方法存在时验证其函数身份，缺失时验证 undefined、BigInt、NaN、Infinity、负零、Date、Map、Set、循环与共享引用、typed array 和 ArrayBuffer transfer。
- 对不可克隆值、重复 transfer 的错误路径核对原缓冲区完整性，保存与刷新后的主档逐字读回。
- 许可证更新至 128 个运行依赖，原生覆盖清单按维护脚本重新生成，29 个写入面核对通过。

## 验证

| 检查 | 结果 |
| --- | --- |
| 完整 Vitest | 442 文件通过，16 文件条件跳过，3971 项通过 / 38 跳过，0 失败 |
| 兼容单元 | 3 项通过，包含缓冲区分离及失败原子性 |
| 相关 E2E | 存档协调、手机滚动、内容包与原版转换 55 项通过 |
| 源码兼容专项 | 原生 API 与缺失 API 各 1 项，共 2 项通过 |
| Android 编译成品 | 两类环境共 2 项通过，新建、Worker active、手机更多页保存、刷新逐字读回、重新进入完成 |
| 类型 / 许可证 | 通过 |
| Web / Android 构建 | 通过，启动预算、薄界面边界及原生覆盖通过 |

兼容专项在主界面及 Worker 中移除 structuredClone、PerformanceMark 和较新的 ArrayBuffer transfer 方法，以验证 MessageChannel 分离路径。Worker 测试通过入口注入，使用原始脚本加载和消息排队。普通环境同时检查原生函数身份。

早期 CommonJS 方案在 Vite 开发入口触发 require 错误，现采用 ES 模块适配。最初 Blob Worker 驱动产生额外消息排队问题，已改为在 Worker 入口注入能力缺失。Android 手机页的暂停重复标签和保存按钮描述由可见 role 与真实“更多 → 保存并返回”操作匹配。原始失败、trace 与修正后的通过记录保留。

## 冻结载荷与范围

干净源码 `d41282234ef5` 的 Web 200 件、Android 编译载荷 208 件冻结于 `D:/GameDev/WorkArtifacts/DSPidle2/android-structured-clone-20261113/`。清单由维护工具在相同提交生成并逐文件复验。

- Web aggregate 为 `473d273a6d73ede2ba3be6475e6f2e1d94f3d146a2391eedd9528ff616f43408`。
- Android aggregate 为 `265ed3cbf7607ac642b8d87b5e5c04600eb946c9d96d178f2fdd8fabdc025ae3`。
- 原始证明位于本工作树 `artifacts/android-structured-clone-20261113/`，包括正式包资源核对、复现异常栈、最终单元、E2E、构建和清单。

当前交付为本地兼容修复与编译验证载荷。玩家原机、真实 WebView 版本以及后续正式 APK 与发布矩阵属于待验证范围。
