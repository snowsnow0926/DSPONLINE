import { Factory, LockKeyhole, Route } from "lucide-react";
import { useMemo } from "react";
import { BUILDINGS, CONSTRUCTION } from "../game/content";
import type { NativeConstructionInventoryFrame } from "../game/nativeConstructionInventoryStore";
import { QuantityValue } from "./QuantityValue";

interface NativeConstructionDockProps {
  frame: NativeConstructionInventoryFrame | null;
  selectedBuildingId: string | null;
  pending: boolean;
  onPlacementChange: (buildingId: string | null) => void;
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
  pending,
  onPlacementChange,
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
        <span role="status"><LockKeyhole size={12} />Rust 权威 · 单栋放置</span>
      </div>
    </div>
    <div className="construction-items">
      {rows.length === 0 ? <div className="construction-item-shell">
        <span className="construction-item" role="status">当前没有施工库存</span>
      </div> : rows.map((row) => {
        const knownConstruction = directory.has(row.buildingId);
        const knownBuilding = Object.prototype.hasOwnProperty.call(BUILDINGS, row.buildingId);
        const knownNonBuilding = knownConstruction && !knownBuilding;
        const disabled = pending || row.amount < 1 || knownNonBuilding;
        const selected = selectedBuildingId === row.buildingId;
        const label = constructionLabel(directory, row.buildingId);
        return <div className="construction-item-shell" key={row.buildingId}>
          <button
            className={`construction-item${selected ? " active" : ""}`}
            type="button"
            disabled={disabled}
            aria-pressed={selected}
            onClick={() => onPlacementChange(selected ? null : row.buildingId)}
            title={knownNonBuilding
              ? `${label}尚未接入这条单栋建筑放置命令`
              : `${label}将由 Rust 在落点时重新检查库存、科技、行星和建筑模板`}
          >
            <i><ConstructionMark buildingId={row.buildingId} /></i>
            <span>{label}</span>
            <strong>×<QuantityValue value={row.amount} interactive={false} /></strong>
          </button>
        </div>;
      })}
    </div>
    <p className="native-construction-dock__notice">
      普通建筑可单栋放置；每次落点都会重新向 Rust 申请凭证并原子扣料。线路、批量扩建、删除和制造仍保持关闭。
    </p>
  </footer>;
}
