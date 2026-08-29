import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("native technology workspace App integration", () => {
  const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
  const workspace = readFileSync(
    fileURLToPath(new URL("../components/TechnologyWorkspace.tsx", import.meta.url)),
    "utf8",
  );

  it("never constructs the Web research model while a native authority session is bound", () => {
    expect(app).toMatch(/technologyOpen && !nativePlayerAuthorityBoundFrame[\s\S]*?createWebTechnologyWorkspaceReadModel\(game\)/);
    expect(app).toMatch(/const technologyWorkspaceReadModel = nativePlayerAuthorityBoundFrame[\s\S]*?nativeTechnologyWorkspaceReadModel[\s\S]*?: webTechnologyWorkspaceReadModel/);
    expect(app).toMatch(/technologyWorkspaceReadModel \? \([\s\S]*?<TechnologyWorkspace[\s\S]*?readModel=\{technologyWorkspaceReadModel\}[\s\S]*?: <WorkspaceLoading label="正在同步权威科研状态…"/);
  });

  it("keeps the component detached from GameState and the entity scan", () => {
    expect(workspace).toMatch(/readModel: TechnologyWorkspaceReadModel/);
    expect(workspace).not.toMatch(/game: GameState/);
    expect(workspace).not.toMatch(/\.entities\.reduce/);
    expect(workspace).not.toMatch(/networkMatrixStock/);
  });

  it("routes only the proven native research subset through exact projected commands", () => {
    expect(app).toMatch(/nativeAuthorityRequired=\{Boolean\(nativePlayerAuthorityBoundFrame\)\}/);
    expect(app).toMatch(/createNativeProjectedQueueTechnologyCommand\(\{ baseRevision, projection, techId \}\)/);
    expect(app).toMatch(/createNativeProjectedRemoveQueuedTechnologyCommand\(\{ baseRevision, projection, techId \}\)/);
    expect(app).toMatch(/createNativeProjectedInfiniteResearchAutomationCommand\(\{ baseRevision, projection, enabled \}\)/);
    expect(app).toMatch(/nativeTechnologyWorkspaceReadModel\.revision === factoryThinViewExpectedRevision[\s\S]*?nativeTechnologyWorkspaceSnapshot\.frame\?\.projection/);
  });

  it("keeps unsupported native research mutations visibly read-only", () => {
    expect(workspace).toMatch(/nativeAuthorityRequired \|\| !unlockedEndgame/);
    expect(workspace).toMatch(/disabled=\{nativeAuthorityRequired\} onClick=\{onPauseResearch\}/);
    expect(workspace).toMatch(/disabled=\{nativeAuthorityRequired\} onClick=\{onCancelResearch\}/);
    expect(workspace).toMatch(/disabled=\{nativeAuthorityRequired \|\| Boolean\(selected \|\| activeInfinite\)\} onClick=\{onResumeResearch\}/);
    expect(workspace).toMatch(/finiteQueueMutationReady = !nativeAuthorityRequired \|\| Boolean/);
    expect(app).toMatch(/原生权威暂未开放暂停科研；当前权威状态未改变/);
    expect(app).toMatch(/原生权威暂未开放无限科研目标切换；当前权威状态未改变/);
  });
});
