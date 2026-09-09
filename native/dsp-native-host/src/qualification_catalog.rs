//! Authenticated, bounded Windows catalog member snapshots.
//!
//! This verifies a signature and publisher, not permission to run a player
//! session. Candidate identity, producer provenance, scope, expiry, revocation
//! watermarks and single-owner activation remain separate required checks.
//! Nothing here is exposed through the renderer or Host RPC protocol.

use std::path::Path;

pub const MAX_QUALIFICATION_BYTES: usize = 256 * 1024;
pub const MAX_CATALOG_BYTES: usize = 1024 * 1024;
const MAX_PUBLISHERS: usize = 8;

#[derive(Debug, thiserror::Error)]
pub enum CatalogVerificationError {
    #[error("Windows catalog verification is unavailable on this platform")]
    UnsupportedPlatform,
    #[error("an independent bounded publisher policy is required")]
    InvalidPublisherPolicy,
    #[error("qualification carrier path is not a direct local file path")]
    UnsafePath,
    #[error("qualification carrier file is empty or exceeds its bound")]
    InvalidFileSize,
    #[error("qualification carrier could not be read or locked")]
    Io(#[from] std::io::Error),
    #[error("required Windows trust API is unavailable")]
    TrustApiUnavailable,
    #[error("Windows catalog operation failed with code {0}")]
    CatalogOperation(u32),
    #[error("Windows rejected the catalog member with status {0:#010x}")]
    TrustRejected(i32),
    #[error("Windows did not return a complete primary publisher chain")]
    MissingPublisher,
    #[error("the catalog signature does not use an approved SHA-2 digest")]
    WeakSignatureDigest,
    #[error("the authenticated publisher is not in the independent policy")]
    PublisherMismatch,
}

/// Private fields prevent a parsed JSON or IPC response from manufacturing a
/// verified snapshot. The bytes are those read under the same locks as WinTrust.
#[derive(Debug)]
pub struct VerifiedCatalogMember {
    member_bytes: Vec<u8>,
    member_sha256: [u8; 32],
    catalog_sha256: [u8; 32],
    publisher_certificate_sha256: [u8; 32],
}

impl VerifiedCatalogMember {
    pub fn member_bytes(&self) -> &[u8] {
        &self.member_bytes
    }

    pub fn member_sha256(&self) -> [u8; 32] {
        self.member_sha256
    }

    pub fn catalog_sha256(&self) -> [u8; 32] {
        self.catalog_sha256
    }

    pub fn publisher_certificate_sha256(&self) -> [u8; 32] {
        self.publisher_certificate_sha256
    }
}

/// The caller supplies publisher certificate DER SHA-256 pins from trusted
/// program policy, never from the carrier being checked. No default publisher,
/// environment override, trust-store installation or network retrieval exists.
pub fn verify_windows_catalog_member(
    installation_root: &Path,
    expected_publishers: &[[u8; 32]],
) -> Result<VerifiedCatalogMember, CatalogVerificationError> {
    if expected_publishers.is_empty()
        || expected_publishers.len() > MAX_PUBLISHERS
        || expected_publishers
            .iter()
            .enumerate()
            .any(|(index, pin)| expected_publishers[..index].contains(pin))
    {
        return Err(CatalogVerificationError::InvalidPublisherPolicy);
    }
    #[cfg(windows)]
    {
        windows::verify(installation_root, expected_publishers)
    }
    #[cfg(not(windows))]
    {
        let _ = installation_root;
        Err(CatalogVerificationError::UnsupportedPlatform)
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::ffi::{CStr, OsStr, c_void};
    use std::fs::{File, OpenOptions};
    use std::io::{Read, Seek};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use std::os::windows::io::AsRawHandle;
    use std::path::{Component, PathBuf, Prefix};
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::{FreeLibrary, HANDLE, HMODULE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Security::Cryptography::CERT_STRONG_SIGN_PARA;
    use windows_sys::Win32::Security::WinTrust::*;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_READ,
        GetFileInformationByHandle,
    };
    use windows_sys::Win32::System::LibraryLoader::{
        GetProcAddress, LOAD_LIBRARY_SEARCH_SYSTEM32, LoadLibraryExW,
    };
    use windows_sys::core::{BOOL, GUID, PCWSTR};

    type AcquireContext = unsafe extern "system" fn(
        *mut isize,
        *const GUID,
        PCWSTR,
        *const CERT_STRONG_SIGN_PARA,
        u32,
    ) -> BOOL;
    type ReleaseContext = unsafe extern "system" fn(isize, u32) -> BOOL;
    type CalculateHash = unsafe extern "system" fn(isize, HANDLE, *mut u32, *mut u8, u32) -> BOOL;
    type VerifyTrust = unsafe extern "system" fn(HANDLE, *mut GUID, *mut c_void) -> i32;
    type ProviderData = unsafe extern "system" fn(HANDLE) -> *mut CRYPT_PROVIDER_DATA;
    type ProviderSigner = unsafe extern "system" fn(
        *mut CRYPT_PROVIDER_DATA,
        u32,
        BOOL,
        u32,
    ) -> *mut CRYPT_PROVIDER_SGNR;
    type ProviderCertificate =
        unsafe extern "system" fn(*mut CRYPT_PROVIDER_SGNR, u32) -> *mut CRYPT_PROVIDER_CERT;

    struct SystemLibrary(HMODULE);

    impl Drop for SystemLibrary {
        fn drop(&mut self) {
            // SAFETY: this handle is uniquely owned after successful LoadLibraryExW.
            unsafe { FreeLibrary(self.0) };
        }
    }

    struct TrustApi {
        _library: SystemLibrary,
        acquire: AcquireContext,
        release: ReleaseContext,
        calculate: CalculateHash,
        verify: VerifyTrust,
        provider: ProviderData,
        signer: ProviderSigner,
        certificate: ProviderCertificate,
    }

    impl TrustApi {
        fn load() -> Result<Self, CatalogVerificationError> {
            // SAFETY: the literal is NUL-terminated and only System32 is searched.
            let library = unsafe {
                LoadLibraryExW(
                    windows_sys::core::w!("wintrust.dll"),
                    null_mut(),
                    LOAD_LIBRARY_SEARCH_SYSTEM32,
                )
            };
            if library.is_null() {
                return Err(CatalogVerificationError::TrustApiUnavailable);
            }
            let library = SystemLibrary(library);
            macro_rules! resolve {
                ($name:literal, $kind:ty) => {{
                    // SAFETY: these fixed export names and system ABI signatures
                    // match the SDK; the owning library outlives all calls.
                    let address =
                        unsafe { GetProcAddress(library.0, concat!($name, "\0").as_ptr()) }
                            .ok_or(CatalogVerificationError::TrustApiUnavailable)?;
                    unsafe {
                        std::mem::transmute::<unsafe extern "system" fn() -> isize, $kind>(address)
                    }
                }};
            }
            Ok(Self {
                acquire: resolve!("CryptCATAdminAcquireContext2", AcquireContext),
                release: resolve!("CryptCATAdminReleaseContext", ReleaseContext),
                calculate: resolve!("CryptCATAdminCalcHashFromFileHandle2", CalculateHash),
                verify: resolve!("WinVerifyTrust", VerifyTrust),
                provider: resolve!("WTHelperProvDataFromStateData", ProviderData),
                signer: resolve!("WTHelperGetProvSignerFromChain", ProviderSigner),
                certificate: resolve!("WTHelperGetProvCertFromChain", ProviderCertificate),
                _library: library,
            })
        }
    }

    struct CatalogContext<'a> {
        api: &'a TrustApi,
        handle: isize,
    }

    impl Drop for CatalogContext<'_> {
        fn drop(&mut self) {
            // SAFETY: a successfully acquired context is released exactly once.
            unsafe { (self.api.release)(self.handle, 0) };
        }
    }

    struct TrustState<'a> {
        api: &'a TrustApi,
        action: GUID,
        data: WINTRUST_DATA,
    }

    impl Drop for TrustState<'_> {
        fn drop(&mut self) {
            self.data.dwStateAction = WTD_STATEACTION_CLOSE;
            // SAFETY: every VERIFY receives CLOSE, including rejected signatures.
            // The catalog info, paths, member handle and API still outlive this state.
            unsafe {
                (self.api.verify)(
                    INVALID_HANDLE_VALUE,
                    &mut self.action,
                    (&mut self.data as *mut WINTRUST_DATA).cast(),
                )
            };
        }
    }

    fn last_catalog_error() -> CatalogVerificationError {
        CatalogVerificationError::CatalogOperation(
            std::io::Error::last_os_error().raw_os_error().unwrap_or(0) as u32,
        )
    }

    fn wide(value: &OsStr) -> Result<Vec<u16>, CatalogVerificationError> {
        let mut encoded: Vec<_> = value.encode_wide().collect();
        if encoded.contains(&0) {
            return Err(CatalogVerificationError::UnsafePath);
        }
        encoded.push(0);
        Ok(encoded)
    }

    // Keep every ancestor open without FILE_SHARE_DELETE, so the catalog's
    // path-only Windows API cannot observe a renamed directory or junction.
    fn lock_directories(root: &Path) -> Result<Vec<File>, CatalogVerificationError> {
        if !root.is_absolute() {
            return Err(CatalogVerificationError::UnsafePath);
        }
        // Reject the whole syntax before opening even an earlier ancestor. In
        // particular a nonexistent path must not hide an invalid later segment.
        for component in root.components() {
            match component {
                Component::Prefix(prefix)
                    if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)) => {}
                Component::RootDir => {}
                Component::Normal(name) => {
                    let text = name.to_string_lossy();
                    if text.ends_with(['.', ' ']) || text.contains([':', '\0']) {
                        return Err(CatalogVerificationError::UnsafePath);
                    }
                }
                _ => return Err(CatalogVerificationError::UnsafePath),
            }
        }
        let mut path = PathBuf::new();
        let mut locks = Vec::new();
        for component in root.components() {
            match component {
                Component::Prefix(prefix)
                    if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)) =>
                {
                    path.push(prefix.as_os_str());
                    continue;
                }
                Component::RootDir => path.push(component.as_os_str()),
                Component::Normal(name) => path.push(name),
                _ => return Err(CatalogVerificationError::UnsafePath),
            }
            let directory = OpenOptions::new()
                .access_mode(FILE_READ_ATTRIBUTES)
                .share_mode(FILE_SHARE_READ)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                .open(&path)?;
            let metadata = directory.metadata()?;
            if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            {
                return Err(CatalogVerificationError::UnsafePath);
            }
            locks.push(directory);
        }
        Ok(locks)
    }

    fn locked_file(
        path: &Path,
        max_bytes: usize,
    ) -> Result<(File, Vec<u8>), CatalogVerificationError> {
        let mut file = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)?;
        let metadata = file.metadata()?;
        let mut information = BY_HANDLE_FILE_INFORMATION::default();
        // SAFETY: the live File handle and writable SDK structure are valid.
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) } == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        if !metadata.is_file()
            || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || information.nNumberOfLinks != 1
        {
            return Err(CatalogVerificationError::UnsafePath);
        }
        if metadata.len() == 0 || metadata.len() > max_bytes as u64 {
            return Err(CatalogVerificationError::InvalidFileSize);
        }
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        Read::by_ref(&mut file)
            .take(max_bytes as u64 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 != metadata.len() || bytes.len() > max_bytes {
            return Err(CatalogVerificationError::InvalidFileSize);
        }
        file.rewind()?;
        Ok((file, bytes))
    }

    pub(super) fn verify(
        installation_root: &Path,
        expected_publishers: &[[u8; 32]],
    ) -> Result<VerifiedCatalogMember, CatalogVerificationError> {
        let root = installation_root.join("native-qualification");
        let _directory_locks = lock_directories(&root)?;
        let catalog_path = root.join("qualification.cat");
        let member_path = root.join("qualification.json");
        let (_catalog, catalog_bytes) = locked_file(&catalog_path, MAX_CATALOG_BYTES)?;
        let (member, member_bytes) = locked_file(&member_path, MAX_QUALIFICATION_BYTES)?;
        let api = TrustApi::load()?;
        let mut handle = 0;
        // SAFETY: output storage is valid and SHA256 is a fixed UTF-16 literal.
        if unsafe {
            (api.acquire)(
                &mut handle,
                null(),
                windows_sys::core::w!("SHA256"),
                null(),
                0,
            )
        } == 0
        {
            return Err(last_catalog_error());
        }
        let context = CatalogContext { api: &api, handle };
        let mut calculated_hash = [0_u8; 32];
        let mut hash_len = calculated_hash.len() as u32;
        // SAFETY: the same locked, rewound member handle and bounded output are used.
        if unsafe {
            (api.calculate)(
                context.handle,
                member.as_raw_handle(),
                &mut hash_len,
                calculated_hash.as_mut_ptr(),
                0,
            )
        } == 0
        {
            return Err(last_catalog_error());
        }
        if hash_len != 32 {
            return Err(CatalogVerificationError::TrustApiUnavailable);
        }
        let catalog_wide = wide(catalog_path.as_os_str())?;
        let member_wide = wide(member_path.as_os_str())?;
        let member_tag = wide(OsStr::new(&hex::encode_upper(calculated_hash)))?;
        let mut info = WINTRUST_CATALOG_INFO {
            cbStruct: size_of::<WINTRUST_CATALOG_INFO>() as u32,
            pcwszCatalogFilePath: catalog_wide.as_ptr(),
            pcwszMemberTag: member_tag.as_ptr(),
            pcwszMemberFilePath: member_wide.as_ptr(),
            hMemberFile: member.as_raw_handle(),
            pbCalculatedFileHash: calculated_hash.as_mut_ptr(),
            cbCalculatedFileHash: hash_len,
            hCatAdmin: context.handle,
            ..Default::default()
        };
        let mut trust = TrustState {
            api: &api,
            action: WINTRUST_ACTION_GENERIC_VERIFY_V2,
            data: WINTRUST_DATA {
                cbStruct: size_of::<WINTRUST_DATA>() as u32,
                dwUIChoice: WTD_UI_NONE,
                fdwRevocationChecks: WTD_REVOKE_WHOLECHAIN,
                dwUnionChoice: WTD_CHOICE_CATALOG,
                Anonymous: WINTRUST_DATA_0 {
                    pCatalog: &mut info,
                },
                dwStateAction: WTD_STATEACTION_VERIFY,
                dwProvFlags: WTD_CACHE_ONLY_URL_RETRIEVAL
                    | WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT
                    | WTD_DISABLE_MD2_MD4,
                ..Default::default()
            },
        };
        // SAFETY: all pointer targets are live and locked through TrustState::drop.
        let status = unsafe {
            (api.verify)(
                INVALID_HANDLE_VALUE,
                &mut trust.action,
                (&mut trust.data as *mut WINTRUST_DATA).cast(),
            )
        };
        if status != 0 {
            return Err(CatalogVerificationError::TrustRejected(status));
        }
        // SAFETY: Windows owns the provider chain until the matching CLOSE.
        let publisher_certificate_sha256 =
            unsafe { publisher_digest(&api, trust.data.hWVTStateData)? };
        if !expected_publishers.contains(&publisher_certificate_sha256) {
            return Err(CatalogVerificationError::PublisherMismatch);
        }
        Ok(VerifiedCatalogMember {
            member_sha256: Sha256::digest(&member_bytes).into(),
            catalog_sha256: Sha256::digest(&catalog_bytes).into(),
            member_bytes,
            publisher_certificate_sha256,
        })
    }

    unsafe fn publisher_digest(
        api: &TrustApi,
        state: HANDLE,
    ) -> Result<[u8; 32], CatalogVerificationError> {
        // SAFETY: caller holds a successful, still-live Windows verification state.
        let provider = unsafe { (api.provider)(state) };
        if provider.is_null() {
            return Err(CatalogVerificationError::MissingPublisher);
        }
        // The primary signer is distinct from its timestamp countersigner.
        let signer = unsafe { (api.signer)(provider, 0, 0, 0) };
        if signer.is_null() || unsafe { (*signer).psSigner.is_null() } {
            return Err(CatalogVerificationError::MissingPublisher);
        }
        let oid = unsafe { (*(*signer).psSigner).HashAlgorithm.pszObjId };
        if oid.is_null() {
            return Err(CatalogVerificationError::WeakSignatureDigest);
        }
        // SAFETY: Windows' parsed signer info supplies a NUL-terminated OID.
        let digest_oid = unsafe { CStr::from_ptr(oid.cast()) }.to_bytes();
        if ![
            b"2.16.840.1.101.3.4.2.1".as_slice(),
            b"2.16.840.1.101.3.4.2.2",
            b"2.16.840.1.101.3.4.2.3",
        ]
        .contains(&digest_oid)
        {
            return Err(CatalogVerificationError::WeakSignatureDigest);
        }
        let certificate = unsafe { (api.certificate)(signer, 0) };
        if certificate.is_null() || unsafe { (*certificate).pCert.is_null() } {
            return Err(CatalogVerificationError::MissingPublisher);
        }
        let certificate = unsafe { &*(*certificate).pCert };
        if certificate.pbCertEncoded.is_null()
            || certificate.cbCertEncoded == 0
            || certificate.cbCertEncoded > 64 * 1024
        {
            return Err(CatalogVerificationError::MissingPublisher);
        }
        // SAFETY: certificate bytes are owned by the live Windows trust state.
        let der = unsafe {
            std::slice::from_raw_parts(
                certificate.pbCertEncoded,
                certificate.cbCertEncoded as usize,
            )
        };
        Ok(Sha256::digest(der).into())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        include!("qualification_catalog_signed_tests.rs");

        fn fixture() -> tempfile::TempDir {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("native-qualification");
            std::fs::create_dir(&root).unwrap();
            std::fs::write(root.join("qualification.cat"), b"not a signed catalog").unwrap();
            std::fs::write(root.join("qualification.json"), b"{\"fixture\":true}").unwrap();
            temp
        }

        #[test]
        fn unsigned_member_is_rejected_by_windows_and_all_file_locks_are_released() {
            let temp = fixture();
            for _ in 0..8 {
                assert!(matches!(
                    verify(temp.path(), &[[1; 32]]),
                    Err(CatalogVerificationError::TrustRejected(_))
                ));
                let root = temp.path().join("native-qualification");
                let moved = temp.path().join("moved");
                std::fs::rename(&root, &moved).unwrap();
                std::fs::rename(&moved, &root).unwrap();
                assert_eq!(
                    std::fs::read(root.join("qualification.json")).unwrap(),
                    b"{\"fixture\":true}"
                );
            }
        }

        #[test]
        fn locked_snapshot_blocks_member_writes_and_directory_replacement() {
            let temp = fixture();
            let root = temp.path().join("native-qualification");
            let locks = lock_directories(&root).unwrap();
            let path = root.join("qualification.json");
            let (file, bytes) = locked_file(&path, MAX_QUALIFICATION_BYTES).unwrap();
            assert_eq!(bytes, b"{\"fixture\":true}");
            assert!(OpenOptions::new().write(true).open(&path).is_err());
            assert!(std::fs::rename(&root, temp.path().join("moved")).is_err());
            drop(file);
            drop(locks);
            std::fs::write(path, b"replacement").unwrap();
            std::fs::rename(root, temp.path().join("moved")).unwrap();
        }

        #[test]
        fn hardlinked_or_oversized_members_are_rejected_before_trust() {
            let temp = fixture();
            let member = temp.path().join("native-qualification/qualification.json");
            let alias = temp.path().join("alias.json");
            std::fs::hard_link(&member, &alias).unwrap();
            assert!(matches!(
                verify(temp.path(), &[[1; 32]]),
                Err(CatalogVerificationError::UnsafePath)
            ));
            std::fs::remove_file(alias).unwrap();
            File::options()
                .write(true)
                .open(&member)
                .unwrap()
                .set_len(MAX_QUALIFICATION_BYTES as u64 + 1)
                .unwrap();
            assert!(matches!(
                verify(temp.path(), &[[1; 32]]),
                Err(CatalogVerificationError::InvalidFileSize)
            ));
        }

        #[test]
        fn local_absolute_paths_are_required() {
            for root in [
                Path::new("relative"),
                Path::new(r"\\server\share\app"),
                Path::new(r"C:\safe\..\app"),
                Path::new(r"C:\missing\bad."),
                Path::new(r"C:\missing\bad "),
                Path::new(r"C:\missing\bad:stream"),
            ] {
                assert!(matches!(
                    lock_directories(root),
                    Err(CatalogVerificationError::UnsafePath)
                ));
            }
        }

        #[test]
        fn both_files_are_bounded_and_existing_writers_prevent_verification() {
            let temp = fixture();
            for (name, limit) in [
                ("qualification.cat", MAX_CATALOG_BYTES),
                ("qualification.json", MAX_QUALIFICATION_BYTES),
            ] {
                let path = temp.path().join("native-qualification").join(name);
                let original = std::fs::read(&path).unwrap();
                let writer = File::options().write(true).open(&path).unwrap();
                assert!(matches!(
                    verify(temp.path(), &[[1; 32]]),
                    Err(CatalogVerificationError::Io(_))
                ));
                drop(writer);
                for bytes in [0, limit as u64 + 1] {
                    File::options()
                        .write(true)
                        .open(&path)
                        .unwrap()
                        .set_len(bytes)
                        .unwrap();
                    assert!(matches!(
                        verify(temp.path(), &[[1; 32]]),
                        Err(CatalogVerificationError::InvalidFileSize)
                    ));
                }
                std::fs::write(path, original).unwrap();
            }
        }

        #[test]
        fn junction_at_carrier_or_ancestor_is_rejected_without_changing_target() {
            use std::os::windows::process::CommandExt;
            let temp = fixture();
            let alias = tempfile::tempdir().unwrap();
            let original =
                std::fs::read(temp.path().join("native-qualification/qualification.json")).unwrap();
            for (link, target, installation_root) in [
                (
                    alias.path().join("native-qualification"),
                    temp.path().join("native-qualification"),
                    alias.path().to_path_buf(),
                ),
                (
                    alias.path().join("redirected-installation"),
                    temp.path().to_path_buf(),
                    alias.path().join("redirected-installation"),
                ),
            ] {
                let output = std::process::Command::new("cmd.exe")
                    // CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS. Only the
                    // generated fixture paths enter this fixed mklink command.
                    .creation_flags(0x0800_0000 | 0x0000_4000)
                    .args(["/d", "/c", "mklink", "/J"])
                    .arg(&link)
                    .arg(&target)
                    .output()
                    .unwrap();
                assert!(output.status.success(), "create owned junction fixture");
                assert!(matches!(
                    verify(&installation_root, &[[1; 32]]),
                    Err(CatalogVerificationError::UnsafePath)
                ));
                // Remove only the junction itself, never recursively follow it.
                std::fs::remove_dir(link).unwrap();
                assert_eq!(
                    std::fs::read(temp.path().join("native-qualification/qualification.json"))
                        .unwrap(),
                    original
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_duplicate_or_unbounded_publisher_policy_never_reads_a_carrier() {
        for policy in [vec![], vec![[1; 32], [1; 32]], vec![[2; 32]; 9]] {
            assert!(matches!(
                verify_windows_catalog_member(Path::new("missing"), &policy),
                Err(CatalogVerificationError::InvalidPublisherPolicy)
            ));
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn non_windows_platform_never_authenticates_a_carrier() {
        assert!(matches!(
            verify_windows_catalog_member(Path::new("missing"), &[[1; 32]]),
            Err(CatalogVerificationError::UnsupportedPlatform)
        ));
    }
}
