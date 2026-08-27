use std::ops::Range;
use std::sync::atomic::{AtomicU16, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};

use anyhow::Result;
use rayon::prelude::*;
use rayon::{ThreadPool, ThreadPoolBuilder};

pub(crate) const PARALLEL_MIN_ITEMS: usize = 4_096;
const MAX_WORKERS: usize = 8;
const JOINED_DROP_CHUNKS_PER_WORKER: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct JoinedDropDiagnostics {
    pub worker_count: usize,
    pub chunk_count: usize,
    pub item_count: usize,
    pub parallel: bool,
}

/// One process-lifetime pool shared by every deterministic native-core phase.
/// Indexed Rayon iterators preserve input order; fallible work is collected
/// before errors are inspected so scheduling can never choose which error the
/// caller observes.
pub(crate) struct DeterministicRuntime {
    worker_limit: usize,
    pool: Option<ThreadPool>,
}

pub(crate) fn resolve_worker_limit(requested: Option<&str>, available: usize) -> usize {
    let automatic = available.clamp(1, MAX_WORKERS);
    match requested.map(str::trim) {
        Some("1") => 1,
        Some("2") => 2,
        Some("4") => 4,
        Some("8") => 8,
        None | Some("") | Some("auto") => automatic,
        Some(_) => automatic,
    }
}

impl DeterministicRuntime {
    fn build(worker_limit: usize) -> Result<Self> {
        let worker_limit = worker_limit.clamp(1, MAX_WORKERS);
        let pool = if worker_limit == 1 {
            None
        } else {
            Some(
                ThreadPoolBuilder::new()
                    .num_threads(worker_limit)
                    .thread_name(|index| format!("dsp-native-core-{index}"))
                    .build()?,
            )
        };
        Ok(Self { worker_limit, pool })
    }

    fn serial() -> Self {
        Self {
            worker_limit: 1,
            pool: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn for_test(worker_limit: usize) -> Self {
        assert!(matches!(worker_limit, 1 | 2 | 4 | 8));
        Self::build(worker_limit).expect("test deterministic runtime pool should build")
    }

    pub(crate) fn worker_limit(&self) -> usize {
        self.worker_limit
    }

    pub(crate) fn worker_count_for_items(&self, item_count: usize) -> usize {
        if self.worker_limit == 1 || item_count < PARALLEL_MIN_ITEMS {
            1
        } else {
            self.worker_limit
        }
    }

    pub(crate) fn indexed_map<T, R, F>(&self, values: &[T], map: F) -> Vec<R>
    where
        T: Sync,
        R: Send,
        F: Fn(usize, &T) -> R + Send + Sync,
    {
        if self.worker_count_for_items(values.len()) == 1 {
            return values
                .iter()
                .enumerate()
                .map(|(index, value)| map(index, value))
                .collect();
        }
        self.pool
            .as_ref()
            .expect("parallel deterministic runtime lost its worker pool")
            .install(|| {
                values
                    .par_iter()
                    .enumerate()
                    .map(|(index, value)| map(index, value))
                    .collect()
            })
    }

    pub(crate) fn indexed_try_map<T, R, F>(&self, values: &[T], map: F) -> Result<Vec<R>>
    where
        T: Sync,
        R: Send,
        F: Fn(usize, &T) -> Result<R> + Send + Sync,
    {
        // Do not use Rayon try_collect: its short-circuit winner depends on
        // scheduling. Ordered collection followed by serial Result collection
        // always propagates the lowest failing input index.
        self.indexed_map(values, map).into_iter().collect()
    }

    /// Maps an ascending integer range into its final ordered output buffer.
    /// Parallel failures are retained in a separate bounded slot while a
    /// caller-provided placeholder fills the output position; placeholders
    /// are dropped with the buffer and can never escape an error result. This
    /// avoids a second range-sized `Vec<Result<_>>` while still waiting for all
    /// work and deterministically returning the lowest failing input index.
    pub(crate) fn indexed_try_map_range<R, F, P>(
        &self,
        range: Range<usize>,
        map: F,
        placeholder: P,
    ) -> Result<Vec<R>>
    where
        R: Send,
        F: Fn(usize) -> Result<R> + Send + Sync,
        P: Fn(usize) -> R + Send + Sync,
    {
        let item_count = range.len();
        if self.worker_count_for_items(item_count) == 1 {
            return range.map(map).collect();
        }

        let lowest_error = Mutex::new(None::<(usize, anyhow::Error)>);
        let output = self
            .pool
            .as_ref()
            .expect("parallel deterministic runtime lost its worker pool")
            .install(|| {
                range
                    .into_par_iter()
                    .map(|index| match map(index) {
                        Ok(value) => value,
                        Err(error) => {
                            let mut lowest = lowest_error
                                .lock()
                                .unwrap_or_else(std::sync::PoisonError::into_inner);
                            if lowest
                                .as_ref()
                                .is_none_or(|(lowest_index, _)| index < *lowest_index)
                            {
                                *lowest = Some((index, error));
                            }
                            placeholder(index)
                        }
                    })
                    .collect()
            });
        let lowest_error = lowest_error
            .into_inner()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some((_, error)) = lowest_error {
            Err(error)
        } else {
            Ok(output)
        }
    }

    pub(crate) fn indexed_for_each_mut<T, F>(&self, values: &mut [T], update: F)
    where
        T: Send,
        F: Fn(usize, &mut T) + Send + Sync,
    {
        if self.worker_count_for_items(values.len()) == 1 {
            values
                .iter_mut()
                .enumerate()
                .for_each(|(index, value)| update(index, value));
            return;
        }
        self.pool
            .as_ref()
            .expect("parallel deterministic runtime lost its worker pool")
            .install(|| {
                values
                    .par_iter_mut()
                    .enumerate()
                    .for_each(|(index, value)| update(index, value));
            });
    }

    /// Destroys two retired, destructor-order-independent batches before
    /// returning. Large batches transfer every item into fixed ownership
    /// chunks on this runtime's existing pool; `install` joins all chunks, so
    /// neither a response nor process shutdown can race a remaining drop.
    ///
    /// `fold_chunks` avoids allocating a temporary `Vec` for every chunk. The
    /// two input allocations are consumed by their indexed parallel iterators
    /// and are also gone before this method returns.
    pub(crate) fn drop_owned_joined<T: Send>(
        &self,
        first: Vec<T>,
        second: Vec<T>,
    ) -> JoinedDropDiagnostics {
        let item_count = first.len().saturating_add(second.len());
        if item_count == 0 {
            drop(first);
            drop(second);
            return JoinedDropDiagnostics {
                worker_count: 0,
                chunk_count: 0,
                item_count: 0,
                parallel: false,
            };
        }
        if self.worker_limit == 1 || item_count < PARALLEL_MIN_ITEMS {
            drop(first);
            drop(second);
            return JoinedDropDiagnostics {
                worker_count: 1,
                chunk_count: 1,
                item_count,
                parallel: false,
            };
        }

        #[derive(Default)]
        struct ChunkObservation {
            worker_index: Option<usize>,
            item_count: usize,
        }

        let target_chunks = self
            .worker_limit
            .saturating_mul(JOINED_DROP_CHUNKS_PER_WORKER);
        let chunk_size = item_count.div_ceil(target_chunks).max(1);
        let worker_mask = AtomicU16::new(0);
        let observed_chunks = AtomicUsize::new(0);
        let observed_items = AtomicUsize::new(0);
        self.pool
            .as_ref()
            .expect("parallel deterministic runtime lost its worker pool")
            .install(|| {
                first
                    .into_par_iter()
                    .chain(second.into_par_iter())
                    .fold_chunks(
                        chunk_size,
                        ChunkObservation::default,
                        |mut observation, value| {
                            if observation.item_count == 0 {
                                observation.worker_index = rayon::current_thread_index();
                            }
                            observation.item_count += 1;
                            drop(value);
                            observation
                        },
                    )
                    .for_each(|observation| {
                        if let Some(worker_index) = observation.worker_index {
                            worker_mask.fetch_or(1_u16 << worker_index, Ordering::Relaxed);
                        }
                        observed_chunks.fetch_add(1, Ordering::Relaxed);
                        observed_items.fetch_add(observation.item_count, Ordering::Relaxed);
                    });
            });

        let observed_items = observed_items.load(Ordering::Relaxed);
        debug_assert_eq!(observed_items, item_count);
        JoinedDropDiagnostics {
            worker_count: worker_mask.load(Ordering::Relaxed).count_ones() as usize,
            chunk_count: observed_chunks.load(Ordering::Relaxed),
            item_count: observed_items,
            parallel: true,
        }
    }

    #[cfg(test)]
    fn worker_names(&self) -> Vec<String> {
        self.pool.as_ref().map_or_else(Vec::new, |pool| {
            pool.broadcast(|_| {
                std::thread::current()
                    .name()
                    .unwrap_or("unnamed")
                    .to_owned()
            })
        })
    }
}

pub(crate) fn runtime() -> &'static DeterministicRuntime {
    static RUNTIME: OnceLock<DeterministicRuntime> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        let available = std::thread::available_parallelism()
            .map(usize::from)
            .unwrap_or(1);
        let requested = std::env::var("DSP_NATIVE_CORE_THREADS").ok();
        let worker_limit = resolve_worker_limit(requested.as_deref(), available);
        DeterministicRuntime::build(worker_limit).unwrap_or_else(|_| DeterministicRuntime::serial())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use std::sync::Arc;
    use std::time::Instant;

    #[test]
    fn documented_limits_build_one_bounded_named_pool() {
        for worker_limit in [1, 2, 4, 8] {
            let runtime = DeterministicRuntime::for_test(worker_limit);
            assert_eq!(runtime.worker_limit(), worker_limit);
            let names = runtime.worker_names();
            if worker_limit == 1 {
                assert!(names.is_empty());
            } else {
                assert_eq!(names.len(), worker_limit);
                assert!(
                    names
                        .iter()
                        .all(|name| name.starts_with("dsp-native-core-"))
                );
                names.iter().enumerate().for_each(|(index, name)| {
                    assert_eq!(name, &format!("dsp-native-core-{index}"));
                });
            }
        }
    }

    #[test]
    fn worker_selection_supports_auto_fixed_and_quiet_one() {
        assert_eq!(resolve_worker_limit(None, 1), 1);
        assert_eq!(resolve_worker_limit(None, 16), 8);
        assert_eq!(resolve_worker_limit(Some("auto"), 6), 6);
        assert_eq!(resolve_worker_limit(Some(" auto "), 16), 8);
        assert_eq!(resolve_worker_limit(Some("1"), 16), 1);
        assert_eq!(resolve_worker_limit(Some("2"), 1), 2);
        assert_eq!(resolve_worker_limit(Some("4"), 1), 4);
        assert_eq!(resolve_worker_limit(Some("8"), 1), 8);
        assert_eq!(resolve_worker_limit(Some("invalid"), 3), 3);
    }

    #[test]
    fn indexed_output_is_ordered_and_reports_the_lowest_error_index() {
        let runtime = DeterministicRuntime::for_test(8);
        let values = (0..PARALLEL_MIN_ITEMS + 257).collect::<Vec<_>>();
        let ordered = runtime.indexed_map(&values, |index, value| {
            if index.is_multiple_of(127) {
                std::thread::yield_now();
            }
            (*value, index)
        });
        assert!(
            ordered
                .iter()
                .enumerate()
                .all(|(index, &(value, observed_index))| value == index && observed_index == index)
        );

        let error = runtime
            .indexed_try_map(&values, |index, value| {
                if matches!(index, 17 | 4_100) {
                    anyhow::bail!("failure-at-{index}");
                }
                Ok(*value)
            })
            .unwrap_err();
        assert_eq!(error.to_string(), "failure-at-17");
    }

    #[test]
    fn indexed_try_map_range_preserves_non_zero_start_order_at_every_worker_limit() {
        let start = 73_usize;
        let end = start + PARALLEL_MIN_ITEMS + 257;
        for worker_limit in [1, 2, 4, 8] {
            let runtime = DeterministicRuntime::for_test(worker_limit);
            let placeholder_calls = Arc::new(AtomicUsize::new(0));
            let placeholder_calls_for_map = Arc::clone(&placeholder_calls);
            let ordered = runtime
                .indexed_try_map_range(
                    start..end,
                    |index| {
                        if index.is_multiple_of(127) {
                            std::thread::yield_now();
                        }
                        Ok(index)
                    },
                    move |index| {
                        placeholder_calls_for_map.fetch_add(1, Ordering::SeqCst);
                        index
                    },
                )
                .unwrap();

            assert_eq!(ordered, (start..end).collect::<Vec<_>>());
            assert_eq!(placeholder_calls.load(Ordering::SeqCst), 0);
        }
    }

    #[derive(Debug)]
    struct RangeDropProbe {
        _index: usize,
        dropped: Arc<AtomicUsize>,
    }

    impl Drop for RangeDropProbe {
        fn drop(&mut self) {
            self.dropped.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[test]
    fn indexed_try_map_range_waits_for_all_parallel_work_and_drops_error_output() {
        let start = 101_usize;
        let item_count = PARALLEL_MIN_ITEMS + 257;
        let end = start + item_count;
        let first_failure = start + 17;
        let second_failure = start + 4_100;

        for worker_limit in [2, 4, 8] {
            let runtime = DeterministicRuntime::for_test(worker_limit);
            let map_calls = Arc::new(AtomicUsize::new(0));
            let placeholder_calls = Arc::new(AtomicUsize::new(0));
            let dropped = Arc::new(AtomicUsize::new(0));
            let map_calls_for_map = Arc::clone(&map_calls);
            let dropped_for_map = Arc::clone(&dropped);
            let placeholder_calls_for_map = Arc::clone(&placeholder_calls);
            let dropped_for_placeholder = Arc::clone(&dropped);

            let error = runtime
                .indexed_try_map_range(
                    start..end,
                    move |index| {
                        map_calls_for_map.fetch_add(1, Ordering::SeqCst);
                        if index.is_multiple_of(31) {
                            std::thread::yield_now();
                        }
                        if matches!(index, value if value == first_failure || value == second_failure)
                        {
                            anyhow::bail!("failure-at-{index}");
                        }
                        Ok(RangeDropProbe {
                            _index: index,
                            dropped: Arc::clone(&dropped_for_map),
                        })
                    },
                    move |index| {
                        placeholder_calls_for_map.fetch_add(1, Ordering::SeqCst);
                        RangeDropProbe {
                            _index: index,
                            dropped: Arc::clone(&dropped_for_placeholder),
                        }
                    },
                )
                .unwrap_err();

            assert_eq!(error.to_string(), format!("failure-at-{first_failure}"));
            assert_eq!(map_calls.load(Ordering::SeqCst), item_count);
            assert_eq!(placeholder_calls.load(Ordering::SeqCst), 2);
            assert_eq!(dropped.load(Ordering::SeqCst), item_count);
            assert_eq!(Arc::strong_count(&dropped), 1);
        }
    }

    #[test]
    fn indexed_try_map_range_serial_error_never_calls_placeholder() {
        let runtime = DeterministicRuntime::for_test(1);
        let map_calls = AtomicUsize::new(0);
        let placeholder_calls = AtomicUsize::new(0);
        let error = runtime
            .indexed_try_map_range(
                50..80,
                |index| {
                    map_calls.fetch_add(1, Ordering::SeqCst);
                    if matches!(index, 55 | 70) {
                        anyhow::bail!("failure-at-{index}");
                    }
                    Ok(index)
                },
                |index| {
                    placeholder_calls.fetch_add(1, Ordering::SeqCst);
                    index
                },
            )
            .unwrap_err();

        assert_eq!(error.to_string(), "failure-at-55");
        assert_eq!(map_calls.load(Ordering::SeqCst), 6);
        assert_eq!(placeholder_calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn small_and_quiet_inputs_never_enter_a_rayon_worker() {
        let parallel = DeterministicRuntime::for_test(8);
        let small = parallel.indexed_map(&[1, 2, 3], |_, value| {
            (*value, rayon::current_thread_index())
        });
        assert!(small.iter().all(|(_, worker)| worker.is_none()));

        let quiet = DeterministicRuntime::for_test(1);
        let large = (0..PARALLEL_MIN_ITEMS + 1).collect::<Vec<_>>();
        let observed =
            quiet.indexed_map(&large, |_, value| (*value, rayon::current_thread_index()));
        assert!(observed.iter().all(|(_, worker)| worker.is_none()));

        let mut mutable = large
            .iter()
            .map(|value| (*value, Some(usize::MAX)))
            .collect::<Vec<_>>();
        quiet.indexed_for_each_mut(&mut mutable, |index, slot| {
            assert_eq!(index, slot.0);
            slot.1 = rayon::current_thread_index();
        });
        assert!(mutable.iter().all(|(_, worker)| worker.is_none()));
    }

    #[test]
    fn injected_pool_never_exposes_more_than_its_worker_limit() {
        for worker_limit in [2, 4, 8] {
            let runtime = DeterministicRuntime::for_test(worker_limit);
            let values = (0..PARALLEL_MIN_ITEMS + 257).collect::<Vec<_>>();
            let observed = runtime.indexed_map(&values, |_, _| {
                (
                    rayon::current_num_threads(),
                    std::thread::current()
                        .name()
                        .unwrap_or("unnamed")
                        .to_owned(),
                )
            });
            assert!(observed.iter().all(|(workers, name)| {
                *workers == worker_limit && name.starts_with("dsp-native-core-")
            }));
        }
    }

    struct NestedDropProbe {
        _value: Value,
        dropped: Arc<AtomicUsize>,
    }

    impl Drop for NestedDropProbe {
        fn drop(&mut self) {
            self.dropped.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn nested_drop_probe(index: usize, kind: &str, dropped: &Arc<AtomicUsize>) -> NestedDropProbe {
        NestedDropProbe {
            _value: json!({
                "id": format!("{kind}-{index}"),
                "kind": kind,
                "inventory": {
                    "iron_ore": index,
                    "nested": [{ "count": index + 1 }, { "count": index + 2 }],
                },
                "routes": [
                    { "source": format!("source-{index}"), "items": [index, index + 1] },
                    { "target": format!("target-{index}"), "slots": { "0": index + 2 } },
                ],
            }),
            dropped: Arc::clone(dropped),
        }
    }

    #[test]
    fn joined_drop_is_synchronous_for_nested_entity_and_belt_values_at_every_worker_limit() {
        const REPETITIONS: usize = 3;
        const ENTITY_COUNT: usize = 2_731;
        const BELT_COUNT: usize = PARALLEL_MIN_ITEMS + 257 - ENTITY_COUNT;
        let expected_items = ENTITY_COUNT + BELT_COUNT;

        for worker_limit in [1, 2, 4, 8] {
            let runtime = DeterministicRuntime::for_test(worker_limit);
            let mut elapsed_micros = Vec::with_capacity(REPETITIONS);
            for _ in 0..REPETITIONS {
                let dropped = Arc::new(AtomicUsize::new(0));
                let entities = (0..ENTITY_COUNT)
                    .map(|index| nested_drop_probe(index, "entity", &dropped))
                    .collect::<Vec<_>>();
                let belts = (0..BELT_COUNT)
                    .map(|index| nested_drop_probe(index, "belt", &dropped))
                    .collect::<Vec<_>>();

                let started = Instant::now();
                let diagnostics = runtime.drop_owned_joined(entities, belts);
                elapsed_micros.push(started.elapsed().as_micros());

                assert_eq!(dropped.load(Ordering::SeqCst), expected_items);
                assert_eq!(diagnostics.item_count, expected_items);
                if worker_limit == 1 {
                    assert_eq!(diagnostics.worker_count, 1);
                    assert_eq!(diagnostics.chunk_count, 1);
                    assert!(!diagnostics.parallel);
                } else {
                    assert!((1..=worker_limit).contains(&diagnostics.worker_count));
                    assert!(
                        (worker_limit..=worker_limit * JOINED_DROP_CHUNKS_PER_WORKER)
                            .contains(&diagnostics.chunk_count)
                    );
                    assert!(diagnostics.parallel);
                }
            }
            elapsed_micros.sort_unstable();
            eprintln!(
                "joined-drop-synthetic\tworkers={worker_limit}\titems={expected_items}\tmedian-us={}",
                elapsed_micros[REPETITIONS / 2]
            );
        }
    }

    #[test]
    fn joined_drop_keeps_empty_and_small_batches_serial() {
        let runtime = DeterministicRuntime::for_test(8);
        let empty = runtime.drop_owned_joined::<Value>(Vec::new(), Vec::new());
        assert_eq!(
            empty,
            JoinedDropDiagnostics {
                worker_count: 0,
                chunk_count: 0,
                item_count: 0,
                parallel: false,
            }
        );

        let small = runtime.drop_owned_joined(vec![json!({ "nested": [1, 2, 3] })], Vec::new());
        assert_eq!(small.worker_count, 1);
        assert_eq!(small.chunk_count, 1);
        assert_eq!(small.item_count, 1);
        assert!(!small.parallel);
    }
}
