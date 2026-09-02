import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectNativeComponentSource,
  inspectNativeSurfaceBindings,
  verifyNativeThinUiBoundary,
} from "./verify-native-thin-ui-boundary.mjs";

test("the current dedicated native surfaces do not receive full GameState or legacy writers", () => {
  const report = verifyNativeThinUiBoundary();
  assert.deepEqual(report.failures, []);
  assert.ok(report.nativeSurfaceBindings >= 10);
  assert.ok(report.nativeComponentFiles >= 10);
});

test("rejects direct full-state props, legacy writer captures and hidden JSX spreads", () => {
  const report = inspectNativeSurfaceBindings(`
    const bad = <>
      <NativeGalaxyWorkspace game={game} />
      <NativeCampaignWorkspace onRefresh={() => commitGame(gameRef.current)} />
      <NativeOperationsWorkspace {...props} />
    </>;
  `, "synthetic-App.tsx");
  assert.equal(report.surfaceCount, 3);
  assert.equal(report.failures.length, 4);
  assert.match(report.failures.join("\n"), /NativeGalaxyWorkspace\.game/);
  assert.match(report.failures.join("\n"), /directly captures game/);
  assert.match(report.failures.join("\n"), /commitGame, gameRef/);
  assert.match(report.failures.join("\n"), /must not hide authority data behind a JSX spread/);
});

test("allows bounded projection frames, identities and intent callbacks", () => {
  const report = inspectNativeSurfaceBindings(`
    const good = <NativeDysonPlannerWorkspace
      frame={nativeDysonFrame}
      latestIdentity={nativeIdentity}
      onLaunchEnabledChange={changeNativeLaunchEnabled}
    />;
  `, "synthetic-App.tsx");
  assert.deepEqual(report.failures, []);
  assert.equal(report.surfaceCount, 1);
});

test("rejects full factory types and direct legacy authority use inside dedicated components", () => {
  const failures = inspectNativeComponentSource(`
    type Props = { state: GameState };
    export function NativeBad({ state }: Props) {
      return <button onClick={() => commitGame(gameRef.current)}>{state.revision}</button>;
    }
  `, "NativeBad.tsx");
  assert.equal(failures.length, 3);
  assert.match(failures.join("\n"), /GameState/);
  assert.match(failures.join("\n"), /commitGame/);
  assert.match(failures.join("\n"), /gameRef/);
});
