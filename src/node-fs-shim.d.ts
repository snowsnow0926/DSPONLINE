declare module "node:fs" {
  export function readFileSync(path: string): import("node:buffer").Buffer;
  export function readFileSync(path: string, encoding: "utf8"): string;
}
