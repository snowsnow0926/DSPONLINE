# DSPidle2 1.0.37 Release Agent 交接

> 交接日期：2026-08-11
> 候选源码：`853ecdb12795844c484b1415f8e72967a25e343d`
> Build ID：`1.0.37+853ecdb12795`
> 开发分支：`codex/1.0.37-monopole-tech-offline`
> 当前生产：`1.0.38+351c649af9ee`
> 当前 previous-stable：完整 1.0.37

> **发布状态（2026-08-11）**：1.0.37 已完成正式发布，随后在 1.0.38 发布中成为两地 Web/API、上海下载页和香港 Web-only previous-stable 的完整直接回滚。备份、隔离启动、切换、下载、PWA 和回滚证据见 [1.0.37 正式发布记录](./releases/1.0.37.md) 与 [1.0.38 正式发布记录](./releases/1.0.38.md)。本文以下内容保留开发交接时点的原始门禁与条件，不应再解读为“尚未发布”。

## 1. 交接结论

1.0.37 的功能实现、全量自动化、真实大档只读验证、clean source manifest、Web/API 归档、Windows unpacked 和 Android APK/AAB 未签名诊断制品均已完成。开发角色没有部署生产、修改排行榜历史、写入玩家存档、切换下载页或读取签名私钥。

自动化门禁为 0 失败，但发布必须保留条件：23.5MB 真实档快速离线 Worker 约 17.1～17.5 秒，端到端加正式验证约 36.5～36.8 秒；7 天/30 天非关键估计误差约 49.9%/81.5%；60 秒精确模拟约 12.75 秒。没有 Android 真机、低配 Windows、锁屏后台一小时或覆盖升级证据。建议只在 Release Agent 补齐设备与签名门禁并取得明确风险接受后灰度。

## 2. 本版范围

- 修正 v20+ 迁移可能从非持久资源目录引入幽灵单极磁石的边界。
- 提供只读审计、预览、备份、确认令牌、候选哈希、回滚和审计记录闭环；不会自动修玩家档，速通另需独立审核。
- 科技树桌面横向-only 布局，覆盖滚轮、触控板、拖动、键盘、卡片密度和 100%～200% 字号；手机保留纵向布局。
- 普通离线的不确定保守结果不再静默提交：可从原档精确重试、取消返回菜单，或普通模式双确认零收益跳过；速通保持 exact-only。
- 星图把两个既有批量物流按钮放在同排，新增“量子网络一键接入所有轨道收集器”，并提供确认、成功/跳过数量及原因。
- 完整保留 1.0.35 纯挂机计时/资源守恒和普通/速通存档隔离，完整保留 1.0.36 传送带、索引、自动保存、寻线、统计和建筑堆叠行为。
- 没有修改氢气量子物流规则、倍率平衡、排行榜协议或历史成绩。

完整实现与测试细节见 [1.0.37 开发报告](./DEVELOPMENT_REPORT_1.0.37.md)。

## 3. 兼容性边界

| 层 | 候选 | 与生产兼容性 |
| --- | --- | --- |
| 产品版本 | 1.0.37 | 新候选 |
| GameState | v46 | 与 1.0.36 相同 |
| envelope | v2 | 不变 |
| IndexedDB | 既有模式化记录 | 不升级 |
| cloud schema | v7 | 不变 |
| SQLite layout | v2 | 不变 |
| 普通/速通模式 | `normal` / `speedrun` | 沿用 1.0.35 隔离 |
| 排行榜协议 | 不变 | 速通仍要求明确模式和 exact-only |

旧档缺少模式字段时仍归入普通模式并保留迁移备份；不会自动标为速通。v20+ 资源恢复只采用持久星球目录声明。没有数据库 migration，1.0.36 Web/API 与 1.0.37 API 协议保持兼容，但生产切换仍需两地分别用备份副本做隔离启动和旧客户端兼容检查。

## 4. 源码与制品

### 源码

- clean source commit：`853ecdb12795844c484b1415f8e72967a25e343d`
- Build ID：`1.0.37+853ecdb12795`
- 本地 source manifest：`artifacts/release-manifests/1.0.37-853ecdb12795.json`
- source 文件：160
- aggregate SHA-256：`25b31f5b0ab500b67ac3d3f436d1c8fc8696f50672f627314587f52bdea86fba`
- manifest SHA-256：`1fb186700f24796205730a3366571a1112767bc0556508f8f66be1b864c6c2e8`
- Web/API 解包逐文件：160/160；Web 127、API 33；缺失/额外/哈希不匹配/重叠/禁止 API 路径均为 0。

### 候选目录

本地候选目录：`artifacts/release-packages/1.0.37-853ecdb12795`

| 文件 | 字节 | SHA-256 | 策略 |
| --- | ---: | --- | --- |
| `1.0.37-853ecdb12795-web.tar.gz` | 1,367,067 | `896038c1837a42fae82cd58f41ebaef717edf79d29b81b7f235d3b5fb65bfd16` | Web 候选；只进入未激活目录 |
| `1.0.37-853ecdb12795-api.tar.gz` | 106,423 | `ad2927f30a9c901269fa22ffc1daafa6da629d27f90834bbe75004ca1c264c81` | API 候选；只进入未激活目录 |
| `1.0.37-853ecdb12795-windows-unpacked-diagnostic-unsigned.tar.gz` | 150,112,282 | `d3e5b4d9b0b896533a2ab7899bb43e3372c2fb1a0cf3f07e8f0988f094a2d0bf` | 诊断；`NotSigned`；禁止 stable |
| `1.0.37-853ecdb12795-android-unsigned.apk` | 4,822,679 | `751c89fd8669d0f977e96b643b31497880fd10c15bd1f6fac43e73e7a890fa01` | 诊断；未签名；禁止 stable |
| `1.0.37-853ecdb12795-android-unsigned.aab` | 4,637,964 | `82848a7ae4a0d1c7fc22c6f30a405303517c179bd41a67e94f5848b8cc1e74fc` | 诊断；未签名；禁止 stable |

本地聚合记录：`artifacts/release-packages/1.0.37-853ecdb12795/candidate-artifacts.json`，SHA-256 `f02c6e30149dd6c43bca5d84d26207e60b6b031cdad8695d666e27afe2a3449f`，5/5 文件大小与哈希复验通过。

Windows 包内 `package.json` 与 `dist/version.json` 分别确认版本 `1.0.37`、Build ID `1.0.37+853ecdb12795`；文件版本 `1.0.37`、产品版本 `1.0.37.0`。独立 profile 启动 10 秒时主进程及 3 个子进程保持运行，之后只终止该 profile 的 4 个进程。Authenticode 为 `NotSigned`。

Android clean unsigned build 共 413 个任务并运行 lintVital。`aapt` 确认 `cn.dsponline.network / 1.0.37 / 1000037 / minSdk 24 / targetSdk 36`；zipalign 通过；`apksigner` 明确 APK 不验证，AAB 无签名块且 `jarsigner` 报告未签名。

## 5. 最终开发门禁

| 门禁 | 结果 |
| --- | --- |
| typecheck | 通过 |
| Vitest | 103 文件通过/6 跳过；936 通过/17 跳过；0 失败 |
| Playwright | 277 通过/11 显式条件跳过；0 失败；288 总数；803.5 秒 |
| server | 70 通过/2 可选夹具跳过 |
| ops | 6/6 |
| native tools | 8/8 |
| runtime licenses | 128 个包，当前 |
| root/server production audit | 均为 0 漏洞 |
| clean Web build | 通过；仅既有 >500kB chunk 警告 |
| clean Electron pack/smoke | 通过；`NotSigned` |
| clean Android release unsigned | 通过；APK/AAB 未签名 |
| source/archive verification | 160/160、160/160 |

关键 E2E 覆盖：科技树标准/紧凑 × 100/150/200%、滚轮/触控板/拖动/键盘、200% 科研操作、手机纵向；离线重载/取消/零收益跳过/精确重试；星图宽/窄/手机/200%、批量预览/取消/确认/原因；云上传资源目录保持。全量套件继续覆盖 1.0.35 的普通/速通隔离与纯挂机守恒，以及 1.0.36 的线路并联、燃料、索引和 Canvas。

## 6. 真实档证据与 go/no-go 条件

只读文件 `C:\Users\WINDOWS\Downloads\dsp-idle-save-2026-08-10.json` 为 23,531,371 字节，测试前后 SHA-256 均为 `2ea7d94236f12124b3bc7626da063220792087e5cd9dc9a7ef0b9803c77c1048`。

- 6,984/30,171/604,800/2,592,000 秒快速离线 Worker 往返为 17.116～17.546 秒，验证 19.153～19.649 秒，总计 36.503～36.801 秒。
- 最大估计误差分别为 2.624%、5.877%、49.941%、81.521%。候选均通过当前关键字段/结构/非负/序列化门禁，但不能宣称所有普通库存严格等价。
- 8x/12x/16x 时间扭曲 Worker 约 5.1～5.3 秒；终止 262.3ms，无迟到提交。16x 最大关键误差上界为 1.0。
- 一次 60 秒精确模拟为 12.749 秒，玩法哈希与 60×1 秒相同，非法数量 0。
- 合成设备矩阵覆盖 1GB/2GB/16GB 决策，但没有物理低配设备证据。

Release Agent 的 go/no-go 决策必须明确记录是否接受：端到端超过 30 秒、长窗口非关键误差较高、16x 关键误差边界、60 秒精确 12.75 秒、无物理设备测试。没有书面接受时应停止发布，不能把 decision-required 改回自动提交，也不能用清缓存、跳产量或补物资规避。

## 7. Release Agent 必做步骤

1. 从 commit `853ecdb12795844c484b1415f8e72967a25e343d` 建立全新 clean worktree，复验 source manifest、5 个制品和 candidate JSON。不要从后续文档提交重建二进制并沿用旧 Build ID。
2. Web/API 仅解包到香港和上海的不可变未激活目录；先验证 `version.json`、入口资源、PWA worker、API health、CORS、gzip/raw 和旧 hashed asset，不覆盖 `current`。
3. 两地分别创建并验证生产备份。在备份副本上隔离启动，核对 schema v7/layout v2、账号/云槽/排行榜数量、普通/速通同槽隔离，以及 1.0.36 Web 对候选 API 的兼容。
4. Android 必须使用既有长期证书从同一 source 重建 APK/AAB；验证 APK v2/v3、证书 SHA-256 连续性、zipalign、版本号、正式 API/update URL，并执行 `1.0.36 → 1.0.37` 覆盖升级。禁止创建或替换签名证书。
5. Windows 按现有发行策略从同一 source 重建 setup，记录 Authenticode/SmartScreen 状态，做 `1.0.36 → 1.0.37` 覆盖升级和独立 profile 冒烟。本文 unpacked tar 不能直接加入 stable feed。
6. 至少使用一台低配 Windows 和一台 Android 真机验证：200% 字号科技树、星图三个批量按钮、触摸/滚轮/键盘、普通/速通本地档、云同槽、离线取消/精确重试、锁屏/后台约一小时恢复、自动保存、寻线、统计、建筑堆叠和传送带堵塞。
7. 选择只读的普通大档验证快速离线决策弹窗，确认取消不写盘、精确重试从原档开始、普通零收益跳过需双确认；选择隔离速通档确认没有跳过入口且不能提交近似结果。
8. 不运行单极磁石修复工具处理真实玩家档。若另有明确个案授权，必须在发布流程外执行只读预览、原档备份、哈希/令牌、双人审核、候选复验和逐档回滚准备；速通额外审核。不得批量补矿。
9. 获得用户明确发布授权和风险接受后，先灰度一个 Web 节点，观察 Worker 延迟、decision-required 率、保存失败、负数/非有限值、云冲突和排行榜拒绝，再切第二节点与下载页。
10. 原子切换后核对两地 Build ID、API health、下载 Range/cache、PWA 在线/离线重开、普通/速通云槽、旧 1.0.36 客户端和五个正式下载文件哈希。稳定观察完成后再写 `docs/releases/1.0.37.md` 和正式标签。

## 8. 灰度停止条件

出现以下任一情况立即停止并回滚：

- 相同离线区间重复结算，或取消/重载后离线区间被消费。
- 矿脉减少却没有对应缓存/库存/在途产物，出现负库存、负矿脉或异常超大产量。
- 普通/速通同槽串档、自动保存互相覆盖、普通档可提交速通榜。
- decision-required 候选被自动写回，速通出现零收益跳过或近似结算。
- 单极磁石迁移删除合法节点、自动补矿，或资源工具绕过确认/审核。
- 星图批量操作未确认即改变多个目标、成功/跳过数量错误，或氢气规则发生变化。
- Worker OOM、保存读回失败、PWA 新旧 worker 混用、Android 签名不连续。

不能通过删除缓存、跳过产量、补发物资或直接修改排行榜历史掩盖问题。

## 9. 回滚

- 直接回滚版本：`1.0.36+e0ad49062fa3`，源码 `e0ad49062fa329040b379375b595ba74b7d23daf`。
- 若未切流，废弃候选目录即可；若已灰度，香港/上海 Web/API 和上海下载指针分别原子切回不可变 1.0.36 目录。
- GameState v46、envelope v2、cloud schema v7、SQLite layout v2 均未变化，不执行数据库降级，不删除玩家缓存，不覆盖玩家存档。
- 原生应用沿用 1.0.36 正式包/更新清单；不要发布本文 unsigned 诊断包。
- 资源个案候选若已另行获授权写入，只能使用该个案绑定的原始备份回滚；发布回滚不得触碰其他玩家档或排行榜历史。

## 10. 可直接交给 Release Agent 的提示词

```text
请发布前复验 DSPidle2 1.0.37 候选，但在获得明确发布授权前不要部署。

固定源码：853ecdb12795844c484b1415f8e72967a25e343d
Build ID：1.0.37+853ecdb12795
候选目录：D:\GameDev\DSPidle2\artifacts\release-packages\1.0.37-853ecdb12795
source manifest：D:\GameDev\DSPidle2\artifacts\release-manifests\1.0.37-853ecdb12795.json
开发报告：D:\GameDev\DSPidle2\docs\DEVELOPMENT_REPORT_1.0.37.md
交接：D:\GameDev\DSPidle2\docs\RELEASE_HANDOFF_1.0.37.md

先复验 160/160 source/Web/API 和 candidate-artifacts.json 的 5/5 哈希。Windows unpacked 与 Android APK/AAB 均为未签名诊断制品，禁止进入 stable；Android 必须用既有长期证书从固定源码重建，不能创建新证书。

生产当前保持 1.0.36+e0ad49062fa3。先做两地备份、备份副本隔离启动、低配 Windows/Android 真机、1.0.36→1.0.37 覆盖升级、约一小时后台恢复、普通/速通隔离、离线决策和星图/科技树多字号验收。明确记录是否接受 23.5MB 档端到端离线约 36.5～36.8 秒、30 天非关键估计误差约 81.5%、16x 关键误差上界 1.0 和 60 秒精确约 12.75 秒。

不要修改排行榜历史，不要自动修真实单极磁石存档，不要覆盖玩家存档，不要用清缓存、跳产量或补物资规避结算问题。只有用户明确授权后才按单节点灰度→双节点→下载页执行原子切换；任何守恒、串档、保存或签名异常立即回滚完整 1.0.36。
```
