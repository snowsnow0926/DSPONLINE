# DSP Idle Network

English | [Simplified Chinese README](./README.md)

A 2D infinite-canvas idle factory game inspired by the production flow of Dyson Sphere Program. Start with mining, power, and your first production line, then build interplanetary logistics, research new technologies, and develop Dyson infrastructure. Play in a browser, on Windows, or on Android, with local saves and cloud synchronization.

[Play online](https://dsponline.cn/) · [Download clients](https://download.dsponline.cn/) · [Source repository](https://github.com/snowsnow0926/DSPONLINE)

## Current Releases

Public release metadata was checked on November 8, 2026. Platforms update independently.

| Platform | Stable version | Get it |
| --- | --- | --- |
| Web / PWA | **1.3.9** | [Play online](https://dsponline.cn/) |
| Windows x64 | **1.3.10** | [Download installer](https://download.dsponline.cn/downloads/desktop/stable/dsp-idle-1.3.10-x64-setup.exe) |
| Android 7+ | **1.3.9 / 1003009** | [Download APK](https://download.dsponline.cn/downloads/android/dsp-idle-1.3.9-1003009.apk) |

Windows 1.3.10 fixes cloud-save downloads rejected by DSP request-header validation. Web and Android remain on 1.3.9. See the [1.3.9 release record](./docs/releases/1.3.9.md) for content-pack and save-interaction improvements, and the [1.3.10 release record](./docs/releases/1.3.10.md) for the Windows hotfix, validation, and rollback details.

The Windows installer is currently `NotSigned`; Android retains its long-term release certificate. The download page provides SHA-256 checksums. Package details are in [Native Applications](./docs/NATIVE_APPLICATIONS.md).

> **License:** This repository uses the [PolyForm Noncommercial License 1.0.0](./LICENSE). You may inspect, modify, and use the source for noncommercial purposes. Selling the software, paid hosting, commercial integration, or other expected commercial use requires separate written permission. This project is **source-available**, not open source under the OSI definition. See [COMMERCIAL_USE.md](./COMMERCIAL_USE.md).

## Current Capabilities

Version 1.3.11 is in release preparation. The candidate adds a backed-up conversion to vanilla gameplay, v5 core item and belt overrides, and safe ID renaming with historical mappings. Conversion includes a preview and recovery of core materials. [Candidate record](./docs/releases/1.3.11-development-handoff-2026-11-09.md)

- **Infinite-canvas factories:** React 19 and React Flow with zooming, blueprints, cross-planet production-line lookup, and desktop and mobile portrait/landscape controls.
- **Industrial progression:** mining, smelting, manufacturing, power, belts, logistics, research, Dyson infrastructure, and a galactic endgame. Live simulation and offline settlement follow the same material rules.
- **Planning and manufacturing:** multi-stage recursive crafting, the Construction Center, logistics vessels, a production codex, and real upstream-line location and highlighting.
- **Local-save protection:** main saves, verified backups, snapshots, three manual slots, recovery points before save replacement, write-failure protection, and diagnostic exports.
- **Cloud progress:** username accounts, optional email, four cloud-save slots, revision history, conflict handling, and leaderboards, with separate normal and speedrun progress.
- **Content packs v4:** visual authoring, handcraft controls, recipe restrictions, effective technology bonuses, custom production rules, and save-preserving ID migration.
- **Multiple interfaces:** Simplified Chinese and English, Dark/Light/System themes, font scaling, and two mobile layouts. Language preferences are stored per device.
- **Apps and self-hosting:** Web/PWA, Electron Windows, Capacitor Android, a SQLite cloud service, backup/recovery tools, and independent-node deployment tooling.

For the detailed and continuously updated feature baseline, see [docs/PROJECT_STATUS.md](./docs/PROJECT_STATUS.md).

## Content Packs and Authoring

Open the visual authoring tool under Operations Center → Content Packs to create, validate, and export declarative JSON packs. Packs can:

- Add items, buildings, recipes, technologies, and belt tiers, with icons and categories.
- Configure handcraft availability, building recipe restrictions, and recipe groups unlocked by technology.
- Apply completed-technology bonuses to production speed, power consumption, mining efficiency, and input/output capacity.
- Define fuel energy, generator efficiency, and resource deposits and mining buildings on existing planets.
- Preserve inventory, buildings, and research during compatible updates, with explicit old-ID mappings for renamed content.

Start with the [content-pack guide](./docs/MODDING.md) and the [Crystal Industry v4 example](./docs/examples/example-crystal-v4.content-pack.json). Packs use validated declarative rules and cannot execute arbitrary scripts. Pack configurations are not distributed automatically with cloud saves; install the corresponding packs and compatible versions when moving to another device.

## Local Development

Use Node.js 24. Windows desktop builds also require Rust/Cargo and the corresponding C++ build tools. Android setup is covered in [Native Applications](./docs/NATIVE_APPLICATIONS.md). Install dependencies:

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

Choose checks appropriate to the change; see [Testing and Release](./docs/TESTING_RELEASE.md) for the full matrix:

```powershell
npm run licenses:check
npm run typecheck
npm test
npm run test:server
npm run test:native
npm run test:native-core:serial
npm run test:ops
npm run build
npm run test:e2e
```

Native checks require the Rust toolchain, and browser tests use the locally installed Google Chrome by default. Standard GitHub CI and browser-compatibility checks are triggered manually.

For a local Windows desktop directory package:

```powershell
npm run desktop:pack
```

`desktop:pack` produces a directory package for local validation. See [Native Applications](./docs/NATIVE_APPLICATIONS.md) for package identity, signing, update manifests, and release gates, including the supported scope and qualification requirements of the optional Rust native core.

## Documentation

- [Project status](./docs/PROJECT_STATUS.md): current version, features, deployments, quality baseline, and known risks.
- [Architecture](./docs/ARCHITECTURE.md): frontend, simulator, save, cloud-service, and deployment boundaries.
- [Gameplay systems](./docs/GAMEPLAY_SYSTEMS.md): stable gameplay rules and content scale.
- [Content-pack mod guide](./docs/MODDING.md): JSON format, fields, dependencies, import flow, save boundaries, and a working example (Chinese).
- [Native applications](./docs/NATIVE_APPLICATIONS.md): Windows/Android builds, signing, updates, and native-core boundaries.
- [Testing and release](./docs/TESTING_RELEASE.md): risk-based test selection and the production release checklist.
- [Deployment operations](./docs/DEPLOYMENT_OPERATIONS.md): dual-node backup, release, and rollback procedures.
- [Community builds](./docs/COMMUNITY_BUILDS.md): self-hosted API, native builds, and update URL configuration.
- [GitHub release checklist](./docs/GITHUB_RELEASE_CHECKLIST.md): repository security checks before and after publishing.
- [Roadmap](./docs/ROADMAP.md): planned work.
- [Changelog](./CHANGELOG.md): historical change summaries; see [1.3.9](./docs/releases/1.3.9.md) and [1.3.10](./docs/releases/1.3.10.md) for the latest releases.

## Contributing and Security

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before submitting a change. Do not disclose security vulnerabilities in a public Issue; follow [SECURITY.md](./SECURITY.md) and use GitHub private vulnerability reporting.

The official service data policy and usage rules are in [PRIVACY.md](./PRIVACY.md) and [TERMS.md](./TERMS.md). Third-party dependency notices are in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md). Project name and logo usage is governed by [TRADEMARKS.md](./TRADEMARKS.md).

## License

Original project code, documentation, and assets are available under the [PolyForm Noncommercial License 1.0.0](./LICENSE). Commercial use requires separate written permission from the maintainer.

Third-party components remain under their respective licenses. The complete runtime notice is included in [`public/THIRD_PARTY_LICENSES.txt`](./public/THIRD_PARTY_LICENSES.txt).
