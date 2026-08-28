import { Wrench } from "lucide-react";
import { trackAnalyticsEvent } from "../../game/analytics";
import type { GameState, PlanetId } from "../../game/types";
import type { CompactLayoutSnapshot } from "../../hooks/useCompactLayout";
import type { MobileOverlay, MobileRoute, MobileSheetId, MobileSheetSnap, MobileWorkspaceId } from "../../hooks/useMobileNavigation";
import type { OperationsTab } from "../OperationsWorkspace";
import type { StatisticsTab } from "../StatisticsWorkspace";
import { MobileBottomNav } from "./MobileBottomNav";
import { MobileSheets, type MobileCanvasToolActions, type MobileCanvasToolState, type MobileFactorySheetActions, type MobileFactorySheetState } from "./MobileSheets";
import { MobileTopBar } from "./MobileTopBar";
import { MobileWorkspaceHub } from "./MobileWorkspaceHub";

export function MobileGameShell({ enabled, layout, game, factoryGame, alertCount, planetAlertCounts, route, overlay, tools, toolActions, factory, factoryActions, hasConstructionCenter, onFactory, onOpenHub, onOpenSheet, onSheetSnap, onOpenWorkspace, onOpenOrbitalStation, onOpenStatistics, onOpenOperations, onOpenGalaxy, onOpenCommandPalette, onBack, onTogglePause, onPlanetChange, onConfirmExit, onDismissExit, onRequestExit, onSwitchLegacy }: {
  enabled: boolean;
  layout: CompactLayoutSnapshot;
  game: GameState;
  /** Same-revision bounded row universe for the selected factory inspector. */
  factoryGame: GameState;
  alertCount: number;
  planetAlertCounts: Partial<Record<PlanetId, number>>;
  route: MobileRoute;
  overlay: MobileOverlay;
  tools: MobileCanvasToolState;
  toolActions: MobileCanvasToolActions;
  factory: MobileFactorySheetState;
  factoryActions: MobileFactorySheetActions;
  hasConstructionCenter: boolean;
  onFactory: () => void;
  onOpenHub: () => void;
  onOpenSheet: (id: MobileSheetId) => void;
  onSheetSnap: (snap: MobileSheetSnap) => void;
  onOpenWorkspace: (id: MobileWorkspaceId) => void;
  onOpenOrbitalStation: () => void;
  onOpenStatistics: (tab: StatisticsTab) => void;
  onOpenOperations: (tab: OperationsTab) => void;
  onOpenGalaxy: (tab: "ranking" | "cloud" | "account") => void;
  onOpenCommandPalette: () => void;
  onBack: () => void;
  onTogglePause: () => void;
  onPlanetChange: (planetId: PlanetId) => boolean;
  onConfirmExit: () => void;
  onDismissExit: () => void;
  onRequestExit: () => void;
  onSwitchLegacy: () => void;
}) {
  if (!enabled) return null;
  const openSheet = (id: MobileSheetId) => {
    trackAnalyticsEvent("mobile_nav_open");
    trackAnalyticsEvent("mobile_sheet_open");
    onOpenSheet(id);
  };
  const openWorkspace = (id: MobileWorkspaceId) => {
    trackAnalyticsEvent("mobile_nav_open");
    trackAnalyticsEvent("mobile_workspace_open");
    onOpenWorkspace(id);
  };
  const openStatistics = (tab: StatisticsTab) => {
    trackAnalyticsEvent("mobile_workspace_open");
    onOpenStatistics(tab);
  };
  const openOperations = (tab: OperationsTab) => {
    trackAnalyticsEvent("mobile_workspace_open");
    onOpenOperations(tab);
  };
  const openGalaxy = (tab: "ranking" | "cloud" | "account") => {
    trackAnalyticsEvent("mobile_workspace_open");
    onOpenGalaxy(tab);
  };
  const close = () => onBack();
  return (
    <>
      <MobileTopBar game={game} route={route} alertCount={alertCount} onBack={onBack} onOpenPlanet={() => openSheet("planet")} onTogglePause={onTogglePause} onOpenAlerts={() => openOperations("alerts")} />
      {route.kind === "hub" ? <MobileWorkspaceHub hasConstructionCenter={hasConstructionCenter} onOpenWorkspace={openWorkspace} onOpenOrbitalStation={onOpenOrbitalStation} onOpenStatistics={openStatistics} onOpenOperations={openOperations} onOpenGalaxy={openGalaxy} onOpenCommandPalette={onOpenCommandPalette} onSwitchLegacy={onSwitchLegacy} onRequestExit={onRequestExit} onClose={onBack} /> : null}
      {route.kind === "factory" && !overlay ? <button className="mobile-next-tools-command" type="button" onClick={() => openSheet("tools")} title="画布工具" aria-label="打开画布工具"><Wrench size={22} /></button> : null}
      <MobileSheets game={game} factoryGame={factoryGame} planetAlertCounts={planetAlertCounts} overlay={overlay} tools={tools} toolActions={toolActions} factory={factory} factoryActions={factoryActions} onSheetSnap={onSheetSnap} onClose={close} onPlanetChange={onPlanetChange} onOpenStarMap={() => openWorkspace("star-map")} onConfirmExit={onConfirmExit} onDismissExit={onDismissExit} />
      <MobileBottomNav
        route={route}
        overlay={overlay}
        cargoAmount={game.cargo?.amount ?? 0}
        onFactory={() => { trackAnalyticsEvent("mobile_nav_open"); onFactory(); }}
        onBuild={() => openSheet("build")}
        onInventory={() => openSheet("inventory")}
        onTechnology={() => openWorkspace("technology")}
        onHub={() => { trackAnalyticsEvent("mobile_nav_open"); trackAnalyticsEvent("mobile_workspace_open"); onOpenHub(); }}
      />
      <span className="mobile-next-layout-probe" data-mode={layout.mode} aria-hidden="true" />
    </>
  );
}
