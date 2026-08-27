# ADR-007: Windows native incremental runtime boundaries

- Status: accepted for the 1.2.3 development candidate
- Date: 2026-08-27
- Compatibility: GameState v47 / envelope v2 / cloud schema v8 / SQLite layout v3

## Context

The 1.2.1/1.2.2 native candidate could reuse an unchanged checkpoint, but an
active simulation revision still encoded broad collections. Native projections
also used JSON control responses, production-history consumers had no bounded
native query, and portable v47 export could force a complete state body back
through the renderer. The 155,746-belt real-save fixture additionally showed
that a scheduler must prove every sleep and wake; treating an empty source as
permanently dormant delays production that completes later in the same step.

## Decision

### Persistence dirtiness

The native core tracks base, entity-page, belt-page, entity-topology, and
belt-topology dirtiness independently from simulation wake state. Entity pages
contain 1,024 persisted records and belt pages contain 2,048. A checkpoint
reuses verified metadata for clean pages and emits only dirty pages plus the new
manifest. Dirtiness is acknowledged only after the host has committed and
verified chunks, manifest, WAL, and the selected superblock. Any error aborts
the pending metadata and leaves the dirty set intact for an exact retry.

This is a private Windows persistence decision. It does not add a GameState
field and does not make the private chunk layout a cloud or mod API.

### Belt scheduling

The belt runtime may select an active route-group queue only when the dormant
share is large enough to repay queue maintenance. Wake evidence includes
current source output, a source capable of producing during the current step,
persisted progress/flow/congestion, reservation allowance, recipe and topology
changes, storage changes, logistics/quantum arrival, and power restoration.
Stable order and existing reservation arithmetic remain authoritative.

When the active share is high, the scheduler runs the existing full scan. The
diagnostic contract exposes transfer/reservation checks, skipped routes,
wakes, sleeps, and full-scan passes. Lowering simulation frequency, capacity,
or legal production is not an accepted optimization.

All quantities keep the existing JavaScript-compatible `f64` semantics,
rounding points, `EPSILON` boundaries, stable record order, and checked integer
revision arithmetic. Cross-language equality is determined by the existing
canonical and domain hashes, not by a wider floating-point tolerance.

### Projection data plane

The native host provides independent `viewport-v1` and `statistics-v1`
projections. Each response is capped at 1 MiB and carries schema, session,
revision, sequence, payload length, projection type, and SHA-256. Renderer and
preload validate identity and digest before parsing. Viewport pages are stable
in persisted entity order and include only belts touching the returned entity
page. Statistics pages read the compact persisted history and never parse
entity or belt records for a query.

Electron `MessagePortMain` cannot transfer arbitrary `ArrayBuffer` ownership in
its transfer list, so this candidate uses a bounded binary structured-clone
block with ACK backpressure. It does not claim shared-memory or zero-copy Gate C.

### Portable export

The Rust core streams envelope v2/GameState v47 directly from native-owned base
and raw records. The legacy UTF-16 FNV-1a checksum, UTF-8 byte length, and file
SHA-256 are computed in the same bounded write pipeline. Electron verifies the
host-owned file and copied temporary file before replacing the user-selected
target. Cancellation and export failure do not mutate the core revision.

### Authority and unimplemented gates

This decision does not promote Rust to player-visible authority. Full native
pure-idle/time-warp coverage, deterministic multi-core settlement, shared-memory
Gate C, 24-hour multi-hardware evidence, signed packaging, and staged rollout
remain prerequisites. `authorityEligible=false` and the shadow-only host-open
contract remain fail-closed.

## Consequences

- Active checkpoints can reuse clean persisted pages and cannot clear dirty
  state before durable commit.
- Sparse dormant belt fixtures can skip work without changing exact hashes;
  dense endgame factories correctly retain full-scan cost.
- Viewport, statistics, and compatible export no longer require an unbounded
  renderer response.
- The candidate improves implementation readiness but cannot honestly be called
  the completed Windows-native authority architecture until the external and
  still-unimplemented gates above are closed.

