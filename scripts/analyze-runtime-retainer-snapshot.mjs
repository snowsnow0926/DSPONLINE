import { open } from "node:fs/promises";
import { resolve } from "node:path";

const snapshotPath = resolve(process.argv[2] ?? "artifacts/performance/v119-retainer-path-snapshot-60s.json.heapsnapshot");
const requestedLabel = process.argv[3] ?? "reactflow-next-nodes";
const requestedMarkerIndex = Math.max(0, Number(process.argv[4] ?? 0));

const READ_BUFFER_BYTES = 8 * 1024 * 1024;

async function findToken(fileHandle, startPosition, token) {
  const needle = Buffer.from(token);
  const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
  let carry = Buffer.alloc(0);
  let position = startPosition;
  while (true) {
    const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) throw new Error(`could not find ${token}`);
    const chunk = buffer.subarray(0, bytesRead);
    const combined = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
    const index = combined.indexOf(needle);
    if (index >= 0) return position - carry.length + index + needle.length;
    carry = Buffer.from(combined.subarray(Math.max(0, combined.length - needle.length + 1)));
    position += bytesRead;
  }
}

async function readNumericArray(fileHandle, startPosition, target, label) {
  const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
  let position = startPosition;
  let outputIndex = 0;
  let value = 0;
  let hasValue = false;
  let nextProgress = 10_000_000;
  while (true) {
    const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) throw new Error(`${label} ended before closing bracket`);
    for (let index = 0; index < bytesRead; index += 1) {
      const byte = buffer[index];
      if (byte >= 48 && byte <= 57) {
        value = value * 10 + byte - 48;
        hasValue = true;
        continue;
      }
      if (byte !== 44 && byte !== 93 && byte !== 10 && byte !== 13 && byte !== 32 && byte !== 9) {
        throw new Error(`${label} contains unexpected byte ${byte} at ${position + index}`);
      }
      if (hasValue) {
        if (outputIndex >= target.length) throw new Error(`${label} contains more values than declared`);
        target[outputIndex] = value;
        outputIndex += 1;
        value = 0;
        hasValue = false;
        if (outputIndex >= nextProgress) {
          process.stderr.write(`${label}: ${outputIndex.toLocaleString()} / ${target.length.toLocaleString()} values\n`);
          nextProgress += 10_000_000;
        }
      }
      if (byte === 93) {
        if (outputIndex !== target.length) {
          throw new Error(`${label} value count mismatch: ${outputIndex} !== ${target.length}`);
        }
        return position + index + 1;
      }
    }
    position += bytesRead;
  }
}

async function readStringArray(fileHandle, startPosition) {
  const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
  const values = [];
  let position = startPosition;
  let inString = false;
  let escaped = false;
  let tokenStart = 0;
  let tokenParts = [];
  let nextProgress = 250_000;
  while (true) {
    const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) throw new Error("strings ended before closing bracket");
    for (let index = 0; index < bytesRead; index += 1) {
      const byte = buffer[index];
      if (!inString) {
        if (byte === 34) {
          inString = true;
          escaped = false;
          tokenStart = index;
          tokenParts = [];
        } else if (byte === 93) {
          return values;
        }
        continue;
      }
      if (escaped) {
        escaped = false;
      } else if (byte === 92) {
        escaped = true;
      } else if (byte === 34) {
        const finalPart = Buffer.from(buffer.subarray(tokenStart, index + 1));
        const token = tokenParts.length > 0 ? Buffer.concat([...tokenParts, finalPart]) : finalPart;
        values.push(JSON.parse(token.toString("utf8")));
        inString = false;
        if (values.length >= nextProgress) {
          process.stderr.write(`strings: ${values.length.toLocaleString()} values\n`);
          nextProgress += 250_000;
        }
      }
    }
    if (inString) {
      tokenParts.push(Buffer.from(buffer.subarray(tokenStart, bytesRead)));
      tokenStart = 0;
    }
    position += bytesRead;
  }
}

async function loadSnapshot(path) {
  const fileHandle = await open(path, "r");
  try {
    const prefixBuffer = Buffer.allocUnsafe(1024 * 1024);
    const { bytesRead } = await fileHandle.read(prefixBuffer, 0, prefixBuffer.length, 0);
    const prefix = prefixBuffer.subarray(0, bytesRead);
    const nodeToken = Buffer.from('"nodes":[');
    const nodeTokenIndex = prefix.indexOf(nodeToken);
    if (nodeTokenIndex < 0) throw new Error("nodes token was not found in the snapshot prefix");
    const headerText = prefix.subarray(0, nodeTokenIndex).toString("utf8").replace(/,\s*$/, "") + "}";
    const header = JSON.parse(headerText);
    const meta = header.snapshot.meta;
    const nodeValueCount = header.snapshot.node_count * meta.node_fields.length;
    const edgeValueCount = header.snapshot.edge_count * meta.edge_fields.length;
    process.stderr.write(`allocating typed arrays for ${header.snapshot.node_count.toLocaleString()} nodes and ${header.snapshot.edge_count.toLocaleString()} edges\n`);
    const nodes = new Uint32Array(nodeValueCount);
    const edges = new Uint32Array(edgeValueCount);
    const nodesEnd = await readNumericArray(fileHandle, nodeTokenIndex + nodeToken.length, nodes, "nodes");
    const edgesStart = await findToken(fileHandle, nodesEnd, '"edges":[');
    const edgesEnd = await readNumericArray(fileHandle, edgesStart, edges, "edges");
    const stringsStart = await findToken(fileHandle, edgesEnd, '"strings":[');
    const strings = await readStringArray(fileHandle, stringsStart);
    return { snapshot: header.snapshot, nodes, edges, strings };
  } finally {
    await fileHandle.close();
  }
}

const snapshot = await loadSnapshot(snapshotPath);
const meta = snapshot.snapshot.meta;
const nodes = snapshot.nodes;
const edges = snapshot.edges;
const strings = snapshot.strings;
const nodeFields = meta.node_fields;
const edgeFields = meta.edge_fields;
const nodeTypes = meta.node_types[0];
const edgeTypes = meta.edge_types[0];
const nodeFieldCount = nodeFields.length;
const edgeFieldCount = edgeFields.length;
const nodeCount = nodes.length / nodeFieldCount;
const typeOffset = nodeFields.indexOf("type");
const nameOffset = nodeFields.indexOf("name");
const idOffset = nodeFields.indexOf("id");
const selfSizeOffset = nodeFields.indexOf("self_size");
const edgeCountOffset = nodeFields.indexOf("edge_count");
const edgeTypeOffset = edgeFields.indexOf("type");
const edgeNameOffset = edgeFields.indexOf("name_or_index");
const edgeTargetOffset = edgeFields.indexOf("to_node");
const markerStringIndex = strings.indexOf("__dspRetentionDiagnostic");

if (markerStringIndex < 0) throw new Error("snapshot has no retention markers");

const edgeStarts = new Uint32Array(nodeCount + 1);
let runningEdgeOffset = 0;
for (let ordinal = 0; ordinal < nodeCount; ordinal += 1) {
  edgeStarts[ordinal] = runningEdgeOffset;
  runningEdgeOffset += nodes[ordinal * nodeFieldCount + edgeCountOffset] * edgeFieldCount;
}
edgeStarts[nodeCount] = runningEdgeOffset;

function nodeInfo(ordinal) {
  const offset = ordinal * nodeFieldCount;
  return {
    ordinal,
    id: nodes[offset + idOffset],
    type: nodeTypes[nodes[offset + typeOffset]],
    name: strings[nodes[offset + nameOffset]],
    selfSize: nodes[offset + selfSizeOffset],
    edgeCount: nodes[offset + edgeCountOffset],
  };
}

function edgeName(edgeOffset) {
  const type = edgeTypes[edges[edgeOffset + edgeTypeOffset]];
  const value = edges[edgeOffset + edgeNameOffset];
  return type === "element" || type === "hidden" ? String(value) : strings[value];
}

function outgoing(ordinal) {
  const result = [];
  for (let edgeOffset = edgeStarts[ordinal]; edgeOffset < edgeStarts[ordinal + 1]; edgeOffset += edgeFieldCount) {
    result.push({
      type: edgeTypes[edges[edgeOffset + edgeTypeOffset]],
      name: edgeName(edgeOffset),
      target: edges[edgeOffset + edgeTargetOffset] / nodeFieldCount,
    });
  }
  return result;
}

function markerValue(markerOrdinal, property) {
  const edge = outgoing(markerOrdinal).find((candidate) => candidate.name === property);
  return edge ? nodeInfo(edge.target).name : null;
}

const marked = [];
for (let ordinal = 0; ordinal < nodeCount; ordinal += 1) {
  for (let edgeOffset = edgeStarts[ordinal]; edgeOffset < edgeStarts[ordinal + 1]; edgeOffset += edgeFieldCount) {
    if (edges[edgeOffset + edgeTypeOffset] === edgeTypes.indexOf("property") &&
      edges[edgeOffset + edgeNameOffset] === markerStringIndex) {
      const markerOrdinal = edges[edgeOffset + edgeTargetOffset] / nodeFieldCount;
      marked.push({
        source: ordinal,
        marker: markerOrdinal,
        label: markerValue(markerOrdinal, "label"),
        sequence: Number(markerValue(markerOrdinal, "sequence")),
      });
    }
  }
}

const markerSummary = Object.fromEntries([...new Set(marked.map((entry) => entry.label))].sort().map((label) => {
  const entries = marked.filter((entry) => entry.label === label).sort((left, right) => nodeInfo(left.source).id - nodeInfo(right.source).id);
  return [label, {
    count: entries.length,
    sourceIds: entries.map((entry) => nodeInfo(entry.source).id),
    sourceTypes: [...new Set(entries.map((entry) => `${nodeInfo(entry.source).type}:${nodeInfo(entry.source).name}`))],
  }];
}));
console.log(JSON.stringify({ snapshotPath, nodeCount, edgeCount: edges.length / edgeFieldCount, markerSummary }, null, 2));

const candidates = marked
  .filter((entry) => entry.label === requestedLabel)
  .sort((left, right) => nodeInfo(left.source).id - nodeInfo(right.source).id);
const selected = candidates[Math.min(requestedMarkerIndex, Math.max(0, candidates.length - 1))];
if (!selected) throw new Error(`no marker found for ${requestedLabel}`);
console.log("SELECTED", JSON.stringify({ ...selected, sourceNode: nodeInfo(selected.source), markerNode: nodeInfo(selected.marker) }, null, 2));

process.stderr.write("building complete strong incoming-edge index\n");
const weakEdgeTypeIndex = edgeTypes.indexOf("weak");
const incomingCounts = new Uint32Array(nodeCount);
let strongEdgeCount = 0;
for (let source = 0; source < nodeCount; source += 1) {
  for (let edgeOffset = edgeStarts[source]; edgeOffset < edgeStarts[source + 1]; edgeOffset += edgeFieldCount) {
    if (edges[edgeOffset + edgeTypeOffset] === weakEdgeTypeIndex) continue;
    const target = edges[edgeOffset + edgeTargetOffset] / nodeFieldCount;
    incomingCounts[target] += 1;
    strongEdgeCount += 1;
  }
}

const incomingStarts = new Uint32Array(nodeCount + 1);
for (let ordinal = 0; ordinal < nodeCount; ordinal += 1) {
  incomingStarts[ordinal + 1] = incomingStarts[ordinal] + incomingCounts[ordinal];
}
const incomingSources = new Uint32Array(strongEdgeCount);
const incomingEdgeIndexes = new Uint32Array(strongEdgeCount);
const incomingCursor = incomingStarts.slice(0, nodeCount);
for (let source = 0; source < nodeCount; source += 1) {
  for (let edgeOffset = edgeStarts[source]; edgeOffset < edgeStarts[source + 1]; edgeOffset += edgeFieldCount) {
    if (edges[edgeOffset + edgeTypeOffset] === weakEdgeTypeIndex) continue;
    const target = edges[edgeOffset + edgeTargetOffset] / nodeFieldCount;
    const slot = incomingCursor[target];
    incomingCursor[target] += 1;
    incomingSources[slot] = source;
    incomingEdgeIndexes[slot] = edgeOffset / edgeFieldCount;
  }
}

process.stderr.write(`searching ${strongEdgeCount.toLocaleString()} strong edges for the shortest path to ${nodeInfo(0).name}\n`);
const visited = new Uint8Array(nodeCount);
const parentChild = new Int32Array(nodeCount);
parentChild.fill(-1);
const parentIncomingSlot = new Uint32Array(nodeCount);
const queue = new Uint32Array(nodeCount);
let queueHead = 0;
let queueTail = 1;
queue[0] = selected.source;
visited[selected.source] = 1;
let root = selected.source === 0 ? 0 : null;
while (queueHead < queueTail && root === null) {
  const target = queue[queueHead];
  queueHead += 1;
  for (let slot = incomingStarts[target]; slot < incomingStarts[target + 1]; slot += 1) {
    const source = incomingSources[slot];
    if (visited[source]) continue;
    visited[source] = 1;
    parentChild[source] = target;
    parentIncomingSlot[source] = slot;
    if (source === 0) {
      root = source;
      break;
    }
    queue[queueTail] = source;
    queueTail += 1;
  }
}

if (root !== null) {
  const path = [];
  let current = root;
  while (current !== selected.source) {
    const child = parentChild[current];
    if (child < 0) break;
    const slot = parentIncomingSlot[current];
    const edgeOffset = incomingEdgeIndexes[slot] * edgeFieldCount;
    path.push({
      source: nodeInfo(current),
      edgeType: edgeTypes[edges[edgeOffset + edgeTypeOffset]],
      edgeName: edgeName(edgeOffset),
      target: nodeInfo(child),
    });
    current = child;
  }
  console.log("ROOT_PATH", JSON.stringify({ visited: queueTail, path }, null, 2));
} else {
  console.log("ROOT_PATH", JSON.stringify({ visited: queueTail, path: null }, null, 2));
}
