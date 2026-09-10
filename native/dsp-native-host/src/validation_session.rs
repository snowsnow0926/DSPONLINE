//! Independent facts about a synthetic Windows validation directory. A lease
//! pins its directories and fixture while alive; a serialized snapshot does
//! not retain those locks and is never qualification or gameplay authority.
use crate::qualification_binding::QualificationSession;
use serde::Serialize;

#[cfg(any(all(windows, target_arch = "x86_64"), test))]
const PREFIX: &str = "dspidle-rust-validation-";
const FIXTURE: &[u8] = include_bytes!("../../../desktop/native-validation-fixture-v1.json");
#[cfg(any(all(windows, target_arch = "x86_64"), test))]
const MAX_FIXTURE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("validation-session-rejected")]
pub struct ValidationSessionError;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationSessionSnapshot {
    schema_version: u8,
    kind: &'static str,
    session_id: String,
    session: QualificationSession,
    authority_eligible: bool,
    release_allowed: bool,
}

fn valid_session_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// No arbitrary path, fixture digest, profile ID, cloud policy or authority
/// boolean is accepted. The ID is only a selector below the OS temporary root.
pub fn inspect_validation_session(
    id: &str,
) -> Result<ValidationSessionSnapshot, ValidationSessionError> {
    Ok(ValidationSessionLease::open(id)?.snapshot().clone())
}

pub struct ValidationSessionLease {
    snapshot: ValidationSessionSnapshot,
    #[cfg(all(windows, target_arch = "x86_64"))]
    _locks: windows::Locks,
}

impl ValidationSessionLease {
    pub fn open(id: &str) -> Result<Self, ValidationSessionError> {
        if !valid_session_id(id) {
            return Err(ValidationSessionError);
        }
        #[cfg(all(windows, target_arch = "x86_64"))]
        {
            windows::open(&std::env::temp_dir(), id)
        }
        #[cfg(not(all(windows, target_arch = "x86_64")))]
        {
            Err(ValidationSessionError)
        }
    }

    pub fn snapshot(&self) -> &ValidationSessionSnapshot {
        &self.snapshot
    }

    /// A future admitted fresh session must import these exact bytes, never an
    /// arbitrary save found inside the profile. This method grants no admission.
    pub fn fixture_bytes(&self) -> &'static [u8] {
        FIXTURE
    }
}

#[cfg(all(windows, target_arch = "x86_64"))]
mod windows {
    use super::*;
    use crate::qualification_catalog::windows::{lock_directories, open_bounded_file};
    use sha2::{Digest, Sha256};
    use std::fs::File;
    use std::io::Read;
    use std::os::windows::fs::MetadataExt;
    use std::os::windows::io::AsRawHandle;
    use std::path::Path;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ID_INFO, FileIdInfo, GetFileInformationByHandleEx,
    };

    pub(super) struct Locks {
        _directories: Vec<File>,
        _fixture: File,
    }

    fn directory_identity(file: &File, hash: &mut Sha256) -> Result<(), ValidationSessionError> {
        let mut information = FILE_ID_INFO::default();
        // SAFETY: the live directory handle remains pinned in Locks; the output
        // pointer and size refer to exactly the SDK's FILE_ID_INFO structure.
        if unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle(),
                FileIdInfo,
                (&mut information as *mut FILE_ID_INFO).cast(),
                size_of::<FILE_ID_INFO>() as u32,
            )
        } == 0
            || information.FileId.Identifier == [0; 16]
            || information.FileId.Identifier == [0xff; 16]
        {
            return Err(ValidationSessionError);
        }
        hash.update(information.VolumeSerialNumber.to_le_bytes());
        hash.update(information.FileId.Identifier);
        hash.update(
            file.metadata()
                .map_err(|_| ValidationSessionError)?
                .creation_time()
                .to_le_bytes(),
        );
        Ok(())
    }

    pub(super) fn open(
        temporary_root: &Path,
        id: &str,
    ) -> Result<ValidationSessionLease, ValidationSessionError> {
        let root = temporary_root.join(format!("{PREFIX}{id}"));
        if !valid_session_id(id)
            || root.as_os_str().len() > 4096
            || FIXTURE.is_empty()
            || FIXTURE.len() > MAX_FIXTURE_BYTES
        {
            return Err(ValidationSessionError);
        }
        let directories =
            lock_directories(&root.join("profile")).map_err(|_| ValidationSessionError)?;
        let mut fixture = open_bounded_file(&root.join("fixture-v47.json"), MAX_FIXTURE_BYTES)
            .map_err(|_| ValidationSessionError)?;
        let mut bytes = Vec::new();
        Read::by_ref(&mut fixture)
            .take(MAX_FIXTURE_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| ValidationSessionError)?;
        if bytes != FIXTURE {
            return Err(ValidationSessionError);
        }
        let mut profile_hash = Sha256::new();
        profile_hash.update(b"dsp-windows-validation-profile-v1\0");
        profile_hash.update(id.as_bytes());
        // Pin both session root and profile. Copying all marker/fixture bytes,
        // replacing either directory, or reusing the selector changes identity.
        for file in directories.iter().rev().take(2).rev() {
            directory_identity(file, &mut profile_hash)?;
        }
        let snapshot = ValidationSessionSnapshot {
            schema_version: 1,
            kind: "windows-validation-session-snapshot-v1",
            session_id: id.to_owned(),
            session: QualificationSession {
                profile_id: hex::encode(&profile_hash.finalize()[..16]),
                fixture_sha256: hex::encode(Sha256::digest(FIXTURE)),
                cloud_writes: false,
            },
            authority_eligible: false,
            release_allowed: false,
        };
        Ok(ValidationSessionLease {
            snapshot,
            _locks: Locks {
                _directories: directories,
                _fixture: fixture,
            },
        })
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::fs;

        fn prepare(parent: &Path, id: &str) -> std::path::PathBuf {
            let root = parent.join(format!("{PREFIX}{id}"));
            fs::create_dir(&root).unwrap();
            fs::create_dir(root.join("profile")).unwrap();
            fs::write(root.join("fixture-v47.json"), FIXTURE).unwrap();
            root
        }

        #[test]
        fn independent_leases_agree_and_hold_all_directories_and_fixture() {
            let parent = tempfile::tempdir().unwrap();
            let id = "ab".repeat(16);
            let root = prepare(parent.path(), &id);
            let first = open(parent.path(), &id).unwrap();
            let second = open(parent.path(), &id).unwrap();
            assert_eq!(first.snapshot(), second.snapshot());
            assert_eq!(first.fixture_bytes(), FIXTURE);
            assert!(!first.snapshot().session.cloud_writes);
            assert!(!first.snapshot().authority_eligible);
            assert!(
                fs::OpenOptions::new()
                    .write(true)
                    .open(root.join("fixture-v47.json"))
                    .is_err()
            );
            assert!(fs::rename(root.join("fixture-v47.json"), root.join("other")).is_err());
            assert!(fs::rename(root.join("profile"), root.join("other")).is_err());
            assert!(fs::rename(&root, parent.path().join("moved")).is_err());
            // Directory locks must still allow a future isolated app to persist.
            fs::write(root.join("profile").join("synthetic-progress"), b"test").unwrap();
            drop(first);
            assert!(fs::rename(&root, parent.path().join("moved")).is_err());
            drop(second);
            fs::rename(&root, parent.path().join("moved")).unwrap();
        }

        #[test]
        fn copied_bytes_and_replaced_profile_do_not_reuse_identity() {
            let parent = tempfile::tempdir().unwrap();
            let id = "ab".repeat(16);
            let root = prepare(parent.path(), &id);
            let first = open(parent.path(), &id).unwrap().snapshot().clone();
            fs::rename(root.join("profile"), root.join("old-profile")).unwrap();
            fs::create_dir(root.join("profile")).unwrap();
            let replacement = open(parent.path(), &id).unwrap().snapshot().clone();
            assert_ne!(first.session.profile_id, replacement.session.profile_id);
            fs::rename(&root, parent.path().join("old-root")).unwrap();
            prepare(parent.path(), &id);
            assert_ne!(
                first.session.profile_id,
                open(parent.path(), &id)
                    .unwrap()
                    .snapshot()
                    .session
                    .profile_id
            );
        }

        #[test]
        fn wrong_missing_oversize_and_hardlinked_fixtures_are_rejected() {
            let parent = tempfile::tempdir().unwrap();
            let id = "cd".repeat(16);
            let root = prepare(parent.path(), &id);
            let file = root.join("fixture-v47.json");
            for bytes in [
                b"player-save".as_slice(),
                b"",
                &vec![b' '; MAX_FIXTURE_BYTES + 1],
            ] {
                fs::write(&file, bytes).unwrap();
                assert!(open(parent.path(), &id).is_err());
            }
            fs::write(&file, FIXTURE).unwrap();
            fs::hard_link(&file, root.join("alias")).unwrap();
            assert!(open(parent.path(), &id).is_err());
            fs::remove_file(&file).unwrap();
            assert!(open(parent.path(), &id).is_err());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selectors_cannot_supply_a_path_or_authority() {
        assert!(valid_session_id(&"ab".repeat(16)));
        for id in [
            "",
            ".",
            "../profile",
            "C:\\profile",
            "ABAB",
            &"a".repeat(31),
            &"a".repeat(33),
            &format!("{}\n", "a".repeat(32)),
        ] {
            assert!(ValidationSessionLease::open(id).is_err());
        }
    }
    #[test]
    fn compiled_fixture_is_a_valid_full_normal_main_v47_envelope() {
        let parsed = dsp_native_core::v47_import::parse_v47_envelope_stream(FIXTURE).unwrap();
        assert_eq!(parsed.proof().mode, "normal");
        assert_eq!(parsed.proof().envelope_slot, "main");
        assert_eq!(parsed.proof().state_version, 47);
        assert!(parsed.proof().entity_count > 0);
        assert!(FIXTURE.len() < MAX_FIXTURE_BYTES);
        assert_eq!(PREFIX, "dspidle-rust-validation-");
    }
}
