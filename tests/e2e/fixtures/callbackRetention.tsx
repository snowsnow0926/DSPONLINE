import React, { useLayoutEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useLongPress } from "../../../src/hooks/useLongPress";
import { useStableEventCallback } from "../../../src/hooks/useStableEventCallback";

type Kind = "stable-event" | "long-press";
type Payload = { revision: number; data: Uint8Array };
let firstPayload: WeakRef<Payload> | undefined;
let firstCallback: (() => number) | undefined;
let latestCallback: (() => number) | undefined;
let identityStable = true;
let revision = 0;
let kind: Kind = "stable-event";
const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);

function observe(payload: Payload, callback?: () => number) {
  firstPayload ??= new WeakRef(payload);
  if (callback) {
    firstCallback ??= callback;
    identityStable &&= firstCallback === callback;
    latestCallback = callback;
  }
}

function StableHarness({ revision }: { revision: number }) {
  const payload = useMemo<Payload>(() => ({ revision, data: new Uint8Array(1024 * 1024) }), [revision]);
  const callback = useStableEventCallback(() => payload.revision);
  useLayoutEffect(() => observe(payload, callback), [payload, callback]);
  return <button onClick={() => callback()}>current</button>;
}

function LongPressHarness({ revision }: { revision: number }) {
  const payload = useMemo<Payload>(() => ({ revision, data: new Uint8Array(1024 * 1024) }), [revision]);
  const bindings = useLongPress<HTMLDivElement>({
    getTarget: () => String(payload.revision),
    onLongPress: () => { document.body.dataset.lastLongPress = String(payload.revision); },
  });
  useLayoutEffect(() => observe(payload), [payload]);
  return <div {...bindings}>current</div>;
}

function render() {
  flushSync(() => root.render(kind === "stable-event"
    ? <StableHarness revision={revision} /> : <LongPressHarness revision={revision} />));
}

const probe = {
  mount(value: Kind) { kind = value; revision = 0; render(); },
  advance() { revision += 1; render(); },
  inspect() { return { initialPayloadAlive: firstPayload?.deref() !== undefined,
    identityStable, latestValue: latestCallback?.() ?? revision, retainedOriginalValue: firstCallback?.() ?? revision }; },
};
Object.assign(window, { __callbackRetention: probe });

declare global { interface Window { __callbackRetention: typeof probe; } }
