# Desktop Packaging

The desktop shell uses Electron and loads the same Vite build as the web/PWA release.

- `npm run desktop:dev`: start Electron against an already-running Vite server at `http://127.0.0.1:4318`. This development shell uses the performance-edition identity so it cannot read the stable player profile.
- `npm run desktop:pack`: produce an unpacked **stable-edition** bundle under `release/` (or `release-fallback/` if a scanner locks the standard directory). It does not require API/update URLs or signing, and it does not write a release feed.
- `npm run desktop:performance:pack`: produce an unpacked **performance-development** bundle under `release-performance-edition/` (or `release-performance-edition-fallback/`). Isolated appId, EXE, and userData; unsigned and offline by default.
- `npm run desktop:dist`: build unsigned **stable-edition** installable artifacts for local verification. Requires HTTPS API and update URLs; does not sign or write a feed.
- `npm run desktop:performance:dist`: the performance-edition equivalent of `desktop:dist`.
- `npm run desktop:release`: require Windows signing credentials, build **stable-edition** installable artifacts, and stage a generic-provider update feed under the exact successful `release/update-feed/` or `release-fallback/update-feed/` directory. It does not upload the feed and does not collect performance-edition output.

Set `DSP_RELEASE_CHANNEL` to `stable`, `beta`, or `nightly`. The channel is embedded in packaged metadata, so Beta/Nightly installations do not silently fall back to Stable after restart. Each channel can use its own `DSP_UPDATE_*_URL`; `DSP_UPDATE_URL` overrides the selected channel at runtime for an isolated test. Formal release builds require `CSC_LINK` and `CSC_KEY_PASSWORD`. See [NATIVE_APPLICATIONS.md](../docs/NATIVE_APPLICATIONS.md).
