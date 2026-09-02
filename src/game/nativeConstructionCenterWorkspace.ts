import type { NativeConstructionCenterWorkspaceReadModel } from "./factoryReadModels";
import type { NativeAuthoritativeFactoryWorkspaceFrame } from "./nativeFactoryWorkspaceFrame";

/** Exact identity atom consumed by the native read-only workspace. */
export interface NativeConstructionCenterWorkspaceFrame {
  readonly source: "native-authoritative";
  readonly sessionId: string;
  readonly runId: string;
  readonly revision: number;
  readonly activePlanetId: string;
  readonly workspace: NativeConstructionCenterWorkspaceReadModel;
}

export function selectNativeConstructionCenterWorkspaceFrame(
  frame: NativeAuthoritativeFactoryWorkspaceFrame | null,
): NativeConstructionCenterWorkspaceFrame | null {
  const workspace = frame?.constructionWorkspace.nativeCenterWorkspace;
  if (!frame || !workspace || workspace.activePlanetId !== frame.planetNavigation.activePlanetId ||
    workspace.activePlanetId !== frame.constructionWorkspace.activePlanetId ||
    frame.constructionWorkspace.revision !== frame.revision ||
    typeof workspace.writeAvailable !== "boolean") return null;
  return Object.freeze({
    source: "native-authoritative",
    sessionId: frame.sessionId,
    runId: frame.runId,
    revision: frame.revision,
    activePlanetId: workspace.activePlanetId,
    workspace,
  });
}
