import { expect, test, type Locator, type Page } from "@playwright/test";
import { selectSettingsCategory } from "./settings-helpers";

// Opt-in local acceptance coverage. Player saves are never checked into the
// repository and the source file is only read by the browser file picker.
const fixturePath = process.env.DSP_REAL_SAVE_FIXTURE;
const runMatrix = process.env.DSP_REAL_SAVE_CANVAS_MATRIX === "1";
const fixtureLabel = (process.env.DSP_REAL_SAVE_LABEL ?? "fixture").replace(/[^a-zA-Z0-9_-]/g, "-");

const DETAIL_KEY = "dsp-idle-network.ui.canvas-detail.v1";
const OVERLAP_KEY = "dsp-idle-network.ui.canvas-overlap.v1";
const INTERACTION_KEY = "dsp-idle-network.ui.canvas-interaction-detail.v1";

type DetailPreference = "auto" | "full" | "medium" | "minimal";
type OverlapPreference = "marker" | "representative" | "all";
type InteractionPreference = "selected" | "hover" | "base";

const detailLabels: Record<DetailPreference, string> = { auto: "自动", full: "完整", medium: "中等", minimal: "一行" };
const overlapLabels: Record<OverlapPreference, string> = { marker: "数量标记", representative: "代表卡片", all: "全部卡片" };
const interactionLabels: Record<InteractionPreference, string> = { selected: "仅选中", hover: "悬停也展开", base: "保持基础" };

async function setCanvasSettings(page: Page, preferences: {
  detail: DetailPreference;
  overlap: OverlapPreference;
  interaction: InteractionPreference;
}): Promise<void> {
  await page.getByLabel("打开设置").click();
  const settings = page.locator(".operations-workspace");
  await expect(settings).toBeVisible();
  await selectSettingsCategory(settings, "终局性能", "performance");
  // Collapse a potentially huge exact stack before increasing card detail.
  // Applying Full while the previous mode is All can otherwise transiently
  // mount thousands of heavy cards before the next preference click lands.
  await settings.getByRole("radiogroup", { name: "重叠建筑显示方式" })
    .getByRole("radio", { name: overlapLabels[preferences.overlap], exact: true }).click();
  await settings.getByRole("radiogroup", { name: "画布基础卡片" })
    .getByRole("radio", { name: detailLabels[preferences.detail], exact: true }).click();
  await settings.getByRole("radiogroup", { name: "交互卡片展开方式" })
    .getByRole("radio", { name: interactionLabels[preferences.interaction], exact: true }).click();
  await settings.getByRole("button", { name: "关闭运营中心" }).click();
  const shell = page.locator(".game-shell");
  await expect(shell).toHaveAttribute("data-canvas-detail-preference", preferences.detail);
  await expect(shell).toHaveAttribute("data-canvas-overlap-preference", preferences.overlap);
  await expect(shell).toHaveAttribute("data-canvas-interaction-detail-preference", preferences.interaction);
  await expect(settings).toBeHidden();
}

async function expectExpandedNodePainted(node: Locator): Promise<void> {
  await expect(node).toBeVisible();
  await expect(node).toHaveClass(/factory-flow-node--lod-full/);
  await expect.poll(() => node.evaluate((wrapper) => {
    const content = wrapper.querySelector<HTMLElement>('.factory-node[data-heavy-card="true"]');
    const flow = document.querySelector<HTMLElement>(".factory-canvas .react-flow");
    if (!content || !flow || !wrapper.isConnected) return { painted: false, hit: false };
    const bounds = content.getBoundingClientRect();
    const flowBounds = flow.getBoundingClientRect();
    const left = Math.max(bounds.left, flowBounds.left);
    const right = Math.min(bounds.right, flowBounds.right);
    const top = Math.max(bounds.top, flowBounds.top);
    const bottom = Math.min(bounds.bottom, flowBounds.bottom);
    const contentStyle = getComputedStyle(content);
    const wrapperStyle = getComputedStyle(wrapper);
    const painted = right - left >= 2 && bottom - top >= 2 && contentStyle.display !== "none" &&
      contentStyle.visibility !== "hidden" && Number(contentStyle.opacity) >= 0.95 && wrapperStyle.display !== "none" &&
      wrapperStyle.visibility !== "hidden" && Number(wrapperStyle.opacity) >= 0.95;
    let hit = false;
    if (painted) {
      // A centered node can legitimately grow beneath the fixed minimap or
      // bottom construction rail. Require a usable painted point, not the
      // geometric center specifically, so those UI surfaces keep ownership.
      for (const xRatio of [0.18, 0.36, 0.54, 0.72, 0.9]) {
        for (const yRatio of [0.12, 0.28, 0.44, 0.6, 0.76]) {
          const topElement = document.elementFromPoint(left + (right - left) * xRatio, top + (bottom - top) * yRatio);
          if (topElement && (wrapper === topElement || wrapper.contains(topElement))) {
            hit = true;
            break;
          }
        }
        if (hit) break;
      }
    }
    return { painted, hit };
  }), { timeout: 60_000 }).toEqual({ painted: true, hit: true });
}

async function importFixture(page: Page): Promise<void> {
  await page.addInitScript(({ detailKey, overlapKey, interactionKey }) => {
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-20-v1.1.1");
    localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
    localStorage.setItem(detailKey, "minimal");
    localStorage.setItem(overlapKey, "marker");
    localStorage.setItem(interactionKey, "hover");
  }, { detailKey: DETAIL_KEY, overlapKey: OVERLAP_KEY, interactionKey: INTERACTION_KEY });
  await page.goto("/?menu=1");
  await page.getByLabel("选择存档文件").setInputFiles(fixturePath!);
  await expect(page.getByRole("button", { name: "确认导入并进入" })).toBeEnabled({ timeout: 60_000 });
  await page.getByRole("button", { name: "确认导入并进入" }).click();
  await expect(page.locator(".game-shell")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".game-shell")).toHaveAttribute("data-active-planet-node-count", /[1-9]\d*/, { timeout: 60_000 });
}

async function locateLargestCanvasStack(page: Page): Promise<{ x: number; y: number; worldX: number; worldY: number; count: number }> {
  return page.evaluate(async () => {
    const [{ readPersistedLocalSaveValue }, { inspectSave }, { projectCanvasMiniMap }, { groupCanvasNodeStacks }] = await Promise.all([
      import("/src/game/localSaveStore.ts"),
      import("/src/game/storage.ts"),
      import("/src/components/CanvasMiniMap.tsx"),
      import("/src/game/canvasDensityPresentation.ts"),
    ]);
    const raw = await readPersistedLocalSaveValue("dsp-idle-network.save.v1");
    const state = raw ? inspectSave(raw).state : null;
    const flow = document.querySelector<HTMLElement>(".factory-canvas .react-flow");
    const viewport = document.querySelector<HTMLElement>(".react-flow__viewport");
    if (!state || !flow || !viewport) throw new Error("real-save canvas state missing");
    const active = state.entities.filter((entity) => entity.planetId === state.activePlanetId);
    const transform = new DOMMatrixReadOnly(getComputedStyle(viewport).transform);
    const grouped = groupCanvasNodeStacks(
      active.map((entity) => ({ id: entity.id, x: entity.position.x, y: entity.position.y })),
      transform.a,
      new Set(),
      new Map(),
      new Set(),
      new Set(),
      "marker",
    );
    const targetEntity = active
      .map((entity) => ({ entity, presentation: grouped.byNodeId.get(entity.id) }))
      .filter((entry) => entry.presentation?.marker)
      .sort((left, right) => (right.presentation?.count ?? 0) - (left.presentation?.count ?? 0))[0];
    if (!targetEntity?.presentation || targetEntity.presentation.count < 2) throw new Error("real-save fixture has no canvas stack");
    const target = { ...targetEntity.entity.position, count: targetEntity.presentation.count };
    const flowRect = flow.getBoundingClientRect();
    const projection = projectCanvasMiniMap(
      active.map((entity) => ({ id: entity.id, kind: entity.kind, x: entity.position.x, y: entity.position.y })),
      { x: transform.e, y: transform.f, zoom: transform.a },
      flowRect.width,
      flowRect.height,
    );
    return {
      x: Math.max(1, Math.min(199, projection.offsetX + (target.x - projection.minX) * projection.scale)),
      y: Math.max(1, Math.min(149, projection.offsetY + (target.y - projection.minY) * projection.scale)),
      worldX: target.x,
      worldY: target.y,
      count: target.count,
    };
  });
}

async function centerLargestCanvasStack(page: Page): Promise<{ count: number }> {
  const target = await locateLargestCanvasStack(page);
  const canvasMiniMap = page.getByRole("img", { name: "低频画布小地图" });
  if (await canvasMiniMap.count()) {
    await canvasMiniMap.click({ position: { x: target.x, y: target.y } });
    return { count: target.count };
  }
  const svgMiniMap = page.locator(".react-flow__minimap svg").first();
  await expect(svgMiniMap).toBeVisible();
  const point = await svgMiniMap.evaluate((svg, world) => {
    const viewBox = (svg as SVGSVGElement).viewBox.baseVal;
    const bounds = svg.getBoundingClientRect();
    return {
      x: Math.max(1, Math.min(bounds.width - 1, (world.x - viewBox.x) / Math.max(1, viewBox.width) * bounds.width)),
      y: Math.max(1, Math.min(bounds.height - 1, (world.y - viewBox.y) / Math.max(1, viewBox.height) * bounds.height)),
    };
  }, { x: target.worldX, y: target.worldY });
  await svgMiniMap.click({ position: point });
  return { count: target.count };
}

async function centerCanvasRecipe(page: Page, recipeId: string): Promise<string | null> {
  const target = await page.evaluate(async (requestedRecipeId) => {
    const [{ readPersistedLocalSaveValue }, { inspectSave }, { projectCanvasMiniMap }] = await Promise.all([
      import("/src/game/localSaveStore.ts"),
      import("/src/game/storage.ts"),
      import("/src/components/CanvasMiniMap.tsx"),
    ]);
    const raw = await readPersistedLocalSaveValue("dsp-idle-network.save.v1");
    const state = raw ? inspectSave(raw).state : null;
    const flow = document.querySelector<HTMLElement>(".factory-canvas .react-flow");
    const viewport = document.querySelector<HTMLElement>(".react-flow__viewport");
    if (!state || !flow || !viewport) throw new Error("real-save canvas state missing");
    const active = state.entities.filter((entity) => entity.planetId === state.activePlanetId);
    const entity = active.find((candidate) => candidate.recipeId === requestedRecipeId);
    if (!entity) return null;
    const transform = new DOMMatrixReadOnly(getComputedStyle(viewport).transform);
    const flowRect = flow.getBoundingClientRect();
    const projection = projectCanvasMiniMap(
      active.map((candidate) => ({ id: candidate.id, kind: candidate.kind, x: candidate.position.x, y: candidate.position.y })),
      { x: transform.e, y: transform.f, zoom: transform.a },
      flowRect.width,
      flowRect.height,
    );
    return {
      id: entity.id,
      worldX: entity.position.x,
      worldY: entity.position.y,
      minimapX: Math.max(1, Math.min(199, projection.offsetX + (entity.position.x - projection.minX) * projection.scale)),
      minimapY: Math.max(1, Math.min(149, projection.offsetY + (entity.position.y - projection.minY) * projection.scale)),
    };
  }, recipeId);
  if (!target) return null;
  const canvasMiniMap = page.getByRole("img", { name: "低频画布小地图" });
  if (await canvasMiniMap.count()) {
    await canvasMiniMap.click({ position: { x: target.minimapX, y: target.minimapY } });
  } else {
    const svgMiniMap = page.locator(".react-flow__minimap svg").first();
    await expect(svgMiniMap).toBeVisible();
    const point = await svgMiniMap.evaluate((svg, world) => {
      const viewBox = (svg as SVGSVGElement).viewBox.baseVal;
      const bounds = svg.getBoundingClientRect();
      return {
        x: Math.max(1, Math.min(bounds.width - 1, (world.x - viewBox.x) / Math.max(1, viewBox.width) * bounds.width)),
        y: Math.max(1, Math.min(bounds.height - 1, (world.y - viewBox.y) / Math.max(1, viewBox.height) * bounds.height)),
      };
    }, { x: target.worldX, y: target.worldY });
    await svgMiniMap.click({ position: point });
  }
  await expect(page.locator(`.react-flow__node[data-id="${target.id}"]`)).toBeVisible({ timeout: 60_000 });
  return target.id;
}

test.describe("real save canvas density acceptance", () => {
  test.skip(!fixturePath, "requires DSP_REAL_SAVE_FIXTURE");

  test("minimal marker presentation retains visible, unclipped building affordances", async ({ page }) => {
    test.setTimeout(runMatrix ? 900_000 : 180_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await importFixture(page);

    const shell = page.locator(".game-shell");
    await expect(shell).toHaveAttribute("data-canvas-detail-preference", "minimal");
    await expect(shell).toHaveAttribute("data-canvas-overlap-preference", "marker");
    await expect(shell).toHaveAttribute("data-canvas-interaction-detail-preference", "hover");
    await expect(shell).toHaveAttribute("data-canvas-detail-stage", "compact");

    const initialViewport = {
      logicalVisible: Number(await shell.getAttribute("data-canvas-visible-node-count")),
      wrapperCount: await page.locator(".react-flow__node").count(),
      fullyDeferred: await page.locator(".factory-canvas").getAttribute("data-flow-fully-deferred"),
    };
    const fitView = page.locator(".react-flow__controls-fitview");
    await expect(fitView).toBeVisible();
    await fitView.click();
    await expect.poll(async () => Number(await shell.getAttribute("data-canvas-visible-node-count")), { timeout: 60_000 }).toBeGreaterThan(0);
    await expect(page.locator(".factory-canvas")).toHaveAttribute("data-flow-fully-deferred", "false", { timeout: 60_000 });
    await expect.poll(() => page.locator(".react-flow__node").count(), { timeout: 60_000 }).toBeGreaterThan(0);
    const afterFitView = {
      logicalVisible: Number(await shell.getAttribute("data-canvas-visible-node-count")),
      wrapperCount: await page.locator(".react-flow__node").count(),
      fullyDeferred: await page.locator(".factory-canvas").getAttribute("data-flow-fully-deferred"),
    };
    const stackTarget = await centerLargestCanvasStack(page);
    await expect.poll(() => page.locator(".factory-node-stack-marker").count(), { timeout: 60_000 }).toBeGreaterThan(0);

    const metrics = await page.evaluate(() => {
      const shell = document.querySelector<HTMLElement>(".game-shell");
      const flow = document.querySelector<HTMLElement>(".factory-canvas .react-flow");
      if (!shell || !flow) throw new Error("canvas shell missing");
      const flowRect = flow.getBoundingClientRect();
      const intersects = (rect: DOMRect) => rect.right > flowRect.left && rect.left < flowRect.right &&
        rect.bottom > flowRect.top && rect.top < flowRect.bottom;
      const visible = (element: Element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0 &&
          rect.width > 0 && rect.height > 0 && intersects(rect);
      };
      const wrappers = [...document.querySelectorAll<HTMLElement>(".react-flow__node")];
      const contents = [...document.querySelectorAll<HTMLElement>(
        ".factory-node-compact, .factory-node-lod, .factory-node-stack-marker, .vein-node, .machine-node, .logistics-node, .power-node",
      )];
      const markers = [...document.querySelectorAll<HTMLElement>(".factory-node-stack-marker")];
      const compacts = [...document.querySelectorAll<HTMLElement>(".factory-node-compact")];
      const samples = contents.slice(0, 8).map((element) => {
        const rect = element.getBoundingClientRect();
        const parent = element.closest<HTMLElement>(".react-flow__node");
        const parentRect = parent?.getBoundingClientRect();
        const centerX = Math.max(flowRect.left, Math.min(flowRect.right - 1, rect.left + rect.width / 2));
        const centerY = Math.max(flowRect.top, Math.min(flowRect.bottom - 1, rect.top + rect.height / 2));
        const top = document.elementFromPoint(centerX, centerY);
        const style = getComputedStyle(element);
        const parentStyle = parent ? getComputedStyle(parent) : null;
        return {
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
          wrapper: parentRect ? { x: Math.round(parentRect.x), y: Math.round(parentRect.y), width: Math.round(parentRect.width), height: Math.round(parentRect.height) } : null,
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          background: style.backgroundColor,
          zIndex: style.zIndex,
          wrapperOpacity: parentStyle?.opacity,
          wrapperVisibility: parentStyle?.visibility,
          topClass: top instanceof HTMLElement ? top.className : String(top?.nodeName ?? "none"),
        };
      });
      const summarize = (elements: HTMLElement[]) => elements.reduce((summary, element) => {
        const rect = element.getBoundingClientRect();
        const parent = element.closest<HTMLElement>(".react-flow__node");
        const parentRect = parent?.getBoundingClientRect();
        const style = getComputedStyle(element);
        if (visible(element)) summary.intersecting += 1;
        if (rect.width < 8 || rect.height < 6) summary.tiny += 1;
        if (parentRect && (rect.width > parentRect.width + 1 || rect.height > parentRect.height + 1)) summary.outgrowsWrapper += 1;
        summary.minWidth = Math.min(summary.minWidth, rect.width);
        summary.maxWidth = Math.max(summary.maxWidth, rect.width);
        summary.minHeight = Math.min(summary.minHeight, rect.height);
        summary.maxHeight = Math.max(summary.maxHeight, rect.height);
        summary.transforms.add(style.transform);
        return summary;
      }, {
        intersecting: 0,
        tiny: 0,
        outgrowsWrapper: 0,
        minWidth: Number.POSITIVE_INFINITY,
        maxWidth: 0,
        minHeight: Number.POSITIVE_INFINITY,
        maxHeight: 0,
        transforms: new Set<string>(),
      });
      const finish = (summary: ReturnType<typeof summarize>) => ({
        ...summary,
        minWidth: Number.isFinite(summary.minWidth) ? Math.round(summary.minWidth * 10) / 10 : 0,
        maxWidth: Math.round(summary.maxWidth * 10) / 10,
        minHeight: Number.isFinite(summary.minHeight) ? Math.round(summary.minHeight * 10) / 10 : 0,
        maxHeight: Math.round(summary.maxHeight * 10) / 10,
        transforms: [...summary.transforms].slice(0, 4),
      });
      return {
        logicalVisible: Number(shell.dataset.canvasVisibleNodeCount ?? -1),
        activeNodes: Number(shell.dataset.activePlanetNodeCount ?? -1),
        stackGroups: Number(shell.dataset.canvasStackGroupCount ?? -1),
        stackHidden: Number(shell.dataset.canvasStackHiddenCount ?? -1),
        stackMarkers: Number(shell.dataset.canvasStackMarkerCount ?? -1),
        wrapperCount: wrappers.length,
        visibleWrappers: wrappers.filter(visible).length,
        contentCount: contents.length,
        visibleContents: contents.filter(visible).length,
        markerDomCount: markers.length,
        compactDomCount: compacts.length,
        markerGeometry: finish(summarize(markers)),
        compactGeometry: finish(summarize(compacts)),
        samples,
        viewportTransform: getComputedStyle(document.querySelector<HTMLElement>(".react-flow__viewport")!).transform,
        nodesLayer: (() => {
          const element = document.querySelector<HTMLElement>(".react-flow__nodes");
          const style = element ? getComputedStyle(element) : null;
          return { zIndex: style?.zIndex ?? "missing", opacity: style?.opacity ?? "missing", visibility: style?.visibility ?? "missing" };
        })(),
        beltLayer: (() => {
          const element = document.querySelector<HTMLElement>(".canvas-belt-layer");
          const style = element ? getComputedStyle(element) : null;
          return { zIndex: style?.zIndex ?? "missing", opacity: style?.opacity ?? "missing", visibility: style?.visibility ?? "missing" };
        })(),
        flowSize: { width: Math.round(flowRect.width), height: Math.round(flowRect.height) },
      };
    });
    console.log(`REAL_SAVE_CANVAS_METRICS ${JSON.stringify({ initialViewport, afterFitView, stackSize: stackTarget.count, centered: metrics })}`);
    await page.screenshot({
      path: `artifacts/qa/v146-real-save-${fixtureLabel}-minimal-marker-hover-core.png`,
      fullPage: true,
      animations: "disabled",
    });

    expect(metrics.logicalVisible).toBeGreaterThan(0);
    expect(metrics.stackMarkers).toBeGreaterThan(0);
    expect(metrics.markerDomCount).toBeGreaterThan(0);
    expect(metrics.visibleContents).toBeGreaterThan(0);

    if (runMatrix) {
      const paintedAffordanceCount = () => page.evaluate(() => {
        const flow = document.querySelector<HTMLElement>(".factory-canvas .react-flow");
        if (!flow) return 0;
        const viewport = flow.getBoundingClientRect();
        return [...document.querySelectorAll<HTMLElement>(".react-flow__node .factory-node:not(.factory-node-stack-proxy)")]
          .filter((element) => {
            const bounds = element.getBoundingClientRect();
            const left = Math.max(viewport.left, bounds.left);
            const right = Math.min(viewport.right, bounds.right);
            const top = Math.max(viewport.top, bounds.top);
            const bottom = Math.min(viewport.bottom, bounds.bottom);
            if (right - left < 2 || bottom - top < 2) return false;
            const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
            return Boolean(hit && (hit === element || element.contains(hit)));
          }).length;
      });
      const centerStack = async () => {
        await centerLargestCanvasStack(page);
        await expect.poll(paintedAffordanceCount, { timeout: 90_000 }).toBeGreaterThan(0);
      };
      const detailOverlapMatrix: Array<{ detail: DetailPreference; overlap: OverlapPreference }> = [];
      for (const detail of ["minimal", "medium", "auto", "full"] as const) {
        for (const overlap of ["marker", "representative", "all"] as const) detailOverlapMatrix.push({ detail, overlap });
      }
      for (const entry of detailOverlapMatrix) {
        await page.locator(".react-flow__pane").dispatchEvent("click");
        await setCanvasSettings(page, { ...entry, interaction: "base" });
        await centerStack();
        const shell = page.locator(".game-shell");
        if (entry.overlap === "marker") {
          await expect.poll(() => page.locator(".factory-node-stack-marker").count(), { timeout: 90_000 }).toBeGreaterThan(0);
        } else if (entry.overlap === "representative") {
          await expect.poll(() => page.locator(".factory-node-stack-badge").count(), { timeout: 90_000 }).toBeGreaterThan(0);
        } else {
          await expect(shell).toHaveAttribute("data-canvas-stack-hidden-count", "0", { timeout: 90_000 });
        }
        await page.screenshot({
          path: `artifacts/qa/v146-real-save-${fixtureLabel}-${entry.detail}-${entry.overlap}-base-1440x900.png`,
          fullPage: true,
          animations: "disabled",
        });
      }

      for (const interaction of ["selected", "hover"] as const) {
        await page.locator(".react-flow__pane").dispatchEvent("click");
        await setCanvasSettings(page, { detail: "minimal", overlap: "representative", interaction });
        await centerStack();
        const node = page.locator(".react-flow__node").filter({ has: page.locator(".factory-node:not(.factory-node-stack-proxy)") }).first();
        await expect(node).toBeVisible();
        if (interaction === "selected") await node.click({ force: true });
        else await node.hover({ force: true });
        await expect(node).toHaveClass(/factory-flow-node--lod-full/, { timeout: 60_000 });
        await page.screenshot({
          path: `artifacts/qa/v146-real-save-${fixtureLabel}-minimal-representative-${interaction}-1440x900.png`,
          fullPage: true,
          animations: "disabled",
        });
      }

      const mobileGates = [
        { viewport: { width: 390, height: 844 }, detail: "minimal" as const, overlap: "marker" as const, interaction: "hover" as const, name: "390x844" },
        { viewport: { width: 360, height: 640 }, detail: "auto" as const, overlap: "marker" as const, interaction: "base" as const, name: "360x640" },
        { viewport: { width: 844, height: 390 }, detail: "medium" as const, overlap: "representative" as const, interaction: "selected" as const, name: "844x390" },
      ];
      for (const gate of mobileGates) {
        await page.setViewportSize({ width: 1440, height: 900 });
        await setCanvasSettings(page, gate);
        await page.setViewportSize(gate.viewport);
        await page.locator(".react-flow__controls-fitview").dispatchEvent("click");
        await expect.poll(paintedAffordanceCount, { timeout: 90_000 }).toBeGreaterThan(0);
        await page.screenshot({
          path: `artifacts/qa/v146-real-save-${fixtureLabel}-${gate.detail}-${gate.overlap}-${gate.interaction}-${gate.name}.png`,
          fullPage: true,
          animations: "disabled",
        });
      }
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    expect(pageErrors).toEqual([]);
  });

  test("selected and hovered real-save recipe cards stay painted above nearby nodes", async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await importFixture(page);

    await setCanvasSettings(page, { detail: "medium", overlap: "marker", interaction: "selected" });
    const targetId = await centerCanvasRecipe(page, "particle_container_from_unipolar");
    test.skip(!targetId, "fixture has no active-planet unipolar particle-container recipe");
    const target = page.locator(`.react-flow__node[data-id="${targetId}"]`);
    await target.click();
    await expect(target).toHaveClass(/selected/);
    await expectExpandedNodePainted(target);

    await page.locator(".react-flow__pane").dispatchEvent("click");
    await expect(page.locator(".react-flow__node.selected")).toHaveCount(0);
    await setCanvasSettings(page, { detail: "medium", overlap: "marker", interaction: "hover" });
    await centerCanvasRecipe(page, "particle_container_from_unipolar");
    await target.hover();
    await expectExpandedNodePainted(target);
    await page.screenshot({
      path: `artifacts/qa/v146-real-save-${fixtureLabel}-interaction-expanded-stable.png`,
      fullPage: true,
      animations: "disabled",
    });
    expect(pageErrors).toEqual([]);
  });

  test("real-save canvas stays interactive through autosave and a live virtualized pan", async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.addInitScript(() => {
      // Keep this canvas regression deterministic even for the large fixture:
      // capture the exact 30-second user-selected interval and invoke it below
      // instead of waiting for the optional large-save cadence throttle.
      localStorage.setItem("dsp-idle-network.ui.large-save-autosave-throttle.v1", "false");
      const tracker: { autosaveHandler: TimerHandler | null } = { autosaveHandler: null };
      Object.assign(window, { __dspCanvasAutosaveTracker: tracker });
      const nativeSetInterval = window.setInterval.bind(window);
      window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        if (timeout === 30_000) {
          tracker.autosaveHandler = handler;
          return 0 as unknown as ReturnType<typeof window.setInterval>;
        }
        return nativeSetInterval(handler, timeout, ...args);
      }) as typeof window.setInterval;
    });
    await importFixture(page);
    await setCanvasSettings(page, { detail: "minimal", overlap: "all", interaction: "selected" });

    await page.getByLabel("打开设置").click();
    const settings = page.locator(".operations-workspace");
    await selectSettingsCategory(settings, "存档与云同步", "storage");
    await settings.getByRole("button", { name: "30 秒", exact: true }).click();
    await settings.getByRole("button", { name: "关闭运营中心" }).click();
    const shell = page.locator(".game-shell");
    await expect(shell).toHaveAttribute("data-autosave-configured-seconds", "30");
    const resume = page.getByLabel("继续模拟");
    if (await resume.isVisible()) await resume.click();
    await expect(shell).toHaveAttribute("data-simulation-paused", "false", { timeout: 30_000 });
    await page.evaluate(() => {
      const tracker = (window as typeof window & {
        __dspCanvasAutosaveTracker?: { autosaveHandler: TimerHandler | null };
      }).__dspCanvasAutosaveTracker;
      if (!tracker || typeof tracker.autosaveHandler !== "function") {
        throw new Error("30-second canvas autosave handler missing");
      }
      tracker.autosaveHandler();
    });
    await expect(shell).toHaveAttribute("data-persistence-kind", "autosave", { timeout: 60_000 });
    await expect(shell).toHaveAttribute("data-persistence-phase", "complete", { timeout: 120_000 });
    await expect(shell).toHaveAttribute("data-simulation-worker", "active");
    await expect(shell).toHaveAttribute("data-simulation-paused", "false");

    await page.locator(".react-flow__controls-fitview").click();
    const pane = page.locator(".react-flow__pane");
    const paneBox = await pane.boundingBox();
    if (!paneBox) throw new Error("real-save live pan has no pane geometry");
    const before = await page.evaluate(() => ({
      transform: getComputedStyle(document.querySelector<HTMLElement>(".react-flow__viewport")!).transform,
      ids: [...document.querySelectorAll<HTMLElement>(".react-flow__node[data-id]")].map((node) => node.dataset.id ?? ""),
    }));
    await page.mouse.move(paneBox.x + paneBox.width * 0.72, paneBox.y + paneBox.height * 0.42);
    await page.mouse.down();
    await page.mouse.move(paneBox.x + paneBox.width * 0.2, paneBox.y + paneBox.height * 0.42, { steps: 12 });
    await expect.poll(() => page.locator(".react-flow__viewport").evaluate((element) => getComputedStyle(element).transform))
      .not.toBe(before.transform);
    await expect.poll(() => page.locator(".react-flow__node[data-id]").evaluateAll((nodes, ids) =>
      nodes.some((node) => !ids.includes((node as HTMLElement).dataset.id ?? "")), before.ids)).toBe(true);
    await page.mouse.up();

    const targetId = await page.evaluate(() => {
      const flow = document.querySelector<HTMLElement>(".factory-canvas .react-flow");
      if (!flow) return null;
      const flowBounds = flow.getBoundingClientRect();
      return [...document.querySelectorAll<HTMLElement>(".react-flow__node[data-id]")].find((node) => {
        if (node.dataset.stackHiddenWrapper === "true") return false;
        const bounds = node.getBoundingClientRect();
        const x = bounds.left + bounds.width / 2;
        const y = bounds.top + bounds.height / 2;
        const hit = document.elementFromPoint(x, y);
        return x > flowBounds.left + 30 && x < flowBounds.right - 30 &&
          y > flowBounds.top + 30 && y < flowBounds.bottom - 140 &&
          Boolean(hit && (hit === node || node.contains(hit)));
      })?.dataset.id ?? null;
    });
    expect(targetId).not.toBeNull();
    const target = page.locator(`.react-flow__node[data-id="${targetId}"]`);
    await target.click({ force: true });
    await expect(target).toHaveClass(/selected/);
    await expectExpandedNodePainted(target);

    const dragStopsBefore = Number(await page.locator(".factory-canvas").getAttribute("data-drag-stop-count") ?? 0);
    const header = await target.locator(".factory-node__header").boundingBox();
    if (!header) throw new Error("selected real-save node has no drag geometry");
    await page.mouse.move(header.x + header.width / 2, header.y + header.height / 2);
    await page.mouse.down();
    await page.mouse.move(header.x + header.width / 2 + 42, header.y + header.height / 2 + 22, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => Number(await page.locator(".factory-canvas").getAttribute("data-drag-stop-count") ?? 0))
      .toBeGreaterThan(dragStopsBefore);

    await page.getByLabel("框选模式").click();
    await page.mouse.move(paneBox.x + 8, paneBox.y + 8);
    await page.mouse.down();
    await page.mouse.move(paneBox.x + paneBox.width - 8, paneBox.y + paneBox.height - 140, { steps: 10 });
    await page.mouse.up();
    await expect.poll(() => page.locator(".react-flow__node.selected").count()).toBeGreaterThan(0);
    expect(pageErrors).toEqual([]);
  });

  test("real-save factory stays interactive after an operational station canvas round trip", async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const pageErrors: string[] = [];
    const runtimeRenderErrors: string[] = [];
    const reactFlowWarnings: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && message.text().includes("DSP runtime render error")) runtimeRenderErrors.push(message.text());
      if (message.type() === "warning" && message.text().includes("React Flow")) reactFlowWarnings.push(message.text());
    });
    await importFixture(page);
    await setCanvasSettings(page, { detail: "minimal", overlap: "all", interaction: "selected" });

    await page.getByTitle("保存并返回主菜单").click();
    await expect(page.locator(".start-menu")).toBeVisible({ timeout: 120_000 });
    const preparedShape = await page.evaluate(async () => {
      const storage = await import("/src/game/storage.ts");
      const loaded = storage.loadGame();
      const state = loaded.state;
      state.paused = true;
      state.orbitalStation = {
        ...state.orbitalStation,
        status: "operational",
        construction: {
          ...state.orbitalStation.construction,
          stageRequirements: state.orbitalStation.construction.stageRequirements.map((stage) => ({
            ...stage,
            delivered: Object.fromEntries(stage.costs.map((cost) => [cost.itemId, cost.amount])),
            deliveredFleet: { ...stage.fleetCosts },
          })),
        },
      };
      const result = await storage.saveGameVerified(state);
      if (!result.success) throw new Error(result.message);
      return {
        activePlanetId: state.activePlanetId,
        entityCount: state.entities.length,
        beltCount: state.belts.length,
        activeEntityCount: state.entities.filter((entity) => entity.planetId === state.activePlanetId).length,
      };
    });
    await page.evaluate(() => sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1"));
    // importFixture intentionally starts at ?menu=1. Navigate to the factory
    // route instead of reloading that forced-menu URL after preparing the
    // isolated operational-station copy.
    await page.goto("/", { waitUntil: "domcontentloaded" });

    const shell = page.locator(".game-shell");
    const factoryCanvas = page.locator(".factory-canvas");
    await expect(shell).toBeVisible({ timeout: 120_000 });
    await expect(shell).toHaveAttribute("data-active-planet-node-count", String(preparedShape.activeEntityCount), { timeout: 60_000 });
    const persistedShape = await page.evaluate(async () => {
      const [{ readPersistedLocalSaveValue }, { inspectSave }] = await Promise.all([
        import("/src/game/localSaveStore.ts"),
        import("/src/game/storage.ts"),
      ]);
      const raw = await readPersistedLocalSaveValue("dsp-idle-network.save.v1");
      const state = raw ? inspectSave(raw).state : null;
      return state ? {
        activePlanetId: state.activePlanetId,
        entityCount: state.entities.length,
        beltCount: state.belts.length,
        stationStatus: state.orbitalStation.status,
      } : null;
    });
    expect(persistedShape).toEqual({
      activePlanetId: preparedShape.activePlanetId,
      entityCount: preparedShape.entityCount,
      beltCount: preparedShape.beltCount,
      stationStatus: "operational",
    });

    await factoryCanvas.locator(".react-flow__controls-fitview").click();
    await expect.poll(() => factoryCanvas.locator(".react-flow__node[data-id]").count(), { timeout: 60_000 }).toBeGreaterThan(0);
    const factoryViewport = factoryCanvas.locator(".react-flow__viewport");
    const factoryViewportBeforeStation = await factoryViewport.evaluate((element) => getComputedStyle(element).transform);

    await page.getByRole("button", { name: /打开全星系空间站/ }).click();
    const station = page.getByRole("dialog", { name: "全星系空间站" });
    await expect(station.locator(".station-canvas-renderer .react-flow")).toBeVisible({ timeout: 60_000 });
    await expect(station.locator('.react-flow__node[data-id^="module:"]')).toHaveCount(6);
    const stationViewport = station.locator(".station-canvas-renderer .react-flow__viewport");
    const stationViewportBefore = await stationViewport.evaluate((element) => getComputedStyle(element).transform);
    const stationZoomIn = station.locator(".station-canvas-renderer .react-flow__controls-zoomin");
    const stationZoomControl = await stationZoomIn.isEnabled()
      ? stationZoomIn
      : station.locator(".station-canvas-renderer .react-flow__controls-zoomout");
    await stationZoomControl.click();
    await expect.poll(() => stationViewport.evaluate((element) => getComputedStyle(element).transform)).not.toBe(stationViewportBefore);
    await page.locator(".orbital-station-entry").click();
    await expect(station).toHaveCount(0);
    await expect(factoryCanvas).not.toHaveAttribute("inert", "");
    await expect.poll(() => factoryViewport.evaluate((element) => getComputedStyle(element).transform)).toBe(factoryViewportBeforeStation);

    const pane = factoryCanvas.locator(".react-flow__pane");
    const paneBox = await pane.boundingBox();
    if (!paneBox) throw new Error("real-save station return has no factory pane geometry");
    const beforePan = await factoryViewport.evaluate((element) => getComputedStyle(element).transform);
    await page.mouse.move(paneBox.x + paneBox.width * 0.72, paneBox.y + paneBox.height * 0.42);
    await page.mouse.down();
    await page.mouse.move(paneBox.x + paneBox.width * 0.2, paneBox.y + paneBox.height * 0.42, { steps: 12 });
    await expect.poll(() => factoryViewport.evaluate((element) => getComputedStyle(element).transform)).not.toBe(beforePan);
    await page.mouse.up();

    const targetId = await page.evaluate(() => {
      const flow = document.querySelector<HTMLElement>(".factory-canvas .react-flow");
      if (!flow) return null;
      const flowBounds = flow.getBoundingClientRect();
      return [...document.querySelectorAll<HTMLElement>(".factory-canvas .react-flow__node[data-id]")].find((node) => {
        if (node.dataset.stackHiddenWrapper === "true") return false;
        const bounds = node.getBoundingClientRect();
        const x = bounds.left + bounds.width / 2;
        const y = bounds.top + bounds.height / 2;
        const hit = document.elementFromPoint(x, y);
        return x > flowBounds.left + 30 && x < flowBounds.right - 30 &&
          y > flowBounds.top + 30 && y < flowBounds.bottom - 140 &&
          Boolean(hit && (hit === node || node.contains(hit)));
      })?.dataset.id ?? null;
    });
    expect(targetId).not.toBeNull();
    const target = factoryCanvas.locator(`.react-flow__node[data-id="${targetId}"]`);
    await target.click({ force: true });
    await expect(target).toHaveClass(/selected/);
    await expectExpandedNodePainted(target);
    const dragStopsBefore = Number(await factoryCanvas.getAttribute("data-drag-stop-count") ?? 0);
    const header = await target.locator(".factory-node__header").boundingBox();
    if (!header) throw new Error("selected real-save node has no drag geometry after station return");
    await page.mouse.move(header.x + header.width / 2, header.y + header.height / 2);
    await page.mouse.down();
    await page.mouse.move(header.x + header.width / 2 + 42, header.y + header.height / 2 + 22, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => Number(await factoryCanvas.getAttribute("data-drag-stop-count") ?? 0))
      .toBeGreaterThan(dragStopsBefore);

    expect(pageErrors).toEqual([]);
    expect(runtimeRenderErrors).toEqual([]);
    expect(reactFlowWarnings).toEqual([]);
  });
});
