import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve, basename } from "node:path";
import { createRequire } from "node:module";

// Offline diagnostics only. Source maps must describe the exact sampled JS;
// this does not turn sampled CPU weights into an unprofiled timing result.
const require = createRequire(import.meta.url);
const { decodeMappings } = require("typescript");
const options = Object.fromEntries(process.argv.slice(2).map((arg) => arg.replace(/^--/, "").split(/=(.*)/s, 2)));
if (!options.profile || !options.dist || !options.output) throw new Error("Specify --profile, --dist and --output");
const profile = JSON.parse(readFileSync(resolve(options.profile), "utf8"));
const dist = resolve(options.dist);
const maps = new Map();
function sourcePosition(frame) {
  if (!frame.url || frame.lineNumber < 0) return null;
  let filename;
  try { filename = basename(new URL(frame.url).pathname); } catch { return null; }
  const path = resolve(dist, "assets", `${filename}.map`);
  if (!existsSync(path)) return null;
  if (!maps.has(path)) {
    const map = JSON.parse(readFileSync(path, "utf8"));
    const lines = new Map();
    const decoder = decodeMappings(map.mappings);
    for (let item = decoder.next(); !item.done; item = decoder.next()) {
      const mapping = item.value;
      const line = lines.get(mapping.generatedLine) ?? [];
      line.push(mapping); lines.set(mapping.generatedLine, line);
    }
    if (decoder.error) throw new Error(decoder.error);
    maps.set(path, { map, lines });
  }
  const { map, lines } = maps.get(path);
  const line = lines.get(frame.lineNumber) ?? [];
  let low = 0, high = line.length - 1, found = null;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (line[middle].generatedCharacter <= frame.columnNumber) { found = line[middle]; low = middle + 1; }
    else high = middle - 1;
  }
  if (found?.sourceIndex === undefined) return null;
  let sourceFile = map.sources[found.sourceIndex].replaceAll("\\", "/").replace(/^(\.\.\/)+/, "");
  const moduleIndex = sourceFile.indexOf("node_modules/");
  const sourceIndex = sourceFile.indexOf("src/");
  if (moduleIndex >= 0) sourceFile = sourceFile.slice(moduleIndex);
  else if (sourceIndex >= 0) sourceFile = sourceFile.slice(sourceIndex);
  return {
    file: sourceFile,
    line: found.sourceLine + 1, column: found.sourceCharacter,
    name: map.names?.[found.nameIndex] ?? null,
  };
}
const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
const parents = new Map();
for (const node of nodes.values()) for (const child of node.children ?? []) parents.set(child, node.id);
const locations = new Map(profile.nodes.map((node) => [node.id, sourcePosition(node.callFrame)]));
const labels = new Map(profile.nodes.map((node) => {
  const location = locations.get(node.id);
  return [node.id, location ? `${location.file}:${location.line}:${location.column} ${location.name ?? node.callFrame.functionName ?? ""}`
    : `${node.callFrame.functionName || "(anonymous)"} ${node.callFrame.url || ""}:${node.callFrame.lineNumber + 1}`];
}));
const self = new Map(), inclusive = new Map(), leafNodes = new Map();
let mappedSampleMs = 0;
for (let i = 0; i < profile.samples.length; i++) {
  const id = profile.samples[i], ms = profile.timeDeltas[i] / 1000, label = labels.get(id);
  self.set(label, (self.get(label) ?? 0) + ms);
  leafNodes.set(id, (leafNodes.get(id) ?? 0) + ms);
  if (locations.get(id)) mappedSampleMs += ms;
  const visited = new Set();
  for (let parent = id; parent !== undefined; parent = parents.get(parent)) {
    const name = labels.get(parent);
    if (!visited.has(name)) inclusive.set(name, (inclusive.get(name) ?? 0) + ms);
    visited.add(name);
  }
}
const ranked = (values, predicate = () => true) => [...values].filter(([name]) => predicate(name))
  .sort((a, b) => b[1] - a[1]).slice(0, 35).map(([name, ms]) => ({ name, sampledMs: Math.round(ms * 1000) / 1000 }));
const topStacks = [...leafNodes].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([id, ms]) => {
  const stack = [];
  for (let parent = id; parent !== undefined; parent = parents.get(parent)) stack.push(labels.get(parent));
  return { sampledMs: Math.round(ms * 1000) / 1000, stack };
});
const summary = { scope: "Sampled main-thread CPU in an isolated diagnostic run, not unprofiled performance; inclusive weights count each symbol once per sample.",
  sampleCount: profile.samples.length, profileDurationMs: (profile.endTime - profile.startTime) / 1000,
  mappedSampleMs, mapsRead: maps.size, topSelf: ranked(self), topInclusiveApp: ranked(inclusive, (name) => name.startsWith("src/")), topStacks };
writeFileSync(resolve(options.output), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ sampleCount: summary.sampleCount, mapsRead: summary.mapsRead, topSelf: summary.topSelf.slice(0, 14), topInclusiveApp: summary.topInclusiveApp.slice(0, 16) }, null, 2));
