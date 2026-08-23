# 1.1.4 Release Agent 交接

## 唯一允许发布的候选

- Runtime Git SHA：`7dbc149a016c7f53e5d3648e0fdcb3679309ef73`。
- Release ID：`1.1.4-7dbc149a016c`。
- Build ID：`1.1.4+7dbc149a016c`。
- Android：`versionName 1.1.4`，`versionCode 1001004`。
- clean 制品工作树：`D:\GameDev\DSPidle2-v114-release-candidate`。
- 冻结开发 bundle：`artifacts/release-bundle/1.1.4-7dbc149a016c`。
- candidate manifest：`artifacts/release-manifests/1.1.4-7dbc149a016c-candidate.json`，8/8，aggregate SHA-256 `57b8a08fe0d0e8e2bb67cffa56fc1edf8205b8f964532766508922541bbf62ee`。
- provenance：`artifacts/release-manifests/1.1.4-7dbc149a016c-provenance.json`，3/3。
- SHA 清单：`artifacts/release-manifests/1.1.4-7dbc149a016c-SHA256SUMS.txt`，10/10。
- 目标：香港 Web/API、上海 Web/API、上海下载页、Windows stable、Android stable；全部完成后 1.1.3 为 previous-stable。

禁止使用任何更早提交、中间测试产物、Android 未签名包或 Windows unpacked 诊断归档作为 stable 制品。

## 开发门禁结论

- licenses、typecheck、Vitest、server、station、native、ops、完整 Chromium、production build、API expanded smoke、source manifest、candidate manifest 和 provenance 均通过。
- 核心计数：Vitest 1,446/7 skipped；server 376/2；station 3/3；native 25/25；ops 56/6；Chromium 427/26；source 260/260。
- Windows 诊断可执行文件为 `NotSigned`，与历史策略一致；正式 installer 仍需生成。
- Android 开发构建已完成 Web/Capacitor 同步，隔离 shell 未加载 SDK。正式构建必须由受保护 release wrapper 完成。

## Release 执行顺序

1. 对 runtime SHA、clean 状态、candidate manifest、provenance 和 SHA256SUMS 独立复验；不得重建或覆盖冻结 Web/API。
2. 使用受保护访问审计仅确认 Android 长期签名和双节点 transport 可用；不得输出加载器位置、密钥路径、密码、alias、证书内容、主机细节或 token。
3. 在 exact clean SHA 上通过受保护 Android wrapper 临时注入 SDK 和 `DSP_ANDROID_*`，构建 APK/AAB，验证 v2/v3、zipalign、批准历史证书连续性、包名和版本。
4. 生成 Windows `NotSigned` stable installer、blockmap/YAML，核验 ASAR 中官方 HTTPS API 与 stable update metadata；禁止创建自签证书。
5. 生成 Android/Windows stable feed、下载站 staging 和各组件 manifest；下载站所有文件先本地完整复验。
6. 生产预检只读核验香港、上海：磁盘、current/previous/rollback/canary、API/proxy/timer、health/ready、NRestarts、Nginx 112m 和 backup readiness。
7. 每个 API/data-affecting mutation 前分别创建新的 SQLite Backup API snapshot/evidence，要求 hash、quick_check、schema v8、layout v3 和磁盘低于 90%。不得删除 DB/WAL/SHM、有效备份或任何 current/previous/rollback。
8. 上传到新不可变版本目录并远端复验 manifest；按文档原子切换 Web/API，再切下载页和原生 stable。禁止服务器热改、数据库复制/恢复或生产写入 smoke。
9. 分别验收本地/公网 version、build、health、ready、PWA/service worker/cache、旧 hashed asset、下载完整 SHA、Range 206、Windows feed/NotSigned 和 Android feed/签名。
10. 只有全部目标通过后，把 1.1.3 固定为 previous-stable，写正式发布记录和每个目标的精确回滚指针。任何关键门禁失败即停止，不做部分跨区域/原生发布。

## 容量合同特别门禁

- 客户端/桌面/API/Nginx 必须同时体现：64 MiB guaranteed、`96 MiB - 1024 B` hard、80 MiB gzip、96 MiB expanded、128 MiB concurrent、208 MiB response、180 秒 timeout、Nginx `112m`。
- 公网 smoke 不得上传玩家真实存档或使用生产玩家账号；使用无玩家数据的合成 payload/隔离测试路径。
- 旧服务容量回滚不等于数据回滚；数据库永远不随代码回滚。

## 回滚

- Web/API 使用切换前记录的 current/previous/rollback 指针回切到 1.1.3 兼容目录；下载页恢复其切换前 previous 指针；原生 stable feed 恢复 1.1.3。
- 不删除 1.1.4 失败目录，保留远端 manifest 与审计证据。
- 不恢复或覆盖数据库，不删除 WAL/SHM，不回写玩家存档。

开发细节见 [开发报告](./DEVELOPMENT_REPORT_1.1.4.md) 和 [候选记录](./releases/1.1.4-candidate.md)。
