# DSP极简网络 1.1.0 RuntimeWorld 2.0 Release Agent 交接

> 交接状态：开发侧完成，未发布
>
> 当前线上：1.0.47 / `1.0.47+aab581cf0c78`
>
> Runtime / candidate SHA：`9b2c579cbe0de8848f6a4573371fd1322cec0c45`
>
> Build ID：`1.1.0+9b2c579cbe0d`
>
> Release ID：`1.1.0-9b2c579cbe0d`
>
> 分支：`codex/1.1.0-runtimeworld-2`
>
> 工作树：`D:\GameDev\DSPidle2-runtimeworld-2`

本交接不授权连接香港/上海生产、部署、正式签名、更新下载页、切换 stable 或修改玩家/生产数据。Release Agent 只有在用户明确批准发布后才能开始独立复验；未经重新交接不得发布。

## 1. 必须先确认的版本事实

1. 当前生产已经是 1.0.47，runtime SHA `aab581cf0c78e480e1d10fe4c7f91e6d6d9311b7`。1.1.0 必须以该正式行为为兼容基线，不得从旧 1.0.46 候选重新分叉。
2. 1.1.0 固定运行时候选是 `9b2c579cbe0d...`。交接文档提交发生在候选冻结之后，不改变已构建制品对应的 runtime SHA。
3. `07132550abd5...` 因 Android 菜单启动闭包超预算而作废；它的 source/Web/API/Windows 部分制品不是候选，禁止补齐后发布。
4. 旧 1.0.46 `865f125e8624` 与更早 c24 候选继续作废；它们不能被复用或改名为 1.1.0。
5. Windows/Android 当前都只是未签名诊断制品。source archive 只供内部交接，不作为公开下载。

## 2. 1.0.47 已融入内容

合入提交 `07132550abd5df4bd81eb3faa40534ad6cffbf21` 包含：

- “经典”基础卡片：1.0.43 风格 `224×76`；最简卡仍为 `96×32`。
- Canvas 传送带在画布拖动和节点几何重绘后保持实时 viewport，不与建筑错位。
- connection draft 活跃时暂停旧任务、生产链、网络和寻线 dim，建筑不会偶发半透明。
- PWA 生成资源从当前 release root 解析，根页与不可变 canary 均不会形成 `assets/assets/...`。
- 正式 1.0.47 发布记录纳入 `docs/releases/1.0.47.md`，只作为兼容基线事实。

1.0.46 已发布的时间感知周期进度、纯挂机瞬时负数和普通空间站合同量子交付修复也在 1.1.0 全量测试中保留。

## 3. RuntimeWorld 2.0 开发结论

- M-1、M0～M6 开发侧全部收口。RuntimeWorld 默认启用，旧引擎只作为受控领域 fallback/oracle；生产不运行 shadow 双跑。
- Worker 私有 slot、generation、domain revision、dirty journal、传送带/生产/供电/物流/量子编译索引都不进入持久化。
- 非拓扑命令只更新目标 slot 与受影响依赖；结构、内容 fingerprint、revision 缺口或完整性失败会重建明确领域。
- 传送带顺序、公平游标、容量、预留和尾货语义保持；物流稳定岛只跳过已证明无结果的本地扫描，量子和跨岛继续显式 fallback。
- Simulation Worker 准备 canonical save；Persistence Worker 独立 checksum/proof/CAS/事务提交/精确读回。所有 primary 意图共用串行生命周期。
- Canvas 和保存 UI 使用 selector store 发布最小变化，React Flow 的交互、位置、选择、拖动和无障碍外层节点保持。
- GameState v47、save envelope v2、cloud schema v8、SQLite layout v3、IndexedDB records 与排行榜协议不变。

## 4. 两份真实档最终性能

正式开发基线为 `58456b391c4311c0a4969cfe7075c0f47bc75b12`。每档在最终 SHA 执行三次独立冷进程；百分比仅与同机、同入口、同 profiler 模式的 M-1 中位比较。

| 指标 | M-1 | 1.1.0 最终 | 下降 | 结论 |
| --- | ---: | ---: | ---: | --- |
| A 60 秒精确模拟 | 21,631.059 ms | 11,397.269 ms | 47.31% | 通过 40%；未达到 55% |
| A 逐秒 P95 | 489.596 ms | 266.373 ms | 45.59% | 通过 |
| B 60 秒精确模拟 | 6,517.766 ms | 2,718.954 ms | 58.28% | 达到 55% |
| B 逐秒 P95 | 161.000 ms | 54.416 ms | 66.20% | 通过 |

三次 exact/gameplay hash 固定，整段与切片玩法状态一致，`invalidAmounts=0`。发行说明不得写成“所有大档均下降 55%”；可以写“两份验收档均超过 40%，分别为 47.31% 和 58.28%”。

最终 production-preview：A/B 暂停第二帧 36.2/49.5 ms，恢复第二帧 31.4/38.7 ms，画布 P95 16.7/16.8 ms，自动保存 1,222.5/370.1 ms，运行与保存 Long Task 均为 0。两份原件 bytes、mtime 与 SHA-256 未改变。

## 5. 最终门禁

- root `npm ci`：456 packages；server `npm ci`：75 packages；两处 production audit 0 vulnerabilities。
- `npm run licenses:check`：125 runtime packages consistent。
- `npm run typecheck`：passed。
- `npm test -- --maxWorkers=1`：190 files passed / 16 skipped；1,512 passed / 29 skipped / 0 failed。
- `npm run test:server`：363 passed / 2 skipped；station 3/3。
- `npm run test:ops`：56 passed / 6 Linux-only skipped。
- `npm run release:test-switch`：29/29。
- `npm run test:native`：24/24。
- `npm run test:e2e:durable -- --workers=1`：7/7。
- `npm run test:e2e -- --project=chromium --workers=4`：429 passed / 28 explicit conditional skipped / 0 failed（457 total，6.0 分钟）。
- Firefox + WebKit nightly：10/10。
- production-preview functional matrix：34/34；PWA `repeat-each=3`：3/3。
- `npm run build:web`：1,972 modules；startup 195,203 B gzip（JS 102,177、CSS 93,026、最大 JS 58,974）；menu 284,843 B；forbidden 0。
- source manifest 254/254；candidate 10/10；provenance 3/3；SHA256SUMS 12/12。

gate report 声明 22 条条件跳过。完整 Chromium 的 28 条实际跳过均须由 Release Agent 按框架输出复核，不能只用静态声明数量替代实际报告。

### 性能失败必须保留

连接视口隔离门禁通过；显式 expand-all 仍有 133.3 ms 诊断峰值。密度性能第一次最终 SHA 执行有一个 auto 子轮 P95 33.3 ms，按原 `<=21 ms` 门限失败；独立新进程复跑三轮 P95 16.8/16.7/16.7 ms 后通过。没有 retry、skip 或阈值放宽。目标发布机若重复超限，应停止发布。

## 6. 平台诊断

### Web / API

- Web archive：158 files；Build ID 正确。
- source manifest：Web dist + API source inputs 254/254，aggregate `7356b832691c42d9bd5de8563f7101475b40a9f190171f0b16c6b25d75dbce4c`。
- API expanded diagnostic：166 files，aggregate `ea53c0ae5ee6be93db2d3b388fda968ef93d5ddbd5d77b8fa80dfd57dac88cd7`；临时 SQLite health 200。

### Windows

- unpacked ASAR：package 1.1.0，Build ID `1.1.0+9b2c579cbe0d`。
- 独立用户目录、隐藏启动 12 秒后进程树为 4 个；只按精确 PID 关闭，剩余 0。
- Authenticode：`NotSigned`。

### Android

- Gradle `bundleRelease assembleRelease lintVitalRelease`：332 tasks，成功。
- package `cn.dsponline.network`；versionName `1.1.0`；versionCode `1001000`；minSdk 24；targetSdk 36。
- APK zipalign 成功；`apksigner verify` 返回非零并明确 `DOES NOT VERIFY`。
- AAB `META-INF` 签名条目 0；`jarsigner` 报告 unsigned。
- APK/AAB 内置 Build ID 均为 `1.1.0+9b2c579cbe0d`。

首次 Android 构建在旧 SHA 发现菜单 `287,658 > 286,720 B`。最终通过懒加载仅设置页使用的 `NativeUpdateCard` 修复，没有放宽预算；Android 最终 menu 286,471 B。

## 7. 不可变制品

Artifact root：`D:\GameDev\DSPidle2-runtimeworld-2\artifacts\release-bundle\1.1.0-9b2c579cbe0d`。候选目录固定为 10 个文件，共 170,457,946 bytes。

辅助元数据：

- `artifacts/release-manifests/1.1.0-9b2c579cbe0d.json`：254/254，aggregate `7356b832691c42d9bd5de8563f7101475b40a9f190171f0b16c6b25d75dbce4c`。
- `artifacts/release-manifests/1.1.0-9b2c579cbe0d-candidate.json`：10/10，aggregate `18e0c471294a70bd01e1f7454fac7d643746792d274af00e18f89d010d3751eb`。
- `artifacts/release-manifests/1.1.0-9b2c579cbe0d-provenance.json`：3/3 subjects verified。
- `artifacts/release-manifests/1.1.0-9b2c579cbe0d-SHA256SUMS.txt`：12/12。
- `artifacts/release-gate/1.1.0-9b2c579cbe0d-{source-gate,sbom.cdx,gate-report}.json`：clean source、CycloneDX SBOM、22 条静态条件跳过声明。

| 制品 | bytes | SHA-256 |
| --- | ---: | --- |
| source archive | 6,865,491 | `e28c70d45cc94fc8037210f575cdb2b2aee29457e6de7be6583cf9508369020a` |
| Web archive | 1,795,504 | `935bf2558f4a13918bac05e7f5ef7d7b978c9d95ccb84f32e3bc0572e5d7fd63` |
| API archive | 668,361 | `c237a7bd7ea68a217193cbdda02c2c086dd86aa5d9885a3915e8f201051a2686` |
| Windows unsigned unpacked | 150,488,837 | `0457ac87e14b0cc1cb0807cd63ea5183266ea8a8962303cde23b99135053884a` |
| Android unsigned APK | 5,182,908 | `c46400b47a4783656dae36cc7d24679566645f53523905b6b1d5b6dfb387d668` |
| Android unsigned AAB | 4,999,363 | `0f1f9aaa2cd6db4835055b777f590c52563490e86a00b1bb706efec9be6b8d88` |
| source manifest | 43,214 | `542738f61f0233e5b8a5ef8df062daf9a3c65bc24c855486d5708efc9460fac2` |
| source gate | 176 | `0e023fdbc9e8fac804fdd7fc42e085ebc8c2c8533213764f9271dc1f035ad914` |
| SBOM | 407,390 | `95b0917239d34c84f140ae5087972026c89349af1f39e52c33daa0543d96d6e5` |
| gate report | 6,702 | `6098477c667753d2a15fc3b312b326395863c8839a3df49dbd15541115d490d6` |

source archive 二次生成 SHA-256 完全一致。六种归档与 Windows ASAR 共扫描 7,930 个条目，敏感路径 0；Web/API/Windows/Android 解包运行时共 5,482 个文件，本机路径、截图名、私钥头和高置信凭据模式命中 0。

## 8. 已作废候选

- `1.1.0-07132550abd5`：Android 启动预算阻断，部分制品作废。
- 所有 `9b2c579cbe0d` 之前的 1.1.0 runtime SHA：不是当前候选。
- `1.0.46-865f125e8624` 和更早 c24 候选：继续作废。

不要删除或覆盖这些历史目录来“复用路径”；新运行时代码变更必须重新固定 SHA、Build ID、Release ID，重建全部平台制品并按风险重跑门禁。

## 9. Unverified gaps / stop conditions

- 正式 Windows/Android 签名、证书连续性、时间戳、Android 实体设备。
- 低配 Windows/Android 30 分钟内存趋势。
- Linux systemd/Nginx、API 正式发布目录、生产备份、磁盘容量与 rollback preflight。
- 香港/上海原子切换、previous-stable、公开 PWA/API/download smoke、下载页更新与观察窗口。
- 当前线上 generation、slot、previous 指针和备份状态必须由 Release Agent 在授权后的新会话重新读取，不能沿用 1.0.47 发布记录中的旧瞬时值。

签名、授权、备份、回滚、目标节点或性能门禁任一缺失/失败即停止。代码回滚不得恢复、替换或降级生产数据库。

## 10. 给 Release Agent 的下一跳

只有用户明确批准发布后才能继续：

1. 从 runtime SHA `9b2c579cbe0de8848f6a4573371fd1322cec0c45` 建立新的隔离 checkout；不要把后续 docs-only commit 当作制品 SHA。
2. 先独立复算 `SHA256SUMS`、candidate manifest 和 provenance，再执行 clean `npm ci`、完整 release gate、两档真实性能/保存、production-preview PWA 和密度/连接性能；不得把第一次密度失败隐藏在重跑后。
3. 从同一 runtime SHA 使用批准策略重新构建正式 Windows/Android，验证证书连续性、签名、时间戳、APK/AAB 和实体设备。当前 unsigned 包禁止发布。
4. 若包含 API，在临时 SQLite 和最终展开目录先启动复验；生产写入前取得新鲜备份、quick check、schema/layout、容量和 rollback preflight。
5. 重新读取两地 current/previous、release-control、代理、服务、下载页与磁盘事实；按现行 runbook 做原子切换和回滚门禁。
6. 完成公网版本、health/ready、PWA、canary、下载 Range/哈希、原生 feed 和观察窗口后，才可形成正式 `docs/releases/1.1.0.md`。本开发任务不得提前创建正式发布记录。
