// Operator-approved display estimate, not a set of persisted player identities.
// Keep this fixed period and amount when making subsequent releases.
const HONG_KONG_PLAYER_HISTORY = Object.freeze({
  count: 3_700,
  startDate: "2026-08-14",
  endDate: "2026-09-07",
  label: "含历史补偿 3,700",
  description: "含 2026-08-14 至 2026-09-07 历史估算补偿 3,700 人",
});

export function playerDisplayAdjustment(apiBase: string | null, pageUrl: string) {
  if (!apiBase) return null;
  try {
    const api = new URL(apiBase, pageUrl);
    return api.protocol === "https:" && api.hostname === "dsponline.cn"
      && api.pathname.replace(/\/+$/, "") === "/api"
      ? HONG_KONG_PLAYER_HISTORY : null;
  } catch {
    return null;
  }
}
