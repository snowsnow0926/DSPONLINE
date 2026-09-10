// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCanvasKeyboardPan } from "./useCanvasKeyboardPan";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("WASD viewport navigation", () => {
  let root: Root;
  let host: HTMLDivElement;
  let frames: Map<number, FrameRequestCallback>;
  let nextId: number;
  let viewport: { x: number; y: number; zoom: number };
  let enabled: boolean;
  const tick = (time: number) => act(() => {
    const pending = [...frames.values()]; frames.clear(); pending.forEach((frame) => frame(time));
  });
  const key = (type: "keydown" | "keyup", code: string, extra: KeyboardEventInit = {}, target: EventTarget = window) =>
    act(() => target.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true, cancelable: true, ...extra })));
  beforeEach(() => {
    frames = new Map(); nextId = 0; viewport = { x: 0, y: 0, zoom: 0.5 }; enabled = true;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++nextId, callback); return nextId; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    function Harness() {
      useCanvasKeyboardPan({ enabled: () => enabled, getViewport: () => viewport, setViewport: (next) => { viewport = next; } });
      return <input aria-label="name" />;
    }
    act(() => root.render(<Harness />));
  });
  afterEach(() => { act(() => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); });

  it("moves the camera at zoom-independent speed and stops on keyup", () => {
    key("keydown", "KeyD"); tick(0); tick(20);
    expect(viewport).toEqual({ x: -14, y: 0, zoom: 0.5 });
    key("keyup", "KeyD"); tick(40);
    expect(viewport.x).toBe(-14); expect(frames.size).toBe(0);
  });
  it("normalizes diagonals and does not accelerate on repeated keyboard events", () => {
    key("keydown", "KeyW"); key("keydown", "KeyD"); key("keydown", "KeyD", { repeat: true });
    expect(frames.size).toBe(1); tick(0); tick(20);
    expect(Math.hypot(viewport.x, viewport.y)).toBeCloseTo(14);
    expect(viewport.y).toBeGreaterThan(0);
  });
  it("keeps typing, IME composition and browser shortcuts out of the viewport", () => {
    const input = host.querySelector("input")!;
    input.focus(); key("keydown", "KeyW", {}, input); tick(0); tick(20);
    input.blur(); key("keydown", "KeyA", { ctrlKey: true }); key("keydown", "KeyS", { metaKey: true });
    key("keydown", "KeyD", { isComposing: true });
    expect(viewport.x).toBe(0); expect(viewport.y).toBe(0); expect(frames.size).toBe(0);
  });
  it("cancels a held key when focus is lost or a dialog/gesture takes over", () => {
    key("keydown", "KeyW"); tick(0); tick(20);
    window.dispatchEvent(new Event("blur")); tick(40); expect(viewport.y).toBe(14);
    key("keydown", "KeyW"); tick(50);
    const dialog = document.createElement("div"); dialog.setAttribute("role", "dialog"); document.body.append(dialog);
    tick(70); expect(frames.size).toBe(0); dialog.remove();
    key("keydown", "KeyA"); tick(80); enabled = false; tick(100);
    expect(viewport.x).toBe(0); expect(frames.size).toBe(0);
  });
});
