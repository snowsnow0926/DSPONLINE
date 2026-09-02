import { memo, useEffect, useRef, useState } from "react";
import { BlueprintPlacementCursor } from "./BlueprintWorkspace";
import { BuildingPlacementCursor, CargoCursor } from "./GamePanels";
import type { BlueprintDefinition, BuildingId, CargoStack, PlacementCount } from "../game/types";

export interface CanvasClickConnectionPreview {
  originX: number;
  originY: number;
  handleType: "source" | "target";
}

export type CanvasConnectionPreviewTone = "pending" | "valid" | "invalid";
export type CanvasConnectionHint = { label: string; tone: "ready" | "blocked" | "warning" };

interface CanvasInteractionOverlayProps {
  active: boolean;
  placement: BuildingId | null;
  nativePlacementLabel?: string | null;
  placementCount: PlacementCount;
  cargo: CargoStack | null;
  blueprint: BlueprintDefinition | null;
  ctrlHeld: boolean;
  clickConnectionPreview: CanvasClickConnectionPreview | null;
  clickConnectionTone: CanvasConnectionPreviewTone;
  clickConnectionSnapPoint: { x: number; y: number } | null;
  connectionHint: CanvasConnectionHint | null;
  onPointerPosition?: (point: { x: number; y: number }) => void;
}

function ClickConnectionPreview({ preview, pointer, tone }: {
  preview: CanvasClickConnectionPreview;
  pointer: { x: number; y: number };
  tone: CanvasConnectionPreviewTone;
}) {
  const reach = Math.max(48, Math.abs(pointer.x - preview.originX) * 0.42);
  const direction = preview.handleType === "source" ? 1 : -1;
  const path = `M${preview.originX} ${preview.originY} C${preview.originX + reach * direction} ${preview.originY} ${pointer.x - reach * direction} ${pointer.y} ${pointer.x} ${pointer.y}`;
  return (
    <svg className="factory-click-connection-preview" aria-hidden="true">
      <g className={`factory-connection-preview factory-connection-preview--${tone}`}>
        <path className="factory-connection-preview__halo" d={path} />
        <path className="factory-connection-preview__path" d={path} />
        <circle className="factory-connection-preview__target" cx={pointer.x} cy={pointer.y} r="7" />
      </g>
    </svg>
  );
}

/**
 * Pointer-following visuals live outside FactoryGame's React Flow subtree.
 * Pointer coordinates are kept local here so dragging a placement cursor does
 * not invalidate the expensive node/edge derivation in App.
 */
export const CanvasInteractionOverlay = memo(function CanvasInteractionOverlay({
  active,
  placement,
  nativePlacementLabel = null,
  placementCount,
  cargo,
  blueprint,
  ctrlHeld,
  clickConnectionPreview,
  clickConnectionTone,
  clickConnectionSnapPoint,
  connectionHint,
  onPointerPosition,
}: CanvasInteractionOverlayProps) {
  const [pointer, setPointer] = useState(() => ({
    x: typeof window === "undefined" ? 0 : window.innerWidth / 2,
    y: typeof window === "undefined" ? 0 : window.innerHeight / 2,
  }));
  const pointerRef = useRef(pointer);

  useEffect(() => {
    const update = (event: PointerEvent | DragEvent) => {
      const next = { x: event.clientX, y: event.clientY };
      pointerRef.current = next;
      onPointerPosition?.(next);
      if (active) setPointer(next);
    };
    window.addEventListener("pointermove", update);
    window.addEventListener("dragover", update);
    return () => {
      window.removeEventListener("pointermove", update);
      window.removeEventListener("dragover", update);
    };
  }, [active, onPointerPosition]);

  if (!active) return null;
  const previewPointer = clickConnectionSnapPoint ?? pointer;
  return <>
    {clickConnectionPreview ? <ClickConnectionPreview preview={clickConnectionPreview} pointer={previewPointer} tone={clickConnectionTone} /> : null}
    <BuildingPlacementCursor buildingId={cargo ? null : placement} count={placementCount} x={pointer.x} y={pointer.y} />
    {!cargo && !placement && nativePlacementLabel ? <div
      className="building-placement-cursor"
      data-native-placement-cursor="true"
      style={{ transform: `translate3d(${pointer.x + 16}px, ${pointer.y + 16}px, 0)` }}
    >
      <div className="building-placement-array" aria-hidden="true"><i>◆</i></div>
      <span>{nativePlacementLabel}</span>
      <strong>单栋 · Rust 复核</strong>
    </div> : null}
    <CargoCursor cargo={cargo} x={pointer.x} y={pointer.y} />
    {blueprint ? <BlueprintPlacementCursor blueprint={blueprint} x={pointer.x} y={pointer.y + (cargo ? 42 : 0)} /> : null}
    {connectionHint ? <div className={`connection-hint connection-hint--${connectionHint.tone}`} style={{ transform: `translate3d(${pointer.x + 18}px, ${pointer.y + 18}px, 0)` }}>{connectionHint.label}</div> : null}
    {placement && ctrlHeld ? <div className="continuous-placement-indicator" style={{ left: pointer.x + 18, top: pointer.y - 34 }}><span>Ctrl</span><b>连续扩建</b></div> : null}
  </>;
});
