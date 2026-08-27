# ADR-008: Windows Performance Edition execution architecture

- Status: in development; not approved for native authority or stable release
- Date: 2026-08-27; evidence updated 2026-08-28
- Compatibility: GameState v47 / envelope v2 / cloud schema v8 / SQLite layout v3
- Branch boundary: `codex/windows-full-native-next`

## Context

The 1.2.3 Windows candidate proved exact Rust simulation, durable native chunks,
WAL recovery, bounded projections, and streaming v47 export. It did not prove a
player-visible performance win because JavaScript remained authoritative and the
Rust core still decoded a large JSON object graph and scanned most of 80,674
entities and 155,746 belts every simulated second.

The read-only 76,898,141-byte endgame fixture establishes the development
baseline. On the current Windows 10 / i7-14700KF machine, a fresh release build
produced an exact native step in approximately 2.37 seconds and the matching
JavaScript step in approximately 4.69 seconds during the initial unloaded run.
The native phase profile attributed approximately 1.71 seconds to the factory
step: about 468 ms to power/facility/machine/miner settlement, 454 ms to the two
belt transfers, 131 ms to quantum supply flushing, and the remainder to power,
local logistics, route, and global phases. Record decoding and commit encoding
were material but not the majority.

These numbers are development observations, not release claims. Later samples
on the same machine were heavily affected by an unrelated QEMU workload, so all
final comparisons must use interleaved old/new runs, record the process tree and
fixture/binary hashes, and report median and P95 rather than selecting the best
sample.

## Decisions

### 1. Native authority is an earned gate

The Performance Edition will use the Rust process as the only complete gameplay
state owner only after all of the following are true:

- every enabled gameplay domain, exact offline segment, conservative pure-idle
  contract, and time-warp boundary has native coverage;
- 1/2/4/8/automatic thread schedules produce identical canonical, component,
  field, and domain SHA-256 values;
- a same-revision public v47 recovery point is durably available;
- 24-hour multi-hardware shadow evidence, fault injection, and process-tree
  performance gates pass;
- the player explicitly opts into the invitation channel.

`authorityEligible=false` remains fail-closed until generated evidence closes
those gates. A local UI switch, build flag, or benchmark mode cannot bypass it.
An uncertain authoritative result pauses at the current revision; it does not
silently install an older JavaScript mirror.

### 2. One hot state, not a second JSON DOM

The terminal design is a compact native state with stable integer symbols,
structure-of-arrays scalar columns, flat sparse inventories, compiled route
groups, dirty persistence pages, and cold extension fields. Raw JSON is a
portable import/export and recovery representation, not the per-step execution
model.

A rejected prototype retained the complete `serde_json::Value` graph beside raw
records. On the real fixture it increased native Private Bytes from roughly
290 MB to roughly 1.50 GB and made cold open slower. That design must not return.
The next resident-state change must replace allocations, not duplicate them.

### 3. Compiled deterministic phases

Topology changes compile stable entity, planet, grid, source-group, target-slot,
and reverse wake indexes. An exact step preserves the existing phase order and
all JavaScript-compatible rounding points.

Parallel work is limited to independent read probes or entity-local settlement.
Workers read one immutable phase snapshot and emit index-addressed results.
The coordinator applies results in the original category and entity order.
Unordered reductions, worker-local floating aggregates, route reordering, or a
wider numeric tolerance are forbidden.

The first multicore slice parallelizes power probes. The second computes only
entity-local ordinary-machine input/output cycle ceilings in private indexed
slots; the coordinator still performs every deduction, output addition and
floating aggregate in persisted entity order. Research completion, infinite
research, Dyson launch accounting, shared target capacity, fair route cursors,
quantum inventory, logistics dispatch, construction, and global statistics
remain serial barriers until each has a fixed merge contract. The real fixture
has already matched canonical state at 1/2/4/8 threads for these slices; this is
development evidence, not the outstanding 24-hour/multi-hardware authority gate.

### 4. Dense and sparse factories are separate schedules

The closed wake proof from ADR-007 remains authoritative for sparse networks.
Dense factories may select a full scan when active-queue bookkeeping would cost
more. Full scan is not permission to recreate per-group temporary allocations:
scratch arrays are owned by the runtime and reused while preserving candidate,
target-capacity, cursor, and post-action order.

The real fixture must continue reporting two transfer passes, one reservation
pass, three full-scan passes, 311,492 transfer route checks, and 155,746
reservation checks unless an exact compiled algorithm deliberately replaces
that diagnostic contract.

### 5. Thin Electron is the immediate shell; shell replacement is evidence-led

The current machine can build the hardened Electron shell and Rust sidecar
without installing a new system SDK. Tauri has a usable system toolchain but no
repository integration. WinUI 3 development targets are absent. Therefore:

- the immediate testable Performance Edition keeps Electron as a thin window,
  input, accessibility, account, and update shell;
- simulation, persistence, recovery, projections, and large-file I/O remain in
  the independent Rust process;
- a shell laboratory uses isolated app data, disabled cloud/update endpoints,
  one fixture and one metrics contract;
- Tauri, WinUI 3, or Win32/Direct2D may replace the shell only after an A/B test
  shows at least 15% additional process-tree memory reduction or a material UI
  P95/long-frame improvement without losing IME, accessibility, touch, DPI, or
  recovery behavior.

Changing the shell does not count as simulation throughput improvement.

### 6. Persistence and public compatibility do not change

Native chunks, dirty-page checkpointing, dual superblocks, hash-chained WAL,
streaming v47 export, and explicit ACK semantics remain as accepted in ADR-005
through ADR-007. No new persisted field is required by this decision. Existing
v47 saves remain loadable/exportable/cloud-syncable, and a private native
generation never becomes a cloud or mod API.

### 7. A durable lease fences every normal-main writer before authority experiments

An exact-realtime experiment may not coexist with a generic `normal-main`
writer. The Rust store therefore treats a valid or corrupt durable lease as a
write fence at both transaction admission and publication. The fence also
covers raw/idempotent WAL append, compaction, generic core commit and generic
checkpoint. A transaction admitted before lease preparation is not grandfathered
through the commit boundary.

The only permitted operation while an active lease owns one pending tick is a
separate host-only request carrying the lease identity. Rust derives the fixed
command ID, revision chain, one-second exact budget and null gameplay command
from the durable lease. Renderer and preload expose no corresponding method.
Desktop startup inspects the lease after Host hello and before creating the
normal window; valid or unverifiable state stops normal startup. This safety
mechanism does not constitute authority promotion: the experiment still lacks
the complete public-primary/UI recovery chain and `authorityEligible=false`
remains mandatory.

## Rejected shortcuts

- Retaining a complete parsed JSON graph beside raw records: rejected by the
  1.50 GB Private Bytes result.
- Switching the Windows host to mimalloc without removing allocations: rejected
  after it raised the same fixture's process memory to roughly 1.51 GB and made
  the profiled step slower on this machine.
- Enabling serde_json `preserve_order` as a hot-loop shortcut: rejected by an
  isolated two-by-two real-save A/B. Although it avoids BTree key reordering,
  the exact-step native Private Bytes peak rose from approximately 2.803 GB to
  3.763 GB. It also changed content-addressed checkpoint churn for a
  semantically restored base record, proving that allocation/layout switches
  require persistence evidence as well as canonical equality.
- Increasing active-queue sleeping without new wake evidence: rejected because
  it can delay same-step production.
- Per-second complete `GameState` IPC: rejected because it restores the memory
  and serialization peak outside Rust.
- Unordered parallel reduction or approximate hashes: rejected because it can
  change one-ULP boundaries and diverge from persisted JavaScript semantics.
- Enabling native authority for benchmarks: rejected because benchmark support
  is not gameplay coverage or recovery evidence.

## Required evidence

Every optimization batch must record:

- Git/build identity, host binary SHA-256, fixture SHA-256, OS/CPU/RAM/GPU, power
  plan, remote-session state, and known background load;
- exact canonical equality and unchanged source file size, mtime, and SHA-256;
- 1/2/4/8/automatic thread results where concurrency changed;
- native step P50/P95, per-phase P50/P95, process-tree Private Bytes P50/P95 and
  peak, save/export/import P95, IPC bytes, and UI frame P50/P95/P99;
- failure, cancellation, host restart, WAL retry, disk-full/read-only, and
  checkpoint hash-continuity outcomes.

Final Windows artifacts additionally require the desktop release matrix,
isolated launch smoke, upgrade/rollback evidence, code signing, Defender and
three hardware tiers. Missing external evidence is reported as a blocker or
residual risk, never converted into a pass.

## Consequences

- Development can improve the current Rust core and ship a testable thin-shell
  laboratory without pretending the final WinUI or native-authority gates are
  complete.
- Failed performance experiments are preserved as architecture evidence and
  removed from the candidate code.
- The main engineering target is less work per simulated second and fewer live
  allocations; moving the same work between processes is insufficient.
- Version and public release identity are chosen only after the performance and
  compatibility gates close. This branch does not silently claim 1.2.4 or 2.0.0.

## 2026-08-28 measured implementation note

The E18 candidate replaced additional hot JSON/object churn in entity and belt
writeback, production history, quantum logistics and local logistics. Its local
peer directory is immutable within a topology revision and is rebuilt only
after a topology-changing command or a five-second elevator-mode boundary.

On the immutable 76,898,141-byte fixture, the frozen public 1.2.3 Host and E18
both matched JavaScript for a one-second exact step. Three interleaved samples
measured median native step `2,631.08 -> 1,651.42 ms` and median step Private
Bytes delta `1,327,386,624 -> 960,110,592 B`. Open peak fell about 35.33%.
The E18 thread matrix completed 15/15 cells with one canonical hash; automatic
threads were 57.81% faster than one thread on this machine.

The frozen public Host did not match JavaScript after the full benchmark's
three consecutive one-second burst, so the paired full-workflow A/B was aborted
and has no valid performance percentage. E18 completed the same full workflow
in three independent processes with exact durable/checkpoint/burst evidence.
This is stronger local correctness evidence, but it does not close 24-hour,
multi-hardware, code-signing, public-primary or player-visible authority gates.
