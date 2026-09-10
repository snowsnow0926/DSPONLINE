# Windows Rust 独立内置目录｜2026-09-10

Role: develop。完整 Windows Rust Goal 的实时接管前置工作；不授予玩家权威，不改变 GameState、保存格式、模拟规则或现有内容包行为。

## 问题与实现

此前 Host 的运行目录来自 renderer。即使它通过格式检查，内容包 fingerprint 也不能独立证明配方、建筑、科技等实际定义属于已验证程序。资格正文中的 `catalogSha256` 需要从程序本身取得，不能从正文、存档或 renderer 反填。

新增生成器在独立 Vite 模块图中应用空扩展包注册表，再调用实际 `createNativeCoreCatalog`；以现有跨语言 canonical SHA-256 导出完整目录，写入 `desktop/native-builtin-catalog-v1.json`。当前文件 93,770 字节，只含公开游戏定义，不读取玩家存档、浏览器或网络服务。

同一文件随 ASAR 打包，并由 Rust `include_bytes!` 编进 Host。main 从自身模块旁的成员读入有界 UTF-8，验证规范字节和摘要；Host 从编译字节独立计算摘要，并通过真实 `RuntimeCatalog::from_value` 检查完整定义及关系。两端返回私有缓存派生的目录摘要与 registry fingerprint，不暴露可修改的目录引用。

两端匹配器对完整原始目录计算摘要。对象键排列不影响摘要，数组顺序、未知字段、配方/建筑数值及 registry 改变会拒绝。仅传入相同 fingerprint 不够。当前匹配器尚未接到玩家接管门禁，现有 shadow/离线/扩展内容兼容保持原行为。

`inspect-builtin-catalog` 是真实 Host 的无头只读入口：不创建 SaveStore、不启动模拟、不接受路径参数、不使用目录或摘要环境变量，始终返回 `authorityEligible: false`。包内零窗口探针新增 main 与 Host 目录核对。

`native:build-host` 和 desktop pack 都重新从当前前端定义生成并逐字节检查目录；过期时失败，需要显式重新生成、审查及提交，构建不会自动改写它。完整 Native 测试入口包含新单测及真实进程测试。

## 验证记录

目录生成与逐字节漂移验证通过；28 项 Node 单测/包边界、正常 release workspace/all-targets 严格 Clippy、Host 全套 275 passed/4 ignored，以及助手/主入口各 3 passed。Host 全套用时 36.92 秒（编译另计），不包含未执行专用项目。

最终完整 Native **915 passed / 1 Windows 符号链接权限 skip / 0 failed**，82.67 秒；前端目录与 canonical 摘要 **7/7**、类型检查通过。真实 Host 进程与 main 目录一致，伪造 cwd 文件、摘要环境变量均无效；额外路径参数拒绝，临时目录未创建存档、哨兵内容不变。

`artifacts/rust-rp1-loop/builtin-catalog-validate-v1/report.json` 为 PASS，12 项源码/生成文件在验证前后摘要一致。正常 release Host SHA-256 为 `13a6ead150f80e22ad82dd7741312948229cbf4ff516847149a60d2577f0eb4a`；助手为 `9ed039c1285212b2a37f3f149366526c2ee98a5378497c8e525226a77fdd4400`。目录 canonical SHA-256 为 `3cc51a3f95dba83113d57a40e1ad367a4c695d71e72958af451342e3c0e038a8`，包装 JSON 文件摘要另为 `fc2313dca70771e899d4d3b2c0bd04396e488eb5149c72082f5f48721c7c653a`，两者含义不同。

守护正常 exit 0、无停止原因，393.11 秒，最低可用内存 8,478,568 KiB；6 GiB 启动/2 GiB 停止、BelowNormal、重任务串行。源码尚未变更游戏规则，因此本批未重跑整个核心/游戏或浏览器矩阵，上一批结果不作为本批重测。新冻结包在代码提交后另行构建验证。

## 仍需完成

本批仅提供独立的内置目录事实。规则/矩阵摘要、可信 profile 与时间/撤销上下文、生产者认证、验证会话准入和实包实际单写者交接仍需继续。目录一致不代表数值正确、性能达标、签名可信或完整 Windows Rust 已完成；额外内容包和竞速资格需独立范围及验证。

已有离线实包证据见[上一批短瞬态](./rust-windows-short-transient-2026-09-10.md)。完整目标、长测、安装升级回退及既有浏览器失败项仍见[执行目标](../rust/windows-full-development.md)。本批不操作生产服务器、云档或公开下载。
