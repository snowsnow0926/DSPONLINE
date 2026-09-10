import type { ItemId } from "./types";

type Inventory = Readonly<Partial<Record<ItemId, number>>>;

/** Read-only counterpart of construction's WIP, tray, then quantum consumption. */
export function constructionMaterialsAvailable(
  inventory: Inventory,
  tray: Inventory,
  quantumBuffer: Inventory,
  requirements: ReadonlyArray<{ itemId: ItemId; amount: number }>,
): boolean {
  // Only recipe inputs need a temporary balance. Keep the three sources
  // separate so rounding and repeated material entries match consumption.
  const balances = new Map<ItemId, { inventory: number; tray: number; quantum: number }>();
  for (const requirement of requirements) {
    let balance = balances.get(requirement.itemId);
    if (!balance) {
      balance = {
        inventory: Math.max(0, Math.floor(inventory[requirement.itemId] ?? 0)),
        tray: Math.max(0, Math.floor(tray[requirement.itemId] ?? 0)),
        quantum: Math.max(0, Math.floor(quantumBuffer[requirement.itemId] ?? 0)),
      };
      balances.set(requirement.itemId, balance);
    }
    let remaining = Math.max(0, Math.floor(requirement.amount));
    const fromJob = Math.min(remaining, balance.inventory);
    balance.inventory -= fromJob;
    remaining -= fromJob;
    const fromTray = Math.min(remaining, balance.tray);
    balance.tray -= fromTray;
    remaining -= fromTray;
    if (balance.quantum < remaining) return false;
    balance.quantum -= remaining;
  }
  return true;
}
