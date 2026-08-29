import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("native factory interaction App wiring", () => {
  it("pins selection and connection IDs into the exact native viewport atom", () => {
    const app = readFileSync(resolve("src/App.tsx"), "utf8");

    expect(app).toMatch(/selectNativeFactorySelectionRelatedEntityIds\(nativeFactoryThinViewSnapshot,[\s\S]*?sessionId: nativePlayerAuthorityActiveFrame\?\.sessionId \?\? null,[\s\S]*?revision: factoryThinViewExpectedRevision/);
    expect(app).toMatch(/connectionEntityIds: factoryInteractionConnectionEntityIds/);
    expect(app).toMatch(/createNativeFactoryInteractionPinRequest\(\{[\s\S]*?relatedEntityIds: factoryThinViewRelatedEntityIds/);
    expect(app).toMatch(/requestedPinnedEntityIds: factoryViewportPinnedEntityIds/);
    expect(app).toMatch(/requestedPinnedBeltIds: factoryViewportPinnedBeltIds/);
    expect(app).toMatch(/requestTruncated:\s*factoryInteractionPinRequest\.truncated/);
  });

  it("selects one native interaction atom before lazily touching Web arrays", () => {
    const app = readFileSync(resolve("src/App.tsx"), "utf8");
    const interactionBlock = app.slice(
      app.indexOf("const factoryInteractionRows = useMemo("),
      app.indexOf("const dockBeltTier =", app.indexOf("const factoryInteractionRows = useMemo(")),
    );

    expect(interactionBlock).toMatch(/selectFactoryInteractionRows\([\s\S]*?nativeAuthoritativeFactoryInteractionRows,[\s\S]*?\(\) => createWebFactoryInteractionRows\(game/);
    expect(interactionBlock).toMatch(/const selectedEntities = factoryInteractionRows\.selectedEntities/);
    expect(interactionBlock).toMatch(/const selectedEntity = factoryInteractionRows\.selectedEntity/);
    expect(interactionBlock).toMatch(/const selectedBelt = factoryInteractionRows\.selectedBelt/);
    expect(interactionBlock).toMatch(/const selectedBelts = factoryInteractionRows\.selectedBelts/);
    expect(interactionBlock).not.toMatch(/game\.entities\.(?:find|filter)|game\.belts\.(?:find|filter)|canvasGame\.belts\.(?:find|filter)/);
    expect(interactionBlock).toMatch(/factoryInteractionRows\.source === "native-authoritative"[\s\S]*?factoryInteractionRows\.multiSelectionSummaryReadModel/);
    expect(interactionBlock).toMatch(/factoryInteractionRows\.source === "native-authoritative"[\s\S]*?factoryInteractionRows\.inspectorSummaryReadModel/);
    expect(interactionBlock).toMatch(/factoryInteractionRows\.source === "native-authoritative"[\s\S]*?factoryInteractionRows\.selectionToolbarReadModel/);
    expect(interactionBlock).not.toMatch(/factorySelectionReadGame|projectionEntities|projectionBelts/);
  });

  it("uses exact native rows for connection previews but revalidates commands on authority state", () => {
    const app = readFileSync(resolve("src/App.tsx"), "utf8");
    const readStateBlock = app.slice(
      app.indexOf("const getFactoryConnectionReadState = useCallback("),
      app.indexOf("const beginConnectionDraft = useCallback(", app.indexOf("const getFactoryConnectionReadState = useCallback(")),
    );
    const commitBlock = app.slice(
      app.indexOf("const onConnect = useCallback("),
      app.indexOf("useEffect(() => { connectRequestRef.current = onConnect;", app.indexOf("const onConnect = useCallback(")),
    );

    expect(readStateBlock).toMatch(/const frame = nativeAuthoritativeFactoryCanvasFrameRef\.current/);
    expect(readStateBlock).toMatch(/nativePlayerAuthorityOwnsRuntimeRef\.current[\s\S]*?!frame[\s\S]*?!frame\.entityById\.has\(sourceEntityId\)/);
    expect(readStateBlock).toMatch(/selectFactoryConnectionReadState\([\s\S]*?gameRef\.current,[\s\S]*?frame,/);
    expect(readStateBlock).toMatch(/sessionId: frame\?\.sessionId \?\? nativePlayerAuthorityActiveFrame\?\.sessionId \?\? null/);
    expect(readStateBlock).toMatch(/revision: frame\?\.revision \?\? factoryThinViewExpectedRevision/);
    expect(readStateBlock).toMatch(/planetId: frame\?\.planetId \?\? gameRef\.current\.activePlanetId/);
    expect(readStateBlock).toMatch(/nativePlayerAuthorityOwnsRuntimeRef\.current && frame && result\.entities !== frame\.entities/);
    expect(readStateBlock).toMatch(/const state = getFactoryConnectionReadState\(connection\.source, connection\.target\)/);
    expect(readStateBlock).not.toMatch(/gameRef\.current\.(?:entities|belts)\.(?:find|filter)/);

    expect(commitBlock).toMatch(/const before = gameRef\.current/);
    expect(commitBlock).toMatch(/connectBeltWithResult\(before, connection\.source, connection\.target/);
    expect(commitBlock).toMatch(/commitGame\(\(\) => result\.state\)/);
  });
});
