use std::ops::Range;
use std::sync::atomic::{AtomicU16, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};

use anyhow::Result;
use rayon::prelude::*;
use rayon::{ThreadPool, ThreadPoolBuilder};

pub(crate) const PARALLEL_MIN_ITEMS: usize = 4_096;
/// JSON records and deterministic writeback helpers can build a moderately
/// deep temporary value tree. The Windows default thread stack (roughly
/// 2 MiB) is not sufficient for the largest valid v47 batches and can turn a
/// recoverable candidate into STATUS_STACK_OVERFLOW/STATUS_ACCESS_VIOLATION.
/// Keep the reserve bounded and explicit for every native worker instead of
/// relying on the host process' platform default.
pub(crate) const NATIVE_THREAD_STACK_BYTES: usize = 4 * 1024 * 1024;
const MAX_WORKERS: usize = 8;
const JOINED_DROP_CHUNKS_PER_WORKER: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct JoinedDropDiagnostics {
    pub worker_count: usize,
    pub chunk_count: usize,
    pub item_count: usize,
    pub parallel: bool,
}

/// Diagnostics for one fixed, heterogeneous prepare stage.
///
/// The stage is deliberately separate from authoritative commit. Workers may
/// only produce owned read-only results; callers inspect fallible results and
/// replay them in a fixed serial order after every partition has joined.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PartitionedPrepareDiagnostics {
    pub active_partitions: usize,
    pub work_items: usize,
    pub selected_worker_count: usize,
    pub observed_worker_count: usize,
    pub parallel: bool,
}

/// Diagnostics for one ordered indexed prepare. The observed mask is recorded
/// by the mapping closure itself, so tests can prove that an injected runtime
/// owns the actual row parsing rather than merely reporting its configured
/// worker limit while another global pool performs the work.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct IndexedPrepareDiagnostics {
    pub item_count: usize,
    pub selected_worker_count: usize,
    pub observed_worker_count: usize,
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
                    .stack_size(NATIVE_THREAD_STACK_BYTES)
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

    fn partitioned_prepare_diagnostics(
        &self,
        active_mask: u8,
        work_items: usize,
        worker_mask: &AtomicU16,
        parallel: bool,
    ) -> PartitionedPrepareDiagnostics {
        let active_partitions = active_mask.count_ones() as usize;
        PartitionedPrepareDiagnostics {
            active_partitions,
            work_items,
            selected_worker_count: if active_partitions == 0 {
                0
            } else if parallel {
                self.worker_limit.min(active_partitions)
            } else {
                1
            },
            observed_worker_count: if active_partitions == 0 {
                0
            } else if parallel {
                worker_mask.load(Ordering::Relaxed).count_ones().max(1) as usize
            } else {
                1
            },
            parallel,
        }
    }

    fn partitioned_prepare_is_parallel(&self, active_mask: u8, work_items: usize) -> bool {
        active_mask.count_ones() >= 2 && self.worker_count_for_items(work_items) > 1
    }

    /// Runs four heterogeneous read-only prepare partitions on the bounded
    /// process-lifetime pool. Fixed nesting is part of the scheduler contract:
    /// scheduling may change elapsed time, but the returned tuple always keeps
    /// partition order. Small work and a single active partition remain on the
    /// caller thread so coordination cannot make the common case slower.
    #[allow(clippy::too_many_arguments, clippy::type_complexity)]
    pub(crate) fn partitioned_prepare4<A, B, C, D, FA, FB, FC, FD>(
        &self,
        active_mask: u8,
        work_items: usize,
        first: FA,
        second: FB,
        third: FC,
        fourth: FD,
    ) -> ((A, B, C, D), PartitionedPrepareDiagnostics)
    where
        A: Send,
        B: Send,
        C: Send,
        D: Send,
        FA: FnOnce() -> A + Send,
        FB: FnOnce() -> B + Send,
        FC: FnOnce() -> C + Send,
        FD: FnOnce() -> D + Send,
    {
        const SUPPORTED_MASK: u8 = 0b0000_1111;
        assert_eq!(
            active_mask & !SUPPORTED_MASK,
            0,
            "four-partition prepare mask exceeds its fixed domain"
        );
        let parallel = self.partitioned_prepare_is_parallel(active_mask, work_items);
        let worker_mask = AtomicU16::new(0);
        let mark = |partition: usize| {
            if active_mask & (1 << partition) != 0
                && let Some(worker_index) = rayon::current_thread_index()
            {
                worker_mask.fetch_or(1_u16 << worker_index, Ordering::Relaxed);
            }
        };
        let first = || {
            mark(0);
            first()
        };
        let second = || {
            mark(1);
            second()
        };
        let third = || {
            mark(2);
            third()
        };
        let fourth = || {
            mark(3);
            fourth()
        };
        let values = if parallel {
            let ((first, second), (third, fourth)) = self
                .pool
                .as_ref()
                .expect("parallel deterministic runtime lost its worker pool")
                .install(|| {
                    rayon::join(|| rayon::join(first, second), || rayon::join(third, fourth))
                });
            (first, second, third, fourth)
        } else {
            (first(), second(), third(), fourth())
        };
        let diagnostics =
            self.partitioned_prepare_diagnostics(active_mask, work_items, &worker_mask, parallel);
        (values, diagnostics)
    }

    /// Eight-partition counterpart used by cold factory-domain preparation.
    /// Every closure joins before the result tuple is returned. Callers must
    /// inspect `Result` values in stable partition order; no worker is allowed
    /// to mutate the live CoreState or publish a partial cache.
    #[allow(clippy::too_many_arguments, clippy::type_complexity)]
    pub(crate) fn partitioned_prepare8<A, B, C, D, E, F, G, H, FA, FB, FC, FD, FE, FF, FG, FH>(
        &self,
        active_mask: u8,
        work_items: usize,
        first: FA,
        second: FB,
        third: FC,
        fourth: FD,
        fifth: FE,
        sixth: FF,
        seventh: FG,
        eighth: FH,
    ) -> ((A, B, C, D, E, F, G, H), PartitionedPrepareDiagnostics)
    where
        A: Send,
        B: Send,
        C: Send,
        D: Send,
        E: Send,
        F: Send,
        G: Send,
        H: Send,
        FA: FnOnce() -> A + Send,
        FB: FnOnce() -> B + Send,
        FC: FnOnce() -> C + Send,
        FD: FnOnce() -> D + Send,
        FE: FnOnce() -> E + Send,
        FF: FnOnce() -> F + Send,
        FG: FnOnce() -> G + Send,
        FH: FnOnce() -> H + Send,
    {
        let parallel = self.partitioned_prepare_is_parallel(active_mask, work_items);
        let worker_mask = AtomicU16::new(0);
        let mark = |partition: usize| {
            if active_mask & (1 << partition) != 0
                && let Some(worker_index) = rayon::current_thread_index()
            {
                worker_mask.fetch_or(1_u16 << worker_index, Ordering::Relaxed);
            }
        };
        let first = || {
            mark(0);
            first()
        };
        let second = || {
            mark(1);
            second()
        };
        let third = || {
            mark(2);
            third()
        };
        let fourth = || {
            mark(3);
            fourth()
        };
        let fifth = || {
            mark(4);
            fifth()
        };
        let sixth = || {
            mark(5);
            sixth()
        };
        let seventh = || {
            mark(6);
            seventh()
        };
        let eighth = || {
            mark(7);
            eighth()
        };
        let values = if parallel {
            let (((first, second), (third, fourth)), ((fifth, sixth), (seventh, eighth))) = self
                .pool
                .as_ref()
                .expect("parallel deterministic runtime lost its worker pool")
                .install(|| {
                    rayon::join(
                        || {
                            rayon::join(
                                || rayon::join(first, second),
                                || rayon::join(third, fourth),
                            )
                        },
                        || {
                            rayon::join(
                                || rayon::join(fifth, sixth),
                                || rayon::join(seventh, eighth),
                            )
                        },
                    )
                });
            (first, second, third, fourth, fifth, sixth, seventh, eighth)
        } else {
            (
                first(),
                second(),
                third(),
                fourth(),
                fifth(),
                sixth(),
                seventh(),
                eighth(),
            )
        };
        let diagnostics =
            self.partitioned_prepare_diagnostics(active_mask, work_items, &worker_mask, parallel);
        (values, diagnostics)
    }

    /// Returns the number of worker threads that actually answer a broadcast
    /// on this process-lifetime pool. This is intentionally used only by the
    /// opt-in benchmark/profile path: normal simulation does not pay for a
    /// diagnostic barrier and no runtime detail enters GameState or a public
    /// protocol response.
    pub(crate) fn observed_worker_count(&self) -> usize {
        self.pool
            .as_ref()
            .map_or(1, |pool| pool.broadcast(|_| ()).len())
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

    /// Maps fixed-size ascending row chunks into an ordered output buffer.
    ///
    /// Parallel eligibility is intentionally based on the original row count,
    /// not the much smaller chunk count. The chunk boundaries therefore stay
    /// identical at every worker limit while large, expensive row probes can
    /// still use the process-lifetime pool. Indexed collection preserves chunk
    /// order; callers may replay floating-point contributions serially without
    /// making scheduling observable in authoritative state.
    pub(crate) fn ordered_chunk_map<R, F>(
        &self,
        item_count: usize,
        rows_per_chunk: usize,
        map: F,
    ) -> Vec<R>
    where
        R: Send,
        F: Fn(usize, Range<usize>) -> R + Send + Sync,
    {
        assert!(
            rows_per_chunk > 0,
            "deterministic chunk size must be positive"
        );
        let chunk_count = item_count.div_ceil(rows_per_chunk);
        let range_for_chunk = |chunk_index: usize| {
            let start = chunk_index * rows_per_chunk;
            start..start.saturating_add(rows_per_chunk).min(item_count)
        };
        if self.worker_count_for_items(item_count) == 1 {
            return (0..chunk_count)
                .map(|chunk_index| map(chunk_index, range_for_chunk(chunk_index)))
                .collect();
        }
        self.pool
            .as_ref()
            .expect("parallel deterministic runtime lost its worker pool")
            .install(|| {
                (0..chunk_count)
                    .into_par_iter()
                    .map(|chunk_index| map(chunk_index, range_for_chunk(chunk_index)))
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

    /// Fallible ordered map with evidence from the workers that actually ran
    /// the mapping closure. This method uses only this runtime's existing
    /// bounded pool and completes the indexed collection before selecting the
    /// lowest input error. Callers must invoke it outside a partitioned
    /// prepare closure; nested Rayon scheduling is intentionally unsupported.
    pub(crate) fn indexed_try_map_with_diagnostics<T, R, F>(
        &self,
        values: &[T],
        map: F,
    ) -> (Result<Vec<R>>, IndexedPrepareDiagnostics)
    where
        T: Sync,
        R: Send,
        F: Fn(usize, &T) -> Result<R> + Send + Sync,
    {
        let item_count = values.len();
        if item_count == 0 {
            return (
                Ok(Vec::new()),
                IndexedPrepareDiagnostics {
                    item_count,
                    selected_worker_count: 0,
                    observed_worker_count: 0,
                    parallel: false,
                },
            );
        }
        let selected_worker_count = self.worker_count_for_items(item_count);
        if selected_worker_count == 1 {
            return (
                values
                    .iter()
                    .enumerate()
                    .map(|(index, value)| map(index, value))
                    .collect(),
                IndexedPrepareDiagnostics {
                    item_count,
                    selected_worker_count,
                    observed_worker_count: 1,
                    parallel: false,
                },
            );
        }

        let worker_mask = AtomicU16::new(0);
        let mapped = self
            .pool
            .as_ref()
            .expect("parallel deterministic runtime lost its worker pool")
            .install(|| {
                values
                    .par_iter()
                    .enumerate()
                    .map(|(index, value)| {
                        if let Some(worker_index) = rayon::current_thread_index() {
                            worker_mask.fetch_or(1_u16 << worker_index, Ordering::Relaxed);
                        }
                        map(index, value)
                    })
                    .collect::<Vec<_>>()
            });
        let observed_worker_count =
            worker_mask.load(Ordering::Relaxed).count_ones().max(1) as usize;
        (
            mapped.into_iter().collect(),
            IndexedPrepareDiagnostics {
                item_count,
                selected_worker_count,
                observed_worker_count,
                parallel: true,
            },
        )
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

    /// Updates three equally sized structure-of-arrays slices in index order.
    /// Every length is validated before the first mutable element is exposed,
    /// so a malformed caller cannot leave a partially updated state behind.
    #[allow(dead_code)]
    pub(crate) fn indexed_for_each_mut3<A, B, C, F>(
        &self,
        first: &mut [A],
        second: &mut [B],
        third: &mut [C],
        update: F,
    ) -> Result<()>
    where
        A: Send,
        B: Send,
        C: Send,
        F: Fn(usize, &mut A, &mut B, &mut C) + Send + Sync,
    {
        let item_count = first.len();
        anyhow::ensure!(
            second.len() == item_count && third.len() == item_count,
            "indexed_for_each_mut3 length mismatch: first={item_count}, second={}, third={}",
            second.len(),
            third.len()
        );

        if self.worker_count_for_items(item_count) == 1 {
            first
                .iter_mut()
                .zip(second.iter_mut())
                .zip(third.iter_mut())
                .enumerate()
                .for_each(|(index, ((first, second), third))| {
                    update(index, first, second, third);
                });
            return Ok(());
        }

        self.pool
            .as_ref()
            .expect("parallel deterministic runtime lost its worker pool")
            .install(|| {
                first
                    .par_iter_mut()
                    .zip(second.par_iter_mut())
                    .zip(third.par_iter_mut())
                    .enumerate()
                    .for_each(|(index, ((first, second), third))| {
                        update(index, first, second, third);
                    });
            });
        Ok(())
    }

    /// Updates five equally sized structure-of-arrays slices in index order.
    /// Like the three-slice variant, validation is atomic with respect to
    /// mutation: a length error is returned before the callback can run.
    #[allow(dead_code)]
    pub(crate) fn indexed_for_each_mut5<A, B, C, D, E, F>(
        &self,
        first: &mut [A],
        second: &mut [B],
        third: &mut [C],
        fourth: &mut [D],
        fifth: &mut [E],
        update: F,
    ) -> Result<()>
    where
        A: Send,
        B: Send,
        C: Send,
        D: Send,
        E: Send,
        F: Fn(usize, &mut A, &mut B, &mut C, &mut D, &mut E) + Send + Sync,
    {
        let item_count = first.len();
        anyhow::ensure!(
            second.len() == item_count
                && third.len() == item_count
                && fourth.len() == item_count
                && fifth.len() == item_count,
            "indexed_for_each_mut5 length mismatch: first={item_count}, second={}, third={}, fourth={}, fifth={}",
            second.len(),
            third.len(),
            fourth.len(),
            fifth.len()
        );

        if self.worker_count_for_items(item_count) == 1 {
            first
                .iter_mut()
                .zip(second.iter_mut())
                .zip(third.iter_mut())
                .zip(fourth.iter_mut())
                .zip(fifth.iter_mut())
                .enumerate()
                .for_each(|(index, ((((first, second), third), fourth), fifth))| {
                    update(index, first, second, third, fourth, fifth);
                });
            return Ok(());
        }

        self.pool
            .as_ref()
            .expect("parallel deterministic runtime lost its worker pool")
            .install(|| {
                first
                    .par_iter_mut()
                    .zip(second.par_iter_mut())
                    .zip(third.par_iter_mut())
                    .zip(fourth.par_iter_mut())
                    .zip(fifth.par_iter_mut())
                    .enumerate()
                    .for_each(|(index, ((((first, second), third), fourth), fifth))| {
                        update(index, first, second, third, fourth, fifth);
                    });
            });
        Ok(())
    }

    /// Dense fallback for fixed-size paged SoA columns. All page counts and
    /// page lengths are checked before any callback can mutate a row. Pages
    /// remain independently owned, so Rayon can process them without first
    /// rebuilding factory-sized contiguous vectors.
    pub(crate) fn indexed_for_each_mut3_pages<A, B, C, F>(
        &self,
        page_rows: usize,
        first: &mut [&mut [A]],
        second: &mut [&mut [B]],
        third: &mut [&mut [C]],
        update: F,
    ) -> Result<()>
    where
        A: Send,
        B: Send,
        C: Send,
        F: Fn(usize, &mut A, &mut B, &mut C) + Send + Sync,
    {
        anyhow::ensure!(page_rows != 0, "indexed paged update has zero page size");
        anyhow::ensure!(
            second.len() == first.len() && third.len() == first.len(),
            "indexed_for_each_mut3_pages page-count mismatch"
        );
        let mut item_count = 0_usize;
        for page_index in 0..first.len() {
            let page_len = first[page_index].len();
            anyhow::ensure!(
                second[page_index].len() == page_len && third[page_index].len() == page_len,
                "indexed_for_each_mut3_pages page-length mismatch at page {page_index}"
            );
            anyhow::ensure!(
                page_len != 0
                    && page_len <= page_rows
                    && (page_index + 1 == first.len() || page_len == page_rows),
                "indexed_for_each_mut3_pages malformed page at page {page_index}"
            );
            item_count = item_count.saturating_add(page_len);
        }

        let apply_page = |page_index: usize, first: &mut [A], second: &mut [B], third: &mut [C]| {
            first
                .iter_mut()
                .zip(second.iter_mut())
                .zip(third.iter_mut())
                .enumerate()
                .for_each(|(offset, ((first, second), third))| {
                    update(page_index * page_rows + offset, first, second, third);
                });
        };
        if self.worker_count_for_items(item_count) == 1 {
            first
                .iter_mut()
                .zip(second.iter_mut())
                .zip(third.iter_mut())
                .enumerate()
                .for_each(|(page_index, ((first, second), third))| {
                    apply_page(page_index, first, second, third);
                });
            return Ok(());
        }
        self.pool
            .as_ref()
            .expect("parallel deterministic runtime lost its worker pool")
            .install(|| {
                first
                    .par_iter_mut()
                    .zip(second.par_iter_mut())
                    .zip(third.par_iter_mut())
                    .enumerate()
                    .for_each(|(page_index, ((first, second), third))| {
                        apply_page(page_index, first, second, third);
                    });
            });
        Ok(())
    }

    /// Five-column counterpart used by the dense belt post-action fold.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn indexed_for_each_mut5_pages<A, B, C, D, E, F>(
        &self,
        page_rows: usize,
        first: &mut [&mut [A]],
        second: &mut [&mut [B]],
        third: &mut [&mut [C]],
        fourth: &mut [&mut [D]],
        fifth: &mut [&mut [E]],
        update: F,
    ) -> Result<()>
    where
        A: Send,
        B: Send,
        C: Send,
        D: Send,
        E: Send,
        F: Fn(usize, &mut A, &mut B, &mut C, &mut D, &mut E) + Send + Sync,
    {
        anyhow::ensure!(page_rows != 0, "indexed paged update has zero page size");
        anyhow::ensure!(
            second.len() == first.len()
                && third.len() == first.len()
                && fourth.len() == first.len()
                && fifth.len() == first.len(),
            "indexed_for_each_mut5_pages page-count mismatch"
        );
        let mut item_count = 0_usize;
        for page_index in 0..first.len() {
            let page_len = first[page_index].len();
            anyhow::ensure!(
                second[page_index].len() == page_len
                    && third[page_index].len() == page_len
                    && fourth[page_index].len() == page_len
                    && fifth[page_index].len() == page_len,
                "indexed_for_each_mut5_pages page-length mismatch at page {page_index}"
            );
            anyhow::ensure!(
                page_len != 0
                    && page_len <= page_rows
                    && (page_index + 1 == first.len() || page_len == page_rows),
                "indexed_for_each_mut5_pages malformed page at page {page_index}"
            );
            item_count = item_count.saturating_add(page_len);
        }

        let apply_page = |page_index: usize,
                          first: &mut [A],
                          second: &mut [B],
                          third: &mut [C],
                          fourth: &mut [D],
                          fifth: &mut [E]| {
            first
                .iter_mut()
                .zip(second.iter_mut())
                .zip(third.iter_mut())
                .zip(fourth.iter_mut())
                .zip(fifth.iter_mut())
                .enumerate()
                .for_each(|(offset, ((((first, second), third), fourth), fifth))| {
                    update(
                        page_index * page_rows + offset,
                        first,
                        second,
                        third,
                        fourth,
                        fifth,
                    );
                });
        };
        if self.worker_count_for_items(item_count) == 1 {
            first
                .iter_mut()
                .zip(second.iter_mut())
                .zip(third.iter_mut())
                .zip(fourth.iter_mut())
                .zip(fifth.iter_mut())
                .enumerate()
                .for_each(
                    |(page_index, ((((first, second), third), fourth), fifth))| {
                        apply_page(page_index, first, second, third, fourth, fifth);
                    },
                );
            return Ok(());
        }
        self.pool
            .as_ref()
            .expect("parallel deterministic runtime lost its worker pool")
            .install(|| {
                first
                    .par_iter_mut()
                    .zip(second.par_iter_mut())
                    .zip(third.par_iter_mut())
                    .zip(fourth.par_iter_mut())
                    .zip(fifth.par_iter_mut())
                    .enumerate()
                    .for_each(
                        |(page_index, ((((first, second), third), fourth), fifth))| {
                            apply_page(page_index, first, second, third, fourth, fifth);
                        },
                    );
            });
        Ok(())
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
            assert_eq!(runtime.observed_worker_count(), worker_limit);
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
    fn heterogeneous_prepare_keeps_fixed_tuple_order_for_one_two_four_and_eight_workers() {
        let expected = (
            "first".to_owned(),
            vec![2_u64, 3],
            4_i64,
            Some(5_u8),
            "sixth".to_owned(),
            vec![7_u16],
            8_usize,
            false,
        );
        for worker_limit in [1, 2, 4, 8] {
            let runtime = DeterministicRuntime::for_test(worker_limit);
            let (actual, diagnostics) = runtime.partitioned_prepare8(
                0xff,
                PARALLEL_MIN_ITEMS + 257,
                || "first".to_owned(),
                || vec![2_u64, 3],
                || 4_i64,
                || Some(5_u8),
                || "sixth".to_owned(),
                || vec![7_u16],
                || 8_usize,
                || false,
            );
            assert_eq!(actual, expected, "worker limit {worker_limit}");
            assert_eq!(diagnostics.active_partitions, 8);
            assert_eq!(diagnostics.work_items, PARALLEL_MIN_ITEMS + 257);
            assert_eq!(diagnostics.parallel, worker_limit != 1);
            assert_eq!(
                diagnostics.selected_worker_count,
                if worker_limit == 1 { 1 } else { worker_limit }
            );
            assert!(
                (1..=diagnostics.selected_worker_count)
                    .contains(&diagnostics.observed_worker_count)
            );
        }
    }

    #[test]
    fn heterogeneous_prepare_falls_back_for_small_or_single_partition_work() {
        let runtime = DeterministicRuntime::for_test(8);
        let (_, small) = runtime.partitioned_prepare4(
            0b1111,
            PARALLEL_MIN_ITEMS - 1,
            rayon::current_thread_index,
            rayon::current_thread_index,
            rayon::current_thread_index,
            rayon::current_thread_index,
        );
        assert!(!small.parallel);
        assert_eq!(small.selected_worker_count, 1);
        assert_eq!(small.observed_worker_count, 1);

        let (single_values, single) = runtime.partitioned_prepare4(
            0b0010,
            PARALLEL_MIN_ITEMS + 257,
            rayon::current_thread_index,
            rayon::current_thread_index,
            rayon::current_thread_index,
            rayon::current_thread_index,
        );
        assert_eq!(single_values, (None, None, None, None));
        assert_eq!(single.active_partitions, 1);
        assert!(!single.parallel);
        assert_eq!(single.selected_worker_count, 1);
        assert_eq!(single.observed_worker_count, 1);

        let (_, cached) =
            runtime.partitioned_prepare4(0, PARALLEL_MIN_ITEMS + 257, || (), || (), || (), || ());
        assert_eq!(cached.active_partitions, 0);
        assert_eq!(cached.selected_worker_count, 0);
        assert_eq!(cached.observed_worker_count, 0);
        assert!(!cached.parallel);
    }

    #[test]
    fn heterogeneous_prepare_joins_every_result_then_allows_stable_error_selection() {
        let calls = Arc::new(AtomicUsize::new(0));
        for worker_limit in [1, 2, 4, 8] {
            calls.store(0, Ordering::SeqCst);
            let runtime = DeterministicRuntime::for_test(worker_limit);
            let task = |index: usize, fail: bool| {
                let calls = Arc::clone(&calls);
                move || {
                    calls.fetch_add(1, Ordering::SeqCst);
                    if index.is_multiple_of(2) {
                        std::thread::yield_now();
                    }
                    if fail {
                        anyhow::bail!("partition-{index}");
                    }
                    Ok(index)
                }
            };
            let ((first, second, third, fourth), diagnostics) = runtime.partitioned_prepare4(
                0b1111,
                PARALLEL_MIN_ITEMS + 257,
                task(0, false),
                task(1, true),
                task(2, true),
                task(3, false),
            );
            assert_eq!(calls.load(Ordering::SeqCst), 4);
            let lowest = [first, second, third, fourth]
                .into_iter()
                .collect::<anyhow::Result<Vec<_>>>()
                .unwrap_err();
            assert_eq!(lowest.to_string(), "partition-1");
            assert_eq!(diagnostics.parallel, worker_limit != 1);
        }
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
    fn ordered_chunks_keep_fixed_boundaries_and_output_order_at_every_worker_limit() {
        const ROWS_PER_CHUNK: usize = 2_048;
        let item_count = PARALLEL_MIN_ITEMS + 2_117;
        let expected = vec![
            (0, 0..2_048),
            (1, 2_048..4_096),
            (2, 4_096..6_144),
            (3, 6_144..item_count),
        ];

        for worker_limit in [1, 2, 4, 8] {
            let runtime = DeterministicRuntime::for_test(worker_limit);
            let observed =
                runtime.ordered_chunk_map(item_count, ROWS_PER_CHUNK, |chunk_index, range| {
                    if chunk_index.is_multiple_of(2) {
                        std::thread::yield_now();
                    }
                    (chunk_index, range)
                });
            assert_eq!(observed, expected, "worker count {worker_limit}");
        }
    }

    #[test]
    fn ordered_chunks_choose_parallelism_from_rows_not_chunk_descriptors() {
        const ROWS_PER_CHUNK: usize = 2_048;
        let runtime = DeterministicRuntime::for_test(8);
        let observed =
            runtime.ordered_chunk_map(PARALLEL_MIN_ITEMS + 1, ROWS_PER_CHUNK, |_, range| {
                (range, rayon::current_thread_index())
            });

        assert_eq!(observed.len(), 3);
        assert!(
            observed.iter().all(|(_, worker)| worker.is_some()),
            "three descriptors must still execute in the worker pool because the source has over 4,096 rows"
        );

        let small =
            runtime.ordered_chunk_map(PARALLEL_MIN_ITEMS - 1, ROWS_PER_CHUNK, |_, range| {
                (range, rayon::current_thread_index())
            });
        assert!(small.iter().all(|(_, worker)| worker.is_none()));
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

    fn run_indexed_for_each_mut3(worker_limit: usize) -> (Vec<u64>, Vec<u64>, Vec<u8>) {
        let runtime = DeterministicRuntime::for_test(worker_limit);
        let item_count = PARALLEL_MIN_ITEMS + 257;
        let mut first = (0..item_count)
            .map(|index| (index as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15))
            .collect::<Vec<_>>();
        let mut second = (0..item_count)
            .map(|index| !(index as u64).rotate_left((index % 64) as u32))
            .collect::<Vec<_>>();
        let mut visits = vec![0_u8; item_count];

        runtime
            .indexed_for_each_mut3(
                &mut first,
                &mut second,
                &mut visits,
                |index, a, b, visits| {
                    let original_a = *a;
                    let original_b = *b;
                    *a = original_a
                        .wrapping_add(original_b.rotate_left((index % 61) as u32))
                        .wrapping_mul(0xd6e8_feb8_6659_fd93);
                    *b = original_b.wrapping_sub(original_a.rotate_right((index % 59) as u32))
                        ^ (index as u64).wrapping_mul(0xa076_1d64_78bd_642f);
                    *visits = visits.checked_add(1).expect("index must be visited once");
                },
            )
            .unwrap();

        assert!(visits.iter().all(|visits| *visits == 1));
        (first, second, visits)
    }

    type Mut5Signature = (Vec<u64>, Vec<u64>, Vec<u32>, Vec<i64>, Vec<u8>);

    fn run_indexed_for_each_mut5(worker_limit: usize) -> Mut5Signature {
        let runtime = DeterministicRuntime::for_test(worker_limit);
        let item_count = PARALLEL_MIN_ITEMS + 257;
        let mut first = (0..item_count)
            .map(|index| (index as u64).wrapping_mul(0xe703_7ed1_a0b4_28db))
            .collect::<Vec<_>>();
        let mut second = (0..item_count)
            .map(|index| (index as u64).wrapping_add(0x8ebc_6af0_9c88_c6e3))
            .collect::<Vec<_>>();
        let mut third = (0..item_count)
            .map(|index| (index as u32).rotate_left((index % 31) as u32))
            .collect::<Vec<_>>();
        let mut fourth = (0..item_count)
            .map(|index| (index as i64).wrapping_mul(-1_000_003))
            .collect::<Vec<_>>();
        let mut visits = vec![0_u8; item_count];

        runtime
            .indexed_for_each_mut5(
                &mut first,
                &mut second,
                &mut third,
                &mut fourth,
                &mut visits,
                |index, a, b, c, d, visits| {
                    let original_a = *a;
                    let original_b = *b;
                    let original_c = *c;
                    let original_d = *d;
                    *a = original_a.rotate_left(original_c % 64) ^ original_b ^ index as u64;
                    *b = original_b
                        .wrapping_mul(0x94d0_49bb_1331_11eb)
                        .wrapping_add(original_d as u64);
                    *c = original_c
                        .wrapping_add(index as u32)
                        .rotate_right((index % 31) as u32);
                    *d = original_d
                        .wrapping_sub(original_a as i64)
                        .wrapping_add(original_b as i64);
                    *visits = visits.checked_add(1).expect("index must be visited once");
                },
            )
            .unwrap();

        assert!(visits.iter().all(|visits| *visits == 1));
        (first, second, third, fourth, visits)
    }

    #[test]
    fn multi_slice_updates_are_bitwise_identical_at_every_worker_limit() {
        let expected_three = run_indexed_for_each_mut3(1);
        let expected_five = run_indexed_for_each_mut5(1);
        for worker_limit in [1, 2, 4, 8] {
            assert_eq!(run_indexed_for_each_mut3(worker_limit), expected_three);
            assert_eq!(run_indexed_for_each_mut5(worker_limit), expected_five);
        }
    }

    #[test]
    fn indexed_for_each_mut3_rejects_mismatch_before_any_mutation() {
        let runtime = DeterministicRuntime::for_test(8);
        let mut first = vec![10_u64, 20, 30, 40];
        let mut second = vec![50_u64, 60, 70];
        let mut third = vec![80_u64, 90, 100, 110];
        let before_first = first.clone();
        let before_second = second.clone();
        let before_third = third.clone();
        let calls = AtomicUsize::new(0);

        let error = runtime
            .indexed_for_each_mut3(&mut first, &mut second, &mut third, |_, a, b, c| {
                calls.fetch_add(1, Ordering::SeqCst);
                *a = 0;
                *b = 0;
                *c = 0;
            })
            .unwrap_err();

        assert_eq!(
            error.to_string(),
            "indexed_for_each_mut3 length mismatch: first=4, second=3, third=4"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(first, before_first);
        assert_eq!(second, before_second);
        assert_eq!(third, before_third);
    }

    #[test]
    fn indexed_for_each_mut5_rejects_mismatch_before_any_mutation() {
        let runtime = DeterministicRuntime::for_test(8);
        let mut first = vec![1_i32, 2, 3, 4];
        let mut second = vec![5_i32, 6, 7, 8];
        let mut third = vec![9_i32, 10, 11, 12];
        let mut fourth = vec![13_i32, 14, 15, 16];
        let mut fifth = vec![17_i32, 18, 19];
        let before_first = first.clone();
        let before_second = second.clone();
        let before_third = third.clone();
        let before_fourth = fourth.clone();
        let before_fifth = fifth.clone();
        let calls = AtomicUsize::new(0);

        let error = runtime
            .indexed_for_each_mut5(
                &mut first,
                &mut second,
                &mut third,
                &mut fourth,
                &mut fifth,
                |_, a, b, c, d, e| {
                    calls.fetch_add(1, Ordering::SeqCst);
                    *a = 0;
                    *b = 0;
                    *c = 0;
                    *d = 0;
                    *e = 0;
                },
            )
            .unwrap_err();

        assert_eq!(
            error.to_string(),
            "indexed_for_each_mut5 length mismatch: first=4, second=4, third=4, fourth=4, fifth=3"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(first, before_first);
        assert_eq!(second, before_second);
        assert_eq!(third, before_third);
        assert_eq!(fourth, before_fourth);
        assert_eq!(fifth, before_fifth);
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
