import { ReactFlowProvider } from "@xyflow/react";
import { useEffect } from "react";
import { FactoryGame, RuntimeRenderProfile } from "./App";
import type { LoadedGame } from "./game/storage";
import { useAppLocale } from "./i18n/locale";
import "./styles/mobile-shell.css";
import "./styles/mobile-factory.css";
import "./styles/mobile-workspaces.css";

interface FactoryRuntimeProps {
  launchId: number;
  initialLoad: LoadedGame;
  onReturnToMenu: () => void;
  onOpenReleaseNotes: () => void;
  onReleaseNativeRendererState: (releasedLoad: LoadedGame) => void;
}

export default function FactoryRuntime({ launchId, initialLoad, onReturnToMenu, onOpenReleaseNotes, onReleaseNativeRendererState }: FactoryRuntimeProps) {
  const { locale } = useAppLocale();
  useEffect(() => {
    if (locale !== "en") return;
    void import("./i18n/catalogEnglish").then(({ registerGameCatalogEnglish }) => registerGameCatalogEnglish());
  }, [locale]);
  return (
    <ReactFlowProvider key={launchId}>
      <RuntimeRenderProfile id="factory-game">
      <FactoryGame initialLoad={initialLoad} onReturnToMenu={onReturnToMenu} onOpenReleaseNotes={onOpenReleaseNotes} onReleaseNativeRendererState={onReleaseNativeRendererState} />
      </RuntimeRenderProfile>
    </ReactFlowProvider>
  );
}
