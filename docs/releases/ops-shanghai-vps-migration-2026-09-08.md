# 上海 VPS 全业务迁移记录（2026-09-08）

用户授权把即将到期的旧上海整台业务迁往新上海；另明确结束已删除源目录的 Luker 进程，并把 QQ 扫码登录留到稍后。本次是主机迁移，DSP 沿用既有不可变 1.2.6 发布物，没有发布 1.2.7、修改游戏代码或合并香港数据。

**迁移已完成，QQ 按用户安排等待重新登录。** 最终服务、监控、数据与隔离恢复检查通过；迁移收尾配置归档已保存。

## 迁移与数据证据

- 旧机先做 SQLite Backup API 初始快照；停止业务写入后重新生成最终快照。**31/31** SQLite 快照 SHA-256 与 `quick_check` 通过。停止完成之前生成的中间快照单独保留，没有作为最终数据源。
- PostgreSQL 全库逻辑导出、恢复后，两个业务库 **86 张表**的行数与停写后的源端一致。
- 业务归档包含 368,713 个条目、9,690,283,869 字节未压缩内容；压缩归档 4,391,789,785 字节。覆盖业务主目录、站点、应用、Git 仓库、配置和依赖；追加最终数据、系统配置、证书、计划任务及浏览器配置归档。旧主机身份与 SSH 授权没有覆盖新机身份。
- Docker 镜像归档 1,247,548,573 字节，两个运行镜像与源端相同。旧机两份各 3,772,834,441 字节的加密异地备份均完整传输并通过 SHA-256。
- 新机迁移前的配置与数据另行保留；旧机业务数据保留、写入服务停止，Nginx 在旧机到期前转发至新上海。HTTP API 和 HTTPS 下载经旧入口分别读回 200。HTTPS 上游继续校验证书，完整证书链深度设为 3。

私有证据与完整归档保存在新机 `/srv/dsp-idle-data/migration-20260908/`；最终 SQLite/数据库导出在 `/var/lib/dsp-idle-migration/20260908-source-final/`。文件仅限受保护运维访问，不能提交备份内容、真实主机地址或凭据到仓库。临时跨机只读 SSH 授权及对应私钥已移除，其他 SSH 授权保持原样。

## 业务、DNS 与证书

- DSP API、发布代理、LLM 代理、con-artist-master、Openclaw gateway 运行正常，检查时 `NRestarts=0`。QQ 的 NapCat/AstrBot 容器运行、重启计数 0，数据已保留；**QQ 尚未重新登录**，不代表机器人消息连接已恢复。
- Openclaw 使用从旧机保留的 Chromium 运行环境；实际启动浏览器并读取测试页面标题通过，随后通过 Openclaw 自身的 `browser start` 检查。控制台 allowed origin 更新为新机；Node 与 Openclaw 服务入口文件 SHA-256 和旧机一致。原扩展目录保持原路径，旧浏览器配置另外归档。
- 7 个管理域的 15 条 A 记录从旧上海改为新上海，TTL 600 保持不变。两台权威 DNS 共 **30/30** 检查通过；三家公共解析器的下载域名检查通过。`dsponline.cn` 只切下载子域，香港根域与 `www` 保持独立。
- 下载页公网版本读回 `1.2.6+df828869e276`；新机 HTTPS 完整读取 **10 个下载文件**并核对哈希，Range 206 和版本清单禁止缓存规则通过。
- 5 组原已过期的业务证书完成续期，主域通配证书覆盖 beta/gemini；同步证书与 DNS 验证续期钩子后 Nginx 配置检查通过。
- 迁移前已经停用的 PM2 应用保持停用，代码和数据保留。两个历史站点后端原先已无监听、另一个站点原先返回 404，这些不是新增恢复上线的业务。Luker 按用户要求结束，没有源码可迁移。

## DSP 精确基线与回退边界

| 项目 | 迁移完成检查时的值 |
| --- | --- |
| Runtime SHA | `df828869e276e5d3a67513095a4d1c93d13c500f` |
| Release ID | `1.2.6-df828869e276` |
| Web current | `/var/www/dsp-idle/releases/web-1.2.6-df828869e276` |
| API current | `/opt/dsp-idle-cloud/releases/api-1.2.6-df828869e276` |
| Web/API previous（switch-state） | `1.2.5-0a1c6629ced1` |
| 下载 current / previous | `download-site-1.2.6-df828869e276` / `download-site-1.2.5-0a1c6629ced1` |
| Switch / proxy generation | `32` / `92` |
| API slot / port / proxy | green / `4322` / forward |
| Pending switch | 无 |
| API health / ready | 200 / 200 |

源端与新机按排序相对路径和文件内容比对：Web 173 文件、7,505,443 字节；API 含依赖 1,214 文件、39,239,496 字节；下载 10 文件、110,844,598 字节；release-control 25 文件、215,228 字节，均一致。

控制文件 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| `/usr/local/sbin/dsp-idle-switch-release` | `ddbfac90c8e7f565870f73b2252f206bb77e766d246f386ca84bb802c4451b37` |
| `release-switch.mjs` | `c5a99b385b56312ed67a8b2ffcc4147f9b962209250569231546230ba5e997d5` |
| `api-handoff-proxy.mjs` | `2f908b40b5a715bf290ee4b5aad55256eae25c1e642abd4bb2677ec90fc16dd0` |

后续运维使用完整的受保护 **`DSP_SH_NEW_*`** 配置；当前会话原 **`DSP_SH_*` 仍代表旧机**，不能凭变量名认为已经改向。调用现有 Shanghai helper 时在单个子进程内映射新配置，并重新验证目标身份和即时状态。不要对旧机继续部署。

代码回退只切 Web/API/下载各自不可变指针，不能回放迁移前数据库。若需迁回旧机，必须先冻结新机写入并保全新增数据，不能直接启动旧机写服务造成双写。旧机到期后不应把它作为可用回滚节点。

## 运维收尾

新机系统盘保留的前次数据盘迁移副本，15 个文件共 **23,053,524,505 字节**，逐文件与数据盘原件做完整 SHA-256 比对后清理。原件全部保留；清理后系统盘空闲约 28.3 GB，临时扩展副本经校验清理后数据盘空闲约 19.4 GB。节点监控重新运行 **`ok=true`、failedChecks 为空**，没有降低 15% 空闲阈值。

恢复演练首次执行发现恢复目录沿用旧机服务账号的数值 UID/GID；只修复 `restore-work` 和 `restore-reports` 的归属，生产数据库权限不变。随后原演练脚本在临时服务启动后报计数减少：独立诊断确认 **仅清理了 54 个已过期会话（810 → 756）**；1,070 个账号、850 份当前云档、10,043 条历史存档及其他保护计数均与清单一致，隔离 health/ready 200。哈希、解密与 SQLite 完整性检查此前已通过。

已在独立不可变目录 `/usr/local/lib/dsp-idle-migration/restore-validator-20260908/` 配置演练校验器：只允许实际已过期的原会话消失，并检查剩余会话的身份与到期时间；其余保护记录仍按原严格规则比较。本地和 Linux 合成测试覆盖过期会话、有效会话、有效会话丢失、身份变化、异常新增、账号丢失和加密备份篡改，均符合预期。原游戏 API 与 `/usr/local/lib/dsp-idle-ops/current` 未改写；生效边界仅为 `dsp-idle-restore-drill.service.d/95-migration-session-validation.conf` 的 `ExecStart` 覆盖。**完整演练于 2026-09-08 15:43:24（上海时间）通过**，耗时 794,093 ms，schema 8 → 8、SQLite/public-status 正常，明确记录 54 个过期会话清理；演练工作副本自动清理。

| 演练校验器文件 | SHA-256 |
| --- | --- |
| `restore-drill.mjs` | `ea51d8d8e71884c6f9e0284156e9d1797fc745e239ec0685cb665e57ec018c17` |
| `sqlite-snapshot.mjs` | `b265d41b88ddf7ef25845415731be40fc22172b0f42c8817a5ffe75811484d06` |
| `backup-crypto.mjs`（原样保留） | `c8af9eeaff1c13b0bb45caef3b9c471b012d9885621caa1996c46b982d0e7b4b` |

该目录的上级同时承载现役 DNS 续期钩子，**不能作为迁移临时文件删除**。校验器若需回退，可在演练空闲时移走上述独立 drop-in 并 daemon-reload；这不会改动备份或生产数据，但原脚本对过期会话的误报也会恢复。后续统一运维版本应在保持这些保护测试的前提下整合此修正。

新机 cron、DSP 健康与恢复演练 timer、PostgreSQL 备份 timer、certbot 续期 timer 已启用。PostgreSQL 备份服务实跑 `success/0`。旧机 27 个业务相关 systemd 单元及 root Openclaw 设置迁移退役条件，两个旧 QQ 容器关闭自动重启，避免旧机重启后产生双写；Nginx 转发继续运行。退役条件文件为 `/var/lib/dsp-idle-migration/20260908-initial/retired-writers`，不能绕过数据回迁流程移除此条件。

最终检查 API/代理 health/ready 均 200、业务服务与两个容器运行且重启计数 0、节点监控通过、恢复演练通过；系统盘空闲 **28,286,001,152 B**，数据盘空闲 **19,438,407,680 B**。新机最终配置归档 `new-final-configuration.tar.gz` 为 **739,974 B**，SHA-256 `cce78519789c09f66e021e0752c92ec094efab2aae5a44c844838e9cf77609f6`，与 `final-closeout.json` 一并保存在上述私有迁移证据目录。直接填写旧 IP 的客户端需改用新机地址；域名入口已完成切换。

香港未执行任何变更；只读检查确认香港异地备份目标已经指向新上海，但其备份 timer 当时处于 inactive，原因未在本迁移中确认。没有擅自启停香港 timer，也不把历史状态写成当前通过。需要后续香港运维任务单独核实其调度状态。

本次验证针对数据迁移、运行依赖、DNS/TLS、文件读回、服务和备份；没有以生产玩家账号进行自动写入测试，也没有重新构建或重跑既有 1.2.6 的完整游戏测试矩阵。

文档新增迁移链接、Skill 校验和 `git diff --check` 通过；既有 `desktop/preload.bundle.cjs` 用户文件未修改。
