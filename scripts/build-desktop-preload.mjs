import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export async function buildDesktopPreload(output = path.join(root, "desktop/preload.bundle.cjs")) {
  const bundle = await rolldown({
    cwd: root,
    input: path.join(root, "desktop/preload.cjs"),
    platform: "browser",
    external: ["electron"],
    resolve: { alias: { "node:crypto": path.join(root, "desktop/sandbox-crypto.cjs") } },
  });
  try { await bundle.write({ file: output, format: "cjs", codeSplitting: false, sourcemap: false }); }
  finally { await bundle.close(); }
}
function isDirectInvocation() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectInvocation()) await buildDesktopPreload();
