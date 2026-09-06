# 新上海节点归档迁移记录（2026-08-25）

## 范围

本次只处理异地加密备份归档，不切换应用 current、数据库、玩家存档、DNS 或下载页流量。新节点的 SSH transport 在受保护进程范围内使用了控制台确认的主机公钥；没有把主机、私钥、口令或 known_hosts 内容写入本文。

## 新节点验收

- 身份：root（仅用于受保护的只读/迁移脚本），Linux x86_64。
- 根文件系统：约 49.1 GiB；迁移完成后约 36% 使用（约 31 GiB 可用）。
- 应用、Nginx、备份和恢复 systemd 单元均不存在，监听器未发现应用端口；因此该节点目前是隔离归档节点，不是已切流的下载/应用节点。
- 归档目录及文件均为 root 0600，无 .partial、WAL 或 SHM 残留。

## 迁移证据

不可变归档目录：migrated-20260825T085231Z。每个对象先写入 .partial，再以大小和 SHA-256 完整读回校验后原子改名；四个对象及各自 manifest 均由迁移脚本和独立远端哈希复验。

| 对象 | 字节数 | SHA-256 |
| --- | ---: | --- |
| archive-manual-pre-cos-auto-20260818.sqlite.gz.dspbak | 416510981 | ec1559e1646375946219ab70e38ff76af46ca45396ffa0941f4612cc03946dec |
| cloud-20260820T192225Z-hk-production-1dc7ff.sqlite.dspbak | 3772834441 | 205f9ad830ebba22644d4cb2e317488aee449a5c0ceb7e9aecc661145f452730 |
| cloud-20260821T193425Z-hk-production-f71811.sqlite.dspbak | 3772834441 | 23fc1b54e5fe1d32e7b3e829efb8847efab1871a680ddee646b945acb4d946d8 |
| cloud-20260822T192801Z-hk-production-33b2c3.sqlite.dspbak | 3772834441 | d7adf47742201a56de12043d66e7e59d8bd392e98d4f22f13dfd2500ba550eb8 |

远端 migration-manifest.json：1718 bytes，SHA-256 ecb60ea55376b3f4710a65c596da7f8e8643d4b013b4daa944bf7cdca6d56e4a。 本机审计副本见被忽略的 artifacts/release-staging/shanghai-new-node-migration-manifest.json。

## 旧节点收口

仅在四个对象、四个 manifest 均完成远端完整读回哈希后，删除了旧节点上对应的这四对明确冗余副本。旧节点保留最新两份完整加密备份，目录中 .dspbak 数量为 2、打开文件数为 0，根盘约 70% 使用；没有触碰数据库、WAL/SHM、发布目录或其他备份。

## 后续状态

归档迁移完成后，已另行完成专用接收账户、权限、合成 SCP 探针和可回滚配置切换；详见
`ops-new-shanghai-backup-receiver-2026-08-25.md`。新节点仍不是公开下载源：下载角色还需要经过清单验证的静态制品、TLS/DNS、Nginx 哈希和独立公网 smoke。受保护 transport 的长期登记仍由运维凭据存储负责，未写入本文或仓库。
