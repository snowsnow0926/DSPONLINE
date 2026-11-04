export type InspectorSectionId = "recipe" | "stack" | "upgrade" | "proliferator" | "power";

export interface InspectorLayoutPreferenceV1 {
  version: 1;
  order: InspectorSectionId[];
  collapsed: InspectorSectionId[];
}

export const INSPECTOR_LAYOUT_STORAGE_KEY = "dsp-idle-network.inspector-layout.v1";
export const DEFAULT_INSPECTOR_SECTION_ORDER: readonly InspectorSectionId[] = ["recipe", "stack", "upgrade", "proliferator", "power"];

export function normalizeInspectorLayoutPreference(value: unknown): InspectorLayoutPreferenceV1 {
  const source = value && typeof value === "object" ? value as Partial<InspectorLayoutPreferenceV1> : {};
  const known = new Set<InspectorSectionId>(DEFAULT_INSPECTOR_SECTION_ORDER);
  const order = [...new Set((Array.isArray(source.order) ? source.order : []).filter((id): id is InspectorSectionId => known.has(id as InspectorSectionId)))];
  for (const id of DEFAULT_INSPECTOR_SECTION_ORDER) if (!order.includes(id)) order.push(id);
  const collapsed = [...new Set((Array.isArray(source.collapsed) ? source.collapsed : []).filter((id): id is InspectorSectionId => known.has(id as InspectorSectionId)))];
  return { version: 1, order, collapsed };
}

export function readInspectorLayoutPreference(storage?: Pick<Storage, "getItem">): InspectorLayoutPreferenceV1 {
  try {
    const target = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    const raw = target?.getItem(INSPECTOR_LAYOUT_STORAGE_KEY);
    return normalizeInspectorLayoutPreference(raw ? JSON.parse(raw) : null);
  } catch {
    return normalizeInspectorLayoutPreference(null);
  }
}

export function writeInspectorLayoutPreference(preference: InspectorLayoutPreferenceV1, storage?: Pick<Storage, "setItem">): void {
  try {
    const target = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    target?.setItem(INSPECTOR_LAYOUT_STORAGE_KEY, JSON.stringify(normalizeInspectorLayoutPreference(preference)));
  } catch {
    // A UI preference must never interrupt gameplay when storage is unavailable.
  }
}
