import { describe, expect, it } from "vitest";
import {
  createNativeProjectedActivePlanetCommand,
  type NativeProjectedPlanetNavigationFrame,
} from "./nativeProjectedPlanetNavigationCommands";

function frame(
  revision = 42,
  currentPlanetId = "home",
  targetPlanetId = "mod:planet/远星-1",
): NativeProjectedPlanetNavigationFrame {
  return {
    source: "native-authoritative",
    revision,
    planetNavigation: {
      schema: "factory-read-model-v1",
      activePlanetId: currentPlanetId,
      planets: {
        totalCount: 2,
        truncated: false,
        rows: [
          {
            planetId: currentPlanetId,
            systemId: "helios",
            displayName: "母星",
            code: "HOME",
            active: true,
            discovered: true,
            colonized: true,
            role: null,
            entityCount: 1,
            deviceCount: 1,
            beltCount: 0,
            constructionQueueCount: 0,
            powerFactor: 1,
          },
          {
            planetId: targetPlanetId,
            systemId: "mod:system/织女-α",
            displayName: "模组远星 🚀",
            code: "MOD-1",
            active: false,
            discovered: true,
            colonized: true,
            role: "manufacturing",
            entityCount: 2,
            deviceCount: 2,
            beltCount: 1,
            constructionQueueCount: 0,
            powerFactor: 0.75,
          },
        ],
      },
    },
  };
}

describe("native projected planet navigation commands", () => {
  it("encodes only the same-revision current and target IDs, preserving MOD/UTF-8", () => {
    const projected = frame();
    const command = createNativeProjectedActivePlanetCommand(projected, "mod:planet/远星-1");

    expect(command).toEqual({
      protocolVersion: 1,
      baseRevision: 42,
      topLevelChanges: [{
        path: ["activePlanetId", "home"],
        operation: "set",
        value: "mod:planet/远星-1",
      }],
      changedEntities: [],
      addedEntities: [],
      removedEntityIds: [],
      changedBelts: [],
      addedBelts: [],
      removedBeltIds: [],
    });
    const wire = JSON.stringify(command);
    expect(wire).not.toContain("tray");
    expect(wire).not.toContain("metrics");
    expect(JSON.parse(wire).topLevelChanges[0].value).toBe("mod:planet/远星-1");
  });

  it("returns no command for the current, locked, uncolonized, or unknown planet", () => {
    const projected = frame();
    expect(createNativeProjectedActivePlanetCommand(projected, "home")).toBeNull();
    expect(createNativeProjectedActivePlanetCommand({
      ...projected,
      planetNavigation: {
        ...projected.planetNavigation,
        planets: {
          ...projected.planetNavigation.planets,
          rows: projected.planetNavigation.planets.rows.map((row) =>
            row.planetId === "mod:planet/远星-1" ? { ...row, discovered: false } : row),
        },
      },
    }, "mod:planet/远星-1")).toBeNull();
    expect(createNativeProjectedActivePlanetCommand({
      ...projected,
      planetNavigation: {
        ...projected.planetNavigation,
        planets: {
          ...projected.planetNavigation.planets,
          rows: projected.planetNavigation.planets.rows.map((row) =>
            row.planetId === "mod:planet/远星-1" ? { ...row, colonized: false } : row),
        },
      },
    }, "mod:planet/远星-1")).toBeNull();
    expect(createNativeProjectedActivePlanetCommand(projected, "unknown")).toBeNull();
  });

  it("fails closed for stale-shaped, truncated, duplicate, or malformed projections", () => {
    const projected = frame();
    const cases: NativeProjectedPlanetNavigationFrame[] = [
      { ...projected, revision: Number.MAX_SAFE_INTEGER + 1 },
      {
        ...projected,
        planetNavigation: {
          ...projected.planetNavigation,
          planets: { ...projected.planetNavigation.planets, truncated: true },
        },
      },
      {
        ...projected,
        planetNavigation: {
          ...projected.planetNavigation,
          planets: {
            ...projected.planetNavigation.planets,
            rows: projected.planetNavigation.planets.rows.map((row) => ({ ...row, active: true })),
          },
        },
      },
      {
        ...projected,
        planetNavigation: {
          ...projected.planetNavigation,
          planets: {
            ...projected.planetNavigation.planets,
            rows: [projected.planetNavigation.planets.rows[0]!, projected.planetNavigation.planets.rows[0]!],
          },
        },
      },
    ];
    for (const candidate of cases) {
      expect(() => createNativeProjectedActivePlanetCommand(
        candidate,
        "mod:planet/远星-1",
      )).toThrow(TypeError);
    }
    expect(() => createNativeProjectedActivePlanetCommand(projected, "bad\0planet")).toThrow(TypeError);
    expect(() => createNativeProjectedActivePlanetCommand(projected, "\ud800")).toThrow(TypeError);
  });
});
