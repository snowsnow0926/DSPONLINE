import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { hasSeenCurrentReleaseNotes, markCurrentReleaseNotesSeen } from "./components/releaseNotesSeen";
import { StartMenu } from "./components/StartMenu";
import { DynamicImportBoundary, DynamicImportRecoveryNotice } from "./components/DynamicImportRecovery";
import { importWithRecovery } from "./game/dynamicImportRecovery";
import type { LoadedGame } from "./game/storage";
import { GameDialogProvider } from "./components/GameDialogProvider";
import { LocalSaveWriterBanner } from "./components/LocalSaveWriterBanner";
import { canBypassFactoryMenu } from "./game/factoryBypassPolicy";

const FactoryRuntime = lazy(() => importWithRecovery(() => import("./FactoryRuntime"), "行星工厂模块"));
const ReleaseNotesDialog = lazy(() => importWithRecovery(() => import("./components/ReleaseNotesDialog").then((module) => ({ default: module.ReleaseNotesDialog })), "版本更新记录"));

function FactoryLoading() {
  return <div className="workspace-loading" role="status"><i /><span>正在载入行星工厂</span></div>;
}

export function App() {
  const [bypassMenu] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const forceMenu = params.get("menu") === "1";
    let testSessionRequested = false;
    try { testSessionRequested = window.sessionStorage.getItem("dsp-idle-network.test-bypass-menu") === "1"; } catch { /* optional test flag */ }
    return canBypassFactoryMenu({
      hostname: window.location.hostname,
      developmentBuild: import.meta.env.DEV,
      forceMenu,
      queryRequested: params.get("factory") === "1",
      testSessionRequested,
    });
  });
  const [launch, setLaunch] = useState<{ id: number; loaded: LoadedGame } | null>(null);
  const [bypassLoading, setBypassLoading] = useState(bypassMenu);
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(() => !hasSeenCurrentReleaseNotes());
  const closeReleaseNotes = useCallback(() => {
    markCurrentReleaseNotesSeen();
    setReleaseNotesOpen(false);
  }, []);
  const openReleaseNotes = useCallback(() => setReleaseNotesOpen(true), []);

  useEffect(() => {
    if (!bypassMenu) return;
    let active = true;
    void importWithRecovery(() => import("./game/contentPacks"), "内容包注册表")
      .then((contentPacks) => contentPacks.applyContentPackRegistry(contentPacks.loadContentPackRegistry()))
      .then(() => importWithRecovery(() => import("./game/storage"), "本地存档模块"))
      .then(async ({ loadGame, loadInspectedGame }) => {
        // The local/dev bypass is mounted after IndexedDB initialization, at
        // which point catalog mode intentionally holds no large raw payload in
        // the synchronous cache. Retain the persisted bytes for save conflict
        // checks, and load the independently verified recovery state directly.
        const [{ resolveMenuContinueSave }, { retainLocalSavePayload }] = await Promise.all([
          importWithRecovery(() => import("./game/savePreviewPayload"), "本地存档正文"),
          importWithRecovery(() => import("./game/localSaveStore"), "本地存档目录"),
        ]);
        const selected = await resolveMenuContinueSave("normal");
        if (selected) retainLocalSavePayload(selected.save.key, selected.primaryRaw);
        if (active) setLaunch({ id: Date.now(), loaded: selected
          ? loadInspectedGame(selected.inspection, "normal", selected.save.source) ?? loadGame()
          : loadGame() });
      })
      .finally(() => { if (active) setBypassLoading(false); });
    return () => { active = false; };
  }, [bypassMenu]);

  return (
    <GameDialogProvider>
      <DynamicImportBoundary>
        {!launch && bypassLoading ? <FactoryLoading /> : !launch ? (
          <StartMenu onEnterGame={(loaded) => setLaunch({ id: Date.now(), loaded })} onOpenReleaseNotes={openReleaseNotes} />
        ) : (
          <Suspense fallback={<FactoryLoading />}>
            <FactoryRuntime
              launchId={launch.id}
              initialLoad={launch.loaded}
              onReturnToMenu={() => setLaunch(null)}
              onOpenReleaseNotes={openReleaseNotes}
              onReleaseNativeRendererState={(releasedLoad) => setLaunch((current) => current
                ? { ...current, loaded: releasedLoad }
                : current)}
            />
          </Suspense>
        )}
      </DynamicImportBoundary>
      <LocalSaveWriterBanner />
      <DynamicImportRecoveryNotice />
      <Suspense fallback={null}><ReleaseNotesDialog open={releaseNotesOpen} onClose={closeReleaseNotes} /></Suspense>
    </GameDialogProvider>
  );
}
