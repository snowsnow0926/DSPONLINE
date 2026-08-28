# DSP Idle Network

English | [Simplified Chinese README](./README.md)

A 2D infinite-canvas idle factory game inspired by the production flow of Dyson Sphere Program. The current stable release is `1.2.3`, using GameState v47, save envelope v2, cloud schema v8, and SQLite layout v3. It ships as Web/PWA, an Electron desktop app, and a Capacitor Android app, with cloud accounts, four cloud-save slots, and a live leaderboard. Version 1.2.3 improves construction automation, offline/time-warp settlement, and the Windows native hot paths, and lets eligible normal saves opt into rate-replication idle mode while preserving the original conservation mode. Hong Kong and Shanghai Web/API, the Shanghai download page, Windows stable, and Android stable all run 1.2.3. Android uses the approved long-term signing certificate; Windows remains explicitly published as `NotSigned` under the established policy. See the [1.2.3 release record](./docs/releases/1.2.3.md) and the [Shanghai download node](https://download.dsponline.cn/).

Official site: [https://dsponline.cn](https://dsponline.cn)

Source repository: [https://github.com/snowsnow0926/DSPONLINE](https://github.com/snowsnow0926/DSPONLINE)

> **License:** This repository uses the [PolyForm Noncommercial License 1.0.0](./LICENSE). You may inspect, modify, and use the source for noncommercial purposes. Selling the software, paid hosting, commercial integration, or other expected commercial use requires separate written permission. This project is **source-available**, not open source under the OSI definition. See [COMMERCIAL_USE.md](./COMMERCIAL_USE.md).

## Current Capabilities

- React 19 and React Flow 2D infinite canvas for desktop, mobile portrait/landscape, and PWA.
- Deterministic production, power, conveyor belt, logistics, research, offline progress, Dyson engineering, and galactic endgame simulation.
- 8 star systems, 22 planets, 78 items, 78 recipes, 37 building types, and 67 technologies.
- Local saves, verified backups, automatic snapshots, three manual slots, blueprints, and content packs.
- Username accounts, optional email, four cloud-save slots, revision history, conflict protection, and leaderboard participation.
- Switchable Simplified Chinese and English stored as a device-only preference, plus Dark, Light, and System themes across desktop and both mobile interfaces.
- Multi-stage recursive manufacturing with advanced-recipe fallback, logistics-vessel and Construction Center support, plus cross-planet production-line location from the codex.
- Electron desktop packaging, a Capacitor Android project, and Stable/Beta/Nightly update channels.
- SQLite cloud service, backup and recovery tooling, Nginx/systemd templates, and independent Hong Kong and Shanghai deployments.

For the detailed and continuously updated feature baseline, see [docs/PROJECT_STATUS.md](./docs/PROJECT_STATUS.md).

## Local Development

Node.js 24 is recommended. Install dependencies:

```powershell
npm ci
npm --prefix server ci
```

Start the local cloud service in one terminal:

```powershell
npm run server:dev
```

Start the frontend in another terminal:

```powershell
npm run dev
```

Open `http://127.0.0.1:4318`. The local service stores its SQLite database under `server/data/cloud.sqlite`; this directory is ignored by Git.

To use the local operations dashboard, set an administrator token of at least 32 characters that is used only for development:

```powershell
$env:DSP_ADMIN_TOKEN = "replace-with-a-local-random-value-at-least-32-chars"
npm run server:dev
```

Then open `http://127.0.0.1:4318/admin`. Never place real tokens, server keys, player data, or production databases in the repository, an Issue, a Pull Request, or chat output.

## Community Builds

Standard Web development builds connect to a same-origin `/api` endpoint. Community-built Electron and Android packages disable the official cloud API, account deep links, and automatic updates by default, and do not connect to the official `dsponline.cn` service.

A self-hosted deployment must provide its own HTTPS endpoints at build time. See [docs/COMMUNITY_BUILDS.md](./docs/COMMUNITY_BUILDS.md) and [.env.example](./.env.example). Community forks must not reuse the official domain, signing identity, update source, or account entry points.

## Verification

```powershell
npm run licenses:check
npm run typecheck
npm test
npm run test:server
npm run test:native
npm run test:ops
npm run build
npm run test:e2e
```

For a desktop directory package, also run:

```powershell
npm run desktop:pack
```

Public Windows and Android releases must pass the long-term platform-signing gates. Unsigned preview artifacts must never enter the public update channels.

## Documentation

- [Project status](./docs/PROJECT_STATUS.md): current version, features, deployments, quality baseline, and known risks.
- [Architecture](./docs/ARCHITECTURE.md): frontend, simulator, save, cloud-service, and deployment boundaries.
- [Gameplay systems](./docs/GAMEPLAY_SYSTEMS.md): stable gameplay rules and content scale.
- [Content-pack mod guide](./docs/MODDING.md): JSON format, fields, dependencies, import flow, save boundaries, and a working example (Chinese).
- [Testing and release](./docs/TESTING_RELEASE.md): risk-based test selection and the production release checklist.
- [Deployment operations](./docs/DEPLOYMENT_OPERATIONS.md): dual-node backup, release, and rollback procedures.
- [Community builds](./docs/COMMUNITY_BUILDS.md): self-hosted API, native builds, and update URL configuration.
- [GitHub release checklist](./docs/GITHUB_RELEASE_CHECKLIST.md): repository security checks before and after publishing.
- [Roadmap](./docs/ROADMAP.md): planned work.
- [Changelog](./CHANGELOG.md): player-facing version history.

## Contributing and Security

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before submitting a change. Do not disclose security vulnerabilities in a public Issue; follow [SECURITY.md](./SECURITY.md) and use GitHub private vulnerability reporting.

The official service data policy and usage rules are in [PRIVACY.md](./PRIVACY.md) and [TERMS.md](./TERMS.md). Third-party dependency notices are in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md). Project name and logo usage is governed by [TRADEMARKS.md](./TRADEMARKS.md).

## License

Original project code, documentation, and assets are available under the [PolyForm Noncommercial License 1.0.0](./LICENSE). Commercial use requires separate written permission from the maintainer.

Third-party components remain under their respective licenses. The complete runtime notice is included in [`public/THIRD_PARTY_LICENSES.txt`](./public/THIRD_PARTY_LICENSES.txt).
