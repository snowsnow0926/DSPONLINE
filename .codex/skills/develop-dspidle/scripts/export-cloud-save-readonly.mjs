import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

function decodeArgument(value, label, { optional = false } = {}) {
  if (optional && !value) return "";
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label}_MISSING`);
  const decoded = Buffer.from(value, "base64url").toString("utf8").trim();
  if (!decoded || decoded.length > 128) throw new Error(`${label}_INVALID`);
  return decoded;
}

const requestedUsername = decodeArgument(process.argv[2], "USERNAME").replace(/^@/, "").toLowerCase();
const requestedDisplayName = decodeArgument(process.argv[3], "DISPLAY_NAME", { optional: true });
const base = pathToFileURL(`${process.cwd()}/`);
const [{ default: Database }, { readCloudPayload }, { inspectSavePayloadIntegrity }] = await Promise.all([
  import("better-sqlite3"),
  import(new URL("./cloud-payload-store.mjs", base)),
  import(new URL("./save-integrity.mjs", base)),
]);

const database = new Database("/var/lib/dsp-idle-cloud/cloud.sqlite", {
  readonly: true,
  fileMustExist: true,
});
database.pragma("query_only = ON");

let result;
try {
  result = database.transaction(() => {
    const row = database.prepare("SELECT payload FROM app_state WHERE id = 1").get();
    if (typeof row?.payload !== "string") throw new Error("APP_STATE_UNAVAILABLE");

    const data = JSON.parse(row.payload);
    const users = data?.users && typeof data.users === "object" ? data.users : {};
    const matches = Object.entries(users).filter(([, user]) => {
      const usernameMatches = String(user?.username ?? "").trim().toLowerCase() === requestedUsername;
      const displayNameMatches = !requestedDisplayName ||
        String(user?.displayName ?? "").trim() === requestedDisplayName;
      return usernameMatches && displayNameMatches;
    });
    if (matches.length !== 1) throw new Error(`ACCOUNT_MATCH_COUNT_${matches.length}`);

    const userId = matches[0][0];
    const save = data?.cloudSaves?.[userId];
    if (!Number.isSafeInteger(save?.revision) || save.revision < 1) {
      throw new Error("NORMAL_MAIN_SAVE_NOT_FOUND");
    }

    const payload = readCloudPayload(database, {
      userId,
      slot: "main",
      revision: save.revision,
    });
    if (typeof payload !== "string") throw new Error("NORMAL_MAIN_PAYLOAD_NOT_FOUND");

    const size = Buffer.byteLength(payload, "utf8");
    const sha256 = createHash("sha256").update(payload, "utf8").digest("hex");
    if (size !== save.size) throw new Error("CLOUD_METADATA_SIZE_MISMATCH");
    if (sha256 !== save.checksum) throw new Error("CLOUD_METADATA_SHA_MISMATCH");

    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      throw new Error("CLOUD_PAYLOAD_JSON_INVALID");
    }
    const integrity = inspectSavePayloadIntegrity(payload);
    const state = integrity?.state ?? parsed?.state ?? parsed;
    const elapsedSeconds = Number(state?.elapsedSeconds);
    return {
      payload,
      metadata: {
        revision: save.revision,
        size,
        sha256,
        formatVersion: Number.isInteger(parsed?.formatVersion) ? parsed.formatVersion : null,
        stateVersion: Number.isInteger(state?.version) ? state.version : null,
        integrityValid: integrity?.valid === true,
        hasEntities: Array.isArray(state?.entities),
        mode: typeof parsed?.mode === "string"
          ? parsed.mode
          : (typeof state?.mode === "string" ? state.mode : "normal"),
        elapsedSeconds: Number.isFinite(elapsedSeconds) && elapsedSeconds >= 0 ? elapsedSeconds : null,
      },
    };
  })();
} finally {
  database.close();
}

process.stderr.write(`DSP_EXPORT_META ${JSON.stringify(result.metadata)}\n`);
process.stdout.write(result.payload);
