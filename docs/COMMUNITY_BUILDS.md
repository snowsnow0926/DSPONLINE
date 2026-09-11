# 社区构建与自建服务

社区构建默认不连接官方云 API、账号深链或更新源。这样可以避免非官方安装包消耗官方服务、收集官方账号凭据或让用户误认为分支由官方维护。

## Web

普通 Web 构建没有设置 `VITE_API_BASE_URL` 时使用同源 `/api`。本地 Vite 开发服务器会把 `/api` 代理到 `http://127.0.0.1:4320`。生产自建站应由自己的 HTTPS 反向代理提供同源 API。

## Electron

社区目录包可以直接运行：

```powershell
npm run desktop:pack
```

没有配置下列变量时，打包后的桌面应用禁用云桥和自动更新：

```powershell
$env:DSP_DESKTOP_API_BASE_URL = "https://game.example.com/api"
$env:DSP_UPDATE_BASE_URL = "https://game.example.com/downloads/desktop"
$env:DSP_RELEASE_CHANNEL = "stable"
npm run desktop:pack
```

`DSP_UPDATE_BASE_URL` 下应存在 `stable`、`beta` 和 `nightly` 子目录。`desktop/pack.cjs` 会把云 API 和更新基址写入安装包元数据；运行时不依赖用户机器上的环境变量。

生成可分发安装包时还必须配置合法的 Windows 代码签名凭据。不要发布未签名安装包或把社区包指向官方更新目录。

## Android

没有配置下列变量时，Android 构建禁用云 API、官方账号验证/重置深链和应用内更新检查：

```powershell
$env:DSP_ANDROID_API_BASE_URL = "https://game.example.com/api"
$env:DSP_ANDROID_UPDATE_BASE_URL = "https://game.example.com/downloads/android"
$env:DSP_ANDROID_PUBLIC_ORIGIN = "https://game.example.com"
$env:DSP_RELEASE_CHANNEL = "stable"
npm run android:debug
```

更新清单地址会构造为 `<DSP_ANDROID_UPDATE_BASE_URL>/<channel>.json`。`DSP_ANDROID_PUBLIC_ORIGIN` 必须是没有路径、查询或片段的 HTTPS origin，用于限制账号验证和密码重置深链。

正式 Android 发布必须使用长期 keystore，并让更新清单中的证书 SHA-256 与已批准签名一致。覆盖安装只能由相同应用签名完成。

## 更新清单

更新清单生成器不再默认使用官方地址，必须显式传入发布基址：

```powershell
node scripts/create-native-update-manifests.mjs `
  --base-url https://game.example.com/downloads/ `
  --channel stable `
  --desktop-source release
```

也可以设置 `DSP_NATIVE_UPDATE_BASE_URL`。生成器拒绝 HTTP、未签名生产 APK、证书不匹配和跨源 APK 地址。

## 云服务

本地服务默认只绑定 `127.0.0.1:4320`，数据库位于被 Git 忽略的 `server/data/`。公网部署至少应配置：

- HTTPS 反向代理和严格 `DSP_ALLOWED_ORIGIN`；
- 至少 32 字符的 `DSP_ADMIN_TOKEN`；
- 独立的 SQLite 数据目录、权限和备份；
- 自己的邮件服务、域名、隐私政策和服务条款；
- 限流、日志轮换、监控、恢复演练和安全报告入口。

仓库中的 `deploy/` 是当前官方拓扑的参考实现，不会替自建实例自动配置密钥、证书或合规材料。

Official Android builds through the protected signing helper require all three
explicit endpoint variables above. The official profile rejects incomplete or
insecure configuration; community offline builds do not enable that profile.
