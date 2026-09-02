# 固定 P 核稀疏 legacy station A/B：No-Result

结论：本轮不能证明持久化 active-route 索引有性能收益，也不能据此拒绝候选 Host。6 个进程都成功完成并落盘，但 6 次合成 fixture 的 SHA-256 全不相同；warm 与逐步 canonical SHA-256 也不相同。因此表面的 1.81% / 4.13% / 4.72% 候选降幅只能保留为无效诊断，不能用于接受或拒绝。

## Host 身份

| 角色 | SHA-256 | 大小 | 来源 |
| --- | --- | ---: | --- |
| baseline | `48f097027b90481b37631a2845cb38fcab96ff0db9aedd4b7dbb9e0c9739dc03` | 13,353,472 B | detached clean `5cc95ca28e8fedbcf3b0f9a58ba5650d1596c3ef`, tree `622e7b43a29e1dc076fc325c765c7f685cec5582` |
| candidate | `af5d990292abc878f667b3cb6d0dd88867eeacd180c2fadee186740535189152` | 13,330,432 B | 当前工作树冻结二进制 |

先前里程碑 `6cd7d700d1992e46686525ad6e5b0516061bbccaae1ca816ae6d2d87fc21409b` 已不在磁盘：扫描 91 个 Host 和可用 ZIP 均为 0 命中。clean `5cc95ca` 独立构建因此作为源码里程碑 baseline，但不声称与 6CD7 位相同。

## 已通过的运行门禁

- 顺序：baseline → candidate → candidate → baseline → baseline → candidate。
- 6/6 Vitest 与 Native Host 退出并完成五个 warmed 60 秒推进。
- Node 为 `High@0xFFFF`，Native Host 为 `Normal@0xFFFF`；两角色 6/6 都固定在逻辑 0–15 P 核，线程请求均为 8。
- 场景计数在 6/6 一致：525 entities、65,543 routes、517 groups；其中 16,384 active legacy-station routes、49,152 dormant routes。
- 每个测量步均 `activeQueueEnabled=true`、`fullScanPasses=0`、180 passes；route checks 2,950,166–2,950,380，跳过稳定线路 8,847,360–8,847,574。
- 所有样本最终 domain SHA-256 相同：`acfdde8c5df45e308b3d7bef2c71dd8c4471aa58101ddd0aa10ed8a1e0f53b56`。

## 失败的决定性门禁

| seq | 角色 | fixture SHA-256 | warm canonical SHA-256 | 样本 median |
| ---: | --- | --- | --- | ---: |
| 1 | baseline | `d7e7d15823a28324121d8a8481962c298826352e8426ef1b3e5aa52a2724addd` | `75d339e0be51a12c78b387ea07d7d25501acf4c3d544bc7d33adcbbfc4bd4812` | 750.900 ms |
| 2 | candidate | `0c26cf122ef8aab208b7ef91973b607cce9763aa94e33be364524f94137ecd54` | `4f81395985d7f8e6e3c9c014da6cca88438d13a2cdb9932d54041697bad2506c` | 737.291 ms |
| 3 | candidate | `af5a9edb3f29f6239b700233a9af523b1b081756bbb1c05e078d80f913c305b2` | `53996ba63be0647311003dc30c2a1c0b5be830ee5e345bd39da348de7c21cd4a` | 739.287 ms |
| 4 | baseline | `ca8c04fb340512a49682ebaf2a4fc78e47925c95d05ab9af9cc22d03cfa206d2` | `5325b710f9832c2be7d30bf04784e4fd9545cb0db5f316bf2305408903afe045` | 771.127 ms |
| 5 | baseline | `0a234776cd56a1e309627fb0ebd47a984155b8c5a4572a4f22d074891c202e43` | `1fa8fa77331cd8810d7a7110144f9cc29518554745375cd96e0d89f875bd23e9` | 776.759 ms |
| 6 | candidate | `a0568c3e0cd0b1fcb83ada118edea851320b8cfc4aedf93e28259250f88f6360` | `9bccc80b486013fbea1676b1e7fb25332d9d2dbe6e4f090f711f7899724b2d5d` | 740.072 ms |

runner 在每个进程内重新生成 GameState，进程变化字段进入持久化字节和 canonical hash。拓扑与 domain proof 相同不足以替代“同一输入字节”的 A/B 门禁。

## 原始证据

runner：`station-active-route-benchmark.test.ts`（SHA-256 `cbc8bb5872540c84aa6d9d30b309a4be474eca0c3a9c569efeb28fc7be2ae434`）与 `vitest.config.mjs`（`6f01a054b5789833d4664cf94e7c931a91fa806cdb2efe906f8c8f95d36609d4`）。

每个下列 stem 同时存在 `.json` 与 `.log`：

- `baseline-round-1-sequence-1`
- `candidate-round-1-sequence-2`
- `candidate-round-2-sequence-3`
- `baseline-round-2-sequence-4`
- `baseline-round-3-sequence-5`
- `candidate-round-3-sequence-6`

完整逐文件哈希、每步 canonical/domain、时序和调度诊断见同目录 `synthetic-pcore-ab-no-result.sanitized.json`。报告只使用占位符与相对 artifact 名，不含绝对本机路径。

## 下一最小实验

先一次性生成并持久化一个 synthetic v47 envelope，记录 SHA-256；所有子进程只读同一个文件，并在计时前强制 fixture 与 pre-step canonical hash 全等，再执行 B-C / C-B / B-C。真实 91,955-route 玩家档另跑 Full A/B，只判非退化，不宣称 O(active) 收益。
