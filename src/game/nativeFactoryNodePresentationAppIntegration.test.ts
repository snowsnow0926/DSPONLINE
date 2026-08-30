import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function sourceSection(source: string, start: string, end: string, from = 0): string {
  const startIndex = source.indexOf(start, from);
  if (startIndex < 0) throw new Error(`Missing source-contract start anchor: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (endIndex < 0) throw new Error(`Missing source-contract end anchor: ${end}`);
  return source.slice(startIndex, endIndex);
}

function assignment(source: string, name: string): string {
  return sourceSection(source, `const ${name} =`, ";\n");
}

describe("native factory node presentation App integration", () => {
  const app = readFileSync(resolve("src/App.tsx"), "utf8");
  const nodes = readFileSync(resolve("src/components/FactoryNodes.tsx"), "utf8");

  it("opts every native viewport-v2 read into entity presentation version 1", () => {
    const refresh = sourceSection(
      app,
      "void nativeFactoryThinViewStore.refresh(projectionSource, {",
      "nativeFactoryThinViewStore,",
    );

    expect(refresh).toMatch(/viewport:\s*\{[\s\S]*?entityPresentationVersion:\s*1,[\s\S]*?planetId:\s*nativeFactoryProjectionPlanetId/);
    expect(app).toMatch(/const nativePresentation = factoryCanvasRows\.nodePresentationByEntityId\?\.get\(entity\.id\)/);
    expect(app).toMatch(/semanticSupported:\s*nativePresentation\?\.supported \?\? true/);
  });

  it("keeps full-state display lookup and node semantic helpers on the Web fallback only", () => {
    const displayLookup = sourceSection(
      app,
      "const canvasDisplayLookup = useMemo(",
      "const activateCanvasStack = useCallback",
    );
    expect(displayLookup).toMatch(/automaticDenseCanvasMode && !nativePlayerAuthorityOwnsRuntime && !canvasRuntimeDetailsDeferred[\s\S]*?createEntityDisplayLookup\(canvasGame\)/);
    expect(displayLookup).toMatch(/\[automaticDenseCanvasMode, canvasGame, canvasRuntimeDetailsDeferred, nativePlayerAuthorityOwnsRuntime\]/);
    expect(displayLookup.match(/createEntityDisplayLookup\(canvasGame\)/g)).toHaveLength(1);

    const nodeMapStart = app.indexOf("const next = activePlanetEntities.map((entity) => {");
    expect(nodeMapStart).toBeGreaterThanOrEqual(0);
    const nodeMap = sourceSection(
      app,
      "const next = activePlanetEntities.map((entity) => {",
      "const derivationMs =",
    );
    const nativePresentationIndex = nodeMap.indexOf(
      "const nativePresentation = factoryCanvasRows.nodePresentationByEntityId?.get(entity.id);",
    );
    const dynamicPresentationIndex = nodeMap.indexOf("dynamicNodeCount += 1;");
    expect(nativePresentationIndex).toBeGreaterThanOrEqual(0);
    expect(dynamicPresentationIndex).toBeGreaterThan(nativePresentationIndex);
    expect(nodeMap.match(/semanticSupported:\s*nativePresentation\?\.supported \?\? true/g)).toHaveLength(2);
    const staticPresentation = sourceSection(
      nodeMap,
      "if (staticPresentation) {",
      "dynamicNodeCount += 1;",
    );
    const staticCacheGuard = sourceSection(
      nodeMap,
      "const staticVisualSignature =",
      "if (staticPresentation) {",
    );
    expect(staticCacheGuard).toMatch(/nativePresentationSignature/);
    expect(staticCacheGuard).toMatch(/previous\.data\.visualSignature === staticVisualSignature/);
    expect(staticPresentation).not.toMatch(/getEntityPowerFactor|getResourceReserveSnapshot|getEntityOperatingStatus|getEntityOutputCapacity|getEntityCycleRatePerSimulationSecond/);
    expect(assignment(staticPresentation, "acceptedInputItemIds")).toMatch(/^const acceptedInputItemIds = nativePresentation[\s\S]*?nativePresentation\.acceptedInputItemIds[\s\S]*?: topologyStable && previous[\s\S]*?: getAcceptedInputs\(entity, canvasGame\)/);
    expect(assignment(staticPresentation, "producedOutputItemIds")).toMatch(/^const producedOutputItemIds = nativePresentation[\s\S]*?nativePresentation\.producedOutputItemIds[\s\S]*?: topologyStable && previous[\s\S]*?: getProducedOutputs\(entity\)/);
    expect(staticPresentation).toMatch(/powerFactor:\s*nativePresentation[\s\S]*?nativePresentation\.powerFactor[\s\S]*?: previous\?\.data\.powerFactor/);
    expect(staticPresentation).toMatch(/status:\s*staticAlertActive[\s\S]*?: nativePresentation[\s\S]*?nativePresentation\.status[\s\S]*?: previous\?\.data\.status/);
    expect(staticPresentation).toMatch(/semanticSupported:\s*nativePresentation\?\.supported \?\? true/);
    const dynamicPresentation = sourceSection(
      nodeMap,
      "dynamicNodeCount += 1;",
      "const connectionViewportFull =",
    );
    for (const [name, nativeField, unsupportedValue, webHelper] of [
      ["powerFactor", "nativePresentation.powerFactor", "0", "getEntityPowerFactor"],
      ["resourceReserve", "nativePresentation.resourceReserve", "null", "getResourceReserveSnapshot"],
      ["outputCapacity", "nativePresentation.outputCapacity", "0", "getEntityOutputCapacity"],
      ["cycleRatePerSecond", "nativePresentation.cycleRatePerSecond", "0", "getEntityCycleRatePerSimulationSecond"],
    ] as const) {
      const fieldAssignment = assignment(dynamicPresentation, name);
      expect(fieldAssignment, name).toMatch(new RegExp(
        `^const ${name} = nativePresentation\\s*\\?\\s*nativePresentation\\.supported\\s*\\?\\s*${nativeField.replace(".", "\\.")}\\s*:\\s*${unsupportedValue}\\s*:\\s*${webHelper}\\(canvasGame, entity`,
      ));
      expect(fieldAssignment.match(new RegExp(`${webHelper}\\(`, "g")), name).toHaveLength(1);
    }
    const statusAssignment = assignment(dynamicPresentation, "status");
    expect(statusAssignment).toMatch(/^const status = nativePresentation\s*\?\s*nativePresentation\.supported\s*\?\s*nativePresentation\.status\s*:\s*\{[\s\S]*?label: "原生语义暂不支持"[\s\S]*?\}\s*:\s*getEntityOperatingStatus\(canvasGame, entity/);
    expect(statusAssignment.match(/getEntityOperatingStatus\(/g)).toHaveLength(1);
    expect(assignment(dynamicPresentation, "ejectorTarget")).toMatch(/!nativePresentation &&[\s\S]*?getEjectorOrbitTargetStatus\(canvasGame, entity\)/);

    const connectionPresentation = sourceSection(
      nodeMap,
      "const acceptedInputItemIds = nativePresentation",
      "const className = [",
      nodeMap.indexOf("dynamicNodeCount += 1;"),
    );
    expect(assignment(connectionPresentation, "acceptedInputItemIds")).toMatch(/nativePresentation\.acceptedInputItemIds[\s\S]*?: getAcceptedInputs\(entity, canvasGame\)/);
    expect(assignment(connectionPresentation, "producedOutputItemIds")).toMatch(/nativePresentation\.producedOutputItemIds[\s\S]*?: getProducedOutputs\(entity\)/);
    expect(connectionPresentation).toMatch(/nativePresentation[\s\S]*?nativePresentation\.supported && acceptedInputItemIds\.includes\(nodeConnectionDraft\.itemId\)[\s\S]*?: canEntityAcceptBeltItem\(canvasGame, entity, nodeConnectionDraft\.itemId\)/);
  });

  it("routes unsupported native rows to a topology-only node before any rich presentation", () => {
    const unsupported = sourceSection(
      nodes,
      "function FactoryNodeUnsupportedView",
      "const SPECIAL_BELT_ENDPOINT_BUILDINGS",
    );
    expect(unsupported).toMatch(/data-native-semantic-supported="false"/);
    expect(unsupported).toMatch(/data-heavy-card="false"/);
    expect(unsupported).toMatch(/只读拓扑节点/);
    expect(unsupported).not.toMatch(/<Handle|<InputSlot|<OutputSlot|<WorkCycle|data\.status|data\.powerFactor|data\.resourceReserve|data\.acceptedInputItemIds|data\.producedOutputItemIds|data\.on[A-Z]/);

    for (const name of ["VeinNode", "MachineNode", "LogisticsNode", "PowerNode"] as const) {
      const node = sourceSection(
        nodes,
        `export function ${name}`,
        name === "PowerNode" ? "function areNodeVisualPropsEqual" : "export function ",
      );
      const unsupportedIndex = node.indexOf("if (props.data.semanticSupported === false) return <FactoryNodeUnsupportedView");
      expect(unsupportedIndex, name).toBeGreaterThanOrEqual(0);
      expect(unsupportedIndex, name).toBeLessThan(node.indexOf("props.data.lod === \"full\""));
    }
  });
});
