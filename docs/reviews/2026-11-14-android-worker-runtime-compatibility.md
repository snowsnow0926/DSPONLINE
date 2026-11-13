# Android Worker 异常与运行记录刷新

2026-11-14，Role develop，优先级 P1。用户提供的聊天截图反馈新版 Android 可以进入工厂，但出现 Worker 报错和运行记录持续刷新。用户后续确认，存储权限说法属于玩家猜测。原机型号及 WebView 版本未知。

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

当前实验确认了截图中 Worker 异常和反复重建的原因。隔离模拟器中，已安装 APK 的 SHA-256 与候选相同，外部存储权限请求列表为空，实际保存、覆盖安装与冷启动通过。玩家原机的具体 WebView 版本和权限配置待回访。

## 验证与交付

干净运行提交为 5112ef433c3635f902d9038823de7059b1c57bcf，构建号为 1.3.13+5112ef433c36。

| 检查 | 通过 | 条件跳过 | 失败 |
| --- | ---: | ---: | ---: |
| 完整单元 | 3975 | 38 | 0 |
| 定向兼容及协议单元 | 22 | 0 | 0 |
| 完整 Chromium | 652 | 34 | 0 |
| 定向兼容及持续异常 Chromium | 5 | 0 | 0 |
| Android 编译成品 Chromium | 4 | 0 | 0 |
| 可选持久恢复及内容包转换 | 25 | 0 | 0 |
| 生产 Web 手机及 PWA | 9 | 0 | 0 |
| Node 原生工具 | 639 | 1 | 0 |

类型、Web/Android 构建、启动预算、原生边界与覆盖、128 个运行依赖许可证核对通过。全部 16 个 Worker 的首个模块导入有边界回归。持续 runtimeError 注入验证初次故障后的三个恢复尝试，失败后五秒内 Worker 数量稳定，画面物资和已验证主档逐字保留。

APK/AAB 通过历史证书连续性，APK v2/v3 和 zipalign 通过，每包 209 个封装资源逐件一致。隔离断网模拟器完成正式 1.3.13 到同版本候选的 63 步实际操作，旧库存 4 保留，采集并显式保存到 7 后冷启动仍为 7，暂停及 firstInstallTime 保留，包级 crash/ANR 为 0。安装后的 APK 摘要也已重新核对。

| 本地候选文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| dsp-idle-1.3.13-1003013-worker-compat-5112ef433c36.apk | 6201652 | 00897f5123af392c26e551fe33766eca22bf43e819b28dc40fed6ce84c308cd7 |
| dsp-idle-1.3.13-1003013-worker-compat-5112ef433c36.aab | 5990988 | d44c80677a9826b58bcac1dd484febe9a4316de3cbaa5d9fa15dc9996a6cb8a7 |

本次交付为同签名的本地安卓复测候选，versionName 为 1.3.13，versionCode 为 1003013，通过新构建号及带源码摘要的文件名识别。成品目录为 D:/GameDev/WorkArtifacts/DSPidle2/android-worker-compat-20261114/candidate/android/。Web 200 件冻结文件的 aggregate 为 9f06f4d67c4817e3d91b1c507aba8e0b003200672d0327caf8983fda4fd73934。

验收汇总保存在本工作树 artifacts/android-worker-compat-20261114/delivery-proof.json，包含正式旧 APK 的 207 件编译资源匹配、原始异常和 68 次创建记录、各软件矩阵、签名和安装后摘要证明。日志、复现截图及追踪输出同目录保存，大体积测试输出位于 D 盘独立任务目录。早期驱动的文本选择器、初始化时机和 Worker 总数预期已修正后复验，三斜线类型引用也已置于兼容导入之前并通过类型检查。

存档格式边界为 GameState v47、envelope v2、云 schema8、SQLite layout3。实体原机复测为待完成项。
