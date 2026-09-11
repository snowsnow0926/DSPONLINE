# 受保护发布凭据与新会话接管

本文是 DSPidle2 发布账号的固定入口。目标是让新的 Release Agent 能完成 Android 正式签名和香港/上海运维连接，同时不需要知道、打印或复制真实 keystore、SSH 私钥、口令、别名、主机地址或本机保管路径。

## 1. 不变原则

- Git、文档、聊天、发布制品、VPS 和命令输出中都不得出现真实密钥路径、口令、token、私钥正文或受保护节点信息。
- Android 签名材料与 VPS SSH 材料相互独立，禁止交叉复用。
- 只把秘密注入到单次子进程；构建或 SSH 命令结束后不在当前 PowerShell 会话保留秘密变量。
- 不创建新 Android 证书。受保护材料不可用或证书连续性不符时立即停止。
- Windows 当前没有可信代码签名证书，继续明确记录为 `NotSigned`；不得临时生成 PFX 或自签证书伪装正式签名。
- 拥有凭据不等于获得发布授权。签名、上传、连接、备份、切换和生产数据操作仍分别受 Release 角色、交接清单和用户明确授权约束。

## 2. 未来 Agent 只使用这些入口

先在仓库根目录按**当前目标**运行只读能力检查，不要在无关本地任务上默认 `All`：

```powershell
pwsh -NoProfile -File .codex/skills/develop-dspidle/scripts/test-protected-release-access.ps1 -Capability Android
pwsh -NoProfile -File .codex/skills/develop-dspidle/scripts/test-protected-release-access.ps1 -Capability HongKong
pwsh -NoProfile -File .codex/skills/develop-dspidle/scripts/test-protected-release-access.ps1 -Capability Shanghai
```

输出只包含 `ready / task-helper-managed / blocked`、布尔门禁和所需变量名，不返回真实值或路径，也不构建、不签名、不连接服务器。未使用目标缺失不构成当前任务阻塞，也不构成索取无关凭据的理由。

本机 Android vault 由用户级 locator `DSP_ANDROID_SIGNING_CONFIG` 指向。这个 locator 只用于受控脚本内部解析；不要用 `Get-Content`、`Write-Output`、`Format-List`、异常堆栈或聊天消息显示它的值。若 locator 缺失，脚本只允许按固定文件名 `android-release-v1.properties` 找到唯一、ACL 受限的既有 vault；零个或多个候选都必须失败关闭。

Android vault 的稳定字段契约为：

```text
keystorePath
storePassword
keyAlias
keyPassword
certificateSha256
```

这些是字段名，不是值。构建脚本只把前四项映射为子进程的：

```text
DSP_ANDROID_KEYSTORE
DSP_ANDROID_KEYSTORE_PASSWORD
DSP_ANDROID_KEY_ALIAS
DSP_ANDROID_KEY_PASSWORD
```

香港与上海连接只接受以下受保护变量契约：

| 节点 | 必需 | 可选 |
| --- | --- | --- |
| 香港 | `DSP_HK_HOST`、`DSP_HK_SSH_USER`、`DSP_HK_SSH_KEY_PATH`、`DSP_HK_KNOWN_HOSTS` | `DSP_HK_SSH_PORT`、`DSP_HK_BIND_ADDRESS` |
| 上海 | `DSP_SH_HOST`、`DSP_SH_SSH_USER`、`DSP_SH_SSH_KEY_PATH`、`DSP_SH_KNOWN_HOSTS` | `DSP_SH_SSH_PORT`、`DSP_SH_BIND_ADDRESS` |

真实值只来自受保护运维环境或已经验证的本机运维记录。不要从截图、DNS、聊天文本、旧命令输出或仓库占位符猜测。香港单账号只读导出和排行榜操作优先使用 Skill 已维护的专用工具；一般发布连接仍需先通过本表的完整 transport 和固定 host-key 门禁。

## 3. Android 正式签名

### 3.1 只读检查

```powershell
pwsh -NoProfile -File .codex/skills/develop-dspidle/scripts/invoke-protected-android-release.ps1
```

默认仅检查 vault ACL、keystore 可读性和批准证书连续性，不构建、不写源码、不连接生产。它不会输出 vault 路径、alias、口令或证书正文。

### 3.2 从固定 clean SHA 构建

必须在独立、干净、可追溯的 checkout/worktree 中运行：

```powershell
pwsh -NoProfile -File .codex/skills/develop-dspidle/scripts/invoke-protected-android-release.ps1 `
  -WorkspaceRoot '<isolated-clean-worktree>' `
  -ExpectedGitSha '<40-char-runtime-sha>' `
  -Build
```

脚本在子进程中临时注入 `DSP_ANDROID_*`，执行仓库的 `npm run android:release`，然后验证：

- Git SHA 精确且工作树为 clean；
- 包名 `cn.dsponline.network`、versionName 和 versionCode；
- APK Signature Scheme v2/v3；
- `zipalign`；
- APK 与 AAB 均延续 vault 内批准的历史证书；
- 仅报告制品文件名、大小、SHA-256、版本和通过/失败状态。

正式 stable feed 仍需单独使用 `scripts/create-native-update-manifests.mjs`，并显式传入 HTTPS base URL、stable 通道、已验证 APK 和批准证书 SHA-256。构建成功本身不授权更新下载页或上传服务器。

任何以下错误都必须停止，不得绕过：`PROTECTED_ANDROID_CONFIG_*`、`PROTECTED_ANDROID_KEYSTORE_*`、`PROTECTED_ANDROID_CERTIFICATE_CONTINUITY_FAILED`、`ANDROID_RELEASE_GIT_SHA_MISMATCH`、`ANDROID_RELEASE_WORKTREE_NOT_CLEAN`、APK/AAB 签名或 metadata 校验失败。

## 4. 香港和上海 SSH

1. 先运行能力检查，要求目标节点的 4 个必需变量完整、私钥和 `known_hosts` 可读、固定 host-key 条目存在。
2. VPN/TUN 开启时，只为当前 `ssh`、`scp` 或 HTTPS 探针绑定物理 IPv4；不得关闭 VPN、添加持久路由或改全局 SSH 配置。
3. OpenSSH 必须同时使用 `IdentitiesOnly=yes`、`StrictHostKeyChecking=yes`、受保护 `UserKnownHostsFile`、`BatchMode=yes`、有界连接超时及单次连接尝试。
4. 第一个远端动作必须只读：确认节点身份、current/previous/rollback 指针、服务、health/ready、磁盘和备份能力。未确认前不上传、不备份、不切换。
5. 后端、schema、数据库、排行榜或云数据相关操作遵循 [部署与运维手册](./DEPLOYMENT_OPERATIONS.md) 的 Backup API、停写、证据和回滚门禁。
6. 香港和上海独立验证、独立备份、独立切换；不得把上海反代到香港，也不得跨节点复制数据库。

一般只读/发布脚本通过固定 wrapper 流式传入，避免在命令行展开真实 transport。默认只检查本地能力；只有显式 `-Run` 才连接：

```powershell
# 只读本地检查，不连接
pwsh -NoProfile -File .codex/skills/develop-dspidle/scripts/invoke-protected-ssh-script.ps1 -Node HongKong

# 用户已授权的远端只读脚本
pwsh -NoProfile -File .codex/skills/develop-dspidle/scripts/invoke-protected-ssh-script.ps1 `
  -Node HongKong -ScriptPath '<lf-safe-readonly-script.sh>' -Run

# 生产变更还必须显式声明模式、授权和精确 Release ID
pwsh -NoProfile -File .codex/skills/develop-dspidle/scripts/invoke-protected-ssh-script.ps1 `
  -Node Shanghai -ScriptPath '<bounded-release-script.sh>' -Mode Mutating `
  -MutationAuthorized -ExpectedReleaseId '<version-12charsha>' -Sudo -Run
```

wrapper 强制固定 host key、单次物理出口、BatchMode 和有界连接；不接受 inline remote command。远端脚本只能输出经过隐私审查的版本、指针、健康、哈希和计数，不能输出环境、账号、数据库正文或目录中的秘密。上传制品仍走发布清单约束的独立 SCP 流程；该 wrapper 不自动授予上传权限。

### 4.1 新节点接入/重新绑定

新 VPS 不能通过桌面文本、聊天记录、DNS 结果或一次性 `ssh-keyscan` 自动替换现有节点。受保护加载器目前只接受已经登记并固定主机指纹的 transport；没有登记入口时，Release Agent 必须报告 blocker，而不是自行创建普通 `.env` 或接受未知指纹。

安全登记顺序如下：

1. 在提供商控制台或受信任的串口渠道核验新机 SSH 主机指纹；该指纹不能只来自待连接主机本身。
2. 在受保护运维存储中登记新节点的 `DSP_SH_HOST`、`DSP_SH_SSH_USER`、`DSP_SH_SSH_KEY_PATH`、`DSP_SH_KNOWN_HOSTS`（端口和物理出口按需登记），并保留旧节点记录作为回退。
3. 确认私钥文件和 `known_hosts` 的 ACL 仍为受限状态，且新主机指纹与登记值一致；不要把任何真实值写入仓库、普通用户环境、交接文档或聊天。
4. 重新加载 Agent 会话后只运行能力检查：

```powershell
pwsh -NoProfile -File .codex/skills/develop-dspidle/scripts/test-protected-release-access.ps1 -Capability Shanghai
```

只有同时得到 `status: ready`、完整 transport、可读私钥、可读 `known_hosts` 和 `strictHostKeyEntryPresent: true`，才允许进行第一个远端只读预检。能力检查失败时不得用旧节点值、新节点明文密码、`StrictHostKeyChecking=no`、`accept-new` 或未经验证的临时文件替代。登记/轮换本身不授权上传、备份、切换或数据库操作。

专用入口：

```powershell
# 香港当前 normal/main 云档只读导出
pwsh -NoProfile -File .codex/skills/develop-dspidle/scripts/export-hk-cloud-save.ps1 -Username '<username>'

# 香港单账号排行榜 dry-run
pwsh -NoProfile -File .codex/skills/develop-dspidle/scripts/invoke-hk-leaderboard-action.ps1 -MatchBy Username -Identifier '<username>'
```

专用工具可以从受保护环境或既有验证记录恢复香港 transport，但这不等于为任意 SSH 命令提供授权。上海没有专用账号工具时，必须由 Release Agent 在受保护运维环境中完整注入 `DSP_SH_*`；缺一项即报告 blocker。

## 5. 新会话可直接使用的提示词

```text
Role: release。先完整读取 docs/PROTECTED_RELEASE_ACCESS.md、
docs/DEPLOYMENT_OPERATIONS.md、docs/TESTING_RELEASE.md 以及
.codex/skills/develop-dspidle/references/protected-release-access.md。

先只运行 .codex/skills/develop-dspidle/scripts/
test-protected-release-access.ps1；不得打印 locator、真实路径、alias、口令、
私钥、主机、账号、known_hosts 内容或证书正文。

Android 只使用 invoke-protected-android-release.ps1，从用户指定的 clean runtime
SHA 构建；秘密只进入子进程，必须验证 APK v2/v3、zipalign、包名/版本、APK/AAB
历史证书连续性和 SHA-256。不得创建新证书，Windows 继续 NotSigned。

服务器只使用 DSP_HK_* / DSP_SH_* 受保护 transport，保持严格 host-key、TLS 和
按命令物理出口。先只读 preflight；没有用户明确发布授权、不可变 manifest、完整
Backup API 证据、回滚指针或磁盘余量时不得上传或切换。任何能力 unavailable 时只
报告缺失的非秘密前置条件，不猜路径、不从聊天/日志复制秘密、不降低校验。
```

## 6. 轮换与恢复

- Android keystore 的“轮换”不是普通发布操作。要保持现有安装链，必须恢复同一长期私钥；无法恢复时停止 stable 发布并进行单独的产品迁移决策。
- 更新 vault locator 或 ACL 后，先运行两条只读检查，再在隔离 checkout 构建；不得直接用生产发布验证新配置。
- SSH key 轮换先在目标节点并存安装新公钥，建立新 `known_hosts` 证据和只读连接，完成回滚验证后才移除旧公钥。密钥轮换不授权代码或数据库变更。
- 如果本机 locator、vault、受保护 transport 或 host-key 记录不可读，向用户报告明确的非秘密 prerequisite；不要把真实位置补写进本文。
