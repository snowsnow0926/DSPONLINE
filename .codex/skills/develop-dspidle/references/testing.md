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

Current production baseline: 1.0.38 on GameState v46, save envelope v2, cloud schema v7 and SQLite layout v2. The clean source passed 950 Vitest tests with 18 explicit skips and a final full Playwright run of 280 passes with 11 explicit conditional fixture skips; the first full run had one transient 90-second timeout, then the target and full clean rerun passed. Local and inactive production server verification passed 70 with 2 optional skips. Operations are 6/6, native tools 8/8, and 128 runtime licenses are consistent. Hong Kong and Shanghai Web/API run `1.0.38-351c649af9ee`; Android is `1.0.38 / 1000038`, Windows is 1.0.38 `NotSigned`, and the direct code/download rollback baseline is 1.0.37. Six public Chrome scenarios, current PWA cache/offline behavior and the 1.0.37 previous-stable worker/Cache Storage isolation passed. The user waived only this candidate's Android physical-device, low-spec Windows, 1.0.37-to-1.0.38 Windows upgrade-retention and approximately one-hour background/lock-screen gates; do not turn those waivers into passing results or reuse them for later releases.

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
