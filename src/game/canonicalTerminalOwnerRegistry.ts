import type { GameState } from "./types";
import type { ContentPackRegistry } from "./contentPacks";
import type { AuthoritativeSaveSerializationResponse } from "./authoritativeSaveSerializationProtocol";

/** Same response boundary as a dedicated save Worker. No payload is persisted
 * here; the ordinary client still validates its proof and owns termination. */
export interface AuthoritativeSaveWorkerChannel {
  onmessage: ((event: MessageEvent<AuthoritativeSaveSerializationResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
}

export interface CanonicalTerminalSerializationOwner {
  supports(registry: ContentPackRegistry): boolean;
  claim(sourceIsCurrent: () => boolean): AuthoritativeSaveWorkerChannel;
  close(error?: Error): void;
}

// Kept independent from the decoder client: storage imports the serialization
// client inside Workers, and must not recursively bundle the decoder Worker.
const owners = new WeakMap<GameState, CanonicalTerminalSerializationOwner>();

export function registerCanonicalTerminalOwner(state: GameState, owner: CanonicalTerminalSerializationOwner): void {
  const previous = owners.get(state);
  if (previous && previous !== owner) previous.close();
  owners.set(state, owner);
}

export function discardCanonicalTerminalOwner(state: GameState, expectedOwner?: CanonicalTerminalSerializationOwner): void {
  const owner = owners.get(state);
  if (!owner || expectedOwner && owner !== expectedOwner) return;
  owners.delete(state);
  owner.close();
}

export function claimCanonicalTerminalOwner(
  state: GameState, registry: ContentPackRegistry, sourceIsCurrent: () => boolean,
): AuthoritativeSaveWorkerChannel | null {
  const owner = owners.get(state);
  if (!owner) return null;
  owners.delete(state);
  if (!owner.supports(registry)) { owner.close(); return null; }
  try { return owner.claim(sourceIsCurrent); }
  catch (error) { owner.close(); throw error; }
}
