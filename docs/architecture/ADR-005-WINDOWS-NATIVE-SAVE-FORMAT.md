# ADR-005: Windows internal save v1

- Status: accepted for 1.2.0 development
- Date: 2026-08-26
- Public compatibility: GameState v47 / envelope v2 remains unchanged

## Decision

Windows desktop builds may maintain a private native save beside the existing
public save. It uses immutable content-addressed chunks, a manifest committed
after its chunks, two alternating checksummed superblocks, and an append-only
WAL with monotonic revisions and command IDs.

The native store lives only under Electron `userData`. Renderer requests name a
validated logical slot; no renderer-controlled path crosses IPC. A native save
is recoverable only from the newest valid superblock whose manifest, chunk root
and contiguous WAL all verify. Recovery fails closed and never silently selects
an older gameplay revision.

During the Windows beta, native and v47-compatible persistence are written from
the same authoritative revision. Success is reported only after both required
writes and readback proofs succeed. The v47 / envelope v2 export remains the
portable rollback boundary for older clients and Web/Android.

## File layout

```text
native-saves/<logical-slot>/
  superblock-a.json
  superblock-b.json
  chunks/<sha256>.zst
  generations/<generation>/manifest.json
  wal/<first>-<last>.wal
  staging/<transaction-id>/...
```

Chunks and manifests are immutable. A transaction publishes its manifest, then
atomically replaces exactly one superblock. Compaction preserves at least two
verified generations and never mutates the active generation in place.

## Threat model

The format must detect partial writes, reordering, truncation, bit flips,
duplicated revisions, stale manifests, path traversal, oversized IPC payloads,
sidecar crashes and renderer crashes. It does not attempt to defend against an
administrator deliberately replacing every generation and its checksums.

## Consequences

- Normal saves append bounded data instead of rebuilding a giant JSON graph.
- A public export still performs an explicit v47 materialization.
- Disk use temporarily includes two generations and WAL; compaction is needed.
- The internal format cannot be treated as a cloud or mod API.

