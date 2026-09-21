/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { createPlayerInitialState } from "../game/engine";
import { createWebFactoryConstructionWorkspaceReadModel } from "../game/webFactoryReadModelAdapter";
import { AppLocaleProvider } from "../i18n/locale";
import { ConstructionCenterWorkspace } from "./ConstructionCenterWorkspace";
import type { GameState } from "../game/types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = undefined; });

function state(): GameState {
  const s = createPlayerInitialState(); s.entities = []; s.tray = {}; s.planetTrays.home = s.tray;
  s.constructionAutomation.quantumSourceEnabled = true; s.quantumLogisticsNetwork.enabled = true;
  s.constructionAutomation.targetStock = { arc_smelter: 1 }; s.construction.arc_smelter = 0;
  const base = { planetId: "home", position: { x: 0, y: 0 }, interactionLocked: false, inputs: {}, outputs: {}, progress: 0, utilization: 0, productionRate: 0, routingCursor: 0, machineCount: 1, minerCount: 0 } as const;
  s.entities.push({ ...base, id: "first", kind: "machine", buildingId: "construction_center" }, { ...base, id: "second", kind: "machine", buildingId: "construction_center" }, { ...base, id: "tower", kind: "station", buildingId: "interstellar_logistics_station", quantumMode: "quantum", stationTier: 2, stationSlots: [] });
  return s;
}
function render(game: GameState) {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root!.render(<AppLocaleProvider><ConstructionCenterWorkspace open game={game} constructionReadModel={createWebFactoryConstructionWorkspaceReadModel(game)} onClose={() => {}} onEnabledChange={() => {}} onQuantumSourceChange={() => {}} onTargetChange={() => {}} onBatchTargetChange={() => {}} /></AppLocaleProvider>));
  return host;
}

describe("construction delivery explanations", () => {
  it("shows the actual receipt and stocked material while delivery is waiting", () => {
    const s = state(); s.elapsedSeconds = 5; s.quantumLogisticsNetwork.inventory.water = "1000000";
    s.quantumLogisticsNetwork.runtimeFlow = { boundarySecond: 5, uploaded: {}, downloaded: {}, globalUploadPerMinute: 5000, globalDownloadPerMinute: 5000, quantumTowerStacks: 1, quantumCollectorStacks: 0,
      constructionDeliveries: { first: { boundarySecond: 5, needed: { water: 16 }, requested: { water: 16 }, delivered: {} } } };
    const first = render(s).querySelector('[data-construction-center-id="first"]')!;
    expect(first.textContent).toContain("等待共享配送额度");
    expect(first.textContent).toContain("量子库水 100万");
    expect(first.textContent).toContain("请求 16 / 送达 0");
  });

  it("does not mark first-center ingredients ready using a different center's private cache", () => {
    const s = state(); s.constructionAutomation.quantumMaterialBuffer = { second: { iron_ingot: 4, stone_brick: 2, circuit_board: 4, magnetic_coil: 2 } };
    const panel = render(s);
    const row = Array.from(panel.querySelectorAll(".construction-center-row")).find(el => el.querySelector(".construction-center-identity strong")?.textContent === "电弧熔炉")!;
    expect(row.querySelectorAll(".construction-center-materials .ready")).toHaveLength(0);
    expect(panel.textContent).toContain("材料预览仅计首个中心可用库存");
  });
});
