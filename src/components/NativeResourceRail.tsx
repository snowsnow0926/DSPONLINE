import { Box, PackageOpen } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ITEMS, PLANETS } from "../game/content";
import type { NativeFactoryInventoryFrame } from "../game/nativeFactoryInventoryStore";
import type { DraggedItemSourceKind, ItemDefinition, ItemId, PlanetDefinition } from "../game/types";
import { getAccessibleItemGlyphTextColor, ItemGlyph, ItemHoverCard } from "./ItemReference";
import { QuantityValue } from "./QuantityValue";

interface NativeResourceRailProps {
  frame: NativeFactoryInventoryFrame | null;
  pending: boolean;
  onPickTray: (itemId: string) => void;
  onDropCargo: () => void;
  onStowEntityInventory: (
    itemId: ItemId,
    sourceKind: Extract<DraggedItemSourceKind, "node" | "node-input">,
    sourceId: string,
  ) => void;
  onSetTrayItemLimit: (value: number) => void;
}

const ITEM_DIRECTORY = ITEMS as unknown as Record<string, ItemDefinition | undefined>;
const PLANET_DIRECTORY = PLANETS as unknown as Record<string, PlanetDefinition | undefined>;

function NativeItemMark({ itemId }: { itemId: string }) {
  const item = ITEM_DIRECTORY[itemId];
  if (!item) {
    return <i className="item-glyph item-glyph--solid item-mark" aria-label={itemId}>?</i>;
  }
  return <ItemHoverCard itemId={itemId as ItemId}>
    <ItemGlyph itemId={itemId as ItemId} className="item-mark" />
  </ItemHoverCard>;
}

function itemLabel(itemId: string): string {
  return ITEM_DIRECTORY[itemId]?.name ?? itemId;
}

function NativeCargoMark({ itemId }: { itemId: string }) {
  const item = ITEM_DIRECTORY[itemId];
  if (!item) return <i className="item-glyph item-glyph--solid">?</i>;
  return <i
    className={`item-glyph item-glyph--${item.kind}`}
    style={{ backgroundColor: item.color, color: getAccessibleItemGlyphTextColor(item.color) }}
  >{item.symbol}</i>;
}

export function NativeResourceRail({
  frame,
  pending,
  onPickTray,
  onDropCargo,
  onStowEntityInventory,
  onSetTrayItemLimit,
}: NativeResourceRailProps) {
  const [trayLimitDraft, setTrayLimitDraft] = useState(frame ? String(frame.trayItemLimit) : "1000000");
  const [trayLimitError, setTrayLimitError] = useState<string | null>(null);
  const frameRef = useRef(frame);
  frameRef.current = frame;
  useEffect(() => {
    if (!frame) return;
    setTrayLimitDraft(String(frame.trayItemLimit));
    setTrayLimitError(null);
  }, [frame?.activePlanetId, frame?.revision, frame?.trayItemLimit]);
  const planet = frame ? PLANET_DIRECTORY[frame.activePlanetId] : null;
  const cargoIsPortable = frame?.cargo && ["logistics_drone", "logistics_vessel"].includes(frame.cargo.itemId);
  const disabled = pending || !frame;
  const commitTrayLimit = () => {
    const current = frameRef.current;
    if (!current || pending) return;
    const normalized = trayLimitDraft.trim().replaceAll(",", "");
    if (!/^[0-9]+$/.test(normalized)) {
      setTrayLimitError("请输入十进制正整数，不支持小数、负数或指数格式");
      return;
    }
    const next = Number(normalized);
    if (!Number.isSafeInteger(next) || next < current.trayItemLimitBounds.minimum ||
        next > current.trayItemLimitBounds.maximum) {
      setTrayLimitError("允许范围为 1,000 至 100,000,000");
      return;
    }
    setTrayLimitError(null);
    onSetTrayItemLimit(next);
  };
  const rows = useMemo(() => frame?.rows ?? [], [frame?.rows]);

  return <aside className="resource-rail native-resource-rail" aria-label="Windows 原生物资托盘">
    {!frame ? <section className="rail-block" data-native-authority-unavailable="tray-cargo-v1">
      <div className="rail-heading"><span>当前行星物资</span><strong>原生模式</strong></div>
      <p role="status">正在等待同一 revision 的 Rust 托盘投影；旧网页库存不会显示，也不能参与操作。</p>
    </section> : <>
      <section className={`rail-block cargo-block${frame.cargo ? " rail-block--cargo-drop" : ""}`}>
        <div className="rail-heading">
          <span>{cargoIsPortable ? "随身载具载荷" : frame.cargo ? "手提星际载荷" : "光标载荷"}</span>
          <strong>{frame.cargo ? "1 / 1" : "0 / 1"}</strong>
        </div>
        <button
          className={`cargo-slot${frame.cargo ? " cargo-slot--loaded" : ""}`}
          type="button"
          disabled={disabled || !frame.cargo}
          onClick={onDropCargo}
          title={frame.cargo ? "由 Rust 无损放回当前物资库存" : "光标当前未携带物资"}
        >
          {frame.cargo ? <>
            <NativeCargoMark itemId={frame.cargo.itemId} />
            <span>{itemLabel(frame.cargo.itemId)}</span>
            <strong>×<QuantityValue value={frame.cargo.amount} interactive={false} /></strong>
          </> : <><PackageOpen size={18} /><span>空载</span></>}
        </button>
        {frame.cargo && frame.cargo.amount > frame.pickupTargetAmount
          ? <small role="status">历史手持量超过 {frame.pickupTargetAmount}，会原样保留并可整栈放回。</small>
          : null}
      </section>

      <section
        className="rail-block tray-block"
        data-native-entity-stow="same-revision-v1"
        onDragOver={(event) => {
          if (!disabled && event.dataTransfer.types.includes("application/factory-item")) {
            event.preventDefault();
          }
        }}
        onDrop={(event) => {
          if (disabled) return;
          const itemId = event.dataTransfer.getData("application/factory-item") as ItemId;
          const sourceKind = event.dataTransfer.getData("application/factory-source-kind");
          const sourceId = event.dataTransfer.getData("application/factory-source-id");
          if (!itemId || !sourceId || (sourceKind !== "node" && sourceKind !== "node-input")) return;
          event.preventDefault();
          event.stopPropagation();
          onStowEntityInventory(itemId, sourceKind, sourceId);
        }}
      >
        <div className="rail-heading">
          <span>{planet?.code ?? frame.activePlanetId}物资托盘</span>
          <strong>{pending ? "命令确认中" : "Rust 权威"}</strong>
        </div>
        <label className="tray-limit-control">
          <span>单种物资上限</span>
          <input
            type="number"
            min={frame.trayItemLimitBounds.minimum}
            max={frame.trayItemLimitBounds.maximum}
            step={1000}
            inputMode="numeric"
            value={trayLimitDraft}
            disabled={disabled}
            aria-label={`${planet?.name ?? frame.activePlanetId}单种物资上限`}
            onChange={(event) => setTrayLimitDraft(event.target.value)}
            onBlur={commitTrayLimit}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                setTrayLimitDraft(String(frame.trayItemLimit));
                event.currentTarget.blur();
              }
            }}
          />
          <small>1千–1亿</small>
        </label>
        <div className="tray-limit-presets" role="group" aria-label="物资托盘单种物资上限预设">
          {[10_000, 100_000, 1_000_000, 100_000_000].map((value) => <button
            type="button"
            disabled={disabled}
            className={frame.trayItemLimit === value ? "active" : ""}
            key={value}
            onClick={() => {
              setTrayLimitDraft(String(value));
              setTrayLimitError(null);
              onSetTrayItemLimit(value);
            }}
          >{value === 10_000 ? "1万" : value === 100_000 ? "10万" : value === 1_000_000 ? "100万" : "1亿"}</button>)}
        </div>
        {trayLimitError ? <p className="tray-limit-error" role="alert">{trayLimitError}</p> : null}
        <div className="tray-list">
          {rows.length === 0 ? <div className="tray-empty"><Box size={18} /><span>暂无库存</span></div> : rows.map((row) => {
            const mixedCargo = Boolean(frame.cargo && frame.cargo.itemId !== row.itemId);
            const fullCargo = Boolean(frame.cargo && frame.cargo.itemId === row.itemId &&
              frame.cargo.amount >= frame.pickupTargetAmount);
            return <button
              className="tray-row"
              type="button"
              key={row.itemId}
              disabled={disabled || mixedCargo || fullCargo}
              onClick={() => onPickTray(row.itemId)}
              title={row.overLimit
                ? `${itemLabel(row.itemId)}超过当前自动写入上限；现有库存不会删除`
                : `拿取${itemLabel(row.itemId)}`}
            >
              <NativeItemMark itemId={row.itemId} />
              <span>{itemLabel(row.itemId)}</span>
              <strong><QuantityValue value={row.amount} interactive={false} /></strong>
            </button>;
          })}
        </div>
        <p className="native-resource-rail__notice">可将普通建筑输入/输出拖回托盘；站点输出、向建筑投料与永久丢弃仍保持关闭。</p>
      </section>
    </>}
  </aside>;
}
