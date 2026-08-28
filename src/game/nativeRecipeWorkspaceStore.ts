import type {
  DesktopBridge,
  DesktopNativeCoreRecipeWorkspaceProjectionResult,
} from "../desktop";
import type { NativeRecipeWorkspaceFrame, RecipeWorkspaceSelector } from "./recipeWorkspaceReadModel";
import { recipeWorkspaceSelectorsEqual, validRecipeWorkspaceSelector } from "./recipeWorkspaceReadModel";

export interface NativeRecipeWorkspaceSnapshot {
  readonly status: "empty" | "loading" | "ready" | "unavailable";
  readonly requestedRevision: number | null;
  readonly frame: NativeRecipeWorkspaceFrame | null;
}

export interface NativeRecipeWorkspaceSource {
  readVerifiedRecipeWorkspaceProjection(
    expectedRevision: number,
    expectedRegistryFingerprint: string,
    selector: RecipeWorkspaceSelector,
  ): Promise<DesktopNativeCoreRecipeWorkspaceProjectionResult | null>;
}

const LOGICAL_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const EMPTY_SNAPSHOT: NativeRecipeWorkspaceSnapshot = Object.freeze({
  status: "empty",
  requestedRevision: null,
  frame: null,
});

function validLogicalId(value: string | null | undefined, maximum = 256): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum && LOGICAL_ID_PATTERN.test(value);
}

export function createNativePlayerAuthorityRecipeWorkspaceProjectionSource(
  bridge: Pick<DesktopBridge, "getNativeCoreRecipeWorkspaceProjection"> | null,
  sessionId: string,
): NativeRecipeWorkspaceSource | null {
  const readProjection = bridge?.getNativeCoreRecipeWorkspaceProjection;
  if (!validLogicalId(sessionId, 128) || typeof readProjection !== "function") return null;
  return Object.freeze({
    async readVerifiedRecipeWorkspaceProjection(
      expectedRevision: number,
      expectedRegistryFingerprint: string,
      selector: RecipeWorkspaceSelector,
    ) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
          !validLogicalId(expectedRegistryFingerprint) || !validRecipeWorkspaceSelector(selector)) return null;
      try {
        const result = await readProjection({
          sessionId,
          expectedRevision,
          expectedRegistryFingerprint,
          itemIds: [...selector.itemIds],
          selectedItemId: selector.selectedItemId,
          location: null,
        });
        return result.revision === expectedRevision &&
          result.registryFingerprint === expectedRegistryFingerprint &&
          result.request.selectedItemId === selector.selectedItemId &&
          recipeWorkspaceSelectorsEqual(
            { itemIds: result.request.itemIds as RecipeWorkspaceSelector["itemIds"], selectedItemId: result.request.selectedItemId as RecipeWorkspaceSelector["selectedItemId"] },
            selector,
          ) ? result : null;
      } catch {
        return null;
      }
    },
  });
}

export class NativeRecipeWorkspaceStore {
  private snapshot: NativeRecipeWorkspaceSnapshot = EMPTY_SNAPSHOT;
  private requestToken = 0;
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): NativeRecipeWorkspaceSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  clear(): void {
    this.requestToken += 1;
    this.publish(EMPTY_SNAPSHOT);
  }

  async refresh(
    source: NativeRecipeWorkspaceSource,
    sessionId: string,
    expectedRevision: number,
    expectedRegistryFingerprint: string,
    selector: RecipeWorkspaceSelector,
  ): Promise<"committed" | "superseded" | "unavailable"> {
    if (!validLogicalId(sessionId, 128) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
        !validLogicalId(expectedRegistryFingerprint) || !validRecipeWorkspaceSelector(selector)) {
      this.clear();
      return "unavailable";
    }
    const token = ++this.requestToken;
    const previousFrame = this.snapshot.frame;
    this.publish(Object.freeze({ status: "loading", requestedRevision: expectedRevision, frame: previousFrame }));
    const projection = await source.readVerifiedRecipeWorkspaceProjection(
      expectedRevision,
      expectedRegistryFingerprint,
      selector,
    );
    if (token !== this.requestToken) return "superseded";
    if (!projection || projection.schemaVersion !== 1 || projection.projectionType !== "recipe-workspace-v1" ||
        projection.revision !== expectedRevision || projection.registryFingerprint !== expectedRegistryFingerprint) {
      this.publish(Object.freeze({ status: "unavailable", requestedRevision: expectedRevision, frame: previousFrame }));
      return "unavailable";
    }
    const frame: NativeRecipeWorkspaceFrame = Object.freeze({
      sessionId,
      revision: expectedRevision,
      projection,
    });
    this.publish(Object.freeze({ status: "ready", requestedRevision: expectedRevision, frame }));
    return "committed";
  }

  private publish(next: NativeRecipeWorkspaceSnapshot): void {
    if (this.snapshot === next) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
