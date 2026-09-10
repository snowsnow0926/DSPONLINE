# Windows Rust：一次规范编码更新两个摘要

2026-09-09，Role: develop。完整 Windows Goal 保持 active；本批减少实际 Native 请求中的重复校验工作，尚未开放实时权威或发布新包。

## 改动

`canonical_digest_bundle_with_parsed` 原来对每条实体/传送带记录分别调用两次规范 JSON 编码，更新完整状态摘要与对应集合摘要。现在同一次键排序、数字格式化和字符串转义的字节流，同时送入两个独立 SHA-256 状态；两个摘要各自已有的前缀和后缀保留。没有缓存整条或整个工厂的编码字符串，没有改变字段顺序、数值格式或摘要算法。

独立字节向量覆盖嵌套对象/数组、不同摘要前缀、中文与 emoji、转义字符、负零、指数/十进制边界和 JS 安全整数。原单摘要 API 复用相同遍历器。

## Rust 验证

[正常优化版验证](../../artifacts/rust-rp1-loop/native-canonical-pair-validation-v1.json) PASS：规范编码专项 4/4；完整核心 1,114 pass / 5 ignored / 0 fail，Host 库 253 pass / 1 驱动 ignored、入口 3 pass，均 0 fail。fmt、严格 release workspace/all-targets Clippy 和正常 Host 构建通过。完整测试没有筛掉其他用例。

- canonical.rs SHA-256：`7dbb25af3983289cc4185080ddee9e12b4bc5053dfa511fcf3bd85232e21d328`。
- state.rs SHA-256：`1b82c10e14f9b0c50e5ccaa80d8fd0f8a1acbad42f188d0e16bcb0e6881b234b`。
- 新 Host：17,901,056 bytes，SHA-256 `7253807b6ccead1ba2f02d0175294d716064d34517c7e05b740530bf5ef9474b`。
- [验证守护](../../artifacts/rust-rp1-loop/native-canonical-pair-validation-v1-guard/guard.json)：正常退出 0，1,266.5677712 秒，最低空闲 4,410,608 KiB。首次重新编译包含在耗时内。

## 实际终局 Native 请求 A/B

[完整记录](../../artifacts/rust-rp1-loop/native-canonical-pair-private-ab-v1/report.json) PASS。基线为冻结 a6a37b00 包中 ef56b807 Host，候选为上述 7253807b 程序的独立副本。两者正常 release、2 线程、无 profile；注册原始终局档 110,042 实体、233,300 带，恢复同一来源后固定 9 秒请求。它不是玩家原始累计离线时长，也不是实际 Windows 菜单等待。

各预热一次后不计入正式统计，三对 AB/BA/AB 顺序，每次独立 Host/存储目录；RPC 计时包含解析、校验、精确模拟和持久导出，进程启动与事后核验在计时外。

| 配对 | 旧 Host（ms） | 新 Host（ms） |
| --- | ---: | ---: |
| 1：AB | 52,755.3676 | 50,831.2704 |
| 2：BA | 53,552.3606 | 51,799.3048 |
| 3：AB | 61,965.8378 | 54,085.8472 |
| 中位 | **53,552.3606** | **51,799.3048** |

中位少 **1,753.0558 ms（3.273536%）**。最后一对波动明显，原始样本全部保留；三对都较快，但样本量有限，不能外推为所有工厂、完整入口、帧率或峰值内存收益，也不与此前其他环节百分比相加。

八次（含预热）都 exact=9、approximation=0，完整来源/候选摘要、三个集合摘要、顶层字段摘要和 domain 摘要一致。导出均为 208,891,374 bytes，SHA-256 `15c91fa1509ad6949d22a2db6a257890992c1dfb9b3bcd635bd8d1ec9c1cb934`，与此前六次完整 JS 对照通过的固定导出相同。本次没有重新运行这份私人档的 JS 参考模拟；比较对象及其历史完整对照由驱动校验后使用。

八次正常 shutdown 均 exit 0，两个用户主档槽位为空，来源文件不变，所属临时目录已清理；原玩家文件大小、mtime、SHA-256 未变，程序和六份关联源码前后摘要一致。[A/B 守护](../../artifacts/rust-rp1-loop/native-canonical-pair-private-ab-v1-guard/guard.json) 正常退出 0，447.0924685 秒，最低空闲 4,811,748 KiB。全程无游戏窗口、串行低优先级，6 GiB 启动 / 2 GiB 停止。

## 后续门禁

[完整集成验证](../../artifacts/rust-rp1-loop/native-canonical-pair-integration-v1.json) PASS，绑定上述 Rust 源码与 Host，以及本批[堆叠端口修复](./rust-rp1-partial-canvas-endpoints-2026-09-09.md)的五份代码/测试：Native 接口 750 pass / 1 skip / 0 fail，完整游戏 3,176 pass / 39 skip / 0 fail，其中实际 Native 对照 50 pass / 1 长测 skip / 0 fail；类型、Web 构建及三项构建门禁通过。750 项包含工具和替身测试，不能全部算作实际桌面验收。[集成守护](../../artifacts/rust-rp1-loop/native-canonical-pair-integration-v1-guard/guard.json) 正常退出 0，605.8364679 秒，最低空闲 7,860,972 KiB，6/2 GiB 门槛不变。

新冻结 Windows 包的原 90 秒终局入口、成功持久写档、正常关闭和两次重开仍须验证；上述局部数据不能替代它们。继续按[完整目标](../rust/windows-full-development.md)推进正式资格、实际实时接管、玩法/云兼容、性能/内存、长测和安装升级回退。
