# Android Worker 异常与运行记录刷新

2026-11-14，Role develop，优先级 P1。用户提供的聊天截图反馈新版 Android 可以进入工厂，但出现 Worker 报错和运行记录持续刷新。玩家另称与存储权限有关，具体权限项和操作结果未知，原机型号及 WebView 版本未知。

附件为 codex-clipboard-0f515aa9-1f82-4a11-bf1d-fb8275306bbb.png 与 codex-clipboard-039d6342-3ed8-49db-bf24-00232677f585.png。开发基线为已发布 1.3.13 的完整提交 f69b90abbf3cc2f4970597169c26b99a63c6a974。

## 已确认原因

正式 1.3.13 编译资源 1.3.13+59c3bcddbe36 在仅移除 Worker 的 Array.prototype.at 后，实际建厂及采集操作重现 t.path.at is not a function。五秒内创建了 68 个模拟 Worker，运行记录持续追加同一异常，存储访问设置保持原测试条件。调用对应 simulationRuntimeProtocol.ts 中命令补丁对 patch.path.at(-1) 的访问。

App 的 runtimeError 分支在精确恢复期间再次失败时，新建恢复记录并把 attempts 置为 0。已有的 error 事件路径带有次数上限，两种错误路径的计数需要共用。

## 修复

- compat/runtime.ts 对缺失的 Array.prototype.at、Object.hasOwn 及 structuredClone 提供统一能力适配，复用固定版本 core-js-pure。
- 主界面、共享模块和全部 16 个 Worker 接入运行时入口。已有原生方法的身份及属性描述符经过检查。
- 精确恢复的两类错误共用计数，累计三次恢复失败后停止自动重建，保存暂停视图、已确认状态和原主档。
- 回归覆盖原生环境、仅缺少 structuredClone、仅 Worker 缺少 at、主界面及 Worker 同时缺少相关接口四类环境，以及持续 runtimeError 的停止重试和主档保护。

## 存储权限说法

主档沿 localSaveStore.ts 的 IndexedDB 事务写入及逐字读回路径保存，设备偏好和协调信息使用 localStorage。Capacitor Bridge 启用了 DOM storage，AndroidManifest 声明的权限为 INTERNET，导出通过私有导出目录及 FileProvider 分享。Android 官方说明应用私有目录读写具备默认访问权。[Android 私有存储说明](https://developer.android.com/training/data-storage/app-specific#internal)。

当前实验确认了截图中 Worker 异常和反复重建的原因。玩家是否启用某个权限后恢复，以及是否另有独立的 IndexedDB 或导出故障，需要原始操作结果和完整错误信息来确认。

## 验证与交付

已执行完整单元测试，443 文件通过、16 文件条件跳过，3975 项通过、38 项跳过。兼容层和协议定向单元 22 项通过。原始复现、能力注入、截图和追踪文件保存在本工作树 artifacts/android-worker-compat-20261114/，大体积测试输出位于 D 盘独立任务目录。

完整浏览器回归、编译成品检查和同签名 Android 修复包在本轮继续验收。存档格式边界为 GameState v47、envelope v2、云 schema8、SQLite layout3。
