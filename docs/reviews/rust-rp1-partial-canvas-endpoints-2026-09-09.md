# Windows Rust：保留堆叠连线可见端的真实位置

2026-09-09，Role: develop。为完整 Windows 回归继续核对多次出现的堆叠连线失败，发现实际 Canvas 端口丢失问题，修复共享界面代码；没有改变游戏状态或存档格式。

## 问题与修复

`canvasLineEndpoints` 原来只有同时拿到源端、目标端的 React Flow handle 时才记录测量。堆叠隐藏的节点不挂载 handle，因此另一端即使可见且已经测量，也会一并丢弃，退回卡片中心。原 50 节点用例固定要求目标点 (0, 96)，本机这个旧断言通过；它没有验证线是否落在可见输入口。

独立 DOM 检查发现本机夹具真实输入口为 (11, 134)：旧 Canvas 的 Y 少 38，X 少 11。现在源端和目标端分别保留已有的测量值；只有不可测的一端使用现有代理几何。两端均缺失时仍由原几何构建器处理。DTO 保持四个字段，允许缺失端的字段值为 undefined，绘制时已有逐坐标回退可直接使用。

新增两项单元覆盖源端缺失和目标端缺失。浏览器用实际 handle/node/viewport 的同一次 DOM 采样检查目标 X/Y；隐藏源端 96×32 代理、路线、命中、选择、隐藏节点不可聚焦等原断言继续执行。

## 证据与失败保留

- [原固定断言](../../artifacts/rust-rp1-loop/canvas-stack-port-red-v1.json) 本机 1/1，通过事实保留，不能冒称本机复现了云端的 96/96.5 失败。
- [独立 Y 检查](../../artifacts/rust-rp1-loop/canvas-stack-port-green-v1.json) 2 pass / 1 fail：生产修复前约 -38 差异，另两个现有连线用例通过。
- [修复后首次检查](../../artifacts/rust-rp1-loop/canvas-stack-port-green-v2.json) 2 pass / 1 fail：目标已变成真实 (11, 134)，原 X=0 的卡片边缘断言失败；随后 X 也改用独立 DOM 输入口左边缘。
- [下一轮](../../artifacts/rust-rp1-loop/canvas-stack-port-green-v3.json) 堆叠和像素用例通过，旧多端口用例失败：它分次读取 nodeBox、handleBox、zoom，拼出的预期 Y=626.2618 与 Canvas 351.5 不同。现改成同一浏览器任务同时读取几何与缩放，并按原 0.05 世界单位精度等待对齐；避免初始视口变化时混用不同采样时刻。
- [最终三轮](../../artifacts/rust-rp1-loop/canvas-stack-port-green-v4.json) **9 pass / 0 skip / 0 fail / 0 flaky**：三个用例各独立重复三次，包含多端口、平移/缩放像素和完整 50 节点堆叠交互。没有增加原单测或 expect 超时，没有重试过关。此结果不代表 Linux 云端已经通过。

最终[浏览器守护](../../artifacts/rust-rp1-loop/canvas-stack-port-green-v4-guard/guard.json) 正常退出 0，40.7362445 秒，最低空闲 5,902,344 KiB；无头、静音、单 worker、低优先级，6 GiB 启动 / 2 GiB 停止。各次失败记录保留，不合并成一次全绿。

## 当前状态

[完整集成验证](../../artifacts/rust-rp1-loop/native-canonical-pair-integration-v1.json) PASS：完整游戏 3,176 pass / 39 skip / 0 fail，包含本文件全部 5 项画布单元及实际 Native 对照 50 pass / 1 长测 skip；Native 接口 750 pass / 1 skip / 0 fail，类型与 Web 构建门禁通过。该修复同本批 [Rust 双摘要优化](./rust-rp1-native-canonical-pair-2026-09-09.md)一起形成后续 Windows 候选；云端新源码、实际冻结包及完整发布资格另行验收，Goal 保持 active。
