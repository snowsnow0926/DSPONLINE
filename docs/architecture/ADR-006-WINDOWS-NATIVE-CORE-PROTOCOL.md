# ADR-006: Windows native core process and protocol

- Status: accepted for 1.2.0 development
- Date: 2026-08-26

## Decision

The native save and simulation core run in an independent Rust process. It is
spawned and supervised only by Electron main. It is not a renderer native addon
and is never loaded into the sandboxed renderer process.

The transport is a bounded binary frame protocol over inherited pipes. Each
frame carries magic, protocol version, kind, request ID, sequence, byte length
and CRC32. Payloads are capped at 8 MiB. Control payloads are JSON; large state
data uses binary frames with explicit backpressure. Renderer-facing IPC exposes
logical operations only and validates sender, identifiers, sizes and state
transitions before forwarding anything.

## Authority states

```text
js-only -> shadow -> native-ready -> native-authoritative
     ^          |          |                 |
     +----------+----------+---- explicit recovery
```

Shadow mode advances JS and Rust from the same verified checkpoint and command
sequence. Every checkpoint compares a canonical root hash plus domain counters.
Any mismatch blocks authority promotion and records a diagnostic. Once promoted,
the native process owns the exact state; renderer and Worker receive projections,
not a second full GameState.

An unexpected native exit pauses at the most recent verified native checkpoint.
The application may recover through the retained JS engine only after exporting
and verifying that exact checkpoint. It must not install an older checkpoint or
hide lost simulation time.

## Rejected alternatives

- A Node native addon in renderer: expands the renderer crash and permission
  boundary and makes rollback harder.
- Base64 payloads over ordinary IPC: creates large transient strings and defeats
  the memory objective.
- Calling the old JavaScript engine from Rust and labeling it native: does not
  satisfy state ownership, throughput or memory gates.

