# 1.2.3 Release Agent 交接

> 状态：`1.2.3-25aeeb34e501` 已于 2026-08-28 完成香港、上海、下载页、Windows 和 Android stable 全量原子发布；previous-stable 为 `1.2.2-8b9c93e13270`。最终生产证据见 [正式发布记录](./releases/1.2.3.md)。

## 固定候选

- Runtime commit：`25aeeb34e501fdb68441b88cf305502b730c34d6`
- Release ID：`1.2.3-25aeeb34e501`
- Build ID：`1.2.3+25aeeb34e501`
- Detached 候选目录：`D:/GameDev/DSPidle2-v123-release-candidate`
- Bundle：`artifacts/release-bundle/1.2.3-25aeeb34e501/`
- Candidate manifest：`artifacts/release-manifests/1.2.3-25aeeb34e501-candidate.json`
- Provenance：`artifacts/release-manifests/1.2.3-25aeeb34e501-provenance.json`
- SHA256SUMS：`artifacts/release-manifests/1.2.3-25aeeb34e501-SHA256SUMS.txt`

候选 manifest 为 12 个不可变对象，aggregate SHA-256 `0ebcd1c79a3e8ba9990f6595ac597574c46123342d3f370b4dd423ee83c619da`；provenance 3/3、SHA256SUMS 20/20、Web 171、API 182、native feed 6、download site 9、native archive 2、Windows unpacked 77 均已独立复验。API 归档与解压副本 182/182 逐文件一致。禁止重建或覆盖这些制品。

## 变更摘要

1. 新增玩家可选的“产率复制挂机”，以已有 60 个模拟秒、最少 30 秒的正向统计复制材料、科研、逐恒星系火箭与壳面帆；不额外精确模拟或扫描全工厂。
2. 保留原守恒纯挂机，并将五项无限科技有效等级总和大于 200 作为复制模式门槛；速通模式不可用。
3. 建筑制造、普通离线与时间扭曲继续使用逐恒星系事件账本、稳态证书和 Windows 原生增量热路径。
4. Windows stable 恢复历史产品身份和数据目录，实验性能版继续隔离。
5. 修复 390×844 手机新版浅色主题中“完整检查器”正文被白色桥接层遮挡；深色主题和拖拽行为不变。

GameState v47、envelope v2、cloud schema v8、SQLite layout v3 均不变；本候选不修改或迁移玩家数据。

## 门禁结果

- TypeScript、Rust fmt、Rust clippy `-D warnings`、许可证和根/server 生产审计通过。
- Vitest 1,704/29/0；Server 384/2；station 4/4；Ops 56/6；release-switch 29/29。
- Native JS/desktop 180/1/0；Rust workspace 222/222。
- Chromium 432/27/0；durable 7/7；production preview 3/3；手机浅色检查器专项 1/1。
- Web build 1,984 modules，startup gzip 180,059 B，forbidden startup modules 0。
- Android APK/AAB 由受保护加载器使用批准长期配置生成；APK v2/v3、zipalign、包名、`1.2.3 / 1002003` 和证书连续性通过。
- API 36.1 模拟器完成正式 `1.2.2 / 1002002 → 1.2.3 / 1002003` 原地升级；`firstInstallTime` 不变、候选进程运行、Fatal/ANR 为 0。
- Windows setup 与 unpacked 的版本、Build ID、stable 通道、正式 API/更新地址和隔离启动通过；Authenticode 明确为 `NotSigned`。

尚未完成的候选专属硬件门禁：Android 实体设备、低配/主流/高配 Windows、Windows `1.2.2 → 1.2.3` 覆盖升级与长时运行。Android 模拟器覆盖升级已通过，但不能代替真机。旧候选豁免不得复用；必须补测或由用户明确接受 `1.2.3-25aeeb34e501` 的风险。

## 生产预检与切换边界

2026-08-28 只读预检：香港 generation 43、上海 generation 25；两端 Web/API current 均为 `1.2.2-8b9c93e13270`，previous 均为 `1.1.9-c3f4eff6cb5a`，pending absent，API/proxy active、`NRestarts=0`、local health/ready 200、schema v8/layout v3、Nginx 检查通过。香港根盘 60%、约 28.6 GB 可用，活动库约 4.04 GB；上海根盘 75%、约 15.6 GB 可用，活动库约 0.46 MB。服务器自身严格 TLS 公网探针确认香港 version/health/ready 为 1.2.2 / 200，`/canary/previous/` 302 到 1.1.9；下载站 version、Android/Windows stable 均为 1.2.2，Android minimum code 继续为 1000002。上海 download current 为 1.2.2。预检未修改生产。

正式切换固定顺序：

1. 再次核对本 manifest/SHA、双节点 current/previous/generation/pending/磁盘与服务。
2. 每个 API 节点分别创建全新 SQLite Backup API 快照，并验证完整 SHA-256、`quick_check=ok`、schema v8/layout v3、evidence 和保护水位。
3. 上传冻结归档到新不可变版本目录，远端按组件 manifest 逐文件复验；候选 API 只在备份克隆和隔离端口预热。
4. 使用受控 handoff 与 release-control 原子切换双节点 Web/API；不得同时启动两个生产 writer，不得恢复或复制数据库/WAL/SHM。
5. 原子切换上海下载页、Windows/Android stable；整批任一目标失败即停止并按现场指针回滚，不做部分跨区域/原生发布。
6. 验收双节点 version/health/ready、PWA/service worker/cache、下载页、9 文件完整哈希、Range 206、Android v2/v3/证书与 Windows `NotSigned`。
7. 观察通过后将刚替换的 1.2.2 Web 设置为香港 `/canary/previous/`，并记录新的 current/previous/generation、下载回滚指针与代码回滚命令。数据库永不随代码回滚。

不得热改服务器、删除数据库/WAL/SHM或有效备份/回滚目录、输出签名/SSH材料、使用生产账号写 smoke、上传玩家存档，或跳过失败的备份、哈希、健康、签名、缓存和下载门禁。

## 正式发布结果

- 用户明确豁免本 Release ID 的 Android 实体设备、三档 Windows、Windows 1.2.2→1.2.3 覆盖升级及长时运行门禁；其余备份、清单、签名、健康、PWA、缓存、Range 和完整下载门禁均通过。
- 香港/上海 current 为 `1.2.3-25aeeb34e501`，previous 为 `1.2.2-8b9c93e13270`，generation 分别为 44/28，均为 green/4322，pending absent、health/ready 200、`NRestarts=0`。
- 上海下载 current/previous 为 `download-site-1.2.3-25aeeb34e501` / `download-site-1.2.2-8b9c93e13270`；香港 previous Web 已切到 1.2.2。
- 正式 Backup API evidence：香港 4,054,929,408 B / `de96d50c926c02e8ba366823b50a593936937e034ef1088384cd38b799a6772e`，上海 462,848 B / `020e6c65a58778182a961219ac38573263b16d30c79566d980569233b61ac458`；均为 quick_check ok、schema 8、layout 3。
- 完整现场记录、proxy 计数泄漏处置、制品哈希和回滚边界见 [1.2.3 正式发布记录](./releases/1.2.3.md)。
