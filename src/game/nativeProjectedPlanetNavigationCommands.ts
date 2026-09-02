import {
  FACTORY_READ_MODEL_LIMITS,
  FACTORY_READ_MODEL_SCHEMA,
  type PlanetNavigationReadModel,
} from "./factoryReadModels";
import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";

const MAX_PLANET_ID_BYTES = 160;
const textEncoder = new TextEncoder();

/** The exact native-authority atom needed to request travel; no GameState. */
export interface NativeProjectedPlanetNavigationFrame {
  readonly source: "native-authoritative";
  readonly revision: number;
  readonly planetNavigation: PlanetNavigationReadModel;
}

function hasWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function validPlanetId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") &&
    hasWellFormedUnicode(value) && textEncoder.encode(value).byteLength <= MAX_PLANET_ID_BYTES;
}

function requireExactNativeNavigationFrame(
  frame: NativeProjectedPlanetNavigationFrame,
): PlanetNavigationReadModel {
  if (!frame || frame.source !== "native-authoritative" ||
    !Number.isSafeInteger(frame.revision) || frame.revision < 0) {
    throw new TypeError("原生行星切换命令需要当前权威 revision");
  }
  const navigation = frame.planetNavigation;
  if (!navigation || navigation.schema !== FACTORY_READ_MODEL_SCHEMA ||
    !validPlanetId(navigation.activePlanetId) || !navigation.planets ||
    !Array.isArray(navigation.planets.rows) || navigation.planets.truncated ||
    !Number.isSafeInteger(navigation.planets.totalCount) ||
    navigation.planets.totalCount !== navigation.planets.rows.length ||
    navigation.planets.rows.length > FACTORY_READ_MODEL_LIMITS.planetRows) {
    throw new TypeError("原生行星切换命令需要完整且未截断的导航投影");
  }

  const planetIds = new Set<string>();
  let activeRows = 0;
  for (const row of navigation.planets.rows) {
    if (!validPlanetId(row.planetId) || planetIds.has(row.planetId)) {
      throw new TypeError("原生行星切换导航投影包含非法或重复的行星 ID");
    }
    planetIds.add(row.planetId);
    if (row.active) {
      activeRows += 1;
      if (row.planetId !== navigation.activePlanetId) {
        throw new TypeError("原生行星切换导航投影的活动行星不一致");
      }
    }
  }
  if (activeRows !== 1) {
    throw new TypeError("原生行星切换导航投影缺少唯一活动行星");
  }
  return navigation;
}

/**
 * Builds one minimal travel intent from a same-revision native navigation
 * frame. The unusual two-segment path is an intentional semantic marker:
 * Rust verifies the observed current ID, then owns all tray/planetTrays/metrics
 * accounting and WAL replay. No inventory snapshot crosses into the renderer.
 */
export function createNativeProjectedActivePlanetCommand(
  frame: NativeProjectedPlanetNavigationFrame,
  targetPlanetId: string,
): SimulationCommandPatch | null {
  const navigation = requireExactNativeNavigationFrame(frame);
  if (!validPlanetId(targetPlanetId)) {
    throw new TypeError("原生行星切换目标 ID 无效");
  }
  if (targetPlanetId === navigation.activePlanetId) return null;
  const target = navigation.planets.rows.find((row) => row.planetId === targetPlanetId);
  if (!target || !target.discovered || !target.colonized) return null;

  return {
    protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
    baseRevision: frame.revision,
    topLevelChanges: [{
      path: ["activePlanetId", navigation.activePlanetId],
      operation: "set",
      value: targetPlanetId,
    }],
    changedEntities: [],
    addedEntities: [],
    removedEntityIds: [],
    changedBelts: [],
    addedBelts: [],
    removedBeltIds: [],
  };
}
