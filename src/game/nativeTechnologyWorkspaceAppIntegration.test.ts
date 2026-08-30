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

  it("routes the native research lifecycle through exact projected intent commands", () => {
    expect(app).toMatch(/nativeAuthorityRequired=\{Boolean\(nativePlayerAuthorityBoundFrame\)\}/);
    expect(app).toMatch(/nativeCommandPending=\{nativePlayerAuthorityCommandPending\}/);
    expect(app).toMatch(/createNativeProjectedSelectTechnologyCommand\(\{ baseRevision, projection, techId \}\)/);
    expect(app).toMatch(/createNativeProjectedPauseResearchCommand\(\{ baseRevision, projection \}\)/);
    expect(app).toMatch(/createNativeProjectedCancelResearchCommand\(\{ baseRevision, projection \}\)/);
    expect(app).toMatch(/createNativeProjectedResumeResearchCommand\(\{ baseRevision, projection \}\)/);
    expect(app).toMatch(/createNativeProjectedSelectInfiniteResearchCommand\(\{ baseRevision, projection, researchId \}\)/);
    expect(app).toMatch(/createNativeProjectedTechnologyLayoutCommand\(\{[\s\S]*?baseRevision,[\s\S]*?projection,[\s\S]*?layout: technologyLayout/);
    expect(app).toMatch(/createNativeProjectedRemoveQueuedTechnologyCommand\(\{ baseRevision, projection, techId \}\)/);
    expect(app).toMatch(/createNativeProjectedInfiniteResearchAutomationCommand\(\{ baseRevision, projection, enabled \}\)/);
    expect(app).toMatch(/nativeTechnologyWorkspaceReadModel\.revision === factoryThinViewExpectedRevision[\s\S]*?nativeTechnologyWorkspaceSnapshot\.frame\?\.projection/);
  });

  it("keeps pending commands single-flight and explains the native-only infinite guard", () => {
    expect(workspace).toMatch(/nativeCommandPending \? "等待上一条原生科研命令确认"/);
    expect(workspace).toMatch(/nativeAuthorityRequired && readModel\.research\.selectedTechId \? "请先暂停或取消当前有限科研，再开始无限科研"/);
    expect(workspace).toMatch(/finiteQueueMutationReady = !nativeCommandPending && \([\s\S]*?!nativeAuthorityRequired \|\| !readModel\.activeInfiniteResearchId/);
    expect(workspace).not.toMatch(/原生权威暂未开放暂停科研/);
    expect(app).not.toMatch(/原生权威暂未开放无限科研目标切换/);
    expect(app).not.toMatch(/原生权威暂未开放科技树布局写入/);
    expect(workspace).toMatch(/technology-layout-toggle[\s\S]*?disabled=\{nativeCommandPending\}/);
  });

  it("does not apply the conservative native infinite guard to the Web workspace", () => {
    expect(workspace).toMatch(/nativeAuthorityRequired && Boolean\(readModel\.research\.selectedTechId\)/);
    expect(workspace).toMatch(/nativeAuthorityRequired && \(Boolean\(selected\) \|\| active\)/);
  });
});
