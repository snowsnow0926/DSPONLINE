import type { ContentPackRegistry } from "./contentPacks";
import {
  finalizePureIdleMacroCandidate,
  summarizePureIdleMacroSession,
  type PureIdleMacroOperationOptions,
  type PureIdleMacroSession,
  type PureIdleMacroSummary,
} from "./pureIdleMacro";
import { inspectSave, serializeEnvelope } from "./storage";
import type { GameState } from "./types";

export type PureIdleCandidateValidation =
  | { ok: true; state: GameState; rawBytes: number }
  | { ok: false; failure: string };

function rawByteLength(raw: string): number {
  try {
    return new TextEncoder().encode(raw).byteLength;
  } catch {
    return raw.length;
  }
}

/** Non-Worker compatibility gate used by direct tests and diagnostic callers. */
export function validatePureIdleCandidate(
  candidate: GameState,
  contentPackRegistry: ContentPackRegistry,
): PureIdleCandidateValidation {
  try {
    const raw = serializeEnvelope(candidate, Date.now(), "primary", undefined, contentPackRegistry);
    const inspection = inspectSave(raw, contentPackRegistry);
    if (!inspection.valid || !inspection.state) {
      return { ok: false, failure: inspection.issues[0] ?? "候选存档无法通过正式重载校验" };
    }
    return { ok: true, state: inspection.state, rawBytes: rawByteLength(raw) };
  } catch (error) {
    return { ok: false, failure: error instanceof Error ? error.message : "候选存档序列化失败" };
  }
}

export function finalizePureIdleMacroSession(
  session: PureIdleMacroSession,
  targetWallSeconds: number,
  contentPackRegistry: ContentPackRegistry,
  options: PureIdleMacroOperationOptions = {},
): { state: GameState; summary: PureIdleMacroSummary; rawBytes: number } {
  const candidate = finalizePureIdleMacroCandidate(session, targetWallSeconds, options);
  const validation = validatePureIdleCandidate(candidate.state, contentPackRegistry);
  if (!validation.ok) {
    session.phase = "failed";
    throw new Error(`纯挂机候选存档未通过重载校验：${validation.failure}`);
  }
  session.candidate = validation.state;
  const summary = summarizePureIdleMacroSession(session);
  return { state: validation.state, summary, rawBytes: validation.rawBytes };
}
