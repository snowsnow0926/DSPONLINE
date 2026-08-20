# DSP极简网络 1.1.1 云上传与挂机保存 P0 开发报告

> 状态：开发完成，运行时候选已固定，未发布
>
> 分支：`codex/1.1.1-cloud-upload-p0`
>
> Runtime SHA：`a2d64acf1845ad912a9c19c6781b05801d8685e1`
>
> Build ID：`1.1.1+a2d64acf1845`
>
> Release ID：`1.1.1-a2d64acf1845`
>
> 兼容基线：1.1.0 / `9b2c579cbe0de8848f6a4573371fd1322cec0c45`

本轮在独立工作树 `D:\GameDev\DSPidle2-v111-cloud-upload-p0` 完成。没有连接生产、上传玩家附件、修改玩家账号或云存档、签名原生制品、更新下载页或执行部署。两份玩家附件全程只读，开发前后文件大小与 SHA-256 完全一致。

## 1. 结论

1. 已查明 1.1.0 合法存档被服务器报告“云存档格式无效”的确定原因：玩家在同一任务日结算全部四个空间站合同后，客户端因报价列表为空而按相同 seed/taskDay/slot 再次生成同一组合同，导致 `offers` 与 `history` 出现四个重复 ID；服务端的严格去重校验因此拒绝整个云正文。
2. 客户端现在以 `history + settledIds + accepted` 为不可再次报价集合。加载受影响存档时只移除不可领取的同 ID 报价，保留历史、奖励、徽记、声望和结算防重记录；同一任务日不再重生，下一任务日仍正常生成新合同。
3. 服务端增加严格受限的 1.1.0 兼容：仅当报价与已结算历史的合同身份、需求和奖励完全一致，且该 ID 已存在于 `settledIds` 防重集合时接受。缺失防重、伪造奖励、accepted/history 冲突及其他重复 ID 继续拒绝。
4. 已查明纯挂机终止或页面长时间卡顿后误报“跨标签页覆盖”的三条同页竞态：React effect cleanup 绕过主保存生命周期直接写入；Persistence Worker 把同 owner/token 的过期租约当成接管；排在 proof commit 后的同页 legacy 写仍携带 proof 前的 revision/catalog。
5. 生命周期保存现在进入同一个有序 primary 队列；依赖替换和开发 StrictMode cleanup 由 generation 微任务取消，真实应用内卸载使用静默保存，纯挂机持有时间线时不注入 cleanup 保存。过期租约只允许完全相同的 writer/fencing token 续租；同页后续写仅在当前 payload/catalog/revision proof 完整且由同一 fence 推进时 rebase。真实其他标签页接管仍是硬冲突并保留双方版本。

## 2. 两份只读附件证据

### 云上传附件

- bytes：`2,855,557`
- SHA-256：`a4830a56c944c4fd0a4d1025b82cd4f2502335b352157411707b329916011cff`
- envelope v2 / GameState v47 / normal；完整性校验通过。
- 2,273 entities / 4,710 belts。
- 修复前合同板：offers 4、accepted 0、history 4、settledIds 4；四个 offer ID 全部与 history 重复。
- 修复后的服务端校验直接接受原始正文；客户端规范化结果为 offers 0、accepted 0、history 4、settledIds 4。
- 附件没有上传到任何服务器，也没有被改写。

### 纯挂机/假冲突附件

- bytes：`24,065,369`
- SHA-256：`19a18164b0b66fb5df18d6ecaebf4bd5ea44be4839f737753a350e805b50d6d2`
- envelope v2 / GameState v47 / normal/main；完整性校验通过。
- 21,190 entities / 41,136 belts；存档累计约 1,072.7 小时；`timeWarp.enabled=true`，未提交时间预算为 0。
- 实际浏览器验收完成两次权威 autosave、逐字读回、自动快照、重载和继续运行；两次保存约 2,638 ms / 1,632 ms，冲突记录始终为 0，writer 仍为 primary。
- 首轮大画布观测仍包含最高约 210 ms 的 Long Task；本热修修复由卡顿诱发的错误冲突和保存失败，不宣称已经消除所有超大工厂绘制卡顿。
- 附件没有上传到任何服务器，也没有被改写。

## 3. 兼容边界

- 产品版本：1.1.1；Android metadata：`1.1.1 / 1001001`。
- GameState v47、save envelope v2、cloud schema v8、SQLite layout v3、IndexedDB database/version/object store/record schema 均不变。
- 不改变玩法数值、合同奖励、玩家库存、云 revision、排行榜或空间站公开资料。
- 服务端兼容只放宽已经由 `settledIds` 防止重复领奖的精确 1.1.0 遗留形状；不存在通用“忽略重复 ID”。
- 真实跨标签页写入、不同 fencing token、损坏 catalog、stale revision 和伪造正文仍被拒绝。

## 4. 最终验证

| 检查 | 结果 |
| --- | --- |
| Version consistency | 1.1.1 / Android 1001001，通过 |
| TypeScript | 通过 |
| Full Vitest | 190 files passed / 16 skipped；1,514 passed / 29 skipped / 0 failed |
| Server | 363 passed / 2 skipped；station 3/3 |
| Ops / release switch / native tools | 56/6；29/29；24/24 |
| Final Chromium | 431 passed / 28 条件跳过 / 0 failed（459 total，4 workers） |
| 真实 24 MB 附件 autosave | 1/1；两次 proof save、快照、重载、继续运行、0 conflict |
| Web build | 1,972 modules；startup 195,381 B gzip；menu 286,632 B；forbidden startup modules 0 |
| API expanded smoke | 166 files；临时 SQLite `/api/health` 200；schema v8 / layout v3 |
| Immutable metadata | source 254/254；Web 158/158；API 166/166；candidate 7/7；provenance 3/3 |
| Diff hygiene | `git diff --check` 通过；运行时提交后工作树 clean |

第一次 459 项全量回归有一个旧 v33 测试直接读取已迁移为空的 localStorage，得到 430 passed / 28 skipped / 1 failed；产品保存已经正确写入 IndexedDB。测试改为等待 manual persistence complete 并读取正式持久层后连续 3/3 通过，随后完整 459 项得到上述 431/28/0。没有隐藏失败、增加 retry、skip 或放宽产品门禁。

## 5. 不可变开发制品

Artifact root：`D:\GameDev\DSPidle2-v111-cloud-upload-p0\artifacts\release-bundle\1.1.1-a2d64acf1845`

- source manifest：254 files，aggregate `918c601f897fcb218f5ee99dfa96debf7d5fd808643046d5eb8e058a85467274`
- Web component：158 files，aggregate `31e8db4196d91453172308b622cca21b2bbf2536aa8578d12f59903ca288dc69`
- API expanded component：166 files，aggregate `8aaff8110b6edfc25cff3f356c0579f911a3d525e1cf46f344d1499752aae281`
- candidate bundle：7 files，aggregate `8497df2d182ba2534a018efb6af6c315d2038060bd373acd0a96d20e28394663`
- provenance：3 subjects verified against runtime SHA。
- Web/API 归档路径扫描未发现 `.env`、数据库、私钥或证书文件；展开内容高置信私钥模式命中 0。

当前只形成 source/Web/API 开发候选。没有构建 Windows 安装包、Android APK/AAB，也没有调用受保护签名加载器；Release Agent 不得把 1.1.0 原生包改名复用。

## 6. 剩余发布门禁

- Release Agent 从 runtime SHA 建立独立 clean checkout，重新核对 manifest/provenance 并按风险复验。
- Windows 按既有策略明确 `NotSigned`；Android 必须由批准的受保护来源重新构建并验证长期证书连续性、v2/v3、package/version 和真实设备门禁。
- 香港、上海必须分别取得新鲜且验证通过的 SQLite Backup API evidence、磁盘容量、current/previous/rollback 指针和隔离 API 启动证据。
- Web 与 API 应作为同一热修发布，完成两节点 health/ready、公网云上传、PWA/cache、下载页/Range/hash 和观察窗口。
- 当前生产和 previous-stable 必须在发布时重新读取；本开发报告不授权部署或预设回滚版本。

