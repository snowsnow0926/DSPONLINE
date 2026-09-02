/// <reference lib="webworker" />

import {
  CANVAS_BELT_RENDER_PROTOCOL_VERSION,
  configureCanvasBeltSurface,
  paintCanvasBeltLayer,
  type CanvasBeltRenderGeometry,
  type CanvasBeltWorkerRequest,
  type CanvasBeltWorkerResponse,
} from "./canvasBeltRenderer";

const scope = self as DedicatedWorkerGlobalScope;
let canvas: OffscreenCanvas | null = null;
let context: OffscreenCanvasRenderingContext2D | null = null;
let geometry: CanvasBeltRenderGeometry | null = null;
let topologyRevision = -1;

function post(value: CanvasBeltWorkerResponse): void {
  scope.postMessage(value);
}

scope.onmessage = (event: MessageEvent<CanvasBeltWorkerRequest>) => {
  const message = event.data;
  if (!message || message.protocolVersion !== CANVAS_BELT_RENDER_PROTOCOL_VERSION) {
    post({ kind: "unavailable", protocolVersion: CANVAS_BELT_RENDER_PROTOCOL_VERSION, code: "PROTOCOL_INVALID" });
    return;
  }
  if (message.kind === "init") {
    canvas = message.canvas;
    context = canvas.getContext("2d");
    if (!context) {
      post({ kind: "unavailable", protocolVersion: CANVAS_BELT_RENDER_PROTOCOL_VERSION, code: "CONTEXT_UNAVAILABLE" });
      return;
    }
    canvas.addEventListener("contextlost", () => {
      post({ kind: "unavailable", protocolVersion: CANVAS_BELT_RENDER_PROTOCOL_VERSION, code: "CONTEXT_LOST" });
    }, { once: true });
    return;
  }
  if (message.kind === "topology") {
    if (message.positions.length % 4 !== 0 ||
        message.routeCenters.length * 4 !== message.positions.length ||
        message.routeModes.length !== message.routeCenters.length ||
        message.colors.length !== message.routeCenters.length) {
      post({ kind: "unavailable", protocolVersion: CANVAS_BELT_RENDER_PROTOCOL_VERSION, code: "PROTOCOL_INVALID" });
      return;
    }
    topologyRevision = message.revision;
    geometry = {
      positions: message.positions,
      routeCenters: message.routeCenters,
      routeModes: message.routeModes,
      colors: message.colors,
    };
    return;
  }
  if (message.kind !== "frame" || !canvas || !context || !geometry ||
      message.revision !== topologyRevision || !Number.isSafeInteger(message.sequence) || message.sequence < 1) {
    post({ kind: "unavailable", protocolVersion: CANVAS_BELT_RENDER_PROTOCOL_VERSION, code: "PROTOCOL_INVALID" });
    return;
  }
  const startedAt = performance.now();
  configureCanvasBeltSurface(canvas, context, message.surface);
  const result = paintCanvasBeltLayer(
    context,
    geometry,
    message.candidateIndexes,
    message.viewport,
    message.surface,
    "topology",
  );
  post({
    kind: "frame-complete",
    protocolVersion: CANVAS_BELT_RENDER_PROTOCOL_VERSION,
    sequence: message.sequence,
    revision: message.revision,
    durationMs: performance.now() - startedAt,
    ...result,
  });
};

export {};
