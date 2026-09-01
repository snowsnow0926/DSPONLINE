import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("native special input port App integration", () => {
  const app = readFileSync(resolve("src/App.tsx"), "utf8");
  const inspector = readFileSync(
    resolve("src/components/NativeFactoryInspectorPanel.tsx"),
    "utf8",
  );

  it("commits only compact same-revision material delivery and orbital cargo intents", () => {
    const start = app.indexOf("const changeNativeMaterialDeliverySlot");
    const end = app.indexOf("const changeNativeEntityRecipe", start);
    const handlers = app.slice(start, end);
    expect(start).toBeGreaterThan(0);
    expect(handlers).toMatch(
      /nativeFactoryProjectionIdentityRef\.current[\s\S]*?nativePlayerAuthorityCommandBindingRef\.current/,
    );
    expect(handlers).toMatch(
      /commandSource\.sessionId !== binding\.sessionId[\s\S]*?commandSource\.baseRevision !== binding\.revision/,
    );
    expect(handlers).toMatch(
      /commitNativeProjectedCommand\(binding\.revision,[\s\S]*?createConfirmedNativeMaterialDeliverySlotCommand\(binding, slotIndex, mode, itemId\)/,
    );
    expect(handlers).toMatch(
      /commitNativeProjectedCommand\(binding\.revision,[\s\S]*?createConfirmedNativeOrbitalCargoPortClearCommand\(binding, portIndex\)/,
    );
    expect(handlers).not.toMatch(
      /gameRef\.current|commitGame|updateMaterialDeliverySlot|clearOrbitalCargoPort/,
    );
  });

  it("keeps destructive confirmation and the destruction ledger in the bounded thin inspector", () => {
    expect(inspector).toMatch(/data-native-material-delivery="semantic-intent-v1"/);
    expect(inspector).toMatch(/data-native-orbital-cargo-ports="semantic-intent-v1"/);
    expect(inspector).toMatch(/data-native-black-hole-paused="micro-black-hole-v1"/);
    expect(inspector).toMatch(/aria-label="微型黑洞累计销毁账本"/);
    expect(inspector).toMatch(/<AccessibleDialog[\s\S]*?确认特殊物流接口修改/);
    expect(inspector).toMatch(/onClick=\{confirmSpecialPortChange\}/);
    expect(app).toMatch(/onMaterialDeliverySlotChange=\{changeNativeMaterialDeliverySlot\}/);
    expect(app).toMatch(/onOrbitalCargoPortClear=\{clearNativeOrbitalCargoPort\}/);
  });
});
