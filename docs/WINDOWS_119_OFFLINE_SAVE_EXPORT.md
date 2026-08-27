# Windows 1.1.9 离线存档导出

此工具用于在**不启动 DSP 极简网络 1.1.9** 的情况下，把 Windows Electron 用户数据中的主存档导出为游戏可导入的 `.json.gz` 或 `.json` 文件。

## 存档位置与格式

默认用户数据目录为：

```text
%APPDATA%\dsp-idle-network
```

1.1.9 的公开主存档不在安装目录里，也不是一个可以直接复制出来的单独 JSON 文件。它位于以下 Chromium IndexedDB 目录中：

```text
%APPDATA%\dsp-idle-network\IndexedDB\file__0.indexeddb.leveldb
```

主记录键为 `dsp-idle-network.save.v1`；无限矿物速通主记录键为 `dsp-idle-network.save.v1.speedrun`。1.1.9 的后续自动保存还可能位于 `dsp-idle-network.internal.v1.chunked.v1.<mode>.*` 分块 sidecar 中。公开导出仍是 GameState v47 / envelope v2。

## 使用方法

先完全退出游戏，再在项目根目录执行：

```powershell
npm run save:export:windows119
```

默认从 `%APPDATA%\dsp-idle-network` 读取普通模式，并在当前目录新建带时间戳的 `.json.gz`。指定目录、文件或模式：

```powershell
npm run save:export:windows119 -- --profile "$env:APPDATA\dsp-idle-network" --output "D:\Backups\DSPidle-1.1.9-save.json.gz"
npm run save:export:windows119 -- --mode speedrun --output "D:\Backups\DSPidle-1.1.9-speedrun.json.gz"
```

可用参数：

- `--profile <目录>`：Electron 用户数据目录，不是 `win-unpacked` 安装目录。
- `--output <文件>`：必须以 `.json.gz` 或 `.json` 结尾；已有文件绝不会被覆盖。
- `--mode normal|speedrun`：默认 `normal`。
- `--help`：显示命令帮助。

## 安全边界

- 工具先确认游戏进程已经退出，再把 `IndexedDB` 和可选的 `Local Storage` 复制到系统临时目录。
- 无头 Chromium 只打开临时副本；工具不会让浏览器直接打开源用户数据目录，也不会启动游戏可执行文件。
- 复制前、复制后、解析后和输出后都会比对源存储的元数据指纹；检测到并发变化就中止。
- 主档必须通过 v2 checksum、模式和 GameState v47 校验。
- 完整有效且与主档 checksum 绑定的 1.1.9 分块 sidecar 优先导出；sidecar 缺块或校验失败时，工具会带警告回退到较旧但 checksum 有效的完整主档。
- 输出先写临时文件、压缩后读回校验，再以“不覆盖”方式发布；终端只显示摘要与 SHA-256，不打印存档正文。

如果命令提示正在运行、源存储变化或校验失败，不要手工拼接 LevelDB 文件。保持原目录不动，确认游戏完全退出后重试。

## 开发验证

```powershell
npm run test:windows119-export
npm run test:windows119-export:compat
npm run typecheck
```

合成测试覆盖完整主档、较新的有效 sidecar、损坏 sidecar 安全回退、GZIP 读回、拒绝覆盖、Electron 形态 IndexedDB 快照以及导出前后源目录逐字节一致。兼容测试使用游戏自己的 `inspectSave()` / `importGame()` 验证导出的 GameState v47 / envelope v2。开发测试不读取或改写真实玩家存档。
