# Protected Release Access

Use this reference whenever a DSPidle release needs Android signing or Hong Kong/Shanghai SSH transport. The canonical operator-facing procedure is `docs/PROTECTED_RELEASE_ACCESS.md`; this file defines the Agent behavior boundary.

## Start With Capability, Not Discovery

按**当前目标**选择已有参数，不要默认 `All`：

```powershell
pwsh -NoProfile -File .codex/skills/develop-dspidle/scripts/test-protected-release-access.ps1 -Capability Android
pwsh -NoProfile -File .codex/skills/develop-dspidle/scripts/test-protected-release-access.ps1 -Capability HongKong
pwsh -NoProfile -File .codex/skills/develop-dspidle/scripts/test-protected-release-access.ps1 -Capability Shanghai
```

允许值：`Android`、`HongKong`、`Shanghai`、`All`。默认 `All` 只用于同时需要三套能力的发布任务。无关目标缺失不构成当前任务的阻塞，也不构成索取无关凭据的理由。只阻塞依赖缺项的操作，不降低该目标本身的验证。

脚本只读，不得返回秘密值或物理秘密路径。有受保护入口时，不要从会话记录手工搜索口令、keystore 或 SSH 命令行。不要把恢复出的值粘贴进工具调用、计划、文档、清单或聊天。

The stable Android locator is `DSP_ANDROID_SIGNING_CONFIG`. Its value remains private. The protected properties contract is `keystorePath`, `storePassword`, `keyAlias`, `keyPassword` and `certificateSha256`; only the child build process receives the corresponding four `DSP_ANDROID_*` variables.

The stable server contracts are `DSP_HK_HOST`, `DSP_HK_SSH_USER`, `DSP_HK_SSH_KEY_PATH`, `DSP_HK_KNOWN_HOSTS` and their `DSP_SH_*` equivalents. Port and physical bind address are optional. Values come only from the protected operations environment or an already verified local operations record.

## Android

- Default to the check-only invocation of `scripts/invoke-protected-android-release.ps1`.
- Build only from an isolated clean checkout and require the exact 40-character runtime SHA.
- The wrapper injects secrets into a child process, runs the repository release build and verifies package/version metadata, APK v2/v3, zipalign and APK/AAB certificate continuity.
- Report only artifact basenames, sizes, SHA-256, version metadata and boolean gates.
- Do not create or substitute a certificate. Do not publish an unsigned diagnostic package.
- Windows has no approved certificate; keep the explicit `NotSigned` policy.

## SSH

- A complete transport requires host, user, key path and known-hosts file for the exact node; the fixed host-key entry must already exist.
- Bind only the one command to physical egress when VPN/TUN interception requires it. Preserve strict TLS and host-key verification.
- Use `scripts/invoke-protected-ssh-script.ps1` for LF-normalized remote scripts. It is check-only unless `-Run` is explicit; mutating mode additionally requires an authorization switch and exact release ID. Do not place an inline remote command or secret in the invocation.
- Use a read-only preflight before any upload, backup, service operation or pointer switch.
- Credentials provide capability, not authorization. Require the user's explicit target and deploy/operations approval plus all manifest, backup, health, disk and rollback gates in `deployment.md` and `docs/DEPLOYMENT_OPERATIONS.md`.
- Prefer maintained task-specific helpers for Hong Kong cloud-save export and leaderboard actions. They do not grant a general production mutation exception.

## Failure Contract

当前目标所需的 locator、字段、文件、ACL、证书、固定 host key 或物理出口不可用时，停止依赖该能力的动作，并只报告非秘密的缺项名称。未使用的能力保持未检查或 `blocked` 均可，不得因此停止无关的已授权本地工作。不要透露秘密如何被定位，不要复制到仓库 `.env`，不要削弱校验。执行器仍要求受保护工具审批时，遵守审批，不用 Skill 或其他工具绕过。
