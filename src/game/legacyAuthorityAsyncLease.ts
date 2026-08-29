export type LegacyAuthorityState = "bootstrap-pending" | "javascript" | "native";

export interface LegacyAuthorityAsyncLeaseFence {
  readonly authority: LegacyAuthorityState;
  readonly generation: number;
}

export interface LegacyAuthorityAsyncLeaseToken {
  readonly generation: number;
}

export function createLegacyAuthorityAsyncLeaseFence(
  authority: LegacyAuthorityState = "bootstrap-pending",
): LegacyAuthorityAsyncLeaseFence {
  return { authority, generation: 0 };
}

export function reconcileLegacyAuthorityAsyncLeaseFence(
  current: LegacyAuthorityAsyncLeaseFence,
  authority: LegacyAuthorityState,
): LegacyAuthorityAsyncLeaseFence {
  if (current.authority === authority) return current;
  if (current.generation === Number.MAX_SAFE_INTEGER) {
    throw new RangeError("legacy authority lease generation exhausted");
  }
  return { authority, generation: current.generation + 1 };
}

export function issueLegacyAuthorityAsyncLease(
  fence: LegacyAuthorityAsyncLeaseFence,
): LegacyAuthorityAsyncLeaseToken | null {
  return fence.authority === "javascript" ? { generation: fence.generation } : null;
}

export function canContinueLegacyAuthorityAsyncLease(
  token: LegacyAuthorityAsyncLeaseToken | null,
  fence: LegacyAuthorityAsyncLeaseFence,
): boolean {
  return token !== null && fence.authority === "javascript" && token.generation === fence.generation;
}

export function canCommitLegacyAuthorityAsyncLease(
  token: LegacyAuthorityAsyncLeaseToken | null,
  fence: LegacyAuthorityAsyncLeaseFence,
): boolean {
  return canContinueLegacyAuthorityAsyncLease(token, fence);
}
