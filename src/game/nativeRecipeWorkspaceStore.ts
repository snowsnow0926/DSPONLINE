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

export interface NativeRecipeWorkspaceIdentity {
  readonly sessionId: string;
  readonly runId: string;
  readonly revision: number;
  readonly registryFingerprint: string;
}

export interface NativeRecipeWorkspaceSource {
  readonly boundIdentity: NativeRecipeWorkspaceIdentity;
  readVerifiedRecipeWorkspaceProjection(
    selector: RecipeWorkspaceSelector,
  ): Promise<DesktopNativeCoreRecipeWorkspaceProjectionResult | null>;
}

export type NativeRecipeWorkspaceRefreshResult = "committed" | "superseded" | "unavailable";

const LOGICAL_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const EMPTY_SNAPSHOT: NativeRecipeWorkspaceSnapshot = Object.freeze({
  status: "empty",
  requestedRevision: null,
  frame: null,
});

function validLogicalId(value: string | null | undefined, maximum = 256): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum && LOGICAL_ID_PATTERN.test(value);
}

function validIdentity(identity: NativeRecipeWorkspaceIdentity): boolean {
  return validLogicalId(identity.sessionId, 128) && validLogicalId(identity.runId, 128) &&
    Number.isSafeInteger(identity.revision) && identity.revision >= 0 &&
    validLogicalId(identity.registryFingerprint);
}

function sameScope(left: NativeRecipeWorkspaceIdentity, right: NativeRecipeWorkspaceIdentity): boolean {
  return left.sessionId === right.sessionId && left.runId === right.runId &&
    left.registryFingerprint === right.registryFingerprint;
}

function exactIdentity(left: NativeRecipeWorkspaceIdentity, right: NativeRecipeWorkspaceIdentity): boolean {
  return sameScope(left, right) && left.revision === right.revision;
}

function selectorKey(selector: RecipeWorkspaceSelector): string {
  return JSON.stringify([selector.itemIds, selector.selectedItemId]);
}

function requestKey(identity: NativeRecipeWorkspaceIdentity, selector: RecipeWorkspaceSelector): string {
  return `${identity.sessionId}\u0000${identity.runId}\u0000${identity.revision}\u0000${identity.registryFingerprint}\u0000${selectorKey(selector)}`;
}

export function createNativePlayerAuthorityRecipeWorkspaceProjectionSource(
  bridge: Pick<DesktopBridge, "getNativeCoreRecipeWorkspaceProjection"> | null,
  identity: NativeRecipeWorkspaceIdentity,
): NativeRecipeWorkspaceSource | null {
  const readProjection = bridge?.getNativeCoreRecipeWorkspaceProjection;
  if (!validIdentity(identity) || typeof readProjection !== "function") return null;
  const boundIdentity = Object.freeze({ ...identity });
  return Object.freeze({
    boundIdentity,
    async readVerifiedRecipeWorkspaceProjection(
      selector: RecipeWorkspaceSelector,
    ) {
      if (!validRecipeWorkspaceSelector(selector)) return null;
      try {
        const result = await readProjection({
          sessionId: boundIdentity.sessionId,
          runId: boundIdentity.runId,
          expectedRevision: boundIdentity.revision,
          expectedRegistryFingerprint: boundIdentity.registryFingerprint,
          itemIds: [...selector.itemIds],
          selectedItemId: selector.selectedItemId,
          location: null,
        });
        return result.revision === boundIdentity.revision &&
          result.registryFingerprint === boundIdentity.registryFingerprint &&
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

export function selectNativeRecipeWorkspaceFrame(
  snapshot: NativeRecipeWorkspaceSnapshot,
  identity: NativeRecipeWorkspaceIdentity,
  selector: RecipeWorkspaceSelector,
): NativeRecipeWorkspaceFrame | null {
  const frame = snapshot.frame;
  if (!frame || !sameScope(frame, identity) || frame.revision > identity.revision ||
      !recipeWorkspaceSelectorsEqual(
        {
          itemIds: frame.projection.request.itemIds as RecipeWorkspaceSelector["itemIds"],
          selectedItemId: frame.projection.request.selectedItemId as RecipeWorkspaceSelector["selectedItemId"],
        },
        selector,
      ) || snapshot.requestedRevision !== null && identity.revision < snapshot.requestedRevision) return null;
  if (snapshot.status === "ready" && frame.revision === identity.revision) return frame;
  return snapshot.status === "ready" || snapshot.status === "loading" || snapshot.status === "unavailable"
    ? frame
    : null;
}

export class NativeRecipeWorkspaceStore {
  private snapshot: NativeRecipeWorkspaceSnapshot = EMPTY_SNAPSHOT;
  private requestToken = 0;
  private currentKey: string | null = null;
  private flight: {
    readonly key: string;
    readonly promise: Promise<NativeRecipeWorkspaceRefreshResult>;
  } | null = null;
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): NativeRecipeWorkspaceSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  clear(): void {
    this.requestToken += 1;
    this.currentKey = null;
    this.flight = null;
    this.publish(EMPTY_SNAPSHOT);
  }

  refresh(
    source: NativeRecipeWorkspaceSource,
    identity: NativeRecipeWorkspaceIdentity,
    selector: RecipeWorkspaceSelector,
  ): Promise<NativeRecipeWorkspaceRefreshResult> {
    if (!validIdentity(identity) || !exactIdentity(source.boundIdentity, identity) ||
        !validRecipeWorkspaceSelector(selector)) {
      this.clear();
      return Promise.resolve("unavailable");
    }
    const key = requestKey(identity, selector);
    if (this.flight?.key === key) return this.flight.promise;
    if (this.snapshot.status === "ready" && this.snapshot.frame &&
        exactIdentity(this.snapshot.frame, identity) &&
        recipeWorkspaceSelectorsEqual(
          {
            itemIds: this.snapshot.frame.projection.request.itemIds as RecipeWorkspaceSelector["itemIds"],
            selectedItemId: this.snapshot.frame.projection.request.selectedItemId as RecipeWorkspaceSelector["selectedItemId"],
          },
          selector,
        )) return Promise.resolve("committed");
    const token = ++this.requestToken;
    this.currentKey = key;
    const previousFrame = this.snapshot.frame && sameScope(this.snapshot.frame, identity) &&
        this.snapshot.frame.revision <= identity.revision &&
        identity.revision >= (this.snapshot.requestedRevision ?? this.snapshot.frame.revision) &&
        recipeWorkspaceSelectorsEqual(
          {
            itemIds: this.snapshot.frame.projection.request.itemIds as RecipeWorkspaceSelector["itemIds"],
            selectedItemId: this.snapshot.frame.projection.request.selectedItemId as RecipeWorkspaceSelector["selectedItemId"],
          },
          selector,
        )
      ? this.snapshot.frame
      : null;
    this.publish(Object.freeze({ status: "loading", requestedRevision: identity.revision, frame: previousFrame }));
    const promise = this.performRefresh(source, identity, selector, key, token);
    this.flight = { key, promise };
    void promise.finally(() => {
      if (this.flight?.promise === promise) this.flight = null;
    });
    return promise;
  }

  private async performRefresh(
    source: NativeRecipeWorkspaceSource,
    identity: NativeRecipeWorkspaceIdentity,
    selector: RecipeWorkspaceSelector,
    key: string,
    token: number,
  ): Promise<NativeRecipeWorkspaceRefreshResult> {
    const projection = await source.readVerifiedRecipeWorkspaceProjection(selector);
    if (token !== this.requestToken || key !== this.currentKey) return "superseded";
    if (!projection || projection.schemaVersion !== 1 || projection.projectionType !== "recipe-workspace-v1" ||
        projection.revision !== identity.revision ||
        projection.registryFingerprint !== identity.registryFingerprint) {
      this.publish(Object.freeze({
        status: "unavailable",
        requestedRevision: identity.revision,
        frame: this.snapshot.frame,
      }));
      return "unavailable";
    }
    const frame: NativeRecipeWorkspaceFrame = Object.freeze({
      ...identity,
      projection,
    });
    this.publish(Object.freeze({ status: "ready", requestedRevision: identity.revision, frame }));
    return "committed";
  }

  private publish(next: NativeRecipeWorkspaceSnapshot): void {
    if (this.snapshot === next) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
