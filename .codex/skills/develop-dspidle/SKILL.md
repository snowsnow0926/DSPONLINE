---
name: develop-dspidle
description: Maintain and extend the DSPidle2 / DSP极简网络 repository across feedback triage, deterministic gameplay and UI development, save migration, cloud accounts, rankings, PWA/Electron packaging, testing, documentation, and Hong Kong/Shanghai release operations. Use when Codex analyzes player reports, implements or reviews a change, builds artifacts, deploys a verified release, updates the download page, or performs authorized server maintenance.
---

# Develop DSPidle

Use the repository baseline as the source of truth. Preserve player data and deterministic behavior while extending the existing architecture.

## Conversation Roles

Run each dedicated conversation in exactly one role. Declare it at the start as `Role: feedback`, `Role: develop`, or `Role: release`; do not silently switch roles mid-task. The complete handoff fields and role checklists are in [references/agent-roles.md](references/agent-roles.md).

- **Feedback / analysis**: collect player reports and attachments, reproduce or inspect them read-only, classify priority and risk, and produce an implementation-ready handoff. Do not edit source code, build artifacts, or production systems.
- **Development**: consume an approved handoff, modify source/tests/canonical docs, run the proportional validation matrix, and produce a traceable commit and build handoff. Do not SSH to production, change live symlinks, or update the public download page.
- **Release / operations**: consume a development handoff and immutable artifacts, verify checksums and release gates, back up production, atomically deploy the requested node(s), update the download page when authorized, and report rollback targets and smoke checks. Do not change gameplay code or repair a failed release by editing files on the server.

The release role requires an explicit target and release instruction. A development result is not permission to deploy. If a required artifact, signature, backup, health check, or rollback pointer is missing, stop and report the blocker instead of improvising.

## Start Every Task

1. Confirm the conversation role and read the matching handoff in `references/agent-roles.md`.
2. Locate the repository root containing `package.json`, `src/`, `server/`, and `deploy/`.
3. Read `docs/PROJECT_STATUS.md` before making claims about current functionality or deployment state.
4. Read the task-specific canonical document:
   - Architecture or cross-module work: `docs/ARCHITECTURE.md`
   - Gameplay, recipes, technology, progression, or interaction rules: `docs/GAMEPLAY_SYSTEMS.md`
   - Server or deployment work: `docs/DEPLOYMENT_OPERATIONS.md`
   - Tests, build, packaging, or release work: `docs/TESTING_RELEASE.md`
   - Planning or prioritization: `docs/ROADMAP.md`
5. Read [references/project-map.md](references/project-map.md) to route the task to the smallest ownership area.
6. Run `git status --short`. Treat all existing tracked and untracked changes as user work. Do not reset, clean, discard, or overwrite them.
7. Inspect the relevant implementation and tests before proposing or applying a change. Reconcile documentation with code when they disagree.

## Classify Risk

Treat these changes as high risk:

- `GameState`, save envelopes, migrations, localStorage keys, cloud-save payloads, or content-pack IDs
- Simulation timing, item settlement, power allocation, belts, logistics stations, research, Dyson systems, or offline progress
- Authentication, sessions, leaderboard verification, SQLite persistence, backup, or API origin policy
- Nginx, systemd, TLS, DNS, deployment symlinks, or production data directories
- Shared canvas interaction, font scaling, mobile breakpoints, or React Flow handle geometry

For high-risk changes, broaden tests and explicitly verify backwards compatibility and data preservation.

## Follow Project Invariants

- Keep `GameState` as the persisted gameplay truth. Derive React Flow nodes and edges from it; do not persist transient React Flow objects.
- Keep `advanceSimulation()` deterministic for the same state and elapsed seconds. Derive randomness from persisted seeds.
- Settle player-visible inventories as non-negative integers. Keep fractional values only in hidden progress accumulators.
- Keep continuous generators as power sources without fake production cycles. Use cycle progress for mining, production, processing, research, and logistics.
- Preserve all input, output, fuel, route inventory, and construction stock during recipe changes, upgrades, removal, migration, and load operations.
- Support multiple valid lines per building and per station slot. Never assume that the first connection owns the whole entity.
- Preserve explicit recipes and station-slot choices. Auto-configure only an unconfigured compatible target.
- Render belts below building cards and stop card pointer events from reaching belts behind them.
- Keep mouse and touch simulations identical. Check portrait, landscape, and 80/100/125/150 percent font scales for shared UI changes.
- Apply enabled content packs before migrating saves containing extension IDs.
- Keep locked construction hidden unless a requirement explicitly changes that behavior.
- Do not add Dark Fog or combat unless the user explicitly reopens that scope.

## Protect Saves And Production Data

- Never clear or rewrite browser saves as a migration shortcut. Do not call `clearGame()` from ordinary navigation, new-game, menu, or update paths.
- Never delete, initialize, replace, or upload test data into `/var/lib/dsp-idle-cloud`.
- Never expose private keys, passwords, tokens, certificate keys, user save payloads, or backup contents in code, docs, logs, or responses.
- Before a backend, schema, or persistence deployment, create and verify a SQLite backup with the backup API.
- Roll back code independently from data. Restore an older database only as an explicit disaster-recovery action after backing up the current database.
- Keep the Hong Kong production node and Shanghai legacy node independent. Do not redirect or proxy the Shanghai node to Hong Kong.
- Keep cloud credentials disabled on non-local HTTP pages. Do not weaken `src/game/cloud.ts` to support insecure login.
- Do not mutate production systems unless the user explicitly asks for deployment or operations work.
- Keep role ownership separate: analysis may write only explicitly requested analysis/handoff artifacts; development owns source and tests; release owns release directories, deployment state, and release records. Never overwrite another role's uncommitted work.

Read [references/deployment.md](references/deployment.md) before any server action.

Before Android signing or Hong Kong/Shanghai transport, read [references/protected-release-access.md](references/protected-release-access.md) and run [scripts/test-protected-release-access.ps1](scripts/test-protected-release-access.ps1). Use [scripts/invoke-protected-android-release.ps1](scripts/invoke-protected-android-release.ps1) for the signed Android build and [scripts/invoke-protected-ssh-script.ps1](scripts/invoke-protected-ssh-script.ps1) for LF-normalized remote scripts. Never reveal or manually transcribe the protected locator, keystore path, alias, passwords, SSH targets, users, key paths, known-hosts contents, or private keys. Capability does not replace explicit release authorization.

For an explicitly authorized, single-account Hong Kong current-main cloud-save export, use the maintained read-only helper [scripts/export-hk-cloud-save.ps1](scripts/export-hk-cloud-save.ps1) and follow [references/deployment.md](references/deployment.md#single-account-read-only-cloud-save-export). Do not recreate ad hoc SQL/SSH export commands when this helper is available.

For an explicitly authorized single-account leaderboard inspection, restriction, restoration, or ordinary-entry republish on Hong Kong, use [scripts/invoke-hk-leaderboard-action.ps1](scripts/invoke-hk-leaderboard-action.ps1) and follow [references/deployment.md](references/deployment.md#single-account-leaderboard-only-action). It is dry-run by default, requires one exact account match, supports retained-window white-rate capacity/material audits, and emits an exact guard ID for reversible actions. `RepublishNormal` is allowed only behind a separately verified full SQLite backup; the lightweight guard exception applies only to supported admin-API restriction/restoration when the user explicitly waives the full backup. Never extend either path to login, sessions, cloud saves, account deletion, schema changes, or deployment.

For the standing anomaly-review policy, use [scripts/report-hk-leaderboard-reviews.ps1](scripts/report-hk-leaderboard-reviews.ps1) for a read-only Hong Kong/Shanghai queue report. Detection must remain separate from disposition: the report and `leaderboardReviewQueue` do not ban accounts, disable login, delete cloud data, or remove an existing submission. Only an explicitly reviewed admin action may restrict or approve a matching revision.

## Implement By Task Type

### Gameplay Or Content

Update every closed reference: ID types, definitions, sources and uses, compatible buildings, technology unlocks, construction costs, handcraft visibility, planning, migration, and tests. Run catalog and progression audits. Do not add display-only content.

### Simulation Or Logistics

Prefer pure helpers and established engine commands. Test normal operation, missing input, blocked output, no or low power, multiple lines, integer settlement, offline advancement, and deterministic hashing as applicable.

### UI Or Interaction

Reuse existing catalog pickers, hooks, icon library, workspaces, and responsive patterns. Keep fixed controls dimensionally stable. Test pointer capture, click-through, drag preview, zoomed handles, touch targets, overflow, reduced motion, and orientation changes where relevant.

### Save Or Content-Pack Compatibility

Increment `GameState.version` only for a real state shape or semantic migration. Extend `migrateGame()` from the previous production state, preserve unknown-but-valid extension IDs when packs are active, and add migration fixtures. Keep the envelope version separate from the game-state version.

### Cloud Or Server

Validate authentication, body size, origin, rate limits, conflict behavior, persistence, restart, and error responses. Use temporary SQLite in tests. Never run write tests against production.

### Release Or Deployment

Follow the backup, release-directory, atomic switch, health-check, smoke-test, and rollback workflow in the operations docs. Verify Hong Kong and Shanghai separately. Record Git SHA, app version, build ID, and deployed artifact hashes.

The release role must deploy from a clean, traceable development commit and an immutable manifest. Build or test in an isolated directory before touching production; never copy a working tree, player save, SQLite database, secret, or private key into a release. Update `docs/PROJECT_STATUS.md` and `docs/releases/<version>.md` only after the live checks actually pass.

After each successful stable rollout and observation window, keep the just-replaced Hong Kong Web release available as the previous-stable fallback described in [references/deployment.md](references/deployment.md). Expose only an immutable versioned route plus the controlled `/canary/previous/` redirect, preserve the current root worker and caches, require current-API compatibility and public browser isolation evidence, and record the independent Nginx rollback pointer. This fallback never authorizes an API, database, native-feed, or download-page rollback.

Release closeout must update the observed baseline, not the candidate's intended state: add `docs/releases/<version>.md` with the runtime SHA, immutable manifest hashes, backup/health/smoke evidence, waivers and exact current/previous/canary rollback pointers; then reconcile `PROJECT_STATUS.md`, `DEPLOYMENT_OPERATIONS.md`, `TESTING_RELEASE.md`, `NATIVE_APPLICATIONS.md` and `ROADMAP.md` when their present-tense facts changed. Keep candidate/handoff/development evidence linked separately, record any skipped or waived gate explicitly, and never mark a production target healthy from a prior conversation or from a different artifact.

When a VPN or TUN intercepts release traffic, use only the transient per-command egress methods in [references/deployment.md](references/deployment.md). Do not add persistent host routes, weaken TLS or host-key checks, or expose secured targets and key paths. Treat GitHub transport separately from VPS transport: GitHub's official SSH-over-443 endpoint may remain on the VPN path when direct physical egress is unavailable.

## Validate Proportionally

Read [references/testing.md](references/testing.md), choose the smallest sufficient matrix, and report exactly what ran. A production release requires the full matrix. Documentation-only changes require link checks, Skill validation, and `git diff --check`, not an unnecessary browser suite.

Never claim a check passed from an earlier conversation when the current artifact has changed. If a check cannot run, state the gap and residual risk.

## Keep The Baseline Current

Update canonical docs in the same change when behavior, architecture, storage versions, deployment topology, release procedure, test counts, or roadmap status materially changes.

- Put verified present-tense facts in `docs/PROJECT_STATUS.md`.
- Put stable implementation boundaries in `docs/ARCHITECTURE.md`.
- Put player-facing invariants in `docs/GAMEPLAY_SYSTEMS.md`.
- Put operational procedure in `docs/DEPLOYMENT_OPERATIONS.md`.
- Put future work only in `docs/ROADMAP.md`.

Keep this Skill concise. Add detailed facts to canonical docs or its three direct references rather than duplicating them here.
