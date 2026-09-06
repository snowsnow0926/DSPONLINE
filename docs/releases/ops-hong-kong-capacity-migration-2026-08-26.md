# 香港容量迁移记录（2026-08-26）

## 结果

- 目标：在不修改生产数据库、WAL/SHM、应用指针或玩家数据的前提下，将超过本地快速恢复保留线的旧 SQLite 快照迁移到既有受保护 COS 归档。
- 迁移前根盘约 `83%`；迁移后为 `49%`，可用空间约 `36.53 GB`。
- 共迁移 `7` 份已经有完整 Backup API evidence 的历史快照，原始总字节数为 `24,480,923,648`。
- 归档使用固定 `64 MiB` 分片，共 `370` 个数据对象；另有每份独立 manifest 和原 evidence 对象。
- 每个对象写入后均完成大小与 SHA-256 读回；每份归档又按分片顺序完整串接读回，重建 SHA-256 必须与原始快照 evidence 完全一致。
- 只有 manifest、evidence、所有分片、完整串接 SHA-256 和本地恢复保留线全部通过后，才删除对应的单个本地旧快照。

## 保留边界

本地继续保留 `4` 份身份未变化、`quick_check=ok` 的完整快速恢复快照：正式 1.1.8 发布前快照、较早 1.1.8 候选快照、1.1.7 发布前快照和 1.1.6 发布前快照。当前正式 1.1.8 evidence 仍为 schema 8 / layout 3，大小和 SHA-256 与发布记录一致。

以下内容未修改或删除：

- 生产 `cloud.sqlite` 及其 WAL/SHM；
- current、previous、canary、rollback 和 release-control 状态；
- 两份异地加密 staging 保留集；
- Web/API 发布目录、共享 hashed assets、Nginx、systemd 配置与凭据；
- 玩家账号、云存档正文、排行榜、审计和会话数据。

## 收口验证

- COS 归档记录 `7/7`，数据分片 `370/370`，manifest `7/7`，evidence 对象 `7/7`；无 `.tmp` 对象或本地迁移临时文件。
- 七个本地旧源文件及其侧车均不存在；四个保留快照身份、大小、mtime、device/inode 和 evidence 仍匹配。
- 香港 Web/API current 仍为 `1.1.8-c53497b050c4`，previous 仍为 `1.1.6-4f6d24f8c709`，pending switch 不存在。
- API、handoff proxy、健康与节点探针 timer 均 active；本机 health/ready 为 `200/200`，`NRestarts=0`。

历史归档如需恢复，只能在新隔离文件中按 manifest 顺序串接分片，先验证完整 SHA-256、SQLite `quick_check` 和 schema/layout，再进入正式灾备审批；不得直接覆盖生产数据库。

