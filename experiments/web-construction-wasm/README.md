# Web construction kernel probe

这是性能实验，不是游戏运行后端，不会进入 Web 发布包，也不读写本地/云端存档。生产 JS、原生 Host、存档版本和自动备份开关均不受影响。

## 测量对象

- `src/lib.rs` 直接编译现有 `native/dsp-native-core/src/construction_planner.rs`，不复制修改算法；一个仅含目录的 `CoreState` 外壳代替完整游戏状态。
- Rust 和 JS 使用同一目录、科技、库存和目标，逐项比较可制造性、递归步骤、配方选择、材料余额，并复核 Rust 提供的原料短缺原因。未比较 UI 文案，不覆盖生产中心调度、量子配送、退款及电力结算；因此通过本实验不等于可接管游戏。
- 首次传输只有目录，后续调用只有目标编号、相关库存和科技。整份玩家存档不会传入 WASM。
- `endToEnd` 计入每次 JSON 编解码、字节拷贝、调用、结果回读及材料核对。`coreOnly` 预载请求，排除转换与回读，表示理想计算下限，不能用它代表实际接入收益。
- `large-save.ts` 是另一条独立测量路径，在真实 Chrome 中运行 JS 大档结算，对齐 `replicationConstructionBenchmark.test.ts` 的材料压力条件、预热、重新克隆、8 倍产率复制及固定最终序列化时间。读取/准备与序列化另列，推进调用不含这些费用。

## 运行

在仓库根目录，使用现有 Rust `wasm32-unknown-unknown` 目标和 Chrome。所有生成文件放入被忽略的 `artifacts`，无需新增 npm 依赖：

```powershell
$env:CARGO_TARGET_DIR="$PWD/artifacts/web-construction-wasm/target"
cargo build --manifest-path experiments/web-construction-wasm/Cargo.toml --release --target wasm32-unknown-unknown --locked
node experiments/web-construction-wasm/run.mjs
node node_modules/typescript/bin/tsc -p experiments/web-construction-wasm/tsconfig.json --pretty false
```

输出 `artifacts/web-construction-wasm/browser-wasm-probe.json`。运行器只创建无用户配置的临时 Chrome 会话，在随机端口的 `127.0.0.1` 提供实验脚本和 WASM，结束后关闭浏览器及服务。

大档测试需显式提供已有的预热样本路径；不要用玩家正在保存的文件，也不要把样本加入 Git。可用 `--source` 选择旧/新代码目录；程序不会改动源目录或样本，并在运行前后检查样本哈希。每次一个新浏览器进程，以旧/新/新/旧顺序运行；`--name` 指定各次输出名：

```powershell
node experiments/web-construction-wasm/run.mjs --entry=large-save --prepared=D:/path/to/private-prepared.json --source=D:/path/to/checkout --name=browser-large-a1
```

结果含完整最终状态的哈希，不输出状态内容。大档测试的“材料充足”场景只改浏览器内的副本，不代表原存档本来就有这些材料，也不是全游戏帧率、加载耗时或峰值内存测试。

`--entry=save-profile` 使用同一只读样本测量持久投影、传输序列化、接收校验/解码和兼容字符串再编码，每进程三次。它不补充库存或推进生产，不含数据库 I/O；用同样的 `--source` 与旧/新/新/旧顺序比较。每次输出包含完整 payload 哈希，原文件在运行前后均校验。

`--entry=save-responsiveness` 运行真实保存 Worker，并记录定时器、动画帧与回包时注入的测试点击。运行器按内存中的构建产物表提供 Worker 脚本，使用 ES 模块保持 URL 正确。`--decoder-ref=<commit>` 只从该 Git 提交替换 `storage.ts` 和 `saveTransferDecode.ts`，其余源码不变；比较前必须确认相关运行改动只在这两个文件中。

响应测试加 `--memory=1` 时启用 Chrome 精确页面堆信息，并在 Windows 读取当前测试浏览器的 renderer 工作集。进程峰值包含整个测试生命周期，不是某个函数的净分配；`--collect-memory=1` 另在源状态和返回文本均存活时主动收集垃圾，比较保留堆。内存参数用于独立诊断，不能把测试点击或页面堆当作完整游戏 FPS/总内存。

## 普通运行与量子入库对照

`--entry=quantum-runtime` 使用原库存，不补充材料，按 1、10、30 个累计模拟秒推进普通
持久运行时。读取、索引准备和完整状态哈希分别计时；最终对比包含运行诊断字段的完整
GameState JSON 及量子网络摘要，不只比较总产量。

```powershell
node experiments/web-construction-wasm/run.mjs --entry=quantum-runtime --prepared=D:/private/prepared.json --runtime-ref=c07b8ad6 --name=normal-old
node experiments/web-construction-wasm/run.mjs --entry=quantum-runtime --prepared=D:/private/prepared.json --name=normal-new
```

`--runtime-ref` 只替换指定提交的 `engine.ts` 与 `quantumLogisticsNetwork.ts`，其他模块沿用
当前工作树，因此先核对生产改动仅限这两个文件。输出记录运行文件摘要和实际 bundle
摘要。此参数也可用于 `large-save` 的产率复制对照。只在一个测量结束后再开始下一个，
不要并行构建或跑测试；普通引擎耗时不等同于实际网页帧率。

## 时间扭曲供电快照对照

`--entry=power-snapshot` 只对同一份准备态启用控制器并刷新供电快照，不推进生产或
提供新材料。单独记录刷新耗时，完成后再计算完整状态 JSON 的 SHA-256；哈希计算
不计入刷新耗时。使用 `--runtime-ref` 冻结旧引擎，按旧/新/新/旧/旧/新运行。
这只衡量供电准备步骤，不能替代真实页面的启动、退出、帧间隔及内存测试。

```powershell
node experiments/web-construction-wasm/run.mjs --entry=power-snapshot --prepared=D:/private/prepared.json --runtime-ref=bee28f77 --name=power-old
node experiments/web-construction-wasm/run.mjs --entry=power-snapshot --prepared=D:/private/prepared.json --name=power-new
```

## 终态解码与分段迁移

`terminal-decode` 对固定准备态编码后，分别测量同步解码、只分段校验、后台解析及各迁移阶段。
`terminal-decode-cooperative` 使用生产代码的分段校验和分批迁移。原始存档约 105 MiB，
输入的 205.46 MB 是展开并预热后的运行态测试副本，不能把两者混称。
各次使用新 Chrome，旧/新交替串行；准备输入和最终完整 SHA-256 不计入解码时间。
初始排队点击的响应是单次探针，最长画面间隔也不等于整个游戏的 FPS。
`--persisted-proof=1` 在计时结束后调用真实保存 Worker，解压后比较完整正文 SHA-256。
内存峰值若采集会包含这些额外校验，不能据此当作游戏净内存收益。

```powershell
node experiments/web-construction-wasm/run.mjs --entry=terminal-decode --decode-mode=sync --decoder-ref=d2eeba23 --prepared=D:/private/prepared.json --name=decode-old
node experiments/web-construction-wasm/run.mjs --entry=terminal-decode-cooperative --prepared=D:/private/prepared.json --name=decode-new
node experiments/web-construction-wasm/run.mjs --entry=terminal-decode --decode-mode=profile --migration-phases=1 --decoder-ref=d2eeba23 --prepared=D:/private/prepared.json --name=decode-phases
```

## 已有终态一致性探针

`--entry=terminal-parity` 使用同一只读大档对照旧结算顺序和保留的 Worker 终态结算顺序，
分别计算界面状态和最终持久状态的完整 SHA-256。`natural` 保留原科研条件，
`completed-research` 在浏览器副本中人为制造科研完成边界；后者不是原存档的自然状态。
`replication` 使用原库存，在浏览器副本中启用建筑制造和 8 倍产率复制，推进固定 30 秒墙钟，
然后比较完整状态与实际保存 Worker 的输出；只测这份大档，不代表所有存档条件。
`--terminal-path=terminal` 复现已弃用的直接转交路径，不用于实际保存。

```powershell
node experiments/web-construction-wasm/run.mjs --entry=terminal-parity --terminal-path=legacy --research-case=natural --prepared=D:/private/prepared.json --name=terminal-old
node experiments/web-construction-wasm/run.mjs --entry=terminal-parity --terminal-path=terminal-safe --research-case=natural --prepared=D:/private/prepared.json --name=terminal-new
```

## 冻结终态的分批保存传输

`save-state-chunks` 先按当前迁移规则准备同一份只读运行态，然后调用真实主档保存
客户端与保存 Worker。`clone` 使用原有整对象复制；`chunks` 使用生产客户端的
`frozenStateIsCurrent` 选项，每批实体/运输线等待确认并让出浏览器，再提交完整状态。
该选项只适用于独占且不可变的标准化快照，普通正在运行的状态不能这样分批读取。
保存投影、完整正文校验和源状态前后 SHA-256 均保持；源数据、解压和最终哈希不计入
保存往返计时。内存采样包含额外校验，不能据此声称游戏净内存降低。

```powershell
node experiments/web-construction-wasm/run.mjs --entry=save-state-chunks --transport-mode=clone --prepared=D:/private/prepared.json --name=state-clone
node experiments/web-construction-wasm/run.mjs --entry=save-state-chunks --transport-mode=chunks --prepared=D:/private/prepared.json --name=state-chunks
```

这只是保存 Worker 往返，不包含 IndexedDB 或整页退出。整页资格应另用
`experiments/web-live-runtime/run-pairs.ps1`，旧/新/新/旧顺序且与构建、测试串行。

## 终态标准化与保存复用同一后台

`terminal-owner` 对比当前界面分段解码加保存（`ui`）、后台解码后再发给另一个保存后台
（`worker-return`）、同一后台在交回完整标准化状态后生成保存证明（`worker-owner`）。
`worker-owner-blob` 保留不可变源数据以便失败重试；`integrated-blob` 使用真正的生产
`CanonicalTerminalDecoder`、来源登记表及既有保存响应校验器。完整状态与实际解压正文
SHA-256 在计时后核对；计时不含数据库、宏观结算、源数据生成或最终哈希。

Blob 的准备成本单列，未计入局部往返；整页对照必须包含宏观后台的实际 Blob 生成。
进程峰值包含准备与验证，不能把这个孤立原型的内存比例当作整页或整个浏览器的收益。
`terminal-owner-faults` 使用公开合成工厂在真实 Worker 中验证七项错误及失败后的完整状态回退。

```powershell
node experiments/web-construction-wasm/run.mjs --entry=terminal-owner --owner-mode=ui --prepared=D:/private/prepared.json --name=owner-ui
node experiments/web-construction-wasm/run.mjs --entry=terminal-owner --owner-mode=integrated-blob --prepared=D:/private/prepared.json --name=owner-integrated
node experiments/web-construction-wasm/run.mjs --entry=terminal-owner-faults --prepared=D:/private/prepared.json --name=owner-faults
```

整页可使用 `run-pairs.ps1 -PostStopSeconds 3 -AllProcessMemory`，同时观察退出后的画面和
浏览器自身进程列表的工作集/私有字节采样总和。采样总和不是连续物理内存峰值，
仍应独立报告渲染进程旅程峰值、时点采样及其测量边界。

## Rust/WASM 结论

现有 Rust 代码可在浏览器中运行，但这个 JSON 适配器尚无接入收益：简单计算的速度优势被传输和转换抵消；递归分支还会提前计算许多用不到的路线。继续前应验证按需规划、紧凑输入/输出及 JS 回退；不能仅因采用 Rust 就宣布更快。具体数值及候选身份见 [循环记录](../../docs/reviews/2026-10-26-web-performance-loop.md)。

## 大包持久化后台的空闲回收验收

`persistence-retirement` 使用同一只读准备态，先执行完整标准化，再通过真实保存客户端生成固定时间的正文与证明。随后以实际 16 MiB / 2 秒默认值，跨两次后台重建写入 IndexedDB，独立读取完整正文 SHA-256，检查 revision 各递增一次、缓冲可再次使用、禁用的备份未被写入以及调用方完整状态未变。它是数据一致性验收，包含准备和哈希，不用于游戏性能百分比。

```powershell
node experiments/web-construction-wasm/run.mjs --entry=persistence-retirement --prepared=D:/private/prepared.json --output=D:/private/results --name=persistence-parity
```

该入口单独定义网页平台以初始化真实的本地写入租约；其它旧探针的构建环境保持。公共浏览器故障用例缩短门槛和空闲期，大档整页资格仍用生产默认值及独立未采样的旧/新对照。
