export interface CanvasPresentationNode {
  id: string;
  data: { staticPresentation?: boolean };
}

export interface CanvasNodePublication<N extends CanvasPresentationNode> {
  nodes: N[];
  changedNodeCount: number;
  dynamicNodeIds: readonly string[] | null;
}

export function indexCanvasPresentationNodes<N extends { id: string }>(nodes: readonly N[]): Map<string, N> {
  return new Map(nodes.map((node) => [node.id, node]));
}

export function selectCanvasRuntimeRecords<T extends { id: string }>(
  dynamicNodeIds: readonly string[],
  records: ReadonlyMap<string, T>,
): T[] {
  return dynamicNodeIds.flatMap((id) => {
    const record = records.get(id);
    return record ? [record] : [];
  });
}

/**
 * Publish outer React Flow nodes only when presentation/topology changes.
 * Runtime-only derivations normally return the indexed outer node while their
 * data travels through KeyedViewStore; the replacement branch remains a safe
 * fallback if a previously unclassified presentation leaf changes.
 */
export function reconcileCanvasNodePublication<N extends CanvasPresentationNode>(
  current: readonly N[],
  derived: readonly N[],
  fullPresentationRefresh: boolean,
  existing: ReadonlyMap<string, N>,
): CanvasNodePublication<N> {
  if (fullPresentationRefresh) {
    const changedNodeCount = derived.reduce(
      (count, node, index) => count + (node === current[index] ? 0 : 1),
      0,
    );
    return {
      nodes: derived.length === current.length && changedNodeCount === 0 ? current as N[] : [...derived],
      changedNodeCount,
      dynamicNodeIds: derived.flatMap((node) => node.data.staticPresentation ? [] : [node.id]),
    };
  }

  const replacements = new Map(derived
    .filter((node) => node !== existing.get(node.id))
    .map((node) => [node.id, node]));
  return {
    nodes: replacements.size === 0
      ? current as N[]
      : current.map((node) => replacements.get(node.id) ?? node),
    changedNodeCount: replacements.size,
    dynamicNodeIds: null,
  };
}
