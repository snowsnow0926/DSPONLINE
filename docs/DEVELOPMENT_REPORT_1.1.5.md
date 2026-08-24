# 1.1.5 开发报告

## 结论

1.1.5 运行时候选已在干净提交 `a92c0d3157f3658523d8d4abbbb0ae654dc4fc35` 收口，Release ID 为 `1.1.5-a92c0d3157f3`，Build ID 为 `1.1.5+a92c0d3157f3`。本报告之后的文档提交不改变运行时候选。开发阶段没有连接或修改生产环境。

本版解决 70+ MiB 终局存档在自动保存、手动保存及导出时的高峰值内存问题，补充大存档纯挂机真实验收，重做银河综合榜计分，并修复延迟 Worker 快照造成的生产进度视觉回退。

## 大存档保存与导出

- 序列化 Worker 在把结果交给持久化 Worker 前执行 gzip，避免主线程同时持有多个完整 JSON 字符串。
- 持久化 Worker 对 canonical envelope 做有界字段扫描，不再为校验重复 `JSON.parse` 整份终局存档。
- GameState v47 对精确默认值做稀疏化；重载只对 checksum 已验证的当前 v47 内部投影原位补回默认值，不把它当作通用迁移器。
- 浏览器、Windows 与 Android 支持 `.json.gz` 导入/导出；解压后硬上限为 256 MiB。Android 二进制分享采用受限 base64 协议，压缩文件上限 32 MiB。
- Web/API 云传输合同保持 schema v8 / layout v3 和现有生产数据语义，不修改玩家数据库或存档格式版本。

只读真实终局夹具：原始 79,443,856 B，68,649 个实体、135,168 条传送带；v47 canonical 投影为 66,298,825 B，gzip 为 2,763,120 B。夹具源文件测试前后 SHA-256 一致。

在 Chromium 768 MiB renderer 约束下，导入、连续两次自动保存、手动保存、备份读回及完整重载全部通过；两次自动保存原始体量约 66.4 MiB、gzip 约 2.77 MiB，耗时分别约 10.8 秒和 17.1 秒，无页面崩溃、主线程回退或未捕获错误。512 MiB 边界下保存与备份读回通过，但最后一次完整重载触及内存边界，因此不把 512 MiB 宣称为完整支持档。

## 纯挂机大存档

- 标准桌面环境中，只要估计序列化体量不少于 64 MiB，或峰值内存估计不少于 2 GiB，就直接选择保守宏观路径，不先经历高峰值精确校准崩溃。
- Worker 最终状态使用持久化投影协议返回并在主线程验证身份、摘要与 checksum。
- 对真实终局夹具的内存副本增加一个合法控制器后执行 30 天纯挂机：总耗时约 8.27 秒（初始化约 4.17 秒、收口约 4.10 秒），传输 66,413,133 B；结算 2,592,000 秒，结果可重载，实体/传送带数量保持，原始夹具未改变。
- 保守路径只精确执行可证明的 1 秒前缀，并冻结不确定尾段；不会把不确定生产夸大成精确结算。

## 银河综合榜 v2

计分版本为 `balanced-log-v2`。五个公开榜指标等权参与：累计发电、累计上传白糖、白糖产量、戴森功率、实际结算吞吐。每项得分为：

```text
round(max(0, log2(1 + value / baseline)) * 1,000,000)
```

基准分别为 1,000,000 MJ、1、1/min、100 kW、1/min，综合分为五项之和。不再使用隐藏的探索星系或殖民行星加分，也不允许累计量因单位位数压倒速率榜。客户端与服务端使用同一公式和版本字段；匿名公开 Top 100 回放验证 `HIT丶矢乐志` 在给定榜面数据下成为综合第一。

## 门禁结果

| 门禁 | 结果 |
| --- | --- |
| clean source / version | PASS：1.1.5、SHA、Build ID、Android `1001005` 一致 |
| licenses / audit | PASS：125 个运行时包；root/server production audit 均 0 vulnerability |
| typecheck / build | PASS：1,963 modules；startup gzip 194,912 B；menu 284,823 B；forbidden startup modules 0 |
| Vitest | PASS：178 files passed、8 skipped；1,457 tests passed、21 skipped |
| server / station | PASS：376 passed、2 optional skipped；station 3/3 |
| native tools | PASS：25/25 |
| ops | PASS：56 passed、6 Linux-only skipped |
| Chromium full E2E | PASS：427 passed、26 conditional skipped、0 failed |
| production-preview PWA | PASS：1/1 |
| durable recovery | PASS：7/7 |
| release switch isolated | PASS：29/29 |
| 大存档真实验收 | PASS：768 MiB 完整保存/导出/重载；30 天纯挂机通过 |

条件跳过由 gate report 固定记录，未把缺少可选外部夹具当作核心通过。Android JVM 门禁在隔离开发 shell 中仅因未注入 SDK 而未运行；Release Agent 必须通过批准的受保护加载器重跑、正式签名并验证长期证书连续性。实体 Android 设备仍是发布门禁，除非用户对精确候选另行明确豁免。

## 冻结制品

隔离候选目录：`D:\GameDev\DSPidle2-v115-release-candidate`。

- bundle：`artifacts/release-bundle/1.1.5-a92c0d3157f3`
- source manifest：261/261，aggregate `1d4e0ae07c3ecafb04a87825ce8a3963b9ab7612a03217bfa045073f2f2563dc`
- candidate manifest：8/8，aggregate `429b2f57608f96f77f47f4a8015dc94ef68e161ff4fa77c3b4fad227ce7cf8e1`
- provenance：3/3 verified
- SHA256SUMS：10/10 verified

| 制品 | 字节 | SHA-256 |
| --- | ---: | --- |
| Web | 1,755,794 | `f1f0958134cb875c3eb645ce51d9256bc6fff1e91aec5479284987efbea18b5d` |
| API | 690,119 | `7328bb8b1cdee03fd3a1cda8405248a6b85d49d7a1be8b00d34bb1ea667843c2` |
| source | 6,800,639 | `b456674cbb05e97fe045031fff4ef368819b1dd798f87bc2efc23e4fa552701f` |
| Windows unpacked diagnostic | 150,442,878 | `70fab3b92e78325233dfeb366b39d2b38572c384eb46f46f836584f467d6b272` |

四份 tar 均完整读取且未命中数据库、私钥、证书容器或真实环境文件路径；source archive 从固定 SHA 二次生成得到相同 SHA-256。Windows 诊断包为 `NotSigned`，只能用于发布角色下的正式打包比对，不能直接进入 stable。

## 剩余发布工作

发布角色需要在精确 runtime SHA 上：重跑受保护 Android 门禁并正式签名；按历史策略生成 Windows `NotSigned` stable installer；制作 native feed/download site；对香港和上海分别完成只读预检、磁盘保护、SQLite Backup API evidence、不可变目录上传、依赖 smoke、原子切换、公网/PWA/Range/hash/signature 验收。全量成功后把 1.1.4 设为 previous-stable；任一目标失败时不得宣称完整发布成功。
