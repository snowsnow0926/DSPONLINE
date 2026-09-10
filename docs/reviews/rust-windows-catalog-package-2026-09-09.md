# Windows catalog 助手随包交付

2026-09-09，Role: develop，基于 `cd515022`。本批将独立 Rust 助手加入 Windows 固定资源目录，并将助手摘要嵌入 `app.asar/package.json`。**代码回归、实际冻结包和真实 Electron ASAR 加载/助手调用已通过。** 不开放实时权威，不改变游戏或存档格式。

## 实现边界

- `build.extraResources` 固定复制 `native/dsp-catalog-verifier.exe`。packer 在两种打包尝试之前从本次正常构建读取助手摘要，作为包内 `nativeCatalogVerifierSha256`；完成后同时核对包内身份、实际助手文件及本次构建产物，缺失或不符即失败。
- main 新增 packaged factory，从模块自己的 `app.asar/package.json` 读取预期程序摘要，并要求资源目录与该模块所属程序包一致。资格正文、外部 manifest 和 renderer 都不能提供这个程序身份；发布者策略仍须由可信 main 程序单独提供，没有默认生产发布者。
- 新写出的内部 `desktop-build-evidence.json` 使用 schema 2，强制要求助手及嵌入身份；schema 1 仅保留历史制品对照读取。显式要求当前助手的检查拒绝旧版清单。内部清单不是签名或玩法资格，冻结源码、候选、生产者及运行授权仍需各自验证。
- 新增仅运行 Electron main 的包探针，复用既有隔离 profile 和后台策略，不创建 BrowserWindow、不加载游戏，仅验证包内真实模块启动真实助手并拒绝缺失资格文件。探针拒绝带资格载体的资源目录，不能用于启用生产资格。

## 当前证据

`windows-catalog-package-v2.json`：包身份、helper/main、实际助手拒绝、桌面入口/发布工具共 **69 pass / 1 skip / 0 fail**，跳过项为目录符号链接权限。新增检查包括 helper 篡改/缺失/混入另一构建、包内身份来源、旧清单只读兼容与当前候选要求。守护正常退出 0，10.942 秒，最低空闲 7,162,060 KiB，6/2 GiB 门槛。首次 wrapper 在创建守护子进程前失败、无测试结果，之后使用独立路径执行本次通过结果，不复用失败证据。包探针另做语法检查，实际 Electron 结果尚不计通过。

本批没有在开发者电脑安装测试证书，也没有读取玩家存档。上一批 `355d4d5e` 的实际 Host 签名通过与新增 `cd515022` main 助手云端签名测试分开记录，见[签名生命周期](./rust-windows-signed-catalog-ci-2026-09-09.md)及[main 助手基础](./rust-windows-main-catalog-helper-2026-09-09.md)。

首次 `ce814804` 实际构建已执行 Rust/TypeScript/Vite、启动预算、thin UI、覆盖清单及 desktop 平台检查，但 pack 阶段拒绝 Cargo 的构建输出：该 exe 实际 `nlink=2`，与 release/deps 共享硬链接。守护失败退出 1、无内存中断，未生成冻结包。修复只允许受信构建输入使用 Cargo 硬链接；包内已安装助手仍必须 `nlink=1`。新增真实硬链接回归分别证明这两条边界，不放松运行时要求。

下一步从干净提交构建并冻结真实包，核验文件清单及实际包探针，再接完整资格正文、可信生产者、时效撤销和实时单写者交接。完整终局入口、复杂长离线、兼容矩阵和最终 Windows 交付仍未完成。

## 修复后的冻结包与实际调用

`windows-catalog-package-v3.json`：硬链接修复后相关回归 **70 pass / 1 权限 skip / 0 fail**。正常冻结构建基于 `c09cfdf217ca0becec0c01ab8805397283e37438`，Build ID **1.2.7+c09cfdf217ca**，性能开发版、beta、离线默认；Rust/TypeScript/Vite、启动预算、thin UI、覆盖清单及平台检查通过。新 schema 2 清单 **76 项**，完整冻结目录 **79 文件**均核验，旧 57ce 冻结包未变。构建守护正常退出 0，63.008 秒，最低空闲 5,343,228 KiB，6/2 GiB 门槛。

- Host：17,906,176 bytes，SHA-256 `d03577bac6b902eb773be95a351e8857c545e9ca83f4e0258b7517361f0e4c35`。
- 助手：665,600 bytes，SHA-256 `6f32df339f538f58f5fef11435b915d5568f19beb7fe43cde53105a34d075726`。
- ASAR SHA-256：`a501db5ed06f8b9533475023597381c5783c558e56c015b2867fc95aca06b672`。

`package-c09cfdf2-catalog-smoke-v2.json` 实际 Electron main 通过自身 ASAR 加载器加载冻结包模块与包内元数据，启动该包的真实助手；缺失资格载体返回 `carrier-io`，没有产生授权凭据。窗口创建/显示/焦点/对话框均 **0**，实际进程正常退出 0，无强制清理，独立 profile 已删除，前后 79 件冻结文件一致。守护正常退出 0，3.221 秒，最低空闲 7,026,820 KiB，6/2 GiB 门槛。v1 驱动相对模块路径错误发生于 Electron 启动前，保留失败日志；v2 使用新证据路径执行，未重复声明失败为通过。

云端 `cd515022` 的 Host 和独立 main 助手真实签名生命周期已通过，证据/源码摘要已核对，详见[签名记录](./rust-windows-signed-catalog-ci-2026-09-09.md)。该云端助手与本机冻结包属于不同构建，不把两项组合冒认为同一冻结包的完整签名资格验证。

下一步接完整资格正文和生产者身份、到期撤销与实际接管，并继续终局完整流程等完整目标。本批完成助手随包交付及调用，不是完整 Rust 游戏验收，也不声称新增帧率或整段等待收益。
