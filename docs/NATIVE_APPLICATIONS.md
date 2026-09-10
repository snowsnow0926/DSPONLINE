# 原生应用构建与更新

> **平台投入策略（2026-09-11）**：按用户决定，网页版/PWA 为主产品，Android 复用共享玩法、画布与优化并独立验证壳层；Windows 保留既有代码、下载及必要兼容修复，完整原生接管不再作为当前主线目标。Rust 历史候选与验证资产保留，不自动重启其开发或打包循环。详见 [网页版优先计划](./WEB_FIRST_DEVELOPMENT_PLAN_2026-09-11.md)。以下已发布版本事实不因策略调整而改变。

> **当前正式下载（2026-09-11）**：Android stable 为 **1.2.9 / 1002009**，包名 `cn.dsponline.network`，APK 5,672,736 B、SHA-256 `06d0043a542faab0f7e3e2be2fad18b7d2da43c672e66da88ccf7255fe953bf7`；APK v2/v3、zipalign 与 APK/AAB 长期证书连续性通过，最低支持代码仍为 1000002。正式 1.2.8 直接覆盖、旧档进入、新进度明确保存与冷重开通过，设备为后台匿名模拟器，实体手机和长时门禁未计作通过。下载 current 为 `download-site-1.2.9-0521eb63f179-r2`，previous 为 1.2.8；Windows 安装器/4 个更新文件保持 1.2.6 原字节，API 也保持 1.2.6。网页与安卓使用共享优化，不包含 Rust 跨端接入。见 [1.2.9 发布记录](./releases/1.2.9.md)；以下带日期的旧包与旧门禁均为历史。

> **当前正式下载（2026-09-08）**：Android stable 已发布 `1.2.7 / 1002007`（`cn.dsponline.network`），沿用历史证书，v2/v3、zipalign、APK/AAB 证书连续性和公网 APK 完整哈希通过，minimumSupportedVersionCode 保持 1000002。共享保存、导入及挂机恢复修复已包含；正式 APK 的模拟器保存/后台/重开通过，实体设备及最终直接从 1.2.6 升级仍未验证。Windows stable 保持 1.2.6 `NotSigned`；下方 1.2.7 Windows 包是开发候选。Rust 跨端接入留待后续，详情见 [1.2.7 发布记录](./releases/1.2.7.md)。

> **1.2.7 第三轮本地验证候选（2026-09-07）**：目录打包生成内部 `desktop-build-evidence.json`，绑定源码 SHA、Build ID、edition/channel 及 app.asar、Host 和目录文件摘要；正式收集入口进一步验证安装器、YAML 和 feed 引用。`npm run test:desktop-package` 先验证 clean source 对应的离线性能包，缺包/错包退出 2，并为每次运行建立独立证据目录。该内部清单不是签名或发布许可；冻结新包 1.2.7+27c4f15fd621 的真实桌面旅程已 8/8 通过，见 [第三轮开发记录](./reviews/1.2.7-round3-development-2026-09-07.md)。

> **Campaign / Galaxy 原生玩家壳边界（2026-09-01，开发候选）**：当前 Windows Host 新增 `native-core-campaign-workspace-projection-v1` 与 `native-core-galaxy-account-workspace-projection-v1` capability。preload 只接受 exact-key `{sessionId,runId,expectedRevision,expectedRegistryFingerprint}`；main 只把请求路由到当前 normal-main 玩家权威 broker，不允许回落到 renderer shadow 会话。返回分别受 256 KiB 与 64 KiB 硬预算，renderer boundary 拒绝截断、额外键、重复 ID、计数漂移和 lineage 漂移。
>
> 原生 Campaign 页只读固定目录标签与 Rust 进度，不接收 GameState；导航只发 UI locator。原生 Galaxy 页只接收 Rust 游戏摘要和单独的本地账户状态，可创建/切换身份、编辑资料并登录/退出云账号；恢复、导入、覆盖当前主档在 active authority 下显式不可用且没有写入口。Campaign 投影目前打开时仍做 `O(E+B)` Rust 扫描，预算收紧不等于查询计算免费。该切片不生成安装包、不改变签名/更新通道，也不放开 `authorityEligible`。

> **轨道合同原生权威边界（2026-09-01，开发候选）**：Windows authority route 现在以 `orbital-contract-workspace-v1` 提供最多 4 个 offer、3 个 accepted、8 个 completed history、每合同 6 条 requirement 和 256 KiB 的有界投影。main projection broker 对 renderer 的 exact-key 请求内部附加 confirmed wall clock，Host 再用当前 exact-realtime lease 证明 session/run/registry；renderer bridge 与 TypeScript 请求类型均没有时间字段，也拿不到量子网络正文、奖励公式或完整 GameState。
>
> mutation broker 只接受 accept、deliver-quantum、claim、abandon 和 feature 五类语义。时钟在首次排队时采样并进入 SHA-256 command identity；FIFO 的 unknown-response retry 保留完全相同的请求、clock 和 command ID。跨上海午夜的旧 offer 会在 Rust 同步 clone 后 definite reject，源状态不变；pending 结束后 UI 强制重读同 revision 的新 main-clock projection，不会用一次“rollover-only 成功”掩盖拒绝。原生合同页不调用 legacy station writers，Web/PWA fallback 不变。
>
> 此能力不是完整空间站迁移：cargo-terminal binding、decorations、profile/public showcase 和 construction 按钮保持禁用，MOD/非内置 registry 失败关闭。GameState v47、公开 envelope/cloud/SQLite/package 均不升级，`authorityEligible=false`；本候选没有打包、签名、安装、部署或生产操作。

> 2026-08-28 的全面性能开发候选继续保持 `1.2.3` 包版本，仅用作可并存的未签名诊断包，不代表覆盖稳定版。E18 + e503 整合运行时已冻结为 clean 提交 `f6923747c69b0be590a2b2e4c0681f1c41ecee75`，标准目录包 Build ID 为 `1.2.3+f6923747c69b`；75 个文件、413,286,323 B，可测 ZIP 为 157,799,939 B、SHA-256 `f3c3729b93a290cab861fc9caf8e0816080bd32f695a5d66dda26bc2d873b593`。此前 `460742f86483` 的 E18 clean 包只是历史性能基础，不能冒充整合态制品。若今后标准目录再次被安全软件锁住，`desktop/pack.cjs` 只会复用刚解压且经过身份检查的 Electron 分发，在 `release-performance-edition-fallback/win-unpacked` 重试；标准目录与 fallback 仍只能有一个被清单选中。

> 冻结 E18 包及后续整合态沿用同一套可与稳定版并存的 1.2.3 **性能开发版**身份：appId/AppUserModelID 为 `com.dspidle.network.performance`，产品名为 `DSP极简网络 Windows 性能开发版`，默认输出为 `release-performance-edition/`，EXE 为 `dsp-idle-performance-edition.exe`。它在 AppData 使用固定独立的 `DSPidle2-Performance-Edition` userData 与 `Chromium` sessionData，不读取稳定版默认目录；本机存档、云会话、设置、窗口状态和原生私有存档因此初始为空。程序不会自动搬运旧数据，玩家若要测试旧档，必须先在稳定版导出 JSON/JSON.gz，再在性能版通过导入界面明确选择该文件。不要把稳定版数据目录直接覆盖到性能版目录，也不要反向覆盖。

> Windows Electron 壳层默认保留 Chromium 硬件加速，不设置 `--disable-gpu`、`--js-flags`、`max-old-space-size` 或进程优先级。受信桌面 bridge 的 `getRuntimeDiagnostics()` 只读返回有界 GPU、Electron 进程、内存、V8 heap limit 和优先级快照；5 秒内并发请求合并，输出不含参数、环境、路径、URL、存档或异常正文。该快照只覆盖 Electron `getAppMetrics()` 进程，独立 Rust Host 仅列 PID，不能代替发布报告的完整进程树 Private Bytes 采样。

> Windows 原生 Host 的线程数现在有独立设备策略：默认 `balanced/auto`，另有安静、性能和自定义档；性能/自定义档会按当前可用逻辑 CPU 保守下调到 `1/2/4/8`。策略文件位于 Electron `userData`，原子保存且损坏时安全回退。运营中心的设置页只在受信 Windows bridge 存在时显示，会同时返回请求策略、当前进程实际策略、逻辑 CPU 和 `restartRequired`；Web、Android 及旧 bridge 不显示也不调用该面板。为保护活动原生会话及权威 revision，修改后必须完整重启应用才生效，程序不会在运行中重启 Host。

> 1.2.3 Windows 开发候选为活动 revision 增加原生脏页保存，为线路增加安全稀疏 route mask 和稠密全扫描回退，并提供有界视口/统计二进制投影协议、Rust 流式 v47 导出与 current-v47 流式导入切片。当前线路实现每步仍遍历全部 route group，不是闭合反向唤醒队列；玩家 renderer 也尚未消费原生薄投影。导入文件由主进程选择，renderer 不接收路径或正文，验证成功后只创建 `authority:"shadow"` 会话。Host 的保存、WAL、核心、导入/导出和投影等 24 类回执在主进程经过精确字段、范围和关联身份校验后才进入 context-isolated bridge；这只收紧返回边界，不代表薄 UI 已完成。该候选不修改公开存档、云协议或 Android 路径；`authorityEligible=false`，未完成 24 小时/多硬件 Gate C、签名和灰度。架构决策见 [ADR-007](./architecture/ADR-007-WINDOWS-NATIVE-INCREMENTAL-RUNTIME.md)，整合边界见 [三层计划书第 21 节](./WINDOWS_NATIVE_PERFORMANCE_DEVELOPMENT_PLAN_2026-08.md#21-e18-与-e503-方案整合复核2026-08-28)。

> 1.2.1 开发候选优化 Windows 76.9 MB 大型存档的原生冷启动、摘要诊断、事务内存和同 revision 重复保存，并为 Electron 包增加 Android Gradle 残留的排除与生成后硬校验。`authorityEligible=false` 和 JavaScript 权威保持不变；本版不是原生核心默认接管，也没有完成 24 小时/多硬件 Gate C。开发实测与残余边界见 [1.2.1 Windows 性能报告](./releases/1.2.1-windows-performance-development-report-2026-08-27.md)。

> 1.2.0 开发候选为 Windows 增加私有原生增量存档和独立 Rust 影子模拟核心。邀请 Beta 默认关闭、JavaScript 保持权威；原生核心 `authorityEligible=false`，在 24 小时与多硬件 Gate C 完成前不得宣传为默认稳定权威。公开存档继续是 GameState v47 / envelope v2，Web/Android 和 Windows 回退路径不读取私有原生格式。候选实现、实测和残余边界见 [1.2.0 Windows 原生第二、三层报告](./releases/1.2.0-windows-native-layers23-development-report-2026-08-27.md)。该段只描述历史候选边界，不改变下方 1.2.6 当前公开稳定版本事实。

> 当前发布版本：Web/Windows `1.2.6`；Android 正式包 `1.2.6 / 1002006`
> 1.2.6 已进入香港/上海 Web/API、上海下载页、Windows stable 和 Android stable；香港 Web previous-stable 固定为 1.2.5。
> 当前公开稳定版本：Windows `1.2.6` 安装包按历史策略为 `NotSigned`；Android `1.2.6 / 1002006` 使用既有长期证书签名。
> 当前稳定版 Windows 包名：`com.dspidle.network`；本工作树性能开发版使用上方独立身份。
> Android applicationId：`cn.dsponline.network`
> 1.2.6 的 Web、Windows 与 Android 采用 GameState v47、envelope v2、云 schema v8、SQLite layout v3；产率复制终端直结和星球工厂重置不改变旧档迁移边界。
> 公开下载入口：`https://download.dsponline.cn/`，2026-09-08 已迁至新上海，安装包与稳定清单保持 1.2.6，文件完整哈希和 Range 206 复验通过；不消耗香港游戏节点流量。主机与后续运维入口见 [上海迁移记录](./releases/ops-shanghai-vps-migration-2026-09-08.md)。

> 冻结 APK：5,394,620 B，SHA-256 `671a6acb3579c175fc8ea87d8e4f921f5f63f9c36116956e9970a0c187367886`；AAB：5,183,622 B，SHA-256 `7f422c4df00ef56b05d70ff28a6eafd0f657751ab5c813c6af1431171e0ea0e1`。APK/AAB 的 v2/v3、zipalign、包元数据和历史证书连续性通过；实体 Android 设备门禁由用户只针对本 Release ID 明确豁免，未创建新证书。

> Windows setup：105,326,865 B，SHA-256 `eb5eaa5934167f0925a5489549a24e1d2a70d72ee0ccaafb79375165b9b5b534`。完整下载哈希、更新清单、用户豁免和残余边界见 [1.2.6 正式发布记录](./releases/1.2.6.md)。

> 历史 1.0.42 制品和门禁记录仍保留在 [1.0.42 正式发布记录](./releases/1.0.42.md)，不代表当前 stable。

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

Windows 普通版目录包：

```powershell
npm run desktop:pack
```

该命令使用稳定版身份（`com.dspidle.network` / `DSP极简网络.exe` / 历史 `dsp-idle-network` userData），写入固定的 `release/win-unpacked/`，或在 Windows 文件锁命中时写入 `release-fallback/win-unpacked/`。它不生成更新 feed，不要求签名或 HTTPS API/更新地址，允许本地无签名测试。`DSP_RELEASE_CHANNEL` 只改变通道元数据，不会把普通版改成性能开发版。

独立性能开发版目录包：

```powershell
npm run desktop:performance:pack
```

该命令写入 `release-performance-edition/win-unpacked/`，或在文件锁命中时写入 `release-performance-edition-fallback/win-unpacked/`。包后门禁会核对 editionId、产品名和 `dsp-idle-performance-edition.exe`，并拒绝混入稳定版 EXE。默认 `cloudApiBaseUrl` 与 `updateBaseUrl` 均为空。edition（普通版/性能开发版）与 releaseChannel（stable/beta/nightly）是不同概念；性能开发版也可以带 beta 通道，但不会改用稳定版 appId 或数据目录。当前没有签名、部署或下载页授权，不得把这个目录包描述为稳定发布。

测试性能开发版时直接运行其中的 `dsp-idle-performance-edition.exe`。首次运行只会创建 AppData 下的 `DSPidle2-Performance-Edition`；不要复制稳定版的 `dsp-idle-network` profile。需要测试真实旧档时，通过稳定版的“导出”取得 JSON/JSON.gz，再在性能版中手动导入。测试完成后也不要用脚本删除 profile；其中可能已包含玩家刚完成的性能版测试进度。

仅在诊断显卡驱动、远程桌面或 GPU 进程异常时，开发者可以显式启动软件回退：

```powershell
$env:DSP_DESKTOP_EXPERIMENTAL_DISABLE_HARDWARE_ACCELERATION = "1"
npm run desktop:dev
```

这不是默认玩家设置，也不会写入存档或云端。必须完整退出应用后再切换；`true`、`yes` 等模糊值不会生效。不要通过该变量推断 GPU 实际启用状态，应读取运行诊断中的 `gpu.featureStatus`。V8 堆继续由 Chromium 管理，进程优先级继续由操作系统管理；在整机提交内存和前后台响应 A/B 证明收益前，不增加通用 heap/priority 参数。

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

当前公开的 Windows `1.0.42` 是明确标注的未签名测试安装包。它已通过构建、隔离启动、更新清单和下载校验，但 Windows 仍会显示“未知发布者”或 SmartScreen 提示；取得可信代码签名证书之前不得描述为正式签名版。

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

Android `1.0.42` APK 已使用与 `1.0.0` 至 `1.0.38` 相同的长期发布密钥签名，证书 SHA-256 为 `ede2aa09ed143a3fbeb283aad0e7801d192c851f240cd39278c399918a0216ce`。APK Signature Scheme v2/v3 均通过；当前本机受保护发布库位于 `<LOCAL_SIGNING_VAULT>`，包含长期证书材料，目录 ACL 仅允许本机系统账户与开发账户访问。密钥文件、密码和私钥仍不进入 Git、VPS 或公开文档内容。GitHub Actions Secrets 尚未配置，但本机长期 keystore 已恢复。

使用该 vault 构建的 Android `1.0.33` APK 已验证包名 `cn.dsponline.network`、versionCode `1000033`、APK Signature Scheme v2/v3 和相同证书指纹；大小为 4,834,527 字节，SHA-256 为 `14232dd3273ad951acf36d0a97488912e978ae0cd6da3f5cf1104f82419bedeb`。该文件已进入上海稳定下载页与 Android stable 清单。

`1.0.34 / 1000034` 正式 APK 使用同一长期证书生成，大小为 4,841,083 字节，SHA-256 为 `d556e6f3690cbe709d0f493019b55fdadc20658ef865bef9cbc71b1b1511a49e`。APK v2/v3、zipalign、证书连续性和 Android API 36 模拟器 `1.0.33 -> 1.0.34` 的 `install -r` 覆盖升级均已通过，`firstInstallTime` 不变且启动无 Fatal/ANR；该文件已写入公网 stable 清单和下载页。

`1.0.35 / 1000035` 正式 APK 使用同一长期证书生成，大小为 4,861,729 字节，SHA-256 为 `56598fecf674c05141535a4fa99b868c16b4c6ccc6acdf7358a6f305a3c8e88a`。APK v2/v3、zipalign、证书连续性和 Android API 36.1 模拟器 `1.0.34 -> 1.0.35` 的 `install -r` 覆盖升级均已通过，`firstInstallTime` 不变且启动无 Fatal/ANR；该文件已写入公网 stable 清单和下载页。物理真机门禁由用户只对该候选明确豁免。

`1.0.36 / 1000036` 正式 APK 使用同一长期证书生成，大小为 4,879,486 字节，SHA-256 为 `38d5c72e814782303ba884cca96ef0219a9b8d67bb1906f99d18de9a2c467a6b`。APK v2/v3、zipalign、证书连续性、内置正式 API/更新源和公网完整哈希均通过；该文件已写入 stable 清单和下载页。Android 物理真机、`1.0.35 -> 1.0.36` 覆盖升级和本地存档保留未执行，由用户只对该候选明确豁免。

`1.0.37 / 1000037` 正式 APK 使用同一长期证书生成，大小为 4,887,137 字节，SHA-256 为 `5ab6a8a2e78e9c0364cc9249e0ef31f526e4959696815dd1ee79978a649fdd87`。APK v2/v3、zipalign、证书连续性、内置正式 API/更新源和公网完整哈希均通过；4,676,013 字节 AAB 只归档。Android 物理真机、`1.0.36 → 1.0.37` 覆盖升级和约一小时后台门禁未执行，由用户只对该候选明确豁免。

`1.0.38 / 1000038` 正式 APK 使用同一长期证书生成，大小为 4,901,515 字节，SHA-256 为 `9e04137021c90400ed6b547fce0e982c2f3a737b58439ad27618b47841c825c6`。APK v2/v3、zipalign、证书连续性、内置正式 API/更新源和公网完整哈希均通过；API 36.1 模拟器从正式 1.0.37 使用 `adb install -r` 覆盖升级后 `firstInstallTime` 不变、应用前台运行且无 Fatal/ANR。4,690,466 字节 AAB 只归档，常规 JAR 数学验证与证书连续性通过；严格 JAR 输入流结构警告作为已记录风险保留。Android 物理真机和约一小时后台/锁屏门禁由用户只对该候选明确豁免。

`1.0.42 / 1000042` 正式 APK 使用同一长期证书生成，大小为 4,900,079 字节，SHA-256 为 `7a2450b21b23619004ed6b665f1ebe5067b5b158f0f53ce09bf1d8bb14864b95`。APK v2/v3、zipalign、证书连续性、内置正式 API/更新源和公网完整哈希均通过；API 36.1 模拟器从正式 1.0.38 使用 `adb install -r` 覆盖升级后 `firstInstallTime` 不变、应用进程运行且无 Fatal/ANR。4,688,602 字节 AAB SHA-256 为 `b98e96e7a9e1f919ec89675fc8958deec8ab562979accc9e8193f740c3a0594e`，只作归档；严格 JAR 输入流结构警告与 1.0.38 相同。Android 实体真机没有可用设备，未宣称通过。

本机发布前只通过受保护入口读取 vault，不手工显示 locator、配置路径、alias 或口令。先执行只读检查：

```powershell
pwsh -NoProfile -File .codex/skills/develop-dspidle/scripts/test-protected-release-access.ps1 -Capability Android
pwsh -NoProfile -File .codex/skills/develop-dspidle/scripts/invoke-protected-android-release.ps1
```

从独立 clean checkout 正式构建时，向同一脚本提供精确 40 位 runtime SHA 和 `-Build`；脚本只在子进程中注入 `DSP_ANDROID_*`，并验证 APK v2/v3、zipalign、包名/版本及 APK/AAB 历史证书连续性。若本机 vault 不可读，发布必须停止并恢复同一长期材料，不能生成新证书替代。完整新会话流程见 [受保护发布凭据与新会话接管](./PROTECTED_RELEASE_ACCESS.md)。

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

Android 1.0.42 的稳定清单将 `minimumSupportedVersionCode` 保持为 `1000002`：受支持旧版本均能检测到 1.0.42 更新。服务端继续接受合法 v35-v46 存档，客户端不允许把 v46 有损降级。受支持版本进入应用版本卡时会自动检查一次并保留手动重试。

示例：

```powershell
node scripts/create-native-update-manifests.mjs `
  --base-url https://dsponline.cn/downloads/ `
  --channel stable `
  --android-apk android/app/build/outputs/apk/release/app-release.apk `
  --android-certificate-sha256 <公开证书指纹>
```

生成器没有默认发布域名，必须传入 `--base-url` 或设置 `DSP_NATIVE_UPDATE_BASE_URL`。Windows 的 `latest.yml`、安装程序和 blockmap 由 `npm run desktop:release` 写入本次唯一成功的普通版 `release/` 或 `release-fallback/`，对应更新清单位于该目录的 `update-feed/desktop/<channel>/`。正式工作流通过同一套身份模块收集该目录，不会把性能开发版制品混入普通稳定更新源。Android JSON 与 APK 整理到 `release/update-feed/android/`。这些命令只生成待发布目录，不上传服务器。`npm run desktop:dist` 与 `npm run desktop:performance:dist` 只做本机未签名安装器验收，仍要求 HTTPS API/更新地址，但不签名、不写 feed。

## 6. CI 与发布门禁

- `.github/workflows/desktop-release.yml` 使用 Windows 代码签名机密生成安装包和桌面更新目录。
- `.github/workflows/android-release.yml` 从 GitHub Secret 临时恢复 keystore，生成签名 APK/AAB，并校验批准证书后生成更新清单。
- CI 只上传 GitHub Actions 制品，不自动部署 VPS。
- 两个发布 workflow 的 token 权限为只读，并显式注入官方 API、公开 origin 和更新基址；普通 Pull Request CI 不接收这些配置或签名 secrets。
- 向正式更新目录发布前仍需核对版本、通道、SHA-256、证书、安装覆盖、本地存档、云登录、回滚版本和 HTTPS 缓存头。

## 7. 当前原生发布状态

- 已验证 Windows 解包版与 setup 隔离启动、`file://` 加载、FileVersion/ProductVersion 1.0.42、Stable 通道、受限 HTTPS API 和更新基址；隔离用户数据目录正常初始化。
- Android 稳定 APK 为 `1.0.42 / 1000042`，大小 4,900,079 字节，SHA-256 为 `7a2450b21b23619004ed6b665f1ebe5067b5b158f0f53ce09bf1d8bb14864b95`。APK v2/v3、zipalign、批准证书和模拟器覆盖升级均通过；4,688,602 字节 AAB 只归档，未进入下载站或应用商店。
- Windows x64 安装程序版本为 `1.0.42`，大小 109,545,221 字节，SHA-256 为 `c837b5b3ca4aa6f6715349e7bdbfae162d71206976936e52f6b24e5bb8fcbe2d`。Authenticode 状态为 `NotSigned`，下载页继续显示未知发布者警告；blockmap 为 116,356 字节，SHA-256 `8eb5f53512b9e3d680c070bdd039a5a339ae08e0d122b9ff905976cd036700a3`。
- 上海下载站当前目录为 `/var/www/dsp-idle-downloads/releases/download-site-1.0.42-c24e6247d257`；1.0.38 和 1.0.37 历史目录继续保留。二进制使用 immutable 缓存，更新清单使用 no-cache，Range 请求返回 `206`，香港 `/downloads/*` 302 至上海下载域名。
- Web/API 与双原生制品来自运行时发布标识 `1.0.42-c24e6247d257`，包内版本、Build ID、官方 API、更新源与公网 9 文件完整哈希均已复验。完整生产备份、切换和残余风险见 [releases/1.0.42.md](./releases/1.0.42.md)。
- 本轮没有连接 Android 实体设备或低配 Windows；API 36.1 模拟器 1.0.38→1.0.42 覆盖升级和 Windows 隔离启动通过。卸载应用仍会删除本机应用数据，覆盖升级不会主动清除应用数据。
- GitHub Android/Desktop Release 工作流已具备签名门禁，但 GitHub Actions Secrets 尚未配置；本机 Android SDK 和长期 keystore 已恢复并记录在受保护 vault 中。后续配置 CI 时只能导入同一 Android 密钥，不能新建证书替代覆盖升级链。Windows 继续沿用历史未签名测试包策略。
- Android 系统浏览器安装 APK 时，玩家设备可能要求允许该来源安装应用；正式商店分发可作为后续渠道，但不改变包名和签名连续性要求。
- Windows 可信代码签名、iOS 壳层、App Store/Google Play 发布、崩溃收集和物理 Android/iPhone 30 分钟温度耗电测试仍在后续范围。
