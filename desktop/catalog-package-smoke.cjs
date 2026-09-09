"use strict";

// Electron main-only package probe. It creates no BrowserWindow and never loads
// the game. A parent verifier supplies already-frozen resources and a fresh
// isolated profile; no qualification/publisher override is accepted.
const { app, dialog } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { initializePerformanceEditionIdentity } = require("./performance-edition-identity.cjs");
const { installBackgroundSmokePolicy } = require("./background-smoke-policy.cjs");

let finished = false;
function finish(result, code) {
  if (finished) return;
  finished = true;
  process.stdout.write(JSON.stringify(result) + "\n", () => app.exit(code));
}
function fail(error) {
  finish({ status: "FAILED", kind: "CATALOG_PACKAGE_SMOKE", error: String(error?.message ?? error).slice(0, 300) }, 1);
}
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);
dialog.showErrorBox = () => fail(new Error("Unexpected native error dialog"));

async function run() {
  os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL);
  const [resources, profile, expectedHelperSha256] = process.argv.slice(2);
  if (process.argv.length !== 5 || typeof resources !== "string" || !path.isAbsolute(resources)
      || !/^[a-f0-9]{64}$/.test(expectedHelperSha256 ?? "")
      || !profile || !path.isAbsolute(profile) || fs.realpathSync(path.dirname(profile)) !== fs.realpathSync(os.tmpdir())
      || !/^dspidle-performance-smoke-[A-Za-z0-9]+$/.test(path.basename(profile))
      || fs.lstatSync(profile).isSymbolicLink() || !fs.statSync(profile).isDirectory() || fs.readdirSync(profile).length) {
    throw new Error("Package probe requires frozen resources and its own empty profile");
  }
  const identity = initializePerformanceEditionIdentity({ app, smokeIsolation: {
    enabled: true, releaseChannel: "beta", appDataRoot: profile, temporaryRootPath: os.tmpdir(),
  } });
  const audit = installBackgroundSmokePolicy({ app, dialog, identity,
    environment: { DSP_PERFORMANCE_SMOKE_BACKGROUND: "1" } });
  app.setAppLogsPath(path.join(profile, "logs"));
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("mute-audio");
  // A signed qualification must not turn this readonly negative probe into a
  // production authentication run. The fresh development package has none.
  if (fs.existsSync(path.join(resources, "native-qualification"))) throw new Error("Probe requires absent qualification carrier");
  const helperFile = path.join(resources, "native", "dsp-catalog-verifier.exe");
  const actualHelperSha256 = createHash("sha256").update(fs.readFileSync(helperFile)).digest("hex");
  if (actualHelperSha256 !== expectedHelperSha256) throw new Error("Frozen helper differs from parent identity");
  await app.whenReady();
  // Electron's real ASAR loader supplies this module and its own package.json.
  const modulePath = path.join(resources, "app.asar", "desktop", "native-catalog-verifier.cjs");
  const { createPackagedWindowsCatalogVerifier } = require(modulePath);
  const verifier = createPackagedWindowsCatalogVerifier({ resourcesPath: resources,
    publisherCertificateSha256: ["ab".repeat(32)] });
  let rejection;
  try { await verifier.authenticate(); } catch (error) { rejection = error.code; }
  if (rejection !== "carrier-io") throw new Error("Actual packaged helper did not reject the missing carrier");
  if (audit.windowsCreated !== 0 || audit.initiallyVisible !== 0 || audit.showEvents !== 0 || audit.focusEvents !== 0
      || Object.keys(audit.dialogs).length) throw new Error("Package probe violated its no-window contract");
  finish({ status: "PASS", kind: "CATALOG_PACKAGE_SMOKE", actualHelperSha256, rejection,
    authorityEligible: false, backgroundAudit: audit }, 0);
}

setTimeout(() => fail(new Error("Package probe deadline exceeded")), 30_000).unref();
void run().catch(fail);
