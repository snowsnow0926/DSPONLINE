import { Factory, LockKeyhole, Route } from "lucide-react";
import { useMemo } from "react";
import { CONSTRUCTION } from "../game/content";
import type { NativeConstructionInventoryFrame } from "../game/nativeConstructionInventoryStore";
import { QuantityValue } from "./QuantityValue";

interface NativeConstructionDockProps {
  frame: NativeConstructionInventoryFrame | null;
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
 * A deliberately read-only construction tray. It consumes only the bounded
 * Rust projection; placement remains disabled until its command can be
 * checked atomically with the construction decrement and topology mutation.
 */
export function NativeConstructionDock({ frame }: NativeConstructionDockProps) {
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
    data-native-construction-read-only="true"
    aria-label="Windows 原生施工库存"
  >
    <div className="dock-label">
      <div className="dock-summary">
        <span>施工托盘</span>
        <strong><QuantityValue value={frame.totalAmount} interactive={false} /></strong>
      </div>
      <div className="dock-mode-buttons">
        <span role="status"><LockKeyhole size={12} />Rust 权威 · 只读</span>
      </div>
    </div>
    <div className="construction-items">
      {rows.length === 0 ? <div className="construction-item-shell">
        <span className="construction-item" role="status">当前没有施工库存</span>
      </div> : rows.map((row) => <div className="construction-item-shell" key={row.buildingId}>
        <button
          className="construction-item"
          type="button"
          disabled
          title={`${constructionLabel(directory, row.buildingId)}库存已由 Rust 确认；原生放置命令尚未闭合`}
        >
          <i><ConstructionMark buildingId={row.buildingId} /></i>
          <span>{constructionLabel(directory, row.buildingId)}</span>
          <strong>×<QuantityValue value={row.amount} interactive={false} /></strong>
        </button>
      </div>)}
    </div>
    <p className="native-construction-dock__notice">
      现在可安全查看完整库存；放置、删除和制造仍保持关闭，避免只改数量却漏改建筑或物料。
    </p>
  </footer>;
}
