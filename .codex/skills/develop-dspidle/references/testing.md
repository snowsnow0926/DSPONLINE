# Testing Matrix

Canonical details live in `docs/TESTING_RELEASE.md`.

## Commands

```powershell
npm run typecheck
npm test
npm run test:server
npm run test:ops
npm run test:native
npm run licenses:check
npm run build
npm run test:e2e
npm run desktop:pack
```

Current production baseline (2026-08-24): 1.1.5 on GameState v47, save envelope v2, cloud schema v8 and SQLite layout v3. The frozen candidate evidence records 1,457 Vitest passes / 21 skips, 376 server passes / 2 optional skips plus station 3/3, 56 operations passes / 6 Linux-only skips, 25 native-tool passes, and 427 Chromium passes / 26 conditional skips; PWA, durable-recovery, release-switch and public download/Range checks also passed. Hong Kong and Shanghai Web/API run `1.1.5-a92c0d3157f3`; Android is `1.1.5 / 1001005` with the approved historical certificate, Windows is 1.1.5 `NotSigned`, and the direct Web/API/download rollback baseline is 1.1.4. The user explicitly waived only the 1.1.5 Android physical-device gate; it remains a residual risk and must not be reported as a pass or reused for later releases. This documentation task does not rerun the historical release matrix.

## Choose By Change

| Change | Minimum verification |
| --- | --- |
| Docs or this Skill | Markdown/link checks, Skill validator, `git diff --check` |
| Local UI/style | typecheck, build, focused E2E, desktop + portrait + landscape screenshots |
| Font/zoom/React Flow geometry | above plus 80/100/125/150/200 percent handle alignment |
| Content/recipe/technology | typecheck, unit suite, build, content/progression audits, focused E2E |
| Engine/logistics/power | typecheck, full unit suite, build, relevant E2E; full E2E for shared rules |
| Save/migration/offline | full unit suite, old-save migration fixtures, full E2E, build |
| Server/API/SQLite | server tests plus new failure-path tests, `test:ops`, typecheck, build |
| Production release | `npm ci`, typecheck, all unit tests, server tests, build, full E2E, deployment smoke tests |
| Desktop release | production matrix plus `desktop:pack` or `desktop:dist` and launch smoke test |

## Mandatory Regression Themes

- Existing saves load without inventory, entity, belt, technology, blueprint, or queue loss.
- Same state and elapsed time remain deterministic.
- Visible inventories remain non-negative integers.
- A second and third valid line work on the same building and across station slots.
- Recipe changes, upgrades, and removal preserve or refund material.
- Worker and main-thread fallback follow the same rules.
- Node movement updates lines live; building cards block click-through.
- Mobile orientation preserves viewport, selection, and panel state.
- Cloud conflicts do not silently overwrite either side.

## Reporting

Report commands and exact pass/fail counts. Distinguish a newly run result from a historical baseline. Keep Playwright screenshots/traces only as diagnostics; do not commit generated test output unless explicitly requested.
