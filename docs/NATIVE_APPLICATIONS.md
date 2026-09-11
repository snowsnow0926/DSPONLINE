# 原生应用构建与更新

> 当前发布版本：Web/Windows `1.0.38`；Android 正式包 `1.0.38 / 1000038`
> 1.0.37 是当前代码、下载和香港 previous-stable 的直接回滚版本；1.0.38 已写入两地 Web/API 和上海公网更新清单。
> 当前公开稳定版本：Windows `1.0.38` 未签名测试包；Android `1.0.38 / 1000038` 正式签名包
> Windows 包名：`com.dspidle.network`
> Android applicationId：`cn.dsponline.network`
> Web、Windows 与 Android 1.0.38 共用 `GameState` v46。两端存档 envelope v2 和云 schema v7 不变；旧存档通过连续守恒迁移载入。
> 公开下载入口：`https://download.dsponline.cn/`，文件由上海节点提供，不消耗香港游戏节点流量。

> 1.0.38 已使用既有 Android 长期证书生成正式 APK/AAB，并生成 Windows 安装程序；APK 与 Windows setup 已进入上海公网更新清单，AAB 只作归档。用户只豁免精确候选 `1.0.38-351c649af9ee` 的 Android 真机、低配 Windows、`1.0.37 → 1.0.38` Windows 覆盖升级与约一小时后台/锁屏门禁，签名连续性、模拟器升级和隔离启动不能描述为实体设备长时通过。

> `1.0.38` 正式制品来自 clean source `351c649af9eedb22f56f47a6cd06c14cedce6221`。Release Agent 使用既有长期 Android 证书重建并验证 APK v2/v3、zipalign、证书连续性、正式 URL 和 API 36.1 模拟器 `1.0.37 → 1.0.38` 原地升级；Windows setup 的包内 Build ID、正式 URL 与隔离 profile 通过，Authenticode 继续按历史策略为 `NotSigned`，没有创建新证书。完整哈希、下载和豁免边界见 [1.0.38 正式发布记录](./releases/1.0.38.md)。

> 1.0.38 开发阶段的 unsigned Android 与 Windows unpacked 诊断制品只用于复验，现已由同一 clean source 的正式制品替代；它们没有进入 stable feed 或下载页。

## 1. 架构边界

- Windows 使用 Electron，加载本地 `dist/`，启用 context isolation、sandbox、单实例和受限 IPC。
- Android 使用 Capacitor 8，加载打包进 APK 的同一套 Vite 资源，默认采用新版手机 UI，经典 UI 仍可回退。
- PWA 在 Electron 和 Android 中不注册，避免 service worker 与安装包版本形成双重更新源。
- 原生生命周期只触发既有保存流程，不修改模拟步长、GameState 或云存档格式。
- Android 与 Windows 各自保留本机应用数据。覆盖安装和同签名升级不会清除本地存档；卸载应用仍会删除系统应用数据，因此正式发布前必须继续提供导出和云存档。
- Android JSON 导出通过应用缓存目录与系统分享面板完成；Web/Electron 继续使用浏览器下载。
- Android 原生 HTTP 桥不能可靠传输浏览器生成的 gzip Blob。1.0.34 起，Android 云存档上传预先发送原始 JSON 字符串并遵守 30 MiB 客户端安全上限；Web/PWA 的流式 gzip 和 `expectedRevision` 冲突保护不变。该兼容只作用于云存档请求，不关闭 CapacitorHttp，也不改变 GameState、envelope 或云 schema。
- 社区构建默认不连接官方云 API、账号深链或更新源。官方地址只由受保护的发布 CI 显式注入；Electron 会把允许的 API 和更新基址写入包元数据，运行时不依赖玩家机器环境变量。

## 2. 开发环境

共同要求：

```powershell
npm ci
npm run typecheck
```

Windows 目录包：

```powershell
npm run desktop:pack
```

Android 要求 JDK 21、Android SDK 36 和 Build Tools。当前 Wrapper 固定 Gradle 8.14.3，并使用带 SHA-256 校验的腾讯云镜像以避免 GitHub 分发下载超时。

```powershell
$env:JAVA_HOME = "C:\Program Files\Eclipse Adoptium\jdk-21.0.11.10-hotspot"
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
npm run android:debug
```

调试 APK 位于 `android/app/build/outputs/apk/debug/app-debug.apk`。它使用 Android 调试证书，只能试玩，不能进入稳定更新源。

## 3. 版本与通道

- `package.json.version` 是 Windows `app.getVersion()` 和 Android `versionName` 的来源。
- Android 稳定版默认把 `major.minor.patch` 映射为 `major * 1,000,000 + minor * 1,000 + patch`；`1.0.0` 对应 `1000000`。
- Beta、Nightly 或 SemVer prerelease 必须显式设置新的 `DSP_ANDROID_VERSION_CODE`，避免 Android 认为新包不是升级。
- `DSP_RELEASE_CHANNEL` 只允许 `stable / beta / nightly`。平台构建脚本把同一通道写入 Vite 常量、Android 版本属性和 Electron 打包元数据；安装后不会回落到 Stable。
- `DSP_DESKTOP_API_BASE_URL`、`DSP_UPDATE_BASE_URL`、`DSP_ANDROID_API_BASE_URL`、`DSP_ANDROID_UPDATE_BASE_URL` 和 `DSP_ANDROID_PUBLIC_ORIGIN` 都是可选的显式 HTTPS 配置。缺省表示社区离线构建，不使用官方回退值。完整说明见 [COMMUNITY_BUILDS.md](./COMMUNITY_BUILDS.md)。

## 4. 正式签名

Windows 正式安装包需要：

```text
CSC_LINK
CSC_KEY_PASSWORD
```

`npm run desktop:release` 在缺少签名配置时会失败；`npm run desktop:dist` 仅用于本机未签名验收。

当前公开的 Windows `1.0.38` 是明确标注的未签名测试安装包。它已通过构建、隔离启动、更新清单和下载校验，但 Windows 仍会显示“未知发布者”或 SmartScreen 提示；取得可信代码签名证书之前不得描述为正式签名版。

Android 正式包需要长期保管且永不更换的 keystore：

```text
DSP_ANDROID_KEYSTORE
DSP_ANDROID_KEYSTORE_PASSWORD
DSP_ANDROID_KEY_ALIAS
DSP_ANDROID_KEY_PASSWORD
```

正式命令：

```powershell
npm run android:release
```

没有这些变量时可用 `npm run android:release:unsigned` 验证 Release 编译，但未签名 APK/AAB 不得交付玩家。密钥、密码和证书私钥不能提交到 Git、文档、日志或 VPS Web 目录。

Android `1.0.38` APK 已使用与 `1.0.0` 至 `1.0.37` 相同的长期发布密钥签名，证书 SHA-256 为 `ede2aa09ed143a3fbeb283aad0e7801d192c851f240cd39278c399918a0216ce`。APK Signature Scheme v2/v3 均通过；当前本机受保护发布库位于 `<LOCAL_SIGNING_VAULT>`，包含长期证书材料，目录 ACL 仅允许本机系统账户与开发账户访问。密钥文件、密码和私钥仍不进入 Git、VPS 或公开文档内容。GitHub Actions Secrets 尚未配置，但本机长期 keystore 已恢复。

使用该 vault 构建的 Android `1.0.33` APK 已验证包名 `cn.dsponline.network`、versionCode `1000033`、APK Signature Scheme v2/v3 和相同证书指纹；大小为 4,834,527 字节，SHA-256 为 `14232dd3273ad951acf36d0a97488912e978ae0cd6da3f5cf1104f82419bedeb`。该文件已进入上海稳定下载页与 Android stable 清单。

`1.0.34 / 1000034` 正式 APK 使用同一长期证书生成，大小为 4,841,083 字节，SHA-256 为 `d556e6f3690cbe709d0f493019b55fdadc20658ef865bef9cbc71b1b1511a49e`。APK v2/v3、zipalign、证书连续性和 Android API 36 模拟器 `1.0.33 -> 1.0.34` 的 `install -r` 覆盖升级均已通过，`firstInstallTime` 不变且启动无 Fatal/ANR；该文件已写入公网 stable 清单和下载页。

`1.0.35 / 1000035` 正式 APK 使用同一长期证书生成，大小为 4,861,729 字节，SHA-256 为 `56598fecf674c05141535a4fa99b868c16b4c6ccc6acdf7358a6f305a3c8e88a`。APK v2/v3、zipalign、证书连续性和 Android API 36.1 模拟器 `1.0.34 -> 1.0.35` 的 `install -r` 覆盖升级均已通过，`firstInstallTime` 不变且启动无 Fatal/ANR；该文件已写入公网 stable 清单和下载页。物理真机门禁由用户只对该候选明确豁免。

`1.0.36 / 1000036` 正式 APK 使用同一长期证书生成，大小为 4,879,486 字节，SHA-256 为 `38d5c72e814782303ba884cca96ef0219a9b8d67bb1906f99d18de9a2c467a6b`。APK v2/v3、zipalign、证书连续性、内置正式 API/更新源和公网完整哈希均通过；该文件已写入 stable 清单和下载页。Android 物理真机、`1.0.35 -> 1.0.36` 覆盖升级和本地存档保留未执行，由用户只对该候选明确豁免。

`1.0.37 / 1000037` 正式 APK 使用同一长期证书生成，大小为 4,887,137 字节，SHA-256 为 `5ab6a8a2e78e9c0364cc9249e0ef31f526e4959696815dd1ee79978a649fdd87`。APK v2/v3、zipalign、证书连续性、内置正式 API/更新源和公网完整哈希均通过；4,676,013 字节 AAB 只归档。Android 物理真机、`1.0.36 → 1.0.37` 覆盖升级和约一小时后台门禁未执行，由用户只对该候选明确豁免。

`1.0.38 / 1000038` 正式 APK 使用同一长期证书生成，大小为 4,901,515 字节，SHA-256 为 `9e04137021c90400ed6b547fce0e982c2f3a737b58439ad27618b47841c825c6`。APK v2/v3、zipalign、证书连续性、内置正式 API/更新源和公网完整哈希均通过；API 36.1 模拟器从正式 1.0.37 使用 `adb install -r` 覆盖升级后 `firstInstallTime` 不变、应用前台运行且无 Fatal/ANR。4,690,466 字节 AAB 只归档，常规 JAR 数学验证与证书连续性通过；严格 JAR 输入流结构警告作为已记录风险保留。Android 物理真机和约一小时后台/锁屏门禁由用户只对该候选明确豁免。

本机发布前只在受保护 PowerShell 会话中从该 vault 读取配置，不把密码回显到终端：

```powershell
$vault = '<LOCAL_SIGNING_VAULT>'
# 从 android-release-v1.properties 读取 keystorePath、storePassword、keyAlias、keyPassword
# 设置 DSP_ANDROID_* 环境变量后运行 npm run android:release
```

若本机 vault 不可读，发布必须停止并恢复同一文件，不能生成新证书替代。

## 5. 更新源

官方 Windows CI 显式配置 `DSP_UPDATE_BASE_URL=https://dsponline.cn/downloads/desktop`，签名应用读取：

```text
https://dsponline.cn/downloads/desktop/stable
https://dsponline.cn/downloads/desktop/beta
https://dsponline.cn/downloads/desktop/nightly
```

官方 Android CI 显式配置 `DSP_ANDROID_UPDATE_BASE_URL=https://dsponline.cn/downloads/android`，签名应用读取：

```text
https://dsponline.cn/downloads/android/stable.json
https://dsponline.cn/downloads/android/beta.json
https://dsponline.cn/downloads/android/nightly.json
```

Android 清单只接受 schema v1、`cn.dsponline.network`、当前通道、同源 HTTPS 且位于 `/downloads/android/` 的 APK。发布工具默认拒绝文件名包含 `debug` 或 `unsigned` 的 APK，并要求用 `apksigner` 验证 APK Signature Scheme v2+ 和批准的证书 SHA-256 指纹。

Android 1.0.38 的稳定清单将 `minimumSupportedVersionCode` 保持为 `1000002`：1.0.2～1.0.37 均能检测到 1.0.38 更新。服务端继续接受合法 v35-v46 存档，客户端不允许把 v46 有损降级。受支持版本进入应用版本卡时会自动检查一次并保留手动重试。

示例：

```powershell
node scripts/create-native-update-manifests.mjs `
  --base-url https://dsponline.cn/downloads/ `
  --channel stable `
  --android-apk android/app/build/outputs/apk/release/app-release.apk `
  --android-certificate-sha256 <公开证书指纹>
```

生成器没有默认发布域名，必须传入 `--base-url` 或设置 `DSP_NATIVE_UPDATE_BASE_URL`。Windows 的 `latest.yml`、安装程序和 blockmap 由 `npm run desktop:release` 整理到 `release/update-feed/desktop/<channel>/`。Android JSON 与 APK 整理到 `release/update-feed/android/`。这些命令只生成待发布目录，不上传服务器。

## 6. CI 与发布门禁

- `.github/workflows/desktop-release.yml` 使用 Windows 代码签名机密生成安装包和桌面更新目录。
- `.github/workflows/android-release.yml` 从 GitHub Secret 临时恢复 keystore，生成签名 APK/AAB，并校验批准证书后生成更新清单。
- CI 只上传 GitHub Actions 制品，不自动部署 VPS。
- 两个发布 workflow 的 token 权限为只读，并显式注入官方 API、公开 origin 和更新基址；普通 Pull Request CI 不接收这些配置或签名 secrets。
- 向正式更新目录发布前仍需核对版本、通道、SHA-256、证书、安装覆盖、本地存档、云登录、回滚版本和 HTTPS 缓存头。

## 7. 当前原生发布状态

- 已验证 Windows 解包版隔离启动、`file://` 加载、FileVersion/ProductVersion 1.0.38、Stable 通道、受限 HTTPS API 和更新基址；隔离用户数据目录正常初始化。
- Android 稳定 APK 为 `1.0.38 / 1000038`，大小 4,901,515 字节，SHA-256 为 `9e04137021c90400ed6b547fce0e982c2f3a737b58439ad27618b47841c825c6`。APK v2/v3、zipalign、批准证书和模拟器覆盖升级均通过；4,690,466 字节 AAB 只归档，未进入下载站或应用商店。
- Windows x64 安装程序版本为 `1.0.38`，大小 112,466,095 字节，SHA-256 为 `79162042993d9f37445516a6e4cd46dbb1a7b837fc7df4b97ea21f2a3ecfd8e4`。Authenticode 状态为 `NotSigned`，下载页继续显示未知发布者警告；blockmap 为 118,207 字节，SHA-256 `f9d2d8192f5ad0337a4bf60904a0d582e0a3ead7a2d66c7ae6fed4be56d17156`。
- 上海下载站当前目录为 `/var/www/dsp-idle-downloads/releases/download-site-1.0.38-351c649af9ee`，直接回滚目录为 `download-site-1.0.37-853ecdb12795`；历史安装包继续保留。二进制使用 immutable 缓存，更新清单使用 no-cache，Range 请求返回 `206`，香港 `/downloads/*` 302 至上海下载域名。
- Web/API 与双原生制品来自发布标识 `1.0.38-351c649af9ee`，包内版本、Build ID、官方 API、更新源与公网 9 文件完整哈希均已复验。完整生产备份、切换和残余风险见 [releases/1.0.38.md](./releases/1.0.38.md)。
- 本轮没有连接 Android 实体设备；真机、低配 Windows、Windows `1.0.37 → 1.0.38` 覆盖升级和约一小时后台/锁屏门禁由用户只对精确候选明确豁免。卸载应用仍会删除本机应用数据，覆盖升级不会主动清除应用数据。
- GitHub Android/Desktop Release 工作流已具备签名门禁，但 GitHub Actions Secrets 尚未配置；本机 Android SDK 和长期 keystore 已恢复并记录在受保护 vault 中。后续配置 CI 时只能导入同一 Android 密钥，不能新建证书替代覆盖升级链。Windows 继续沿用历史未签名测试包策略。
- Android 系统浏览器安装 APK 时，玩家设备可能要求允许该来源安装应用；正式商店分发可作为后续渠道，但不改变包名和签名连续性要求。
- Windows 可信代码签名、iOS 壳层、App Store/Google Play 发布、崩溃收集和物理 Android/iPhone 30 分钟温度耗电测试仍在后续范围。
