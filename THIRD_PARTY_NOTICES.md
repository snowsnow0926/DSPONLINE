# Third-Party Notices

This inventory is generated from the locked npm runtime dependency trees. Third-party components remain under their own licenses; the project's PolyForm Noncommercial terms do not replace them.

Inventory SHA-256: `fb3ae2076faed2578adf70900a3734c62f4c7d50afffa29806f2353e6fb2603b`

## Direct Runtime Dependencies

| Package | Version | License | Runtime |
| --- | --- | --- | --- |
| `@capacitor/android` | `8.4.2` | `MIT` | client/runtime |
| `@capacitor/app` | `8.1.1` | `MIT` | client/runtime |
| `@capacitor/browser` | `8.0.4` | `MIT` | client/runtime |
| `@capacitor/core` | `8.4.2` | `MIT` | client/runtime |
| `@capacitor/network` | `8.0.1` | `MIT` | client/runtime |
| `@capacitor/splash-screen` | `8.0.2` | `MIT` | client/runtime |
| `@capacitor/status-bar` | `8.0.3` | `MIT` | client/runtime |
| `@noble/hashes` | `1.4.0` | `MIT` | client/runtime |
| `@noble/hashes` | `2.2.0` | `MIT` | client/runtime |
| `@xyflow/react` | `12.11.2` | `MIT` | client/runtime |
| `better-sqlite3` | `12.11.1` | `MIT` | cloud service |
| `electron` | `43.1.1` | `MIT` | client/runtime |
| `electron-updater` | `6.8.9` | `MIT` | client/runtime |
| `lucide-react` | `0.468.0` | `ISC` | client/runtime |
| `react` | `19.2.7` | `MIT` | client/runtime |
| `react-dom` | `19.2.7` | `MIT` | client/runtime |
| `tencentcloud-sdk-nodejs-ses` | `4.1.271` | `Apache-2.0` | cloud service |

## Runtime License Summary

| License expression | Packages |
| --- | ---: |
| `(BSD-2-Clause OR MIT OR Apache-2.0)` | 1 |
| `(MIT OR WTFPL)` | 1 |
| `0BSD` | 2 |
| `Apache-2.0` | 4 |
| `BlueOak-1.0.0` | 1 |
| `BSD-2-Clause` | 1 |
| `BSD-3-Clause` | 2 |
| `ISC` | 18 |
| `MIT` | 96 |
| `Python-2.0` | 1 |

Complete npm runtime license and notice texts are in [`public/THIRD_PARTY_LICENSES.txt`](./public/THIRD_PARTY_LICENSES.txt), which is copied into Web, desktop, and Android builds.

Electron packages must also retain the generated `LICENSE.electron.txt` and `LICENSES.chromium.html`. Android/Gradle artifacts remain governed by the notices embedded in their source packages and generated application; do not strip those notices from binary distributions.

Regenerate this inventory after dependency changes with `npm run licenses:generate` and verify it in CI with `npm run licenses:check`.
