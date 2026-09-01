import { BarChart3, BookOpen, Check, Command, Factory, Flag, FlaskConical, Focus, Gauge, Globe2, Map, PackageOpen, Pause, Play, Search, Settings2, Telescope, WandSparkles, Wrench, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ITEMS, getBuilding, getPlanet } from "../game/content";
import type {
  CommandPaletteEntitySearchReadModel,
  CommandPaletteNativeEntityTarget,
} from "../game/commandPaletteEntitySearchReadModel";
import type { NativeCommandPaletteEntitySearchSnapshot } from "../game/nativeCommandPaletteEntitySearchStore";
import type { FactoryEntity, ItemId } from "../game/types";
import "../styles/command-palette.css";
import { AccessibleDialog } from "./AccessibleDialog";
import { StableTextInput, clearStableTextDraft } from "./CompositionSafeInput";

const COMMAND_PALETTE_DRAFT_ID = "command-palette-search";

export type CommandWorkspace = "operations" | "campaign" | "galaxy" | "star-map" | "statistics" | "recipes" | "technology" | "blueprints" | "dyson" | "inspector" | "resources";

interface CommandPaletteProps {
  open: boolean;
  /** Null while Rust owns the factory; native search must never fall back. */
  webEntities: readonly FactoryEntity[] | null;
  paused: boolean;
  performanceMode: boolean;
  reducedMotion: boolean;
  onClose: () => void;
  onOpenWorkspace: (workspace: CommandWorkspace) => void;
  onFocusRecipe: (itemId: ItemId) => void;
  onFocusEntity: (entityId: string, nativeTarget?: CommandPaletteNativeEntityTarget) => void;
  onAutoLayout: () => void;
  onPauseToggle: () => void;
  onTogglePerformance: () => void;
  onToggleReducedMotion: () => void;
  entitySearchMode?: "web" | "native";
  nativeEntitySearch?: CommandPaletteEntitySearchReadModel | null;
  nativeEntitySearchStatus?: NativeCommandPaletteEntitySearchSnapshot["status"];
  onEntitySearchRequest?: (query: string, cursor: number) => void;
}

type OpenCommandPaletteProps = Omit<CommandPaletteProps, "open">;

interface PaletteCommand {
  id: string;
  label: string;
  detail: string;
  icon: ReactNode;
  run: () => void;
}

export function CommandPalette({ open, ...props }: CommandPaletteProps) {
  return open ? <OpenCommandPalette {...props} /> : null;
}

function OpenCommandPalette({
  webEntities,
  paused,
  performanceMode,
  reducedMotion,
  onClose,
  onOpenWorkspace,
  onFocusRecipe,
  onFocusEntity,
  onAutoLayout,
  onPauseToggle,
  onTogglePerformance,
  onToggleReducedMotion,
  entitySearchMode = "web",
  nativeEntitySearch = null,
  nativeEntitySearchStatus = "empty",
  onEntitySearchRequest,
}: OpenCommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const nativeAuthority = entitySearchMode === "native";
  const close = () => {
    clearStableTextDraft(COMMAND_PALETTE_DRAFT_ID);
    setQuery("");
    if (entitySearchMode === "native") onEntitySearchRequest?.("", 0);
    onClose();
  };
  const run = (action: () => void) => {
    action();
    close();
  };
  const commands = useMemo<PaletteCommand[]>(() => {
    const workspace = (id: string, label: string, detail: string, icon: ReactNode, target: CommandWorkspace): PaletteCommand => ({
      id,
      label,
      detail,
      icon,
      run: () => run(() => onOpenWorkspace(target)),
    });
    const workspaceCommands: PaletteCommand[] = [
      workspace("star-map", "打开星图与星际工业", "探索、航线和行星角色", <Telescope size={16} />, "star-map"),
      workspace("galaxy", "打开银河网络", "账户、累计发电与白矩阵排行榜", <Globe2 size={16} />, "galaxy"),
      workspace("statistics", "打开生产统计", "网络、吞吐和工业规划", <BarChart3 size={16} />, "statistics"),
      workspace("recipes", "打开生产资料库", "物品、建筑、物流、能源、星球、戴森与科研", <BookOpen size={16} />, "recipes"),
      workspace("technology", "打开科技树", "科研队列和解锁路径", <FlaskConical size={16} />, "technology"),
      workspace("operations", "打开运营中心", "警报、设置和存档", <Gauge size={16} />, "operations"),
      workspace("campaign", "打开主线任务", "查看章节目标和奖励", <Flag size={16} />, "campaign"),
      workspace("blueprints", "打开蓝图库", "部署和管理生产蓝图", <Factory size={16} />, "blueprints"),
      workspace("dyson", "打开戴森规划", "轨道、壳层和发射", <Map size={16} />, "dyson"),
      workspace("inspector", "打开设备检查器", "查看当前选中设备", <Wrench size={16} />, "inspector"),
      workspace("resources", "打开物资托盘", "库存与跨星球物资", <PackageOpen size={16} />, "resources"),
    ];
    const nativeWorkspaceIds = new Set(["star-map", "galaxy", "statistics", "recipes", "technology", "operations", "campaign", "blueprints", "dyson", "inspector"]);
    const base: PaletteCommand[] = nativeAuthority
      ? workspaceCommands.filter((command) => nativeWorkspaceIds.has(command.id))
      : [
          ...workspaceCommands,
          { id: "pause", label: paused ? "继续模拟" : "暂停模拟", detail: "Space", icon: paused ? <Play size={16} /> : <Pause size={16} />, run: () => run(onPauseToggle) },
          { id: "performance", label: performanceMode ? "关闭性能模式" : "开启性能模式", detail: "降低大规模工厂视觉负载", icon: <Gauge size={16} />, run: () => run(onTogglePerformance) },
          { id: "motion", label: reducedMotion ? "开启动态效果" : "减少动态效果", detail: "尊重动效偏好", icon: <Settings2 size={16} />, run: () => run(onToggleReducedMotion) },
          { id: "auto-layout", label: "整理当前行星生产网络", detail: "按物流上下游自动排列全部设备", icon: <WandSparkles size={16} />, run: () => run(onAutoLayout) },
        ];
    const itemCommands: PaletteCommand[] = Object.values(ITEMS).map((item) => ({
      id: `recipe:${item.id}`,
      label: `聚焦配方：${item.name}`,
      detail: `${item.symbol} · 打开上下游生产链`,
      icon: <span className="command-item-swatch" style={{ backgroundColor: item.color }}>{item.symbol.slice(0, 3)}</span>,
      run: () => run(() => onFocusRecipe(item.id)),
    }));
    // Do not materialize tens of thousands of entity commands just to show the
    // empty palette. A large factory can publish a new runtime state while the
    // palette is open; deferring this map until there is an actual search term
    // prevents every steady publication from rebuilding the full command list.
    const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
    const entityCommands: PaletteCommand[] = [];
    if (normalizedQuery.length >= 2) {
      const buildingNames = new globalThis.Map<string, string>();
      const planetNames = new globalThis.Map<string, string>();
      if (entitySearchMode === "native") {
        // Native authority returns only fingerprint-bound scalar identity and
        // finite position fields. Display names stay local to the renderer
        // catalog; an absent/stale frame is intentionally an empty native
        // result, never a fallback to the stale renderer state.
        if (nativeEntitySearchStatus === "ready" && nativeEntitySearch?.query === normalizedQuery) {
          for (const row of nativeEntitySearch.rows) {
            const name = row.buildingId
              ? getBuilding(row.buildingId).name
              : row.resourceId ? ITEMS[row.resourceId].name : "生产节点";
            const planetName = getPlanet(row.planetId).name;
            const recipe = row.recipeId ? ` · ${row.recipeId}` : "";
            entityCommands.push({
              id: `entity:${row.entityId}`,
              label: `定位：${name}`,
              detail: `${planetName} · ${row.entityId}${recipe}`,
              icon: <Focus size={16} />,
              run: () => run(() => onFocusEntity(row.entityId, {
                sessionId: nativeEntitySearch.sessionId,
                revision: nativeEntitySearch.revision,
                registryFingerprint: nativeEntitySearch.registryFingerprint,
                planetId: row.planetId,
                label: name,
                positionX: row.positionX,
                positionY: row.positionY,
              })),
            });
          }
        }
      } else {
        // Filter the raw scalar identity first and only create React command
        // objects for the first visible matches. Mapping every entity into JSX
        // before filtering is particularly expensive for a 27k-entity save.
        for (const entity of webEntities ?? []) {
          const name = entity.buildingId
            ? (buildingNames.get(entity.buildingId) ?? (() => {
              const value = getBuilding(entity.buildingId!).name;
              buildingNames.set(entity.buildingId!, value);
              return value;
            })())
            : entity.resourceId ? ITEMS[entity.resourceId].name : "生产节点";
          const planetName = planetNames.get(entity.planetId) ?? (() => {
            const value = getPlanet(entity.planetId).name;
            planetNames.set(entity.planetId, value);
            return value;
          })();
          const recipe = entity.recipeId ? ` · ${entity.recipeId}` : "";
          const label = `定位：${name}`;
          const detail = `${planetName} · ${entity.id}${recipe}`;
          if (!`${label} ${detail}`.toLocaleLowerCase("zh-CN").includes(normalizedQuery)) continue;
          entityCommands.push({
            id: `entity:${entity.id}`,
            label,
            detail,
            icon: <Focus size={16} />,
            run: () => run(() => onFocusEntity(entity.id)),
          });
          if (entityCommands.length >= 16) break;
        }
      }
    }
    return [...base, ...itemCommands, ...entityCommands];
  }, [entitySearchMode, nativeAuthority, nativeEntitySearch, nativeEntitySearchStatus, onAutoLayout, onFocusEntity, onFocusRecipe, onOpenWorkspace, onPauseToggle, onTogglePerformance, onToggleReducedMotion, paused, performanceMode, query, reducedMotion, webEntities]);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    if (!normalized) return commands.slice(0, 12);
    const matches = commands.filter((command) =>
      `${command.label} ${command.detail}`.toLocaleLowerCase("zh-CN").includes(normalized));
    if (entitySearchMode === "native" && normalized.length >= 2) {
      // Preserve the complete bounded native page before filling any remaining
      // palette slots with local workspace/item commands.
      return [
        ...matches.filter((command) => command.id.startsWith("entity:")),
        ...matches.filter((command) => !command.id.startsWith("entity:")),
      ].slice(0, 16);
    }
    return matches.slice(0, 16);
  }, [commands, entitySearchMode, query]);
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const nativeSearchMessage = entitySearchMode === "native" && normalizedQuery.length >= 2 &&
    (nativeEntitySearchStatus !== "ready" || nativeEntitySearch?.query !== normalizedQuery)
    ? nativeEntitySearchStatus === "truncated"
      ? "匹配目录超过原生搜索上限，请输入更具体的名称"
      : nativeEntitySearchStatus === "unavailable"
        ? "原生权威设备搜索暂不可用，请重试"
        : "正在从原生权威目录搜索设备…"
    : null;
  const previousNativeCursor = nativeEntitySearch
    ? Math.max(0, nativeEntitySearch.cursor - nativeEntitySearch.limit)
    : 0;

  useEffect(() => {
    setActiveIndex((index) => Math.min(index, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  const activeCommand = filtered[activeIndex];
  return (
    <AccessibleDialog
      open
      title="命令面板"
      layout="bare"
      ariaLabel="命令面板"
      className="command-palette"
      backdropClassName="command-palette-backdrop"
      initialFocusRef={inputRef}
      onRequestClose={close}
    >
        <header>
          <div className="command-palette-title"><i><Command size={17} /></i><span><strong>命令面板</strong><small>搜索设备、工作区、设置或物品</small></span></div>
          <button type="button" onClick={close} title="关闭命令面板" aria-label="关闭命令面板"><X size={16} /></button>
        </header>
        <label className="command-palette-search"><Search size={16} /><StableTextInput draftId={COMMAND_PALETTE_DRAFT_ID} ref={inputRef} role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="command-palette-results" aria-activedescendant={activeCommand ? `command-palette-option-${activeCommand.id.replace(/[^a-zA-Z0-9_-]/g, "-")}` : undefined} value={query} onValueChange={(value) => { setQuery(value); setActiveIndex(0); if (entitySearchMode === "native") onEntitySearchRequest?.(value, 0); }} onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex((index) => Math.min(index + 1, Math.max(0, filtered.length - 1))); }
          else if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((index) => Math.max(0, index - 1)); }
          else if (event.key === "Enter") { event.preventDefault(); filtered[activeIndex]?.run(); }
        }} placeholder="输入设备、物品、工作区或动作" aria-label="搜索命令" autoComplete="off" /><kbd>Esc</kbd></label>
        <div id="command-palette-results" className="command-palette-list" role="listbox" aria-label="命令结果">
          {filtered.map((command, index) => <button id={`command-palette-option-${command.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`} type="button" role="option" aria-selected={index === activeIndex} className={index === activeIndex ? "active" : ""} key={command.id} onMouseEnter={() => setActiveIndex(index)} onClick={command.run}><i>{command.icon}</i><span><strong>{command.label}</strong><small>{command.detail}</small></span>{index === activeIndex ? <Check size={14} /> : null}</button>)}
          {nativeSearchMessage ? <div className="command-palette-search-status" data-status={nativeEntitySearchStatus}>{nativeSearchMessage}</div> : null}
          {!nativeSearchMessage && filtered.length === 0 ? <div className="command-palette-empty">没有匹配的命令或物品</div> : null}
          {entitySearchMode === "native" && nativeEntitySearchStatus === "ready" &&
              nativeEntitySearch?.query === normalizedQuery &&
              (nativeEntitySearch.cursor > 0 || nativeEntitySearch.nextCursor !== null) ? (
            <nav className="command-palette-pagination" aria-label="设备搜索分页">
              <button type="button" disabled={nativeEntitySearch.cursor === 0} onClick={() => onEntitySearchRequest?.(query, previousNativeCursor)}>上一页</button>
              <span>{nativeEntitySearch.cursor + 1}–{nativeEntitySearch.cursor + nativeEntitySearch.rows.length} / {nativeEntitySearch.totalCount}</span>
              <button type="button" disabled={nativeEntitySearch.nextCursor === null} onClick={() => {
                if (nativeEntitySearch.nextCursor !== null) onEntitySearchRequest?.(query, nativeEntitySearch.nextCursor);
              }}>下一页</button>
            </nav>
          ) : null}
        </div>
        <footer><span><kbd>↑</kbd><kbd>↓</kbd>选择</span><span><kbd>Enter</kbd>执行</span><span><kbd>Esc</kbd>关闭</span></footer>
    </AccessibleDialog>
  );
}
