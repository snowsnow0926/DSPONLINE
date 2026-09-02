# Native planet-metric writer-closure audit

Baseline: `ef6cea199b083a3db33bc51c8c8e2c36b09fcd2d`.

Scope: the session-only cache used by `simple_factory` to probe
`productionRate`, accumulator/exchanger `storedEnergyMj` and capacity,
fuel-generator `fuelRemainingMj` plus the selected fuel input, and the
`machineCount`/planet/building topology needed to interpret those values.
Persisted v47 bytes remain authoritative. The cache never enters a save,
hash, envelope, cloud record, SQLite record, package, or authority decision.

## Closure rule

Every product writer below has one of three explicit outcomes:

1. its exact written entity indexes wake the cache;
2. a command, import, topology change, pure-idle tail, or unclassified writer
   invalidates the cache; or
3. incomplete evidence selects the persisted-order flat full probe.

No writer is covered by inference from a smaller unrelated index. The cached
probe values are always replayed in the historical global entity order with
normal `f64` addition. The optimization is O(active/changed) JSON/catalog
entity probes followed by the required O(all entities) compact scalar replay;
it is not an unordered or delta aggregate.

## `productionRate` writers

| Writer | Product path | Closure evidence |
| --- | --- | --- |
| Renewable power patch | `apply_renewable_power_facility_patch` | `ordinary_settlement_indices` |
| Vein replay | `replay_vein_settlement` | vein outcome entity index, included in `ordinary_settlement_indices` |
| Parallel/inline ordinary machines, including research and Dyson launch recipes | local-machine replay and the historical serial branch in `simulate_step` | `ordinary_settlement_indices` |
| Fuel generators, accumulators, and exchangers | `burn_fuel`, `charge_exchanger`, `discharge_exchanger`, and power-source settlement in `simulate_step` | every topology power-source entity index is included in `ordinary_settlement_indices` |
| Time-warp controller reset | `prepare_time_warp` and controller settlement in `simulate_step` | topology time-warp indexes |
| Material-delivery hubs | both `drain_material_delivery_hubs` phases | exact selected indexes; directory evidence forces full |
| Local station transient reset and buffer transfer | `local_logistics::reset_runtime_for_indices` / `transfer_buffers` | exact reset/changed station indexes; directory evidence forces full |
| Orbital collectors | `interstellar_logistics::run_orbital_collectors` | topology collector indexes; legacy full-scan evidence forces full |
| Construction centers | `construction::run_centers` | exact selected center indexes; directory fallback forces full |
| Ray receivers | `dyson::run_ray_receivers` | reception receiver indexes |
| Orbital cargo terminals | `orbital_station::settle` | topology terminal indexes |
| Quantum supply flush before the barrier | indexed quantum supply flush | exact inventory-written station indexes; directory fallback forces full |
| Belt input before the barrier | first `belts::transfer_with_bandwidth` phase | exact source/target changed-entity indexes |
| Quantum download after the barrier | `quantum_logistics::settle_active_downloads` | inventory-written station indexes remain pending for the next internal step; fallback forces full |
| Belt output after the barrier | second `belts::transfer_with_bandwidth` phase | exact source/target changed-entity indexes remain pending for the next step |
| Material-delivery second phase after the barrier | second `drain_material_delivery_hubs` phase | exact selected indexes remain pending; directory evidence forces full |
| Warper refills | both `interstellar_logistics::refill_station_warpers` phases | exact changed station indexes remain pending; directory evidence forces full |
| Local routes | `local_logistics::advance_routes` | returned changed station indexes remain pending for the next step |
| Interstellar routes | `interstellar_logistics::advance_routes` | returned changed station indexes remain pending for the next step |
| Next-step local runtime reset | post-route station reset list, including collectors | exact reset indexes remain pending for the next step |
| Galactic exporter | `galactic_exports::run` | topology exporter indexes remain pending for the next step |
| Quantum five-second upload boundary | indexed quantum upload flush | exact inventory-written station indexes remain pending; fallback forces full |
| Pure-idle construction tail | `apply_construction_tail_certificate` and final disposable macro candidate | invalidate the candidate cache before publication |

The post-metric rows are deliberately not acknowledged by the current metric
scan. They remain pending against the final committed entity revision and are
re-probed at the next internal step.

## Stored energy, fuel, machine count, and topology

| Dependency | Writers | Closure evidence |
| --- | --- | --- |
| `storedEnergyMj` | accumulator settlement plus `charge_exchanger` / `discharge_exchanger` | power-source entity index |
| `fuelRemainingMj` and selected `inputs[fuelItemId]` | `burn_fuel`; belt input/output movement; player fuel/mode commands | power-source index, belt changed indexes, or command invalidation |
| `machineCount` | placement/stack commands in `command.rs`; no normal simulation writer | every record mutation invalidates and rebuilds admission/topology as required |
| entity ID/kind/building/planet, row count/order | add/remove/generic record patches, placement, load/import/WAL replay | command invalidation or cold full build |
| planet mapping and factory indexes | `CoreState::rebuild_indexes_from_parsed_entities` in `state.rs` | topology rebuild clears the cache; retained topology `Arc` detects same-length COW drift |
| catalog energy/fuel interpretation | immutable catalog `Arc` and registry fingerprint | identity/catalog mismatch or non-empty content-pack registry forces full |

Generic `ValuePatch`/`RecordPatch` application can set or remove arbitrary JSON
paths. `CoreState::apply_command` therefore invalidates this cache for every
record mutation, add, or remove; projection-safe classifications are not used
as planet-metric proof. Load/import starts cold, and WAL mutations pass through
the same command boundary.

A pause-only durable lifecycle command is the sole revision-changing exception:
it changes only the validated top-level `paused` bit and deliberately preserves
all prepared factory domains. The candidate runtime is therefore rebound to the
new committed revision without changing its probes, pending set, or fallback
classification. A post-merge audit found that omitting this rebind made the
revision mismatch permanently sticky as `directory_fallback`; the regression
now warms the cache, pauses, resumes, advances five internal steps, and requires
all five scans to remain sparse.

## Proven non-writers after the metric barrier

The five-second station mode transition writes only operation/mode transition
fields. Quantum transition writes quantum mode/transition state. System-space
construction mutates inputs only on the exact launcher building, which cannot
be a fuel generator. System-space hub settlement can mutate the exact elevator
entity's inputs/outputs as well as base-level hub/network records, but the
elevator building class is disjoint from all three fuel-generator building
IDs. Quantum upload changes endpoint output/runtime fields. None currently
writes a metric dependency. A future unclassified field writer must force flat
full until this table is updated.

## Stable flat-full conditions

The runtime selects the actual full entity range when cold or when any of the
following evidence is incomplete:

- entity count/order/identity, planet count/order, retained topology `Arc`,
  catalog/registry identity, or cache vector shape differs;
- an index is invalid or writer evidence is lost;
- a MOD/opaque key or non-empty content-pack registry is present;
- an orbital, quantum, construction, material-delivery, or other contributing
  directory reports incomplete directory/index evidence;
- the changed set reaches the 3/4 dense threshold;
- a command, import, topology change, or pure-idle tail invalidated the cache.

The test-only flat-full oracle bypasses indexed selection entirely. It is not a
request to the cache to select every row.

## Transaction and error ordering

Selection observes a candidate-local pending snapshot. Probe and validation
finish before that snapshot is acknowledged, so later wakes cannot be erased.
The prepared runtime is owned through `Arc`; `Arc::make_mut` gives the candidate
a private mutation boundary. The source cache, pending set, entity bytes, and
hash remain unchanged if probing or any later simulation/campaign/summary stage
fails. The candidate runtime is installed only after `commit_simulated_state`
succeeds. Parallel probing retains the lowest failing entity index, matching
the former flat scan.
