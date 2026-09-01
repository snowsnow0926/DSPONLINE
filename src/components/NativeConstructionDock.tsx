import { Factory, Hammer, LockKeyhole, Route, Trash2 } from "lucide-react";
import { useMemo } from "react";
import { BUILDINGS, CONSTRUCTION, getBeltConstructionId, getBeltTiers } from "../game/content";
import type { NativeConstructionInventoryFrame } from "../game/nativeConstructionInventoryStore";
import type { BeltTier } from "../game/types";
import { QuantityValue } from "./QuantityValue";

interface NativeConstructionDockProps {
  frame: NativeConstructionInventoryFrame | null;
  selectedBuildingId: string | null;
  selectedBeltTier: BeltTier | null;
  beltLanes: number;
  pending: boolean;
  onPlacementChange: (buildingId: string | null) => void;
  onBeltPlacementChange: (tier: BeltTier | null) => void;
  onBeltLanesChange: (lanes: number) => void;
  onOpenFabricator?: () => void;
  onDeleteConstruction?: (buildingId: string) => void;
}

function beltTierForConstruction(buildingId: string): BeltTier | null {
  return getBeltTiers().find((tier) => getBeltConstructionId(tier) === buildingId) ?? null;
}

function constructionLabel(
  directory: ReadonlyMap<string, { readonly name: string }>,
  buildingId: string,
): string {
  return directory.get(buildingId)?.name ?? buildingId;
}

function ConstructionMark({ buildingId }: { buildingId: string }) {
  return buildingId.startsWith("conveyor_belt_")
    ? <Route size={18} />
    : <Factory size={18} />;
}

/**
 * A bounded Rust construction tray. Known non-building rows stay disabled;
 * built-in and opaque MOD building candidates can request one ordinary
 * placement. The click itself does not mutate state: App still obtains a
 * fresh same-revision Rust capability at the final canvas coordinate.
 */
export function NativeConstructionDock({
  frame,
  selectedBuildingId,
  selectedBeltTier,
  beltLanes,
  pending,
  onPlacementChange,
  onBeltPlacementChange,
  onBeltLanesChange,
  onOpenFabricator,
  onDeleteConstruction,
}: NativeConstructionDockProps) {
  const rows = useMemo(() => frame?.rows ?? [], [frame?.rows]);
  const directory = useMemo(() => new Map<string, { readonly name: string }>(
    CONSTRUCTION.map((definition) => [definition.buildingId, definition]),
  ), [frame?.registryFingerprint]);
  if (!frame) {
    return <section
      className="construction-dock native-construction-dock-unavailable"
      data-native-authority-unavailable="construction-inventory-v1"
      role="status"
    >正在等待同一 revision 的 Rust 施工库存；旧网页库存不会显示，也不能用于建造。</section>;
  }
  return <footer
    className="construction-dock native-construction-dock"
    data-native-construction-placement="ordinary-single-v1"
    aria-label="Windows 原生施工库存"
  >
    <div className="dock-label">
      <div className="dock-summary">
        <span>施工托盘</span>
        <strong><QuantityValue value={frame.totalAmount} interactive={false} /></strong>
      </div>
      <div className="dock-mode-buttons">
        <span role="status"><LockKeyhole size={12} />Rust 权威 · 单次建造</span>
        <label className="native-construction-dock__lanes">
          <span>线路并联</span>
          <input
            type="number"
            min={1}
            max={4096}
            step={1}
            value={beltLanes}
            disabled={pending}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (Number.isSafeInteger(value) && value >= 1 && value <= 4096) onBeltLanesChange(value);
            }}
            aria-label="Windows 原生单条线路并联数量"
          />
        </label>
      </div>
    </div>
    <div className="construction-items">
      {rows.length === 0 ? <div className="construction-item-shell">
        <span className="construction-item" role="status">当前没有施工库存</span>
      </div> : rows.map((row) => {
        const knownConstruction = directory.has(row.buildingId);
        const knownBuilding = Object.prototype.hasOwnProperty.call(BUILDINGS, row.buildingId);
        const beltTier = beltTierForConstruction(row.buildingId);
        const knownNonBuilding = knownConstruction && !knownBuilding && beltTier === null;
        const disabled = pending || row.amount < 1 || knownNonBuilding;
        const selected = beltTier === null
          ? selectedBuildingId === row.buildingId
          : selectedBeltTier === beltTier;
        const label = constructionLabel(directory, row.buildingId);
        return <div className="construction-item-shell" key={row.buildingId}>
          <button
            className={`construction-item${selected ? " active" : ""}`}
            type="button"
            disabled={disabled}
            aria-pressed={selected}
            onClick={() => {
              if (beltTier !== null) onBeltPlacementChange(selected ? null : beltTier);
              else onPlacementChange(selected ? null : row.buildingId);
            }}
            title={knownNonBuilding
              ? `${label}尚未接入这条单栋建筑放置命令`
              : beltTier !== null
                ? `${label}：选择后拖动同物品输出端口到普通输入端口；每次只提交一条线路`
              : `${label}将由 Rust 在落点时重新检查库存、科技、行星和建筑模板`}
          >
            <i><ConstructionMark buildingId={row.buildingId} /></i>
            <span>{label}</span>
            <strong>×<QuantityValue value={row.amount} interactive={false} /></strong>
          </button>
        </div>;
      })}
    </div>
    <div className="native-construction-dock__management" aria-label="Windows 原生施工库存管理">
      <button type="button" disabled={pending || !onOpenFabricator} onClick={onOpenFabricator}><Hammer size={13} />基础制造</button>
      {rows.filter((row) => row.amount > 0).map((row) => <button
        className="danger"
        type="button"
        key={`delete:${row.buildingId}`}
        disabled={pending || !onDeleteConstruction}
        onClick={() => onDeleteConstruction?.(row.buildingId)}
        title={`永久删除${constructionLabel(directory, row.buildingId)}施工库存`}
        aria-label={`永久删除${constructionLabel(directory, row.buildingId)}施工库存`}
      ><Trash2 size={12} />删除 {constructionLabel(directory, row.buildingId)}</button>)}
    </div>
    <p className="native-construction-dock__notice">
      数据型建筑可单栋放置，已注册线路可单条连接；每次都会重新向 Rust 申请凭证并原子扣料。连续批量拉线和特殊物流端口使用独立原子命令。
    </p>
  </footer>;
}
