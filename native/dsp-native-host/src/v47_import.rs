use std::fs::{self, File, FileType, OpenOptions};
use std::io::{BufRead, BufReader, Error as IoError, ErrorKind, Read};
use std::path::Path;

use anyhow::{Context, bail};
use dsp_native_core::MAX_V47_IMPORT_BYTES;
use flate2::bufread::GzDecoder;

#[cfg(windows)]
use std::os::windows::fs::{FileTypeExt, MetadataExt, OpenOptionsExt};
#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, FILE_BASIC_INFO, FILE_SHARE_READ, FileBasicInfo,
    GetFileInformationByHandle, GetFileInformationByHandleEx,
};

#[cfg(windows)]
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
#[cfg(windows)]
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;

pub struct V47ImportSource {
    file: V47ImportFile,
    pub byte_length: u64,
    encoding: V47ImportEncoding,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum V47ImportEncoding {
    Json,
    Gzip,
}

pub struct V47ImportDecodedReader {
    inner: V47ImportDecodedReaderInner,
}

enum V47ImportDecodedReaderInner {
    Json(V47ImportFile),
    Gzip(Box<StrictSingleMemberGzipReader>),
}

impl V47ImportSource {
    /// Returns a decoded JSON reader and, for an uncompressed `.json`, the
    /// exact byte length that must still match at EOF. A `.json.gz` has no
    /// predeclared decoded length; the core counts and bounds those bytes.
    pub fn into_decoded_reader(self) -> (V47ImportDecodedReader, Option<u64>) {
        match self.encoding {
            V47ImportEncoding::Json => (
                V47ImportDecodedReader {
                    inner: V47ImportDecodedReaderInner::Json(self.file),
                },
                Some(self.byte_length),
            ),
            V47ImportEncoding::Gzip => (
                V47ImportDecodedReader {
                    inner: V47ImportDecodedReaderInner::Gzip(Box::new(
                        StrictSingleMemberGzipReader::new(self.file),
                    )),
                },
                None,
            ),
        }
    }
}

impl Read for V47ImportDecodedReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        match &mut self.inner {
            V47ImportDecodedReaderInner::Json(reader) => reader.read(buffer),
            V47ImportDecodedReaderInner::Gzip(reader) => reader.read(buffer),
        }
    }
}

struct StrictSingleMemberGzipReader {
    decoder: GzDecoder<BufReader<V47ImportFile>>,
    decoded_bytes: u64,
    finished: bool,
}

impl StrictSingleMemberGzipReader {
    fn new(file: V47ImportFile) -> Self {
        Self {
            decoder: GzDecoder::new(BufReader::new(file)),
            decoded_bytes: 0,
            finished: false,
        }
    }
}

impl Read for StrictSingleMemberGzipReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if buffer.is_empty() || self.finished {
            return Ok(0);
        }
        let bytes = self.decoder.read(buffer)?;
        if bytes != 0 {
            self.decoded_bytes = self
                .decoded_bytes
                .checked_add(bytes as u64)
                .ok_or_else(|| {
                    IoError::new(
                        ErrorKind::InvalidData,
                        "native v47 gzip decoded byte count overflowed",
                    )
                })?;
            if self.decoded_bytes > MAX_V47_IMPORT_BYTES {
                return Err(IoError::new(
                    ErrorKind::InvalidData,
                    "native v47 gzip import exceeds the decoded 256 MiB limit",
                ));
            }
            return Ok(bytes);
        }

        // The BufRead decoder consumes exactly one gzip member. Any byte left
        // in its input after the member footer is therefore ambiguous trailing
        // data or a second member, both of which this import format rejects.
        if !self.decoder.get_mut().fill_buf()?.is_empty() {
            return Err(IoError::new(
                ErrorKind::InvalidData,
                "native v47 gzip import contains trailing data or multiple members",
            ));
        }
        self.finished = true;
        Ok(0)
    }
}

pub struct V47ImportFile {
    file: File,
    #[cfg(windows)]
    identity: WindowsFileIdentity,
}

impl Read for V47ImportFile {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let bytes = self.file.read(buffer)?;
        #[cfg(windows)]
        if bytes == 0 {
            let current = windows_file_identity(&self.file).map_err(|error| {
                IoError::new(
                    ErrorKind::InvalidData,
                    format!("inspect native v47 import identity after reading: {error:#}"),
                )
            })?;
            if current != self.identity {
                return Err(IoError::new(
                    ErrorKind::InvalidData,
                    "native v47 import file identity changed while reading",
                ));
            }
        }
        Ok(bytes)
    }
}

#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WindowsFileIdentity {
    volume_serial_number: u32,
    file_index: u64,
    file_size: u64,
    number_of_links: u32,
    creation_time: u64,
    last_write_time: u64,
    change_time: i64,
    file_attributes: u32,
}

pub fn open_v47_import_source(path: &Path) -> anyhow::Result<V47ImportSource> {
    if !path.is_absolute() {
        bail!("native v47 import path must be absolute");
    }
    let encoding = import_encoding(path)?;
    let path_metadata =
        fs::symlink_metadata(path).context("inspect native v47 import selection")?;
    validate_direct_file_type(path_metadata.file_type(), &path_metadata)?;
    validate_import_size(path_metadata.len())?;

    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        // Read-only sharing still lets scanners inspect the user-selected
        // save, while denying write/delete sharing prevents ordinary in-place
        // writes and same-name replacement throughout the streaming parse. A
        // by-handle identity is also rechecked at EOF for defense in depth.
        options
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .share_mode(FILE_SHARE_READ);
    }
    let file = options
        .open(path)
        .context("open native v47 import selection")?;
    let opened_metadata = file
        .metadata()
        .context("inspect opened native v47 import selection")?;
    validate_direct_file_type(opened_metadata.file_type(), &opened_metadata)?;
    validate_same_file_identity(&path_metadata, &opened_metadata)?;
    validate_import_size(opened_metadata.len())?;
    if opened_metadata.len() != path_metadata.len() {
        bail!("native v47 import file identity changed before reading");
    }
    #[cfg(windows)]
    let identity = windows_file_identity(&file)?;
    #[cfg(windows)]
    if identity.file_size != opened_metadata.len()
        || identity.creation_time != opened_metadata.creation_time()
        || identity.last_write_time != opened_metadata.last_write_time()
        || identity.file_attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        bail!("native v47 import by-handle identity disagrees with opened metadata");
    }
    Ok(V47ImportSource {
        file: V47ImportFile {
            file,
            #[cfg(windows)]
            identity,
        },
        byte_length: opened_metadata.len(),
        encoding,
    })
}

fn import_encoding(path: &Path) -> anyhow::Result<V47ImportEncoding> {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| anyhow::anyhow!("native v47 import file name is invalid"))?
        .to_ascii_lowercase();
    if name.ends_with(".json.gz") {
        Ok(V47ImportEncoding::Gzip)
    } else if name.ends_with(".json") {
        Ok(V47ImportEncoding::Json)
    } else {
        bail!("native v47 import requires a .json or .json.gz file");
    }
}

#[cfg(windows)]
fn validate_same_file_identity(
    selected: &fs::Metadata,
    opened: &fs::Metadata,
) -> anyhow::Result<()> {
    if selected.creation_time() != opened.creation_time()
        || selected.last_write_time() != opened.last_write_time()
        || selected.len() != opened.len()
    {
        bail!("native v47 import file identity changed before reading");
    }
    Ok(())
}

#[cfg(windows)]
fn windows_file_identity(file: &File) -> anyhow::Result<WindowsFileIdentity> {
    let handle = file.as_raw_handle();
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: `file` owns a live kernel handle for the duration of both calls,
    // and each output pointer references a correctly sized initialized value.
    if unsafe { GetFileInformationByHandle(handle, &mut information) } == 0 {
        return Err(std::io::Error::last_os_error()).context("query native v47 import file ID");
    }
    let mut basic = FILE_BASIC_INFO::default();
    // SAFETY: the handle remains live and the buffer/type/size match
    // `FileBasicInfo` exactly as required by GetFileInformationByHandleEx.
    if unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileBasicInfo,
            (&raw mut basic).cast(),
            std::mem::size_of::<FILE_BASIC_INFO>() as u32,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error())
            .context("query native v47 import change identity");
    }
    Ok(WindowsFileIdentity {
        volume_serial_number: information.dwVolumeSerialNumber,
        file_index: (u64::from(information.nFileIndexHigh) << 32)
            | u64::from(information.nFileIndexLow),
        file_size: (u64::from(information.nFileSizeHigh) << 32)
            | u64::from(information.nFileSizeLow),
        number_of_links: information.nNumberOfLinks,
        creation_time: file_time_value(information.ftCreationTime),
        last_write_time: file_time_value(information.ftLastWriteTime),
        change_time: basic.ChangeTime,
        file_attributes: information.dwFileAttributes,
    })
}

#[cfg(windows)]
fn file_time_value(value: windows_sys::Win32::Foundation::FILETIME) -> u64 {
    (u64::from(value.dwHighDateTime) << 32) | u64::from(value.dwLowDateTime)
}

#[cfg(unix)]
fn validate_same_file_identity(
    selected: &fs::Metadata,
    opened: &fs::Metadata,
) -> anyhow::Result<()> {
    use std::os::unix::fs::MetadataExt;

    if selected.dev() != opened.dev()
        || selected.ino() != opened.ino()
        || selected.len() != opened.len()
    {
        bail!("native v47 import file identity changed before reading");
    }
    Ok(())
}

#[cfg(not(any(windows, unix)))]
fn validate_same_file_identity(
    selected: &fs::Metadata,
    opened: &fs::Metadata,
) -> anyhow::Result<()> {
    if selected.len() != opened.len() {
        bail!("native v47 import file identity changed before reading");
    }
    Ok(())
}

fn validate_import_size(byte_length: u64) -> anyhow::Result<()> {
    if byte_length == 0 || byte_length > MAX_V47_IMPORT_BYTES {
        bail!("native v47 import file size is invalid");
    }
    Ok(())
}

#[cfg(windows)]
fn validate_direct_file_type(file_type: FileType, metadata: &fs::Metadata) -> anyhow::Result<()> {
    if file_type.is_symlink()
        || file_type.is_symlink_dir()
        || file_type.is_symlink_file()
        || !file_type.is_file()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        bail!("native v47 import selection is not a direct regular file");
    }
    Ok(())
}

#[cfg(not(windows))]
fn validate_direct_file_type(file_type: FileType, _metadata: &fs::Metadata) -> anyhow::Result<()> {
    if file_type.is_symlink() || !file_type.is_file() {
        bail!("native v47 import selection is not a direct regular file");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use dsp_native_core::{parse_v47_envelope, parse_v47_envelope_stream};
    use flate2::Compression;
    use flate2::write::GzEncoder;
    use sha2::Digest;
    use std::io::{Read, Seek, SeekFrom, Write};
    use tempfile::tempdir;

    fn utf16_fnv(text: &str) -> String {
        let mut hash = 0x811c9dc5_u32;
        for unit in text.encode_utf16() {
            hash ^= u32::from(unit);
            hash = hash.wrapping_mul(0x01000193);
        }
        format!("{hash:08x}")
    }

    fn valid_envelope() -> Vec<u8> {
        let state = r#"{"version":47,"mode":"normal","entities":[],"belts":[]}"#;
        let checksum = utf16_fnv(&format!("{{\"formatVersion\":2,\"state\":{state}}}"));
        format!(
            "{{\"formatVersion\":2,\"kind\":\"primary\",\"savedAt\":1,\"mode\":\"normal\",\"slot\":\"main\",\"state\":{state},\"checksum\":\"{checksum}\"}}"
        )
        .into_bytes()
    }

    fn gzip(bytes: &[u8]) -> Vec<u8> {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    }

    #[test]
    fn opens_only_a_bounded_absolute_regular_file() {
        let root = tempdir().unwrap();
        let path = root.path().join("save.json");
        fs::write(&path, b"{}").unwrap();
        let source = open_v47_import_source(&path).unwrap();
        assert_eq!(source.byte_length, 2);
        let (mut reader, expected_byte_length) = source.into_decoded_reader();
        assert_eq!(expected_byte_length, Some(2));
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"{}");
        assert!(open_v47_import_source(Path::new("save.json")).is_err());
        let empty = root.path().join("empty.json");
        fs::write(&empty, b"").unwrap();
        assert!(open_v47_import_source(&empty).is_err());
        let oversized = root.path().join("oversized.json");
        File::create(&oversized)
            .unwrap()
            .set_len(MAX_V47_IMPORT_BYTES + 1)
            .unwrap();
        assert!(open_v47_import_source(&oversized).is_err());
        let unsupported = root.path().join("save.gz");
        fs::write(&unsupported, gzip(b"{}")).unwrap();
        assert!(open_v47_import_source(&unsupported).is_err());
    }

    #[test]
    fn streams_one_gzip_member_and_proves_the_decoded_json_identity() {
        let root = tempdir().unwrap();
        let path = root.path().join("save.JSON.GZ");
        let decoded = valid_envelope();
        let compressed = gzip(&decoded);
        fs::write(&path, &compressed).unwrap();

        let source = open_v47_import_source(&path).unwrap();
        assert_eq!(source.byte_length, compressed.len() as u64);
        let (reader, expected_byte_length) = source.into_decoded_reader();
        assert_eq!(expected_byte_length, None);
        let parsed = parse_v47_envelope_stream(reader).unwrap();
        assert_eq!(parsed.proof().source_byte_length, decoded.len() as u64);
        assert_eq!(
            parsed.proof().source_sha256,
            hex::encode(sha2::Sha256::digest(&decoded))
        );
    }

    #[test]
    fn rejects_corrupt_truncated_trailing_and_multi_member_gzip() {
        fn parse(bytes: &[u8]) -> anyhow::Result<dsp_native_core::ParsedV47Envelope> {
            let root = tempdir().unwrap();
            let path = root.path().join("save.json.gz");
            fs::write(&path, bytes).unwrap();
            let source = open_v47_import_source(&path).unwrap();
            let (reader, expected_byte_length) = source.into_decoded_reader();
            assert_eq!(expected_byte_length, None);
            parse_v47_envelope_stream(reader)
        }

        let valid = gzip(&valid_envelope());
        let mut corrupt = valid.clone();
        let final_byte = corrupt.last_mut().unwrap();
        *final_byte ^= 0xff;
        assert!(parse(&corrupt).is_err());

        let truncated = &valid[..valid.len() - 4];
        assert!(parse(truncated).is_err());

        let mut trailing = valid.clone();
        trailing.extend_from_slice(b"trailing");
        let trailing_error = parse(&trailing).unwrap_err();
        assert!(format!("{trailing_error:#}").contains("trailing data or multiple members"));

        let mut multiple = valid;
        multiple.extend_from_slice(&gzip(&valid_envelope()));
        let multiple_error = parse(&multiple).unwrap_err();
        assert!(format!("{multiple_error:#}").contains("trailing data or multiple members"));
    }

    #[test]
    fn rejects_a_gzip_bomb_when_the_decoded_counter_crosses_256_mib() {
        let root = tempdir().unwrap();
        let path = root.path().join("save.json.gz");
        fs::write(&path, gzip(b"  ")).unwrap();
        let source = open_v47_import_source(&path).unwrap();
        let mut reader = StrictSingleMemberGzipReader::new(source.file);
        reader.decoded_bytes = MAX_V47_IMPORT_BYTES - 1;
        let error = reader.read_to_end(&mut Vec::new()).unwrap_err();
        assert!(error.to_string().contains("decoded 256 MiB limit"));
    }

    #[cfg(not(windows))]
    #[test]
    fn detects_file_growth_after_the_validated_handle_is_opened() {
        let root = tempdir().unwrap();
        let path = root.path().join("save.json");
        fs::write(&path, valid_envelope()).unwrap();
        let source = open_v47_import_source(&path).unwrap();
        let mut writer = OpenOptions::new().append(true).open(&path).unwrap();
        writer.write_all(b" ").unwrap();
        writer.sync_all().unwrap();
        let expected_byte_length = source.byte_length;
        let (reader, expected) = source.into_decoded_reader();
        let error = parse_v47_envelope(reader, expected.unwrap()).unwrap_err();
        assert_eq!(expected, Some(expected_byte_length));
        assert!(error.to_string().contains("identity changed"));
    }

    #[cfg(windows)]
    #[test]
    fn holds_a_restrictive_share_lock_until_streaming_import_finishes() {
        let root = tempdir().unwrap();
        let path = root.path().join("save.json");
        let bytes = valid_envelope();
        fs::write(&path, &bytes).unwrap();
        let source = open_v47_import_source(&path).unwrap();
        let parallel_reader = File::open(&path).unwrap();
        assert!(OpenOptions::new().write(true).open(&path).is_err());
        assert!(fs::rename(&path, root.path().join("replaced.json")).is_err());
        drop(parallel_reader);
        let (reader, expected_byte_length) = source.into_decoded_reader();
        parse_v47_envelope(reader, expected_byte_length.unwrap()).unwrap();

        let mut writer = OpenOptions::new().write(true).open(&path).unwrap();
        writer.seek(SeekFrom::Start(0)).unwrap();
        writer.write_all(b"{").unwrap();
        writer.sync_all().unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn by_handle_identity_detects_same_size_in_place_writes_and_replacement() {
        let root = tempdir().unwrap();
        let path = root.path().join("save.json");
        let replacement = root.path().join("replacement.json");
        let retired = root.path().join("retired.json");
        fs::write(&path, b"12345678").unwrap();
        fs::write(&replacement, b"abcdefgh").unwrap();

        let original_handle = File::open(&path).unwrap();
        let original = windows_file_identity(&original_handle).unwrap();
        // Windows may coalesce two metadata updates performed in the same
        // scheduler tick. Keep the content size fixed while giving the second
        // write a distinct observable last-write/change identity.
        std::thread::sleep(std::time::Duration::from_millis(25));
        let mut writer = OpenOptions::new().write(true).open(&path).unwrap();
        writer.seek(SeekFrom::Start(0)).unwrap();
        writer.write_all(b"87654321").unwrap();
        writer.sync_all().unwrap();
        drop(writer);
        drop(original_handle);
        let modified_handle = File::open(&path).unwrap();
        let modified = windows_file_identity(&modified_handle).unwrap();
        assert_eq!(modified.file_size, original.file_size);
        assert_eq!(modified.file_index, original.file_index);
        assert!(
            modified.last_write_time != original.last_write_time
                || modified.change_time != original.change_time
        );
        drop(modified_handle);

        fs::rename(&path, &retired).unwrap();
        fs::rename(&replacement, &path).unwrap();
        let replaced = windows_file_identity(&File::open(&path).unwrap()).unwrap();
        assert_eq!(replaced.file_size, original.file_size);
        assert!(
            replaced.volume_serial_number != original.volume_serial_number
                || replaced.file_index != original.file_index
        );
    }

    #[cfg(windows)]
    #[test]
    fn rejects_a_final_component_symlink_or_reparse_point() {
        use std::os::windows::fs::symlink_file;

        let root = tempdir().unwrap();
        let target = root.path().join("target.json");
        let link = root.path().join("link.json");
        fs::write(&target, b"{}").unwrap();
        if symlink_file(&target, &link).is_ok() {
            assert!(open_v47_import_source(&link).is_err());
        }
    }
}
