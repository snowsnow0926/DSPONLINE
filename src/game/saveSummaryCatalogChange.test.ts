/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { createInitialState } from "./engine";
import { applyContentPackRegistry, commitContentPackRegistry, createContentPackRegistry, registerContentPack, setContentPackEnabled } from "./contentPacks";
import { getSaveSummariesInWorker, getSaveSnapshotSummaries, invalidateSaveSummaryCache, saveGameSnapshot, type SaveSnapshotSummary } from "./storage";
import { validateContentPack } from "./mods";

class SummaryWorker {
  static instances: SummaryWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  request!: { id: number; entries: Array<{ key: string; kind: string }> };
  terminated = false;
  constructor() { SummaryWorker.instances.push(this); }
  postMessage(request: SummaryWorker["request"]) { this.request = request; }
  terminate() { this.terminated = true; }
  reply(summary: SaveSnapshotSummary) {
    const entry = this.request.entries.find(entry => entry.kind === "snapshot")!;
    this.onmessage?.({ data: { id: this.request.id, summaries: [{ key: entry.key, summary }] } } as MessageEvent);
  }
}
afterEach(() => { vi.unstubAllGlobals(); invalidateSaveSummaryCache(); applyContentPackRegistry(createContentPackRegistry()); localStorage.clear(); });

it("discards a late missing-pack summary after the required configuration has been restored", async () => {
  const active = registerContentPack(createContentPackRegistry(), validateContentPack({ formatVersion: 5, id: "summary_pack", name: "摘要包", version: "1.0.0" })).registry;
  expect(commitContentPackRegistry(active, createContentPackRegistry()).persisted).toBe(true);
  const snapshot = saveGameSnapshot(createInitialState(), "测试恢复点");
  expect(snapshot?.valid).toBe(true);
  const disabled = setContentPackEnabled(active, "summary_pack", false).registry;
  expect(commitContentPackRegistry(disabled, active).persisted).toBe(true);
  invalidateSaveSummaryCache();
  SummaryWorker.instances = [];
  vi.stubGlobal("Worker", SummaryWorker);
  const pending = getSaveSummariesInWorker();
  const oldWorker = SummaryWorker.instances[0];
  expect(commitContentPackRegistry(active, disabled).persisted).toBe(true);
  invalidateSaveSummaryCache();
  oldWorker.reply({ ...snapshot!, valid: false, issues: ["内容包已停用"] });
  await vi.waitFor(() => expect(SummaryWorker.instances).toHaveLength(2));
  SummaryWorker.instances[1].reply(snapshot!);
  expect((await pending).snapshots[0].valid).toBe(true);
  expect(getSaveSnapshotSummaries()[0].valid).toBe(true);
  expect(oldWorker.terminated).toBe(true);
});
