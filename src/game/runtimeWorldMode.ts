export interface RuntimeWorldBuildModeInput {
  enabled?: string;
  shadow?: string;
  development: boolean;
}

export interface RuntimeWorldBuildMode {
  enabled: boolean;
  shadowEnabled: boolean;
}

/**
 * RuntimeWorld 2.0 is the default authority in every build. The old engine is
 * retained behind an explicit disable switch, while full Projection v2 shadow
 * comparison is limited to development or a deliberate diagnostic build.
 */
export function resolveRuntimeWorldBuildMode(input: RuntimeWorldBuildModeInput): RuntimeWorldBuildMode {
  return {
    enabled: input.enabled !== "false",
    shadowEnabled: input.shadow === "true" || input.development,
  };
}
