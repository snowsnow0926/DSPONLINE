# DSPidle2 1.0.38 Release Agent 交接

> 交接日期：2026-08-11
> 固定源码：`351c649af9eedb22f56f47a6cd06c14cedce6221`
> Build ID：`1.0.38+351c649af9ee`
> 开发分支：`codex/1.0.38-performance-resource-cap`
> 当前生产：`1.0.38+351c649af9ee`
> 直接回滚与 previous-stable：完整 1.0.37

> **发布状态（2026-08-11）**：用户已对精确候选明确豁免 Android 真机、低配 Windows、`1.0.37 → 1.0.38` Windows 覆盖升级和约一小时后台/锁屏门禁，并接受列明残余风险。香港、上海 Web/API、上海下载页及正式 Android/Windows stable 制品均已发布；完整证据见 [1.0.38 正式发布记录](./releases/1.0.38.md)。本文以下内容保留开发交接时点的原始条件和旧生产基线，不应再解读为“尚未发布”或当前回滚指针。

## 1. 交接结论

1.0.38 功能、全量自动化、真实 23.5 MB 档只读验证、clean source manifest、Web/API 归档、Windows unpacked 和 Android APK/AAB 未签名诊断制品均已完成。开发角色没有部署生产、修改数据库/排行榜历史/玩家存档、切换下载页或读取签名私钥。

Release Agent 仍必须完成：

- 从固定源码使用既有 Android 长期证书重建并验证签名连续性。
- Windows 按现有策略构建正式 setup，明确 Authenticode/SmartScreen 状态。
- 低配 Windows 与 Android 真机、锁屏/后台约一小时、1.0.36→1.0.38 覆盖升级。
- 香港/上海备份、备份副本隔离启动、未激活目录和旧客户端兼容。
- 明确接受 60 秒精确仍为 13.5～13.8 秒、移动 Canvas 偶发长帧和既有长窗口近似风险。
- 获得用户明确发布授权后才允许单节点灰度。

## 2. 本版范围

- 保存、槽位、快照、云上传、离线和纯挂机使用 Worker 权威序列化/校验与可转移缓冲区。
- 传送带结算对象/账本、生产配方静态量、电网/射线与量子物流索引跨稳定 Worker 请求复用。
- v46 持久 JSON 省略可精确重建的默认零值，真实档减少 23.84%。
- 高密度 Canvas 的线路颜色/物品映射只在拓扑变化时重建。
- 普通暂停存档若恰好一个健康单极磁石矿脉，可在持久快照和双重确认后新增一个零缓存、零矿机的有限节点，硬上限两个。
- 完整包含未部署的 1.0.37 科技树、离线决策和星图批量操作，以及 1.0.35 的纯挂机/模式隔离、1.0.36 的线路/画布功能。
- 没有改倍率平衡、氢气规则、排行榜协议或历史成绩。

完整实现、测试和风险见 [1.0.38 开发报告](./DEVELOPMENT_REPORT_1.0.38.md)。

## 3. 兼容性边界

| 层 | 候选 | 与生产兼容性 |
| --- | --- | --- |
| 产品版本 | 1.0.38 | 新候选，包含 1.0.37 |
| GameState | v46 | 与 1.0.36 相同 |
| envelope | v2 | 不变；新写出内容可稀疏 |
| IndexedDB | 既有模式化记录 | 不升级 |
| cloud schema | v7 | 不变 |
| SQLite layout | v2 | 不变 |
| 模式 | `normal` / `speedrun` | 沿用 1.0.35 隔离 |
| 排行榜 | 既有协议 | speedrun 明确模式 + exact-only |

旧档缺少模式字段仍归入普通模式并保留迁移备份。稀疏字段只使用既有 v46 默认值；未压缩 v46 继续读取。没有数据库 migration，但发布前必须使用生产备份副本分别验证 1.0.36 Web/API 与 1.0.38 API，以及 1.0.36 客户端读取一份由候选保存的普通档和速通档。

## 4. 固定源码与制品

### Source manifest

- 本地路径：`artifacts/release-manifests/1.0.38-351c649af9ee.json`
- 文件：161
- aggregate SHA-256：`73e221c5fdc81eaf0537ad958276990861a5dcfc5956ef65ab356fc8c304e79a`
- manifest SHA-256：`f32929f472ba2e1a2301297c1aef15e90f17e95e576447bcd0b42abaddbca6e7`
- Web/API 解包逐文件：161/161；Web 128、API 33；缺失/额外/哈希不匹配均为 0。

### 候选目录

本地候选目录：`artifacts/release-packages/1.0.38-351c649af9ee`

| 文件 | 字节 | SHA-256 | 策略 |
| --- | ---: | --- | --- |
| `1.0.38-351c649af9ee-web.tar.gz` | 1,380,311 | `4434c2e1e6c18aaaf760adbed974637ba3097035bb069d7412c1a24722c8309a` | Web 候选；只进入未激活目录 |
| `1.0.38-351c649af9ee-api.tar.gz` | 106,453 | `75af9a097c9d562515651d912246e762a8c9c0bda678c00fd52e8d38f3e3b234` | API 候选；只进入未激活目录 |
| `1.0.38-351c649af9ee-windows-unpacked-diagnostic-unsigned.tar.gz` | 149,489,314 | `a5110d434b3421be11d106fb52b841727e624e0d469821fd40ae30ce4a3f9972` | `NotSigned`；诊断；禁止 stable |
| `1.0.38-351c649af9ee-android-unsigned.apk` | 4,837,074 | `7f70527e229a19d70ee175fa1e8d8409bbae4ddcd0a2fcf8435ae3be00acfb89` | unsigned；诊断；禁止 stable |
| `1.0.38-351c649af9ee-android-unsigned.aab` | 4,652,404 | `9a2a469b5051972b2f657242ae16eb36094325d7dcb8daf5190520f3675eca44` | unsigned；诊断；禁止 stable |

本地聚合记录：`artifacts/release-packages/1.0.38-351c649af9ee/candidate-artifacts.json`，2,190 字节，SHA-256 `156bfd3c24c08b92832a9ab69a49a0bb33d912bd503a4f7dcbd02e8dd95bebda`，5/5 复验。

Windows ASAR 中 `package.json` 为 1.0.38，`dist/version.json` Build ID 正确；PE `FileVersion=1.0.38`、`ProductVersion=1.0.38.0`，独立 profile 启动 10 秒有 4 个进程，之后只终止该 PID 树。Authenticode 为 `NotSigned`。

Android 完成 413 tasks 与 lintVital；`aapt` 确认 `cn.dsponline.network / 1.0.38 / 1000038 / minSdk 24 / targetSdk 36`，zipalign 通过。`apksigner` 明确 APK `DOES NOT VERIFY`；AAB 没有 RSA/DSA/EC/SF 签名条目，包内 Build ID 正确。

## 5. 最终开发门禁

| 门禁 | 结果 |
| --- | --- |
| typecheck / Vite clean build | 通过；仅既有大 chunk 警告 |
| Vitest | 107 文件通过/6 跳过；950 通过/18 跳过 |
| Playwright | 280 通过/11 条条件夹具跳过；0 失败；291 总数；838.6 秒 |
| server | 70 通过/2 跳过 |
| ops | 6/6 |
| native | 8/8 |
| runtime licenses | 128 个包，当前 |
| root/server production audit | 均为 0 漏洞 |
| source/Web/API | 161/161；缺失/额外/哈希错误 0 |

## 6. 真实档证据

只读附件：`C:\Users\WINDOWS\Downloads\dsp-idle-save-2026-08-10.json`，23,531,371 字节；测试没有写回或上传。

- 稀疏保存：17,920,539 字节，减少 23.84%，checksum/reload v46 有效。
- 30 天纯挂机：14.36～14.78 秒；源状态不变，路线、实体/线路数、科研与关键终局字段有效。
- 60 秒精确三次：13.500～13.817 秒，中位 13.572 秒；哈希 `b9bb64ab / 156870f3` 固定，非法数量 0。
- 6,984 / 30,171 / 604,800 / 2,592,000 秒快速离线 Worker 约 19.7～20.5 秒；测试附加的旧式主线程重序列化使整体验证约 41.9～43.7 秒。正式 Worker 提交流程不执行该附加重复验证。
- 8x / 12x / 16x 约 5.85～6.61 秒，终止约 262ms，无迟到消息；16x 最大关键误差边界仍为 1.0。
- Canvas 仅本机 Chrome 合成矩阵；移动窗口最大帧 139ms，没有真机结论。

## 7. Go / No-Go 条件

以下任一未满足，应保持 No-Go：

1. 未从固定源码和既有 Android 长期证书重建正式包，或证书 SHA-256 不连续。
2. 未完成 1.0.36→1.0.38 Android/Windows 覆盖升级与本地普通/速通档保留验证。
3. 未完成低配 Windows、Android 真机、后台/锁屏约一小时恢复、自动保存、寻线、统计、建筑堆叠、堵带和量子满仓测试。
4. 未在香港/上海分别创建生产备份并用副本隔离启动 API。
5. 未明确接受 13.5～13.8 秒精确模拟、移动长帧、长窗口近似和 30 MiB 云上限风险。
6. 未获得用户明确发布授权。

## 8. Release Agent 必做步骤

1. 从 commit `351c649af9eedb22f56f47a6cd06c14cedce6221` 建立全新 clean worktree，复验 source manifest、candidate JSON 和 5/5 制品。不要从后续文档提交重建二进制并沿用该 Build ID。
2. Web/API 只解包到香港、上海不可变未激活目录；验证 `version.json`、入口、PWA worker、API health、CORS、gzip/raw 和旧 hashed asset，不覆盖 `current`。
3. 两地分别创建并验证生产备份；只在备份副本隔离启动，核对 schema v7/layout v2、账号、普通/速通云槽、历史修订与排行榜数量。
4. 用 1.0.36 Web 对候选 API、1.0.38 Web 对现行 API 做双向协议验证；用 1.0.36 客户端读取候选重新保存的普通/速通副本。
5. Android 使用既有长期证书从固定源码重建；验证 APK v2/v3、证书连续性、zipalign、版本号、正式 API/update URL 和覆盖升级。禁止创建或替换证书。
6. Windows 从固定源码构建正式 setup，记录 Authenticode/SmartScreen，验证包内 Build ID、独立 profile 和覆盖升级。本文 unpacked tar 不能直接进入 stable feed。
7. 真机覆盖 80%～200% 字号、桌面/手机 Canvas、保存 Worker、普通/速通同槽云同步、纯挂机开始/暂停/恢复/停止/后台一小时，以及星图/科技树/传送带/建筑堆叠原功能。
8. 单极磁石只使用合成或明确授权的副本：验证一个→两个、快照、双确认、零库存/零产量、重复拒绝和速通拒绝。不得批量操作真实玩家档。
9. 取得风险接受和用户授权后，先灰度一个 Web 节点，观察保存失败、Worker 延迟/OOM、decision-required、负数/非有限值、云冲突和排行榜拒绝，再切第二节点与下载页。
10. 原子切换后核对两地 Build ID、API health、下载 Range/cache、PWA 在线/离线重开、旧 1.0.36 客户端和正式下载文件哈希。稳定观察后才能写正式 `docs/releases/1.0.38.md`。

## 9. 灰度停止条件

- 相同离线/纯挂机区间重复结算，或取消/重载消费了待结算区间。
- 矿脉减少但缓存/库存/在途没有对应产物，出现负数或异常超大产量。
- 普通/速通同槽串档、自动保存互相覆盖、普通档可提交速通榜。
- Worker 校验失败仍写盘、decision-required 自动提交、速通出现近似/零收益跳过。
- 稀疏存档丢失非零缓存、路线、蓝图、量子库存或旧客户端无法读取。
- 单极磁石扩容增加库存/累计产量、超过两个、在速通可用或无快照提交。
- 混带、四向分流器或优先级顺序与 oracle 不一致。
- PWA worker 混用、Android 签名不连续、覆盖升级丢档、Windows/Android OOM。

不能用删除缓存、跳过产量、补发物资或修改排行榜历史掩盖问题。

## 10. 回滚

- 未切流：废弃 `1.0.38-351c649af9ee` 候选即可，生产不变。
- 已灰度：香港/上海 Web/API 和上海下载指针分别原子切回不可变 1.0.36。
- 不做数据库降级，不清浏览器/App 缓存，不覆盖玩家存档。
- 原生应用继续使用 1.0.36 正式包/更新清单；不得发布本文 unsigned 诊断包。
- 已另获授权执行的单极磁石个案只能用其操作前快照逐档回滚。
- 排行榜历史不属于本版回滚；既有人工恢复流程不变。

## 11. 可直接交给 Release Agent 的提示词

```text
请复验 DSPidle2 1.0.38 候选；在获得用户明确发布授权前不要部署。

固定源码：351c649af9eedb22f56f47a6cd06c14cedce6221
Build ID：1.0.38+351c649af9ee
候选目录：D:\GameDev\DSPidle2\artifacts\release-packages\1.0.38-351c649af9ee
source manifest：D:\GameDev\DSPidle2\artifacts\release-manifests\1.0.38-351c649af9ee.json
开发报告：D:\GameDev\DSPidle2\docs\DEVELOPMENT_REPORT_1.0.38.md
交接：D:\GameDev\DSPidle2\docs\RELEASE_HANDOFF_1.0.38.md

先复验 161/161 source/Web/API 与 candidate-artifacts.json 的 5/5 哈希。Windows unpacked 与 Android APK/AAB 均是未签名诊断制品，禁止进入 stable；Android 必须用既有长期证书从固定源码重建，不能创建新证书。

生产仍为 1.0.36+e0ad49062fa3。先完成两地备份与副本隔离启动、1.0.36 客户端兼容、1.0.36→1.0.38 覆盖升级、低配 Windows/Android 真机、约一小时后台恢复、普通/速通隔离、单极磁石一→二零物资门禁、离线/纯挂机和 Canvas 多字号验收。明确记录是否接受 60 秒精确 13.5～13.8 秒、移动最大帧 139ms、既有长窗口近似和 30 MiB 云上限风险。

不要修改排行榜历史，不要批量修真实玩家存档，不要用清缓存、跳产量或补物资规避问题。只有用户明确授权后才按单节点灰度→双节点→下载页执行原子切换；任何守恒、串档、保存、签名或兼容异常立即回滚完整 1.0.36。
```
