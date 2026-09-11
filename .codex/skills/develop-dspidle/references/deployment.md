# Deployment Guardrails

Read `docs/DEPLOYMENT_OPERATIONS.md` in full before any server mutation.

## Topology

The hostnames below are sanitized repository placeholders. Resolve real deployment targets only from the secured operations environment.

- Hong Kong production: `https://dsponline.cn`, host `hk-origin.example.invalid`.
- Shanghai legacy: `http://shanghai-node.example.invalid`, independently serves its local frontend and local API; public HTTP must not expose account-password input.
- Frontend root: `/var/www/dsp-idle/current`.
- Backend root: `/opt/dsp-idle-cloud/current`.
- Production database: `/var/lib/dsp-idle-cloud/cloud.sqlite`.
- Backups: `/var/lib/dsp-idle-cloud/backups`.
- Backend binds `127.0.0.1:4320` behind Nginx.

These addresses are operational identifiers, not authorization. Never infer permission to deploy from merely having network or SSH access.

## Before Mutation

1. Confirm the user requested deployment or an operational change.
2. Identify the target node explicitly.
3. Read the live Nginx, systemd, symlink, and service state before changing it.
4. Run local tests and build from a traceable commit.
5. Create a verified SQLite backup through the backup API before any API switch, database write, migration or data-affecting operation. For a Web-only immutable directory plus Nginx-only canary that does not change `current`, API or data, back up and verify the exact Nginx state instead of creating unrelated large-database I/O.
6. Record the current frontend/backend release targets for rollback.

## Never Do

- Never delete, truncate, initialize, overwrite, or upload fixtures into `/var/lib/dsp-idle-cloud`.
- Never copy a live SQLite file as the primary backup mechanism.
- Never print or commit SSH keys, passwords, tokens, user payloads, or certificate private keys.
- Never point Shanghai to Hong Kong, or deploy the bridge/redirect templates as its current configuration.
- Never enable cloud login over public HTTP.
- Never combine code rollback with data rollback by default.
- Never use a production account for automated write tests.

## VPN Or TUN Egress

If a VPN/TUN closes VPS SSH before key exchange, keep the VPN enabled and first identify the physical IPv4 interface that owns the real default gateway. Bind each VPS command to that source address only for the life of the process:

- Git OpenSSH: `ssh -b <physical-ip> ...`
- SCP: `scp -o BindAddress=<physical-ip> ...`
- Direct HTTPS probes: `curl --interface <physical-ip> --resolve <host>:443:<secured-origin-ip> ...`

Use `--resolve` only with the protected deployment target so TLS still validates the public hostname while bypassing fake-IP DNS. Never commit the physical address, origin address, username, or key path. Do not add persistent routes, disable the VPN globally, turn off TLS or host-key verification, or reuse a VPS SSH key for application signing.

GitHub may require the opposite path: when direct port 22/443 is blocked but the VPN can reach GitHub, leave Git traffic on the VPN and use GitHub's official `ssh.github.com:443` endpoint through a one-shot `GIT_SSH_COMMAND`. Clear that environment variable after fetch or push; do not rewrite the repository remote or global SSH configuration merely for one release.

## Release Pattern

Upload into a new release directory, validate it, atomically switch `current`, then reload or restart. Do not overwrite the active directory in place. Verify local health first and public health second. Keep the previous release until the observation window ends.

For backend rollback, switch code back and preserve the current database. For frontend rollback, switch the web symlink only.

### Same-Origin Web Canary

A root-scoped production service worker controls every path on the same HTTPS origin. Do not expose an ordinary candidate archive under `/canary/*` unless the rollout explicitly preserves the production PWA contract:

- Use a versioned immutable path and a new directory; do not switch Web/API/download `current` or create a drifting `latest` alias.
- Reject only the candidate Build ID's root `/sw.js` registration while leaving the production worker URL available.
- Return `Cache-Control: no-store` and `Vary: *` for canary responses. `Vary: *` makes Cache API writes reject, preventing the existing root worker from replacing cached production `/index.html` with a canary navigation response.
- Back up the active Nginx configuration, syntax-test the candidate independently, install it atomically, run the active `nginx -t`, and reload only after success.
- In a public Chrome context, first activate the production worker, then visit the canary. Require exactly the production active worker, no waiting/installing worker, byte-identical cached production HTML before and after, and a successful offline production-root reload.
- Never publish unsigned diagnostic native packages or change stable feeds under a Web-only gate waiver.

Removing this kind of canary means restoring the recorded Nginx configuration and reloading it. It does not require code-pointer rollback or database restore.

### Previous-Stable Web Fallback

After a stable rollout and its observation window pass, preserve the just-replaced Hong Kong Web release as a user-visible fallback for client-side regressions. This is a distinct operation from a candidate canary:

- Confirm the chosen Web directory is the exact direct rollback release, its immutable files are complete, and it remains compatible with the current API, cloud schema and save boundary. If compatibility is uncertain, publish no fallback.
- Serve it at `/canary/<previous-release-id>/`. Keep `/canary/previous/` as a `302` with `Cache-Control: no-store` and `Vary: *` to that immutable route; do not implement it as a drifting filesystem symlink. A historical compatibility URL may redirect to `/canary/previous/`, but an immutable version URL must never silently serve another build.
- Reject only the exposed previous build's root `/sw.js?v=<build-id>` request. The current stable worker URL must stay `200`. Return `no-store`, `Vary: *` and `X-Robots-Tag: noindex, nofollow, noarchive` throughout the fallback route.
- Back up and hash the exact active Nginx snippet, syntax-test the candidate independently, install it atomically, run the active `nginx -t`, reload, and retain the backup as the fallback-specific rollback pointer. Do not switch Web/API/download `current` or create unrelated database I/O.
- Verify the public fallback HTML is byte-identical to the immutable previous release, every referenced asset is reachable, the displayed/build version is the previous stable version, the legacy and stable redirects are uncached, the old worker is `404`, and the current worker and API health remain good.
- In a fresh public Chrome context, activate current stable first, record its cached `/index.html`, visit both the stable redirect and immutable fallback, and require exactly the current worker to remain active with no waiting/installing worker. The cached current HTML must be byte-identical before and after, and an offline reload of the current root must still work.
- State the boundary publicly: this fallback can help when new Web code regresses while Hong Kong Nginx and the current API remain available and compatible. It is not protection from an origin, API, database or network outage, and it must not be described as such.

For every later stable release, update `/canary/previous/` only after the new stable observation passes. Point it to the stable Web directory that was just replaced, update the exact previous-build worker rejection, rerun all HTTP and browser checks, and record the new Nginx backup and immutable URL in the release document. Roll back this fallback by restoring its Nginx backup only; leave the current code and database untouched.

### Exceptional Historical Speedrun Recovery

The standard offline recovery tool intentionally accepts only the latest primary cloud revision. Do not weaken that contract for convenience. A non-latest revision may be handled only when the user explicitly authorizes one identified player and displayed time, read-only inspection proves one exact account and one exact eligible revision, and all of these controls are present:

- Resolve the target with a display-name hash and keep the display name, account ID, factory ID, payload and save hash out of public logs and Git.
- Lock the revision, full payload SHA-256, envelope v2 integrity, GameState v46, official season/ruleset, eligible speedrun identity, empty content-pack set, authoritative cumulative progress, milestone seconds and existing submission count.
- Treat a displayed `mm:ss` only as `Math.floor` UI evidence. Store the authoritative fractional milestone seconds; never round it down into a faster result.
- Stop the service and health restart timer, create and verify a full SQLite Backup API snapshot, and preserve the exact historical revision in a separate mode-`0600` evidence database.
- Derive a minimal matching guard from the verified full snapshot, run the exact transaction and an idempotent second pass on a guard copy, then require an optimistic-lock production transaction.
- Permit only one verified speedrun submission plus one privacy-minimized audit action. Assert that cloud payload rows, current revision, target history and payload bytes do not change.
- Restart services and timers, verify local/public health and all speedrun targets, and remove the one-off tool from the server. Do not roll back the full database merely to reverse a ranking entry after normal traffic resumes; use a new backed-up, stopped-service inverse transaction.

Keep the sanitized evidence and rollback boundary in a release/operations record. The verified 2026-08-09 instance is documented in `docs/releases/1.0.34-speedrun-recovery-2026-08-09.md`.

## Smoke Checks

- Hong Kong root returns 200 over HTTPS.
- `www` redirects to the root domain.
- Hong Kong `/api/health` reports SQLite.
- Shanghai root and its own `/api/health` return 200.
- Main menu loads without clearing site storage.
- Existing local save can continue.
- Cloud metadata can be read using a dedicated test account when write validation is required.
- Mobile portrait/landscape and all five font scales remain usable.

## Current Production Baseline

Hong Kong and Shanghai Web/API run `1.0.38-351c649af9ee` with GameState v46, save envelope v2, cloud schema v7 and SQLite layout v2. Their direct code rollback is `1.0.37-853ecdb12795`; Shanghai serves `download-site-1.0.38-351c649af9ee` with the 1.0.37 download directory retained. Android 1.0.38 uses the approved long-term certificate; Windows 1.0.38 remains explicitly `NotSigned`. Production checks confirmed gzip and immutable current/rollback assets, no-cache entry points and feeds, exact 9-file public-download hashes, Range 206, six Chrome smoke scenarios, current PWA offline recovery, active services/timers and `NRestarts=0`. The user waived only this candidate's Android physical-device, low-spec Windows, 1.0.37-to-1.0.38 Windows upgrade-retention and approximately one-hour background/lock-screen gates; do not reuse that waiver or describe it as a pass.

Hong Kong now exposes the direct Web rollback `1.0.37-853ecdb12795` through immutable `/canary/1.0.37-853ecdb12795/`; `/canary/previous/` redirects there, and the former test compatibility URL redirects to `/canary/previous/`. The retired 1.0.36 public fallback path returns `410`, so an immutable historical URL never silently serves another build. The current Web/API pointers remain `1.0.38-351c649af9ee`. This route is Web-only, uses the current API, has current-worker/Cache Storage/offline-browser isolation evidence, and has an independent Nginx rollback backup.

The Hong Kong database is large enough that an online Backup API run can fail to converge under active writes. Use a low-traffic maintenance window, stop the health timer and service writes, allow at least three minutes for startup health, and verify `quick_check`, schema/layout, mode and hash before mutation. A service restart also triggers an immediate large COS snapshot under the current no-window configuration; keep health timers paused until its state is `ready`, or configure and validate an explicit low-traffic backup window. Current disk usage is approximately 79% in Hong Kong and 84% in Shanghai; keep current, direct rollback and valid backups. Never create a second 3 GB Hong Kong copy on the root filesystem if that would cross the 90% protection threshold. COSFS writes and complete reads can consume a same-size root cache before it flushes: during 1.0.38 pristine escrow the root temporarily reached 92%, so the release paused until it returned to 84%, then archived two exact old snapshots with full remote hashes before switching at 79%. Budget source, cache and immediate restart backup simultaneously; do not continue any smoke or switch at 90%+. A root-owned `0600` escrow object requires privileged readback, and backup WAL/SHM files may only be removed after the isolated process is stopped and the main backup hash is exact. Read `docs/releases/1.0.38.md` for evidence and `docs/DEPLOYMENT_OPERATIONS.md` for the current procedure.
