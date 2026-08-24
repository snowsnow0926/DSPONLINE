# Project Map

Use this map after reading `docs/PROJECT_STATUS.md`. Open only the files relevant to the current task.

## Runtime Entry And Orchestration

| Area | Primary files | Notes |
| --- | --- | --- |
| Boot and PWA | `src/main.tsx`, `src/pwa.ts`, `public/sw.js` | Monitoring installs before React; PWA registers only in production. |
| Main menu | `src/components/StartMenu.tsx` | Continue, slots, import, cloud session/recovery, menu settings. |
| Account security and cloud conflicts | `src/components/CloudAccountSecurity.tsx`, `CloudSaveConflictDialog.tsx` | Shared by main menu and Galaxy workspace; server contracts live in `game/cloud.ts`. |
| Factory orchestration | `src/App.tsx` | Simulation Worker, canvas events, workspaces, saves, command wiring. High-conflict file. |
| Global styling | `src/styles.css` | Desktop/mobile/font scale/reduced motion. Very large; patch narrowly. |

## Gameplay Domain

| Task | Primary files | Required companions |
| --- | --- | --- |
| IDs and state | `src/game/types.ts` | `storage.ts`, affected tests |
| Items/buildings/recipes/tech | `src/game/content.ts` | `content.test.ts`, `progressionAudit.ts`, recipe graph |
| Simulation | `src/game/engine.ts` | `engine.test.ts`, `benchmark.ts`, Worker |
| Save/migration/offline | `src/game/storage.ts` | `storage.test.ts`, `endgame.ts` |
| Belts and network diagnosis | `src/game/network.ts` | `FactoryEdges.tsx`, engine belt commands, E2E |
| Power and operating status | `src/game/engine.ts`, `statistics.ts` | factory nodes, inspector, engine tests |
| Research and progression | `content.ts`, `campaign.ts`, `progression.ts`, `endgame.ts` | technology/campaign/galaxy workspaces |
| Recipe lookup, planning, and production management | `recipeGraph.ts`, `planning.ts`, `productionManagement.ts` | recipe/statistics workspaces, `ProductionManagement.tsx` |
| Galaxy and stellar industry | `galaxyCatalog.ts`, `galaxy.ts`, `stellarIndustry.ts` | star map, logistics diagnostics and Dyson workspaces |
| Blueprints | `blueprintExchange.ts`, engine blueprint commands | blueprint workspace and tests |
| Content packs | `mods.ts`, `contentPacks.ts` | operations workspace, storage migration |

## UI Ownership

| Surface | File |
| --- | --- |
| Nodes and ports | `src/components/FactoryNodes.tsx` |
| Lines, labels, preview | `src/components/FactoryEdges.tsx` |
| Resource rail, inspector, construction | `src/components/GamePanels.tsx` |
| Item/recipe modal picker | `src/components/CatalogPicker.tsx` |
| Production library / game codex | `src/components/RecipeWorkspace.tsx`, `src/components/CodexSections.tsx`, `src/styles/codex.css` |
| Focus recipe overlay | `src/components/RecipeFocusPanel.tsx` |
| Technology | `src/components/TechnologyWorkspace.tsx` |
| Statistics/network/planning | `src/components/StatisticsWorkspace.tsx` |
| Star map/logistics diagnosis | `src/components/StarMapWorkspace.tsx` |
| Dyson planning | `src/components/DysonPlannerWorkspace.tsx` |
| Operations/settings/saves/packs | `src/components/OperationsWorkspace.tsx` |
| Campaign | `src/components/CampaignWorkspace.tsx` |
| Accounts/ranking/endgame | `src/components/GalaxyWorkspace.tsx` |
| Mobile behavior | `src/hooks/`, responsive sections of `src/styles.css` |

## Online And Packaging

| Area | Files |
| --- | --- |
| Browser cloud client | `src/game/cloud.ts` |
| Anonymous analytics | `src/game/analytics.ts`, `server/analytics.mjs` |
| Node API and SQLite | `server/index.mjs` |
| Protected operations dashboard | `src/components/AdminDashboard.tsx`, `src/admin.css` |
| API tests | `server/server.test.mjs` |
| Nginx/systemd/backup/restore/monitoring | `deploy/` |
| Read-only leaderboard review report | `server/leaderboard-review-report.mjs`, `deploy/dsp-idle-leaderboard-review-report.*`, `scripts/report-hk-leaderboard-reviews.ps1` |
| Protected Android signing and VPS access | `docs/PROTECTED_RELEASE_ACCESS.md`, `references/protected-release-access.md`, `scripts/test-protected-release-access.ps1`, `scripts/invoke-protected-android-release.ps1`, `scripts/invoke-protected-ssh-script.ps1` |
| Electron | `desktop/main.cjs`, `preload.cjs`, `pack.cjs`, `release-channels.cjs` |
| Desktop CI | `.github/workflows/desktop-release.yml` |
| Build splitting/font transform | `vite.config.ts` |

## Hotspots

The current largest files are `src/styles.css`, `src/game/engine.ts`, `tests/e2e/game-flow.spec.ts`, and `src/App.tsx`. Avoid broad formatting or opportunistic refactors in these files. Extract code only when the requested change benefits and tests cover the new boundary.

## Source-Of-Truth Rules

- Code beats stale docs for current behavior; repair the doc after verification.
- `GameState` beats React component state for persisted gameplay.
- Core catalog definitions beat duplicated display lists.
- Live server configuration beats repository templates for current operations; compare before applying.
- Production data directories are never source-controlled artifacts.
