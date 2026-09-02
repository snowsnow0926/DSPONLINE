use std::fmt::Debug;
use std::fs;
use std::path::Path;

use anyhow::{Context, anyhow, bail};

pub(crate) const MINIMUM_FREE_SPACE_RESERVE_BYTES: u64 = 64 * 1024 * 1024;
pub(crate) const LOW_SPACE_ERROR: &str = "native disk budget is below the required 64 MiB reserve";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DiskSpaceQuery {
    Available(u64),
    #[cfg_attr(windows, allow(dead_code))]
    Unsupported,
}

pub(crate) trait DiskSpaceProbe: Debug + Send + Sync {
    fn query_available_bytes(&self, directory: &Path) -> anyhow::Result<DiskSpaceQuery>;
}

#[derive(Debug, Default)]
pub(crate) struct SystemDiskSpaceProbe;

#[cfg(windows)]
impl DiskSpaceProbe for SystemDiskSpaceProbe {
    fn query_available_bytes(&self, directory: &Path) -> anyhow::Result<DiskSpaceQuery> {
        use std::iter;
        use std::os::windows::ffi::OsStrExt;
        use std::ptr;

        use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

        let encoded = directory
            .as_os_str()
            .encode_wide()
            .chain(iter::once(0))
            .collect::<Vec<_>>();
        if encoded[..encoded.len().saturating_sub(1)].contains(&0) {
            bail!("native disk budget path contains a NUL code unit");
        }
        let mut available = 0_u64;
        // SAFETY: `encoded` is an owned, NUL-terminated UTF-16 path and the
        // output pointer remains valid for the synchronous Win32 call.
        let result = unsafe {
            GetDiskFreeSpaceExW(
                encoded.as_ptr(),
                &mut available,
                ptr::null_mut(),
                ptr::null_mut(),
            )
        };
        if result == 0 {
            return Err(std::io::Error::last_os_error())
                .context("query Windows native disk free space");
        }
        Ok(DiskSpaceQuery::Available(available))
    }
}

#[cfg(not(windows))]
impl DiskSpaceProbe for SystemDiskSpaceProbe {
    fn query_available_bytes(&self, _directory: &Path) -> anyhow::Result<DiskSpaceQuery> {
        // There is deliberately no guessed fallback based on file metadata.
        // Callers can surface this as an unsupported/skipped guard rather than
        // claiming that the platform's free space was verified.
        Ok(DiskSpaceQuery::Unsupported)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DiskBudgetOutcome {
    Verified {
        available_bytes: u64,
        required_bytes: u64,
    },
    Unsupported {
        required_bytes: u64,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DiskBudgetStatus {
    NotChecked,
    Verified,
    Unsupported,
    Failed,
}

pub(crate) fn require_write_budget(
    probe: &dyn DiskSpaceProbe,
    directory: &Path,
    write_bytes: u64,
) -> anyhow::Result<DiskBudgetOutcome> {
    let metadata = fs::metadata(directory).context("inspect native disk budget directory")?;
    if !metadata.is_dir() {
        bail!("native disk budget path is not a directory");
    }
    let required_bytes = write_bytes
        .checked_add(MINIMUM_FREE_SPACE_RESERVE_BYTES)
        .ok_or_else(|| anyhow!("native disk budget byte calculation overflowed"))?;
    match probe
        .query_available_bytes(directory)
        .context("query native disk free space")?
    {
        DiskSpaceQuery::Available(available_bytes) if available_bytes < required_bytes => {
            bail!("{LOW_SPACE_ERROR}: available={available_bytes} required={required_bytes}")
        }
        DiskSpaceQuery::Available(available_bytes) => Ok(DiskBudgetOutcome::Verified {
            available_bytes,
            required_bytes,
        }),
        DiskSpaceQuery::Unsupported => Ok(DiskBudgetOutcome::Unsupported { required_bytes }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[derive(Debug)]
    struct FixedProbe(anyhow::Result<DiskSpaceQuery>);

    impl DiskSpaceProbe for FixedProbe {
        fn query_available_bytes(&self, _directory: &Path) -> anyhow::Result<DiskSpaceQuery> {
            match &self.0 {
                Ok(value) => Ok(*value),
                Err(error) => Err(anyhow!(error.to_string())),
            }
        }
    }

    #[test]
    fn exact_reserve_boundary_is_verified_and_one_byte_below_is_rejected() {
        let root = tempdir().unwrap();
        let write_bytes = 123_u64;
        let required = MINIMUM_FREE_SPACE_RESERVE_BYTES + write_bytes;
        assert_eq!(
            require_write_budget(
                &FixedProbe(Ok(DiskSpaceQuery::Available(required))),
                root.path(),
                write_bytes,
            )
            .unwrap(),
            DiskBudgetOutcome::Verified {
                available_bytes: required,
                required_bytes: required,
            }
        );
        let error = require_write_budget(
            &FixedProbe(Ok(DiskSpaceQuery::Available(required - 1))),
            root.path(),
            write_bytes,
        )
        .unwrap_err();
        assert!(error.to_string().contains(LOW_SPACE_ERROR));
    }

    #[test]
    fn unsupported_is_explicit_while_probe_path_and_overflow_errors_fail_closed() {
        let root = tempdir().unwrap();
        assert_eq!(
            require_write_budget(&FixedProbe(Ok(DiskSpaceQuery::Unsupported)), root.path(), 7,)
                .unwrap(),
            DiskBudgetOutcome::Unsupported {
                required_bytes: MINIMUM_FREE_SPACE_RESERVE_BYTES + 7,
            }
        );
        assert!(
            require_write_budget(
                &FixedProbe(Err(anyhow!("injected disk query failure"))),
                root.path(),
                1,
            )
            .unwrap_err()
            .to_string()
            .contains("query native disk free space")
        );
        assert!(
            require_write_budget(
                &FixedProbe(Ok(DiskSpaceQuery::Available(u64::MAX))),
                root.path(),
                u64::MAX,
            )
            .unwrap_err()
            .to_string()
            .contains("byte calculation overflowed")
        );
        assert!(
            require_write_budget(
                &FixedProbe(Ok(DiskSpaceQuery::Available(u64::MAX))),
                &root.path().join("missing"),
                1,
            )
            .unwrap_err()
            .to_string()
            .contains("inspect native disk budget directory")
        );
    }

    #[test]
    fn system_probe_never_masquerades_as_verified_on_an_unsupported_platform() {
        let root = tempdir().unwrap();
        let outcome = require_write_budget(&SystemDiskSpaceProbe, root.path(), 0).unwrap();
        #[cfg(windows)]
        assert!(matches!(outcome, DiskBudgetOutcome::Verified { .. }));
        #[cfg(not(windows))]
        assert!(matches!(outcome, DiskBudgetOutcome::Unsupported { .. }));
    }
}
