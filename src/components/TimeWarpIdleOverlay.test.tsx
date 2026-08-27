// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInitialState } from "../game/engine";
import {
  createTimeWarpComputeGovernor,
  resolveTimeWarpComputeLimits,
} from "../game/timeWarpComputeGovernor";
import { TimeWarpIdleOverlay } from "./TimeWarpIdleOverlay";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("TimeWarpIdleOverlay", () => {
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

  it("does not present baseline values as zero output before the first verified macro snapshot", () => {
    const game = createInitialState();
    game.totalProduced.universe_matrix = 52_300_000_000_000;
    game.dysonSphere.totalRocketsLaunched = 6_964_000_000;
    game.dysonSphere.structurePoints = 6_964_000_000;
    const governor = createTimeWarpComputeGovernor(game.settings.simulationSpeed);
    const limits = resolveTimeWarpComputeLimits(governor, 15, 15, 1);

    act(() => root.render(<TimeWarpIdleOverlay
      game={game}
      baselineGame={structuredClone(game)}
      startedAt={Date.now()}
      saveFailure={null}
      workerActive
      computeLimits={limits}
      computeState={governor}
      pendingSimulationSeconds={0}
      macroSummary={null}
      recovery={null}
      recoveryStatus="正在执行 3 × 10 秒产线校准"
      onStop={async () => undefined}
      onCancelSettlement={async () => undefined}
      continueAvailable={false}
      onRetryRecovery={async () => undefined}
      onContinueNormally={async () => undefined}
    />));

    expect(host.textContent).toContain("正在执行 3 × 10 秒校准");
    expect(host.textContent).toContain("首个验证快照生成中，校准完成后显示增量");
    expect(host.textContent).toContain("关键产线最低效率校准中");
    expect(host.textContent).not.toContain("本次 +0");
  });
});
