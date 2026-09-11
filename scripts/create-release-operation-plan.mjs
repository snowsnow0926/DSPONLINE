import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyReleasePreflight } from "./release-preflight.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return "Usage: node scripts/create-release-operation-plan.mjs --manifest <candidate.json> --target hk-web|hk-web-api [--sha-sums <SHA256SUMS.txt>] [--allow-dirty]";
}

async function main() {
  const args = process.argv.slice(2);
  const value = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; };
  if (args.includes("--help") || args.includes("-h")) { console.log(usage()); return; }
  const target = value("--target") || "hk-web-api";
  if (!["hk-web", "hk-web-api"].includes(target)) throw new Error("target must be hk-web or hk-web-api");
  const apiMutation = target === "hk-web-api";
  const workspaceRoot = path.resolve(value("--workspace") || repositoryRoot);
  const resolveCliPath = (candidate) => candidate ? (path.isAbsolute(candidate) ? candidate : path.resolve(workspaceRoot, candidate)) : null;
  const preflight = await verifyReleasePreflight({
    manifestPath: resolveCliPath(value("--manifest")) || "",
    shaSumsPath: resolveCliPath(value("--sha-sums")),
    workspaceRoot,
    expectedGitSha: value("--expected-sha"),
    requireClean: !args.includes("--allow-dirty"),
    requiredArtifacts: apiMutation ? ["web", "api"] : ["web"],
  });
  const plan = {
    ok: true,
    target,
    releaseId: preflight.releaseId,
    buildId: preflight.buildId,
    gitSha: preflight.gitSha,
    artifacts: preflight.artifacts,
    apiMutation,
    backupGate: apiMutation
      ? { required: true, method: "sqlite-backup-api", reuseWindowMs: 86_400_000, independentPreflightAboveBytes: 512 * 1024 * 1024 }
      : { required: false, method: "nginx-config-hash-and-syntax" },
    upload: { destination: "new-immutable-release-directory", hashVerifyBeforePromotion: true, preferredTransport: "protected-ssh-stream", scpFallback: true },
    switch: { dryRunRequired: true, currentUnchangedUntilDryRunPasses: true, atomic: true, databaseRollback: false },
    postSwitch: ["local health", "local ready", "public health", "public ready", "version/build", "service-worker/cache", "previous pointer", "disk and restart count"],
    previousStable: { webOnly: true, updateAfterObservation: true, apiRollbackIndependent: true },
  };
  console.log(JSON.stringify(plan));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => { console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; });
}
