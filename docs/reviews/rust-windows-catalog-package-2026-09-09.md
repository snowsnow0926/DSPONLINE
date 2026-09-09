# Windows catalog 助手随包交付

2026-09-09，Role: develop，基于 `cd515022`。本批将独立 Rust 助手加入 Windows 固定资源目录，并将助手摘要嵌入 `app.asar/package.json`。**代码和包工具回归已通过；实际冻结包与真实 Electron ASAR 加载验证仍待执行。** 不开放实时权威，不改变游戏或存档格式。

## 实现边界

- `build.extraResources` 固定复制 `native/dsp-catalog-verifier.exe`。packer 在两种打包尝试之前从本次正常构建读取助手摘要，作为包内 `nativeCatalogVerifierSha256`；完成后同时核对包内身份、实际助手文件及本次构建产物，缺失或不符即失败。
- main 新增 packaged factory，从模块自己的 `app.asar/package.json` 读取预期程序摘要，并要求资源目录与该模块所属程序包一致。资格正文、外部 manifest 和 renderer 都不能提供这个程序身份；发布者策略仍须由可信 main 程序单独提供，没有默认生产发布者。
- 新写出的内部 `desktop-build-evidence.json` 使用 schema 2，强制要求助手及嵌入身份；schema 1 仅保留历史制品对照读取。显式要求当前助手的检查拒绝旧版清单。内部清单不是签名或玩法资格，冻结源码、候选、生产者及运行授权仍需各自验证。
- 新增仅运行 Electron main 的包探针，复用既有隔离 profile 和后台策略，不创建 BrowserWindow、不加载游戏，仅验证包内真实模块启动真实助手并拒绝缺失资格文件。探针拒绝带资格载体的资源目录，不能用于启用生产资格。

## 当前证据

`windows-catalog-package-v2.json`：包身份、helper/main、实际助手拒绝、桌面入口/发布工具共 **69 pass / 1 skip / 0 fail**，跳过项为目录符号链接权限。新增检查包括 helper 篡改/缺失/混入另一构建、包内身份来源、旧清单只读兼容与当前候选要求。守护正常退出 0，10.942 秒，最低空闲 7,162,060 KiB，6/2 GiB 门槛。首次 wrapper 在创建守护子进程前失败、无测试结果，之后使用独立路径执行本次通过结果，不复用失败证据。包探针另做语法检查，实际 Electron 结果尚不计通过。

本批没有在开发者电脑安装测试证书，也没有读取玩家存档。上一批 `355d4d5e` 的实际 Host 签名通过与新增 `cd515022` main 助手云端签名测试分开记录，见[签名生命周期](./rust-windows-signed-catalog-ci-2026-09-09.md)及[main 助手基础](./rust-windows-main-catalog-helper-2026-09-09.md)。

下一步从干净提交构建并冻结真实包，核验文件清单及实际包探针，再接完整资格正文、可信生产者、时效撤销和实时单写者交接。完整终局入口、复杂长离线、兼容矩阵和最终 Windows 交付仍未完成。
