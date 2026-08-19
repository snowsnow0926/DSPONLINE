import { describe, expect, it } from "vitest";
import { createContentPackRegistry } from "./contentPacks";
import { createInitialState } from "./engine";
import { prepareAuthoritativeSavePayload } from "./authoritativeSavePreparation";
import {
  createSimulationPreparedSaveRequest,
  validatePreparedSaveResponse,
} from "./simulationPreparedSaveLifecycle";
import { createSimulationStateIdentity } from "./simulationRuntimeProtocol";

describe("simulation prepared-save lifecycle", () => {
  it("creates an externally resolvable ordered request", async () => {
    const request = createSimulationPreparedSaveRequest("snapshot", "自动快照", 123);
    expect(request).toMatchObject({ id: null, kind: "snapshot", reason: "自动快照", savedAt: 123 });
    request.resolve(null);
    await expect(request.promise).resolves.toBeNull();
  });

  it("binds response kind, timestamp, command acknowledgement and state identity", async () => {
    const state = createInitialState();
    const request = createSimulationPreparedSaveRequest("primary", undefined, 456);
    request.expectedState = state;
    const prepared = await prepareAuthoritativeSavePayload(state, {
      formatVersion: 2,
      savedAt: 456,
      kind: "primary",
      slot: "main",
      contentPackRegistry: createContentPackRegistry(),
    });
    const response = { ...prepared, identity: createSimulationStateIdentity(state) };
    expect(validatePreparedSaveResponse(request, response, false)).toEqual(response.identity);
    expect(() => validatePreparedSaveResponse({ ...request, kind: "snapshot" }, response, false)).toThrow(/身份不一致/);
    expect(() => validatePreparedSaveResponse({ ...request, command: { protocolVersion: 1 } as never }, response, false)).toThrow(/身份不一致/);
  });
});
