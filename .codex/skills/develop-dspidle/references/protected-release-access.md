# Protected Release Access

Use this reference whenever a DSPidle release needs Android signing or Hong Kong/Shanghai SSH transport. The canonical operator-facing procedure is `docs/PROTECTED_RELEASE_ACCESS.md`; this file defines the Agent behavior boundary.

## Start With Capability, Not Discovery

Run the repository helper first:

```powershell
pwsh -NoProfile -File .codex/skills/develop-dspidle/scripts/test-protected-release-access.ps1
```

It is read-only and must return no secret value or physical secret path. Never manually search Codex session transcripts for passwords, keystore values or SSH command lines when the maintained protected entry point is available. Never paste recovered values into a tool call, plan, document, release manifest or chat response.

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

If any protected locator, field, file, ACL, certificate, fixed host key or physical egress gate is unavailable, stop and report only the named non-secret prerequisite. Do not reveal how the secret was located, do not copy it to a repository `.env`, and do not weaken validation.
