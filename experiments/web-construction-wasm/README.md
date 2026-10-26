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

## 当前结论

现有 Rust 代码可在浏览器中运行，但这个 JSON 适配器尚无接入收益：简单计算的速度优势被传输和转换抵消；递归分支还会提前计算许多用不到的路线。继续前应验证按需规划、紧凑输入/输出及 JS 回退；不能仅因采用 Rust 就宣布更快。具体数值及候选身份见 [循环记录](../../docs/reviews/2026-10-26-web-performance-loop.md)。
