import type { CanvasLod } from "./canvasPerformance";
import type { CanvasWorldRectangle } from "./canvasConnectionPresentation";

export type CanvasDetailPreference = "auto" | "full" | "classic" | "medium" | "minimal";
export type CanvasDetailStage = "full" | "medium" | "compact";
export type CanvasCompactCardStyle = "classic" | "minimal";
export type CanvasOverlapPreference = "marker" | "representative" | "all";
export type CanvasInteractionDetailPreference = "selected" | "hover" | "base";

export const CANVAS_DETAIL_MEDIUM_ENTER_VISIBLE = 140;
export const CANVAS_DETAIL_MEDIUM_EXIT_VISIBLE = 100;
export const CANVAS_DETAIL_COMPACT_ENTER_VISIBLE = 480;
export const CANVAS_DETAIL_COMPACT_EXIT_VISIBLE = 360;
export const CANVAS_STACK_ENTER_PX = 12;
export const CANVAS_STACK_EXIT_PX = 18;
export const CANVAS_STACK_PROXY_WIDTH = 96;
export const CANVAS_STACK_PROXY_HEIGHT = 32;
export const CANVAS_STACK_MARKER_WIDTH = 88;
export const CANVAS_STACK_MARKER_HEIGHT = 44;
export const CANVAS_FULL_ALL_MEDIUM_SAFETY_VISIBLE = 480;
export const CANVAS_FULL_ALL_COMPACT_SAFETY_VISIBLE = 1_000;

export function resolveCanvasFullAllSafetyStage(
  detailPreference: CanvasDetailPreference,
  overlapPreference: CanvasOverlapPreference,
  visibleNodeCount: number,
): CanvasDetailStage | null {
  if (detailPreference !== "full" || overlapPreference !== "all") return null;
  if (visibleNodeCount > CANVAS_FULL_ALL_COMPACT_SAFETY_VISIBLE) return "compact";
  if (visibleNodeCount > CANVAS_FULL_ALL_MEDIUM_SAFETY_VISIBLE) return "medium";
  return null;
}

export interface CanvasDensityNode {
  id: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
}

export interface CanvasStackPresentation {
  groupId: string | null;
  /** Short group-wide identity computed once, never by rescanning members per node. */
  membershipToken: string;
  memberIds: readonly string[];
  count: number;
  hidden: boolean;
  /** The sole lightweight, visible group marker used instead of a representative card. */
  marker: boolean;
  halo: boolean;
  alertCount: number;
  criticalAlertCount: number;
}

export interface CanvasStackGrouping {
  byNodeId: ReadonlyMap<string, CanvasStackPresentation>;
  membership: ReadonlyMap<string, string>;
  groupCount: number;
  hiddenCount: number;
  markerCount: number;
}

function finiteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

export function canvasNodeIntersectsWorldRectangle(node: CanvasDensityNode, rectangle: CanvasWorldRectangle): boolean {
  const width = Math.max(1, finiteOr(node.width, 360));
  const height = Math.max(1, finiteOr(node.height, 260));
  const x = finiteOr(node.x, 0);
  const y = finiteOr(node.y, 0);
  return x <= rectangle.right && x + width >= rectangle.left && y <= rectangle.bottom && y + height >= rectangle.top;
}

/** Counts raw logical nodes intersecting the viewport; grouping never lowers the pressure signal. */
export function countVisibleCanvasNodes(nodes: readonly CanvasDensityNode[], rectangle: CanvasWorldRectangle): number {
  let visible = 0;
  for (const node of nodes) if (canvasNodeIntersectsWorldRectangle(node, rectangle)) visible += 1;
  return visible;
}

export function resolveCanvasDetailStage(
  preference: CanvasDetailPreference,
  visibleCount: number,
  previous: CanvasDetailStage = "full",
): CanvasDetailStage {
  if (preference === "full") return "full";
  if (preference === "medium") return "medium";
  if (preference === "classic" || preference === "minimal") return "compact";
  const count = Math.max(0, Math.floor(Number.isFinite(visibleCount) ? visibleCount : 0));
  if (previous === "compact") {
    if (count >= CANVAS_DETAIL_COMPACT_EXIT_VISIBLE) return "compact";
    return count >= CANVAS_DETAIL_MEDIUM_EXIT_VISIBLE ? "medium" : "full";
  }
  if (previous === "medium") {
    if (count >= CANVAS_DETAIL_COMPACT_ENTER_VISIBLE) return "compact";
    return count < CANVAS_DETAIL_MEDIUM_EXIT_VISIBLE ? "full" : "medium";
  }
  if (count >= CANVAS_DETAIL_COMPACT_ENTER_VISIBLE) return "compact";
  return count >= CANVAS_DETAIL_MEDIUM_ENTER_VISIBLE ? "medium" : "full";
}

export function canvasDetailStageLod(stage: CanvasDetailStage): CanvasLod {
  return stage;
}

export function canvasDetailProgress(stage: CanvasDetailStage, visibleCount: number): {
  lower: number;
  upper: number | null;
  ratio: number;
} {
  const count = Math.max(0, Math.floor(Number.isFinite(visibleCount) ? visibleCount : 0));
  if (stage === "full") return {
    lower: 0,
    upper: CANVAS_DETAIL_MEDIUM_ENTER_VISIBLE,
    ratio: Math.min(1, count / CANVAS_DETAIL_MEDIUM_ENTER_VISIBLE),
  };
  if (stage === "medium") return {
    lower: CANVAS_DETAIL_MEDIUM_EXIT_VISIBLE,
    upper: CANVAS_DETAIL_COMPACT_ENTER_VISIBLE,
    ratio: Math.min(1, Math.max(0, (count - CANVAS_DETAIL_MEDIUM_EXIT_VISIBLE) /
      (CANVAS_DETAIL_COMPACT_ENTER_VISIBLE - CANVAS_DETAIL_MEDIUM_EXIT_VISIBLE))),
  };
  return { lower: CANVAS_DETAIL_COMPACT_EXIT_VISIBLE, upper: null, ratio: 1 };
}

interface MutableStackGroup {
  id: string;
  anchorX: number;
  anchorY: number;
  memberIds: string[];
}

const EMPTY_STACK_MEMBER_IDS: readonly string[] = Object.freeze([]);

function stackMembershipToken(memberIds: readonly string[]): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (const id of memberIds) {
    for (let index = 0; index < id.length; index += 1) {
      const code = id.charCodeAt(index);
      first = Math.imul(first ^ code, 0x01000193);
      second = Math.imul(second ^ code, 0x85ebca6b);
    }
    first = Math.imul(first ^ 0xff, 0x01000193);
    second = Math.imul(second ^ 0xff, 0xc2b2ae35);
  }
  return `${memberIds[0] ?? "empty"}:${memberIds.length}:${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
}

/**
 * Groups only near-identical screen positions. A fixed-size spatial hash keeps
 * the pass linear for dense anonymous fixtures; protected interaction targets
 * remain rendered and become the group's presentation leader(s).
 */
export function groupCanvasNodeStacks(
  nodes: readonly CanvasDensityNode[],
  zoom: number,
  protectedIds: ReadonlySet<string> = new Set(),
  previousMembership: ReadonlyMap<string, string> = new Map(),
  alertIds: ReadonlySet<string> = new Set(),
  criticalAlertIds: ReadonlySet<string> = new Set(),
  overlapPreference: CanvasOverlapPreference = "representative",
): CanvasStackGrouping {
  const normalizedZoom = Math.max(0.05, Number.isFinite(zoom) ? zoom : 1);
  const enterDistance = CANVAS_STACK_ENTER_PX / normalizedZoom;
  const exitDistance = CANVAS_STACK_EXIT_PX / normalizedZoom;
  const cellSize = exitDistance;
  const cells = new Map<string, MutableStackGroup[]>();
  const groups: MutableStackGroup[] = [];
  const keyFor = (x: number, y: number) => `${Math.floor(x / cellSize)}:${Math.floor(y / cellSize)}`;

  for (const node of nodes) {
    const x = finiteOr(node.x, 0);
    const y = finiteOr(node.y, 0);
    const cellX = Math.floor(x / cellSize);
    const cellY = Math.floor(y / cellSize);
    let match: MutableStackGroup | null = null;
    let matchDistance = Number.POSITIVE_INFINITY;
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (const group of cells.get(`${cellX + offsetX}:${cellY + offsetY}`) ?? []) {
          const distance = Math.hypot(x - group.anchorX, y - group.anchorY);
          const threshold = previousMembership.get(node.id) === group.id ? exitDistance : enterDistance;
          if (distance <= threshold && distance < matchDistance) {
            match = group;
            matchDistance = distance;
          }
        }
      }
    }
    if (!match) {
      match = { id: node.id, anchorX: x, anchorY: y, memberIds: [] };
      groups.push(match);
      const key = keyFor(x, y);
      const bucket = cells.get(key);
      if (bucket) bucket.push(match);
      else cells.set(key, [match]);
    }
    match.memberIds.push(node.id);
  }

  const byNodeId = new Map<string, CanvasStackPresentation>();
  const membership = new Map<string, string>();
  let groupCount = 0;
  let hiddenCount = 0;
  let markerCount = 0;
  for (const group of groups) {
    const membershipToken = stackMembershipToken(group.memberIds);
    for (const id of group.memberIds) membership.set(id, group.id);
    if (group.memberIds.length < 2) {
      const id = group.memberIds[0];
      if (id) byNodeId.set(id, {
        groupId: null,
        membershipToken,
        memberIds: group.memberIds,
        count: 1,
        hidden: false,
        marker: false,
        halo: false,
        alertCount: 0,
        criticalAlertCount: 0,
      });
      continue;
    }
    groupCount += 1;
    const activeIds = group.memberIds.filter((id) => protectedIds.has(id));
    const leaders = new Set(overlapPreference === "all"
      ? group.memberIds
      : activeIds.length > 0 ? activeIds : [group.memberIds[0]]);
    const haloId = activeIds[0] ?? group.memberIds[0];
    const markerId = overlapPreference === "marker" && activeIds.length === 0 ? haloId : null;
    if (markerId) markerCount += 1;
    const alertCount = group.memberIds.reduce((count, id) => count + (alertIds.has(id) ? 1 : 0), 0);
    const criticalAlertCount = group.memberIds.reduce((count, id) => count + (criticalAlertIds.has(id) ? 1 : 0), 0);
    for (const id of group.memberIds) {
      const hidden = !leaders.has(id);
      if (hidden) hiddenCount += 1;
      byNodeId.set(id, {
        groupId: group.id,
        membershipToken,
        // Only the single halo/marker owns the member list. Expanded and
        // protected siblings never retain a copy, keeping the derivation O(N).
        memberIds: id === haloId ? group.memberIds : EMPTY_STACK_MEMBER_IDS,
        count: group.memberIds.length,
        hidden,
        marker: id === markerId,
        halo: id === haloId,
        alertCount: id === haloId ? alertCount : 0,
        criticalAlertCount: id === haloId ? criticalAlertCount : 0,
      });
    }
  }
  return { byNodeId, membership, groupCount, hiddenCount, markerCount };
}
