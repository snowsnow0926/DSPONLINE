import { createReadStream, existsSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { defineConfig } from "vite";
import base from "../../vite.config";
import packageJson from "../../package.json";

const fixture = process.env.DSP_SAVE_PROBE_FIXTURE;
if (!fixture) throw new Error("DSP_SAVE_PROBE_FIXTURE must name an existing private fixture");
const productionRoot = resolve(process.env.DSP_SAVE_PROBE_DIST ?? "dist");
const contentTypes: Record<string, string> = { ".js": "text/javascript", ".css": "text/css",
  ".html": "text/html", ".svg": "image/svg+xml", ".json": "application/json", ".wasm": "application/wasm" };

export default defineConfig({
  ...base,
  define: { ...base.define, __APP_VERSION__: JSON.stringify(packageJson.version),
    __BUILD_ID__: JSON.stringify(`${packageJson.version}+performance-probe`) },
  plugins: [...base.plugins!, {
    name: "local-save-performance-fixture",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const index = url.pathname === "/" && url.searchParams.has("performanceProduction");
        if (!index && !url.pathname.startsWith("/assets/")) { next(); return; }
        const path = resolve(productionRoot, index ? "index.html" : `.${url.pathname}`);
        if (!path.startsWith(`${productionRoot}${sep}`) || !existsSync(path)) { response.writeHead(404).end(); return; }
        response.writeHead(200, { "Content-Type": contentTypes[extname(path)] ?? "application/octet-stream", "Cache-Control": "no-store" });
        createReadStream(path).on("error", () => response.destroy()).pipe(response);
      });
      server.middlewares.use("/__save_performance_fixture__", (request, response) => {
        if (request.method !== "GET") { response.writeHead(405).end(); return; }
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        createReadStream(fixture).on("error", () => response.destroy()).pipe(response);
      });
    },
  }],
  server: { ...base.server, host: "127.0.0.1", strictPort: true, proxy: { "/api": "http://127.0.0.1:65534" } },
});
