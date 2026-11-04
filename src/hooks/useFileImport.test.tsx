/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFileImport } from "./useFileImport";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("local file import requests", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  function Harness(props: Parameters<typeof useFileImport<string>>[0]) {
    const request = useFileImport(props);
    return <><input type="file" onChange={request.onChange} /><output>{JSON.stringify(request.status)}</output></>;
  }

  async function choose(name: string | null) {
    const input = host.querySelector("input")!;
    Object.defineProperty(input, "files", { configurable: true, value: name ? [new File([name], name)] : [] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  }
  const status = () => JSON.parse(host.querySelector("output")!.textContent!);

  it("clears the preceding candidate before reading and waits for import inspection", async () => {
    const events: string[] = [];
    const inspection = deferred<void>();
    act(() => root.render(<Harness onStart={() => { events.push("clear"); }} read={async () => { events.push("read"); return "new"; }} onImport={async (value) => { events.push(value); await inspection.promise; }} />));
    await choose("save.json");
    expect(events).toEqual(["clear", "read", "new"]);
    expect(status()).toEqual({ kind: "reading" });
    await act(async () => inspection.resolve());
    expect(status()).toBeNull();
  });

  it("reports a rejected read without invoking the importer", async () => {
    const onImport = vi.fn();
    act(() => root.render(<Harness read={async () => { throw new Error("gzip 存档损坏或无法解压"); }} onImport={onImport} />));
    await choose("broken.gz");
    expect(status()).toEqual({ kind: "failed", detail: "gzip 存档损坏或无法解压" });
    expect(onImport).not.toHaveBeenCalled();
  });

  it("ignores an older read finishing after a newer selection", async () => {
    const first = deferred<string>();
    const onImport = vi.fn();
    act(() => root.render(<Harness read={(file) => file.name === "first" ? first.promise : Promise.resolve("second")} onImport={onImport} />));
    await choose("first"); await choose("second");
    await act(async () => first.resolve("first"));
    expect(onImport.mock.calls).toEqual([["second"]]);
    expect(status()).toBeNull();
  });

  it("discards a pending file when its picker is unmounted", async () => {
    const reading = deferred<string>();
    const onImport = vi.fn();
    act(() => root.render(<Harness read={() => reading.promise} onImport={onImport} />));
    await choose("pending");
    act(() => root.render(<div>another workspace</div>));
    await act(async () => reading.resolve("old selection"));
    expect(onImport).not.toHaveBeenCalled();
  });

  it("keeps a newer success when an older read rejects later", async () => {
    const first = deferred<string>();
    act(() => root.render(<Harness read={(file) => file.name === "first" ? first.promise : Promise.resolve("second")} onImport={() => undefined} />));
    await choose("first"); await choose("second");
    await act(async () => first.reject(new Error("old failure")));
    expect(status()).toBeNull();
  });

  it("does nothing when the chooser has no selected file", async () => {
    const read = vi.fn(); const onStart = vi.fn();
    act(() => root.render(<Harness read={read} onImport={() => undefined} onStart={onStart} />));
    await choose(null);
    expect(read).not.toHaveBeenCalled(); expect(onStart).not.toHaveBeenCalled(); expect(status()).toBeNull();
  });

  it("turns an inspection failure into visible state and allows a later successful retry", async () => {
    const onImport = vi.fn().mockRejectedValueOnce(new Error("inspection failed")).mockResolvedValueOnce(undefined);
    act(() => root.render(<Harness read={async () => "payload"} onImport={onImport} />));
    await choose("retry.json");
    expect(status()).toEqual({ kind: "failed", detail: "inspection failed" });
    await choose("retry.json");
    expect(status()).toBeNull(); expect(onImport).toHaveBeenCalledTimes(2);
  });
});
