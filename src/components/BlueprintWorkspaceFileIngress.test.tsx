// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createInitialState } from "../game/engine";
import { NATIVE_BLUEPRINT_IMPORT_RAW_BYTES } from "../game/nativeBlueprintImportInput";
import {
  createWebFactoryConstructionHeadlineReadModel,
  createWebFactoryConstructionWorkspaceReadModel,
} from "../game/webFactoryReadModelAdapter";
import { GameDialogProvider } from "./GameDialogProvider";
import { BlueprintWorkspace } from "./BlueprintWorkspace";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const noop = () => undefined;

function fakeFile(bytes: Uint8Array, reportedSize = bytes.byteLength): File {
  return {
    size: reportedSize,
    arrayBuffer: vi.fn(async () => bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer),
  } as unknown as File;
}

async function chooseFile(input: HTMLInputElement, file: File): Promise<void> {
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("BlueprintWorkspace Web file ingress", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("does not call onImport until file size, arrayBuffer, fatal UTF-8, and exact bytes pass", async () => {
    const game = createInitialState();
    const onImport = vi.fn(() => ({ success: false, message: "测试导入" }));
    act(() => root.render(<GameDialogProvider><BlueprintWorkspace
      open
      game={game}
      factoryHeadlineReadModel={createWebFactoryConstructionHeadlineReadModel(game)}
      constructionReadModel={createWebFactoryConstructionWorkspaceReadModel(game)}
      onClose={noop}
      onDeploy={noop}
      onRemove={noop}
      onRename={noop}
      onTransform={noop}
      onRecipeOverride={noop}
      onFundQueue={noop}
      onFundAllQueues={noop}
      onCancelQueue={noop}
      onExport={noop}
      onImport={onImport}
    /></GameDialogProvider>));

    const input = host.querySelector("[aria-label='选择要导入的蓝图文件']") as HTMLInputElement;
    const metadataOversized = fakeFile(new Uint8Array([0x7b, 0x7d]), NATIVE_BLUEPRINT_IMPORT_RAW_BYTES + 1);
    await chooseFile(input, metadataOversized);
    expect(metadataOversized.arrayBuffer).not.toHaveBeenCalled();
    expect(onImport).not.toHaveBeenCalled();

    await chooseFile(input, fakeFile(new Uint8Array([0xc3, 0x28])));
    expect(onImport).not.toHaveBeenCalled();

    const bytes = new TextEncoder().encode('{"type":"dsp-idle-blueprint"}');
    await chooseFile(input, fakeFile(bytes));
    expect(onImport).toHaveBeenCalledOnce();
    expect(onImport).toHaveBeenCalledWith('{"type":"dsp-idle-blueprint"}');
  });
});
