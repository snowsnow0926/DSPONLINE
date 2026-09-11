# 香港单节点快速发布路径

这份参考只适用于用户明确指定“仅香港”或“香港 Web-only”的发布。它不授权上海、下载页、Android、Windows 或数据库写入。

## 发布前一次性检查

在候选工作树根目录执行：

```powershell
npm run release:preflight -- --manifest <candidate.json> --sha-sums <SHA256SUMS.txt>
npm run release:plan -- --manifest <candidate.json> --target hk-web-api
```

`release:preflight` 必须确认 clean Git SHA、候选 manifest、大小、SHA-256、aggregate hash 和 Web/API 归档；不要从手交接文档猜当前线上版本。`release:plan -- --target hk-web` 用于前端-only 修复，明确不要求 API/SQLite 切换。

## 受保护传输

归档上传使用：

```powershell
pwsh -NoProfile -File .codex/skills/develop-dspidle/scripts/invoke-protected-release-upload.ps1 `
  -Node HongKong -ManifestPath <candidate.json> -Transport Stream
```

脚本只从 `DSP_HK_*` 受保护变量读取连接信息，保持固定 host key、`IdentitiesOnly`、物理出口绑定和 BatchMode。默认使用 SSH 二进制流；`-Transport Auto` 才先尝试旧 SCP，SCP 被服务器关闭时自动切换流式传输。上传入口会自动复跑同目录 `*-SHA256SUMS.txt` 的本地 `release:preflight`，输出仅包含 release ID、归档文件名、大小、SHA-256 和传输方式。

## API 证据与切换边界

- Web-only：只备份并哈希活动 Nginx 配置，先 `nginx -t`；不创建大 SQLite 快照，不切 API。
- Web/API：每个发布窗口只创建一次 SQLite Backup API evidence。证据在 24 小时内、文件设备/inode/mtime/SHA/quick_check/schema/layout 全部不变时可以复用；超过 512 MiB 必须另有独立预检副本，禁止重复复制生产库。
- 上传后先远端哈希验证，再解压到新不可变目录、安装依赖、隔离启动 API；一次 dry-run 成功后才允许原子切换。任何 dry-run 非零都保持 current 不变。
- 使用 `invoke-protected-ssh-script.ps1 -FailureReportPath <ignored-report.json>` 时，失败报告只写节点、阶段分类、退出码、脱敏 marker 和输出长度，不写 stderr、路径、token 或数据库内容。

## 收口与回滚

切换后必须独立检查 local/public health/ready、版本/build、Nginx、NRestarts、磁盘、PWA/cache 和 previous 指针。观察窗口通过后才更新 `/canary/previous/`；canary 只回退 Web，不回退 API 或数据库。

失败时保留当前/previous/有效备份和新候选目录；只清理本次明确生成的临时上传文件或空暂存目录。不要重复运行 Backup API、不要手工删除 WAL/SHM、不要把失败重试当作“继续发布”。
