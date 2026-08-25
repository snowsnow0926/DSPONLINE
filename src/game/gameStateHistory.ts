import {
  applySimulationCommandPatch,
  createSimulationCommandPatch,
  invertSimulationCommandPatch,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";
import type { GameState } from "./types";

export const DEFAULT_GAME_HISTORY_LIMIT = 40;
export const DEFAULT_GAME_HISTORY_BYTE_LIMIT = 32 * 1024 * 1024;

export interface GameStateHistoryEntry {
  undo: SimulationCommandPatch;
  redo: SimulationCommandPatch;
  estimatedBytes: number;
}

export interface GameStateHistorySnapshot {
  undoCount: number;
  redoCount: number;
  estimatedBytes: number;
  entryLimit: number;
  byteLimit: number;
}

function estimatePatchPairBytes(undo: SimulationCommandPatch, redo: SimulationCommandPatch): number {
  // JSON is the durable command representation too, so its UTF-16 length is a
  // conservative browser-heap estimate without retaining a second string.
  return JSON.stringify([undo, redo]).length * 2;
}

/**
 * Bounded inverse-command history. It never retains a complete GameState.
 * Applying a command patch also canonicalizes an engine result back onto the
 * previous graph, so unchanged entity/belt records regain stable references.
 */
export class GameStateHistory {
  readonly #entryLimit: number;
  readonly #byteLimit: number;
  #undo: GameStateHistoryEntry[] = [];
  #redo: GameStateHistoryEntry[] = [];
  #estimatedBytes = 0;

  constructor(options: { entryLimit?: number; byteLimit?: number } = {}) {
    this.#entryLimit = Math.max(1, Math.floor(options.entryLimit ?? DEFAULT_GAME_HISTORY_LIMIT));
    this.#byteLimit = Math.max(1024, Math.floor(options.byteLimit ?? DEFAULT_GAME_HISTORY_BYTE_LIMIT));
  }

  get canUndo(): boolean {
    return this.#undo.length > 0;
  }

  get canRedo(): boolean {
    return this.#redo.length > 0;
  }

  record(previous: GameState, current: GameState): GameState | null {
    const redo = createSimulationCommandPatch(previous, current, 0);
    if (!redo) return null;
    const undo = invertSimulationCommandPatch(previous, redo, 0);
    const entry: GameStateHistoryEntry = {
      undo,
      redo,
      estimatedBytes: estimatePatchPairBytes(undo, redo),
    };
    this.#dropRedo();
    this.#undo.push(entry);
    this.#estimatedBytes += entry.estimatedBytes;
    this.#enforceLimits();
    return applySimulationCommandPatch(previous, redo);
  }

  undo(current: GameState): GameState | null {
    const entry = this.#undo.pop();
    if (!entry) return null;
    this.#redo.push(entry);
    return applySimulationCommandPatch(current, entry.undo);
  }

  redo(current: GameState): GameState | null {
    const entry = this.#redo.pop();
    if (!entry) return null;
    this.#undo.push(entry);
    return applySimulationCommandPatch(current, entry.redo);
  }

  clear(): void {
    this.#undo = [];
    this.#redo = [];
    this.#estimatedBytes = 0;
  }

  snapshot(): GameStateHistorySnapshot {
    return {
      undoCount: this.#undo.length,
      redoCount: this.#redo.length,
      estimatedBytes: this.#estimatedBytes,
      entryLimit: this.#entryLimit,
      byteLimit: this.#byteLimit,
    };
  }

  #dropRedo(): void {
    if (this.#redo.length === 0) return;
    for (const entry of this.#redo) this.#estimatedBytes -= entry.estimatedBytes;
    this.#redo = [];
  }

  #enforceLimits(): void {
    while (this.#undo.length > 1 && (this.#undo.length > this.#entryLimit || this.#estimatedBytes > this.#byteLimit)) {
      const removed = this.#undo.shift();
      if (removed) this.#estimatedBytes -= removed.estimatedBytes;
    }
  }
}
