# Desktop Packaging

The desktop shell uses Electron and loads the same Vite build as the web/PWA release.

- `npm run desktop:dev`: start Electron against an already-running Vite server at `http://127.0.0.1:4318`.
- `npm run desktop:pack`: produce an unpacked platform bundle. On Windows, if a security scanner locks the freshly extracted Electron directory, the script automatically retries into `release-fallback/`.
- `npm run desktop:dist`: build unsigned installable artifacts for local verification.
- `npm run desktop:release`: require Windows signing credentials, build installable artifacts, and stage a generic-provider update feed under the exact successful `release-performance-edition/update-feed/` or `release-performance-edition-fallback/update-feed/` directory. It does not upload the feed.

Set `DSP_RELEASE_CHANNEL` to `stable`, `beta`, or `nightly`. The channel is embedded in packaged metadata, so Beta/Nightly installations do not silently fall back to Stable after restart. Each channel can use its own `DSP_UPDATE_*_URL`; `DSP_UPDATE_URL` overrides the selected channel at runtime for an isolated test. Formal release builds require `CSC_LINK` and `CSC_KEY_PASSWORD`. See [NATIVE_APPLICATIONS.md](../docs/NATIVE_APPLICATIONS.md).
