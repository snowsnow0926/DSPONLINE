# Android 1.2.7 云节点不可用：已确认安装包漏配地址

用户反馈安卓 APP 1.2.7 显示“云节点不可用”。本次只读调查已确认正式下载包的云服务地址缺失，并用该 APK 的原始前端资源复现对应提示。没有修改生产配置、发布新 APK 或改写玩家数据。

## 核实的正式制品

- 实时读取 `https://dsponline.cn/downloads/android/stable.json`：versionName 1.2.7、versionCode 1002007，APK SHA-256 `9e50cfe453cdc49d475bdfb23f6adb2204639bfae64820215b7c64835e4ff180`，大小 5,665,693 B。
- 本地保存的最终 `1.2.7-dab2ff5066b7/android-component` APK 与该哈希一致；包内 `assets/public/version.json` 为 `1.2.7+dab2ff5066b7`、platform android。
- 包内 Capacitor origin 为 `https://localhost`，CapacitorHttp enabled，安卓 UA 版本 1.2.7；但是打包后的前端没有正式云 API 地址。早期 `04f2adeb9126` 候选（SHA `f87c42b3038094ed1a5f258c5546bb11381b81042796cb60c9d38e4c4330c711`）存在 `https://dsponline.cn/api`，不能拿早期候选配置代表最终包。

## 复现与服务侧排除

将最终 APK 的 `assets/public/` 原样提取到隔离目录，在 HTTPS localhost origin 上执行，打开“登录与云存档”，得到：

> 云节点暂时不可用
> 原生应用未配置云服务地址
> 重试

复现过程中 API 请求次数为 **0**。这是原始 APK 资源的浏览器执行复现，不冒充安卓实体设备测试；没有登录生产账号或发送写请求。截图和结构化结果保存在忽略目录 `artifacts/android-cloud-audit-20260909/`。

服务器同时验证 health/ready 为 200、writable true、pendingWrites 0；TLS 证书链验证通过、证书到期 2026-10-19。`Origin: https://localhost` 请求返回 200 与精确 `Access-Control-Allow-Origin: https://localhost`，cloud-save OPTIONS 为 204。已有安卓浏览器/原生来源仍有成功请求，但日志不能据此证明有故障的 1.2.7 正式包能够连接。

## 根因与修复交接

`scripts/build-platform.mjs` 将未设置的 `DSP_ANDROID_API_BASE_URL` 转为空字符串并继续构建，再传入 `VITE_API_BASE_URL`。`src/game/cloud.ts` 在非 Web 平台且没有配置地址时返回 null；`cloudRequest` 随即抛出“原生应用未配置云服务地址”。当前 `verifyBuiltPlatform()` 只检查 platform，未校验云端地址，因而漏配仍可通过已有制品平台门禁。最终打包时为什么丢失环境注入尚未由构建进程记录证明，不应进一步猜测操作过程。

修复目标为安卓正式构建：明确注入 `DSP_ANDROID_API_BASE_URL=https://dsponline.cn/api`、正式更新清单基址和公开站点 origin；增加正式原生制品的必填配置与包内验证。随后使用原长期证书生成可覆盖升级的修复 APK，核对签名、版本码、保存数据保留与实际云端连接，再更新下载制品/清单。若保留同 versionCode，应用内版本比较不能提示更新，需在发布方案中明确处理。

修服务器和刷新网页不能补齐已经安装的 APK 常量。当前正式包需要经过修复后的安装包覆盖升级；本次调查没有执行发布，也没有声称已修复。


## 修复关闭（2026-09-09）

已发布 Android 1.2.8 / 1002008，原生模拟器和最终 APK 原始页面均恢复云连接，签名、覆盖升级和公网分发通过。旧包不能自行发现更新，需手动下载覆盖安装。详见 [正式修复记录](./1.2.8-android-cloud-hotfix.md)。
