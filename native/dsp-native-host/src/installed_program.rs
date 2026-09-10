//! Independently collect this Host installation's program-file facts. This is
//! not signature verification, a qualification token, or gameplay authority.
use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledProgramIdentity {
    pub version: String,
    pub source_sha: String,
    pub build_id: String,
    pub edition_id: String,
    pub channel: String,
    pub platform: String,
    pub arch: String,
    pub host_sha256: String,
    pub asar_sha256: String,
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
#[error("installed-program-rejected")]
pub struct InstalledProgramError;

/// No caller path, environment policy, renderer value or report is accepted.
/// Each invocation starts from the OS-provided path of this executable.
pub fn collect_installed_windows_program_identity()
-> Result<InstalledProgramIdentity, InstalledProgramError> {
    #[cfg(all(windows, target_arch = "x86_64"))]
    {
        windows::collect(&std::env::current_exe().map_err(|_| InstalledProgramError)?)
    }
    #[cfg(not(all(windows, target_arch = "x86_64")))]
    {
        Err(InstalledProgramError)
    }
}

#[cfg(any(all(windows, target_arch = "x86_64"), test))]
mod archive {
    use super::*;
    use serde::de::{MapAccess, Visitor};
    use serde::{Deserialize, Deserializer};
    use std::collections::BTreeMap;
    use std::io::{Read, Seek, SeekFrom};

    pub(super) const MAX_ASAR: usize = 256 * 1024 * 1024;
    const MAX_HEADER: usize = 4 * 1024 * 1024;
    const MAX_MEMBER: usize = 64 * 1024;
    type Result<T> = std::result::Result<T, InstalledProgramError>;

    // ASAR path lookup must not silently pick the last duplicate directory or
    // member. Its standard writer emits unique file names at every level.
    #[derive(Debug)]
    struct UniqueFiles(BTreeMap<String, Node>);

    impl<'de> Deserialize<'de> for UniqueFiles {
        fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
            struct FilesVisitor;
            impl<'de> Visitor<'de> for FilesVisitor {
                type Value = UniqueFiles;
                fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                    f.write_str("unique ASAR file names")
                }
                fn visit_map<A: MapAccess<'de>>(
                    self,
                    mut map: A,
                ) -> std::result::Result<Self::Value, A::Error> {
                    let mut files = BTreeMap::new();
                    while let Some((key, value)) = map.next_entry::<String, Node>()? {
                        if files.insert(key, value).is_some() {
                            return Err(serde::de::Error::custom("duplicate ASAR member"));
                        }
                    }
                    Ok(UniqueFiles(files))
                }
            }
            d.deserialize_map(FilesVisitor)
        }
    }

    #[derive(Debug, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Node {
        files: Option<UniqueFiles>,
        size: Option<u64>,
        offset: Option<String>,
        link: Option<String>,
        unpacked: Option<bool>,
        // File integrity and executable mode are not identity inputs. The
        // complete archive is hashed independently, including these fields.
        #[serde(rename = "executable")]
        _executable: Option<bool>,
        #[serde(rename = "integrity")]
        _integrity: Option<serde::de::IgnoredAny>,
    }

    impl Node {
        fn member(&self, name: &str) -> Result<&Self> {
            if self.link.is_some()
                || self.unpacked == Some(true)
                || self.size.is_some()
                || self.offset.is_some()
            {
                return Err(InstalledProgramError);
            }
            self.files
                .as_ref()
                .and_then(|f| f.0.get(name))
                .ok_or(InstalledProgramError)
        }
        fn range(&self, payload_start: u64, archive_len: u64) -> Result<(u64, usize)> {
            if self.files.is_some() || self.link.is_some() || self.unpacked == Some(true) {
                return Err(InstalledProgramError);
            }
            let size = self
                .size
                .filter(|n| *n > 0 && *n <= MAX_MEMBER as u64)
                .ok_or(InstalledProgramError)?;
            let text = self.offset.as_deref().ok_or(InstalledProgramError)?;
            if text.is_empty()
                || text.len() > 20
                || !text.bytes().all(|c| c.is_ascii_digit())
                || (text.len() > 1 && text.starts_with('0'))
            {
                return Err(InstalledProgramError);
            }
            let offset: u64 = text.parse().map_err(|_| InstalledProgramError)?;
            let start = payload_start
                .checked_add(offset)
                .ok_or(InstalledProgramError)?;
            if start.checked_add(size).is_none_or(|end| end > archive_len) {
                return Err(InstalledProgramError);
            }
            Ok((start, size as usize))
        }
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Package {
        version: String,
        native_build_source_sha: String,
        native_build_id: String,
        desktop_edition_id: String,
        release_channel: String,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Renderer {
        version: String,
        build_id: String,
        platform: String,
    }

    fn read_member<R: Read + Seek>(r: &mut R, (start, size): (u64, usize)) -> Result<String> {
        r.seek(SeekFrom::Start(start))
            .map_err(|_| InstalledProgramError)?;
        let mut bytes = vec![0; size];
        r.read_exact(&mut bytes)
            .map_err(|_| InstalledProgramError)?;
        // serde may skip invalid UTF-8 inside unknown fields. Validate the
        // entire member, matching main's fatal UTF-8 decoder before parsing.
        String::from_utf8(bytes).map_err(|_| InstalledProgramError)
    }

    pub(super) fn program<R: Read + Seek>(r: &mut R, len: u64) -> Result<InstalledProgramIdentity> {
        if !(16..=MAX_ASAR as u64).contains(&len) {
            return Err(InstalledProgramError);
        }
        r.rewind().map_err(|_| InstalledProgramError)?;
        let mut prefix = [0; 16];
        r.read_exact(&mut prefix)
            .map_err(|_| InstalledProgramError)?;
        let word = |i| u32::from_le_bytes(prefix[i..i + 4].try_into().unwrap()) as usize;
        let header_len = word(4);
        let json_len = word(12);
        // Chromium pickle: [size-pickle: 4, header-size], then the string
        // pickle [payload-size, UTF-8 length, bytes, zero alignment padding].
        if word(0) != 4
            || !(8..=MAX_HEADER).contains(&header_len)
            || json_len == 0
            || json_len > MAX_HEADER - 8
            || header_len != 8 + json_len.next_multiple_of(4)
            || word(8) != header_len - 4
            || 8 + header_len as u64 > len
        {
            return Err(InstalledProgramError);
        }
        let mut body = vec![0; header_len - 8];
        r.read_exact(&mut body).map_err(|_| InstalledProgramError)?;
        if body[json_len..].iter().any(|b| *b != 0) {
            return Err(InstalledProgramError);
        }
        let text = std::str::from_utf8(&body[..json_len]).map_err(|_| InstalledProgramError)?;
        let tree: Node = serde_json::from_str(text).map_err(|_| InstalledProgramError)?;
        let payload_start = 8 + header_len as u64;
        let package_range = tree.member("package.json")?.range(payload_start, len)?;
        let renderer_range = tree
            .member("dist")?
            .member("version.json")?
            .range(payload_start, len)?;
        if package_range.0 < renderer_range.0 + renderer_range.1 as u64
            && renderer_range.0 < package_range.0 + package_range.1 as u64
        {
            return Err(InstalledProgramError);
        }
        let package: Package = serde_json::from_str(&read_member(r, package_range)?)
            .map_err(|_| InstalledProgramError)?;
        let renderer: Renderer = serde_json::from_str(&read_member(r, renderer_range)?)
            .map_err(|_| InstalledProgramError)?;
        let parts: Vec<_> = package.version.split('.').collect();
        let source = &package.native_build_source_sha;
        if parts.len() != 3
            || parts
                .iter()
                .any(|p| p.is_empty() || p.len() > 5 || !p.bytes().all(|b| b.is_ascii_digit()))
            || source.len() != 40
            || !source
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || package.native_build_id != format!("{}+{}", package.version, &source[..12])
            || renderer.version != package.version
            || renderer.build_id != package.native_build_id
            || renderer.platform != "desktop"
            || package.desktop_edition_id != "windows-performance-development-v1"
            || package.release_channel != "beta"
        {
            return Err(InstalledProgramError);
        }
        Ok(InstalledProgramIdentity {
            version: package.version,
            source_sha: package.native_build_source_sha,
            build_id: package.native_build_id,
            edition_id: package.desktop_edition_id,
            channel: package.release_channel,
            platform: "win32".into(),
            arch: "x64".into(),
            host_sha256: String::new(),
            asar_sha256: String::new(),
        })
    }
}

#[cfg(all(windows, target_arch = "x86_64"))]
mod windows {
    use super::*;
    use crate::qualification_catalog::windows::{lock_directories, open_bounded_file};
    use sha2::{Digest, Sha256};
    use std::fs::File;
    use std::io::{Read, Seek};
    use std::path::Path;

    struct Installation {
        _directories: Vec<File>,
        host: File,
        asar: File,
    }
    impl Installation {
        fn open(executable: &Path) -> Result<Self, InstalledProgramError> {
            let native = executable.parent().ok_or(InstalledProgramError)?;
            let resources = native.parent().ok_or(InstalledProgramError)?;
            if executable.as_os_str().len() > 4096
                || executable
                    .file_name()
                    .is_none_or(|n| n != "dsp-native-host.exe")
                || native.file_name().is_none_or(|n| n != "native")
            {
                return Err(InstalledProgramError);
            }
            let directories = lock_directories(native).map_err(|_| InstalledProgramError)?;
            let host = open_bounded_file(executable, 128 * 1024 * 1024)
                .map_err(|_| InstalledProgramError)?;
            let asar = open_bounded_file(&resources.join("app.asar"), archive::MAX_ASAR)
                .map_err(|_| InstalledProgramError)?;
            Ok(Self {
                _directories: directories,
                host,
                asar,
            })
        }
        fn identity(&mut self) -> Result<InstalledProgramIdentity, InstalledProgramError> {
            let len = self
                .asar
                .metadata()
                .map_err(|_| InstalledProgramError)?
                .len();
            let mut identity = archive::program(&mut self.asar, len)?;
            identity.host_sha256 = fingerprint(&mut self.host)?;
            identity.asar_sha256 = fingerprint(&mut self.asar)?;
            Ok(identity)
        }
    }

    fn fingerprint(file: &mut File) -> Result<String, InstalledProgramError> {
        let expected = file.metadata().map_err(|_| InstalledProgramError)?.len();
        file.rewind().map_err(|_| InstalledProgramError)?;
        let mut hash = Sha256::new();
        let mut buffer = [0; 64 * 1024];
        let mut total = 0;
        loop {
            let n = file.read(&mut buffer).map_err(|_| InstalledProgramError)?;
            if n == 0 {
                break;
            }
            total += n as u64;
            if total > expected {
                return Err(InstalledProgramError);
            }
            hash.update(&buffer[..n]);
        }
        if total != expected {
            return Err(InstalledProgramError);
        }
        Ok(hex::encode(hash.finalize()))
    }

    pub(super) fn collect(
        executable: &Path,
    ) -> Result<InstalledProgramIdentity, InstalledProgramError> {
        Installation::open(executable)?.identity()
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::fs;

        #[test]
        fn installed_files_stay_locked_until_the_complete_identity_is_collected() {
            let fixture: serde_json::Value =
                serde_json::from_str(include_str!("../../fixtures/installed-program-v1.json"))
                    .unwrap();
            let root = tempfile::tempdir().unwrap();
            let resources = root.path().join("resources");
            let native = resources.join("native");
            fs::create_dir_all(&native).unwrap();
            let host = native.join("dsp-native-host.exe");
            let asar = resources.join("app.asar");
            fs::write(&host, fixture["syntheticHost"].as_str().unwrap()).unwrap();
            fs::write(
                &asar,
                hex::decode(fixture["asarHex"].as_str().unwrap()).unwrap(),
            )
            .unwrap();
            let mut files = Installation::open(&host).unwrap();
            for file in [&host, &asar] {
                assert!(fs::OpenOptions::new().write(true).open(file).is_err());
                assert!(fs::rename(file, file.with_extension("renamed")).is_err());
            }
            assert!(fs::rename(&resources, root.path().join("replaced")).is_err());
            let identity = files.identity().unwrap();
            assert_eq!(identity.host_sha256, fixture["hostSha256"]);
            assert_eq!(identity.asar_sha256, fixture["asarSha256"]);
            drop(files);
            fs::rename(&asar, asar.with_extension("renamed")).unwrap();
        }

        #[test]
        fn installed_files_reject_hardlinks_and_nonstandard_executable_placement() {
            let root = tempfile::tempdir().unwrap();
            let native = root.path().join("native");
            fs::create_dir(&native).unwrap();
            let host = native.join("dsp-native-host.exe");
            fs::write(&host, b"TEST_ONLY").unwrap();
            fs::write(root.path().join("app.asar"), b"TEST_ONLY").unwrap();
            fs::hard_link(&host, native.join("alias.exe")).unwrap();
            assert!(Installation::open(&host).is_err());
            assert!(Installation::open(&native.join("alias.exe")).is_err());
            fs::remove_file(native.join("alias.exe")).unwrap();
            let misplaced = root.path().join("dsp-native-host.exe");
            fs::copy(&host, &misplaced).unwrap();
            assert!(Installation::open(&misplaced).is_err());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use std::io::Cursor;

    fn fixture() -> Value {
        serde_json::from_str(include_str!("../../fixtures/installed-program-v1.json")).unwrap()
    }
    fn decode(bytes: Vec<u8>) -> Result<InstalledProgramIdentity, InstalledProgramError> {
        let len = bytes.len() as u64;
        archive::program(&mut Cursor::new(bytes), len)
    }
    fn encode(header: &str, payload: &[u8]) -> Vec<u8> {
        let aligned = header.len().next_multiple_of(4);
        let mut bytes = Vec::new();
        for word in [
            4u32,
            (8 + aligned) as u32,
            (4 + aligned) as u32,
            header.len() as u32,
        ] {
            bytes.extend_from_slice(&word.to_le_bytes());
        }
        bytes.extend_from_slice(header.as_bytes());
        bytes.resize(16 + aligned, 0);
        bytes.extend_from_slice(payload);
        bytes
    }
    fn synthetic(package: &str, renderer: &str, change: impl FnOnce(&mut Value)) -> Vec<u8> {
        let mut header = json!({"files": {
            "package.json": {"size": package.len(), "offset": "0"},
            "dist": {"files": {"version.json": {"size": renderer.len(), "offset": package.len().to_string()}}}
        }});
        change(&mut header);
        encode(
            &header.to_string(),
            format!("{package}{renderer}").as_bytes(),
        )
    }

    #[test]
    fn parses_independent_electron_asar_writer_fixture() {
        let f = fixture();
        let actual = decode(hex::decode(f["asarHex"].as_str().unwrap()).unwrap()).unwrap();
        let mut value = serde_json::to_value(actual).unwrap();
        value.as_object_mut().unwrap().remove("hostSha256");
        value.as_object_mut().unwrap().remove("asarSha256");
        assert_eq!(value, f["program"]);
    }

    #[test]
    fn rejects_truncation_and_unbounded_or_inconsistent_pickle_lengths() {
        let original = hex::decode(fixture()["asarHex"].as_str().unwrap()).unwrap();
        for size in [0, 1, 7, 8, 15, 16, original.len() - 1] {
            assert!(decode(original[..size].to_vec()).is_err());
        }
        for (offset, value) in [
            (0, 0),
            (4, 0),
            (4, u32::MAX),
            (8, 0),
            (12, 0),
            (12, u32::MAX),
        ] {
            let mut bytes = original.clone();
            bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
            assert!(decode(bytes).is_err());
        }
        assert!(
            archive::program(&mut Cursor::new(original), archive::MAX_ASAR as u64 + 1).is_err()
        );
    }

    #[test]
    fn rejects_unsafe_or_ambiguous_member_ranges_and_directory_redirects() {
        let f = fixture();
        let p = f["packageInfo"].to_string();
        let r = f["renderer"].to_string();
        for offset in [
            "",
            "00",
            "-1",
            "1e2",
            " 0",
            "0\n",
            "18446744073709551615",
            "18446744073709551616",
        ] {
            assert!(
                decode(synthetic(
                    &p,
                    &r,
                    |h| h["files"]["package.json"]["offset"] = json!(offset)
                ))
                .is_err()
            );
        }
        for (key, value) in [
            ("size", json!(0)),
            ("size", json!(65537)),
            ("unpacked", json!(true)),
            ("link", json!("alias")),
            ("files", json!({})),
        ] {
            assert!(
                decode(synthetic(&p, &r, |h| h["files"]["package.json"][key] = value)).is_err()
            );
        }
        assert!(
            decode(synthetic(&p, &r, |h| h["files"]["dist"]["link"] = json!("other"))).is_err()
        );
        assert!(
            decode(synthetic(
                &p,
                &r,
                |h| h["files"]["dist"]["files"]["version.json"]["offset"] = json!("0")
            ))
            .is_err()
        );
    }

    #[test]
    fn rejects_duplicate_paths_fields_invalid_utf8_and_nonzero_padding() {
        let f = fixture();
        let p = f["packageInfo"].to_string();
        let r = f["renderer"].to_string();
        let good = synthetic(&p, &r, |_| {});
        let len = u32::from_le_bytes(good[12..16].try_into().unwrap()) as usize;
        let header = String::from_utf8(good[16..16 + len].to_vec()).unwrap();
        let payload = format!("{p}{r}");
        assert!(
            decode(encode(
                &header.replacen(
                    "\"package.json\":",
                    "\"package.json\":{},\"package.json\":",
                    1
                ),
                payload.as_bytes()
            ))
            .is_err()
        );
        assert!(
            decode(encode(
                &header.replacen("\"offset\":", "\"offset\":null,\"offset\":", 1),
                payload.as_bytes()
            ))
            .is_err()
        );
        let mut utf8 = good.clone();
        utf8[16] = 0xff;
        assert!(decode(utf8).is_err());
        let duplicate = p.replacen("\"version\":", "\"version\":\"1.2.7\",\"version\":", 1);
        assert!(decode(synthetic(&duplicate, &r, |_| {})).is_err());
        let mut padded_header = format!("{header} ");
        if padded_header.len().is_multiple_of(4) {
            padded_header.push(' ');
        }
        let mut padded = encode(&padded_header, payload.as_bytes());
        let padding_index = 16 + padded_header.len();
        padded[padding_index] = 1;
        assert!(decode(padded).is_err());
    }

    #[test]
    fn invalid_utf8_is_rejected_even_in_otherwise_ignored_json_fields() {
        let f = fixture();
        let mut bytes = hex::decode(f["asarHex"].as_str().unwrap()).unwrap();
        let marker = b"\"algorithm\":\"SHA256\"";
        let start = bytes
            .windows(marker.len())
            .position(|w| w == marker)
            .unwrap();
        bytes[start + b"\"algorithm\":\"".len()] = 0xff;
        assert!(decode(bytes).is_err());

        for member in ["packageInfo", "renderer"] {
            let mut input = f.clone();
            input[member]["unrelatedField"] = json!("ENCODING_MARKER");
            let mut bytes = synthetic(
                &input["packageInfo"].to_string(),
                &input["renderer"].to_string(),
                |_| {},
            );
            let marker = b"ENCODING_MARKER";
            let index = bytes
                .windows(marker.len())
                .position(|w| w == marker)
                .unwrap();
            bytes[index] = 0xff;
            assert!(decode(bytes).is_err());
        }
    }

    #[test]
    fn rejects_dirty_mismatched_or_unsupported_program_metadata() {
        let f = fixture();
        for (key, value) in [
            ("version", "1.2.7\n"),
            ("nativeBuildSourceSha", "a"),
            ("nativeBuildId", "1.2.7+aaaaaaaaaaaa.dirty"),
            ("releaseChannel", "stable"),
            ("desktopEditionId", "stable-v1"),
        ] {
            let mut p = f["packageInfo"].clone();
            p[key] = json!(value);
            assert!(
                decode(synthetic(
                    &p.to_string(),
                    &f["renderer"].to_string(),
                    |_| {}
                ))
                .is_err()
            );
        }
        for (key, value) in [
            ("version", "1.2.6"),
            ("buildId", "1.2.7+bbbbbbbbbbbb"),
            ("platform", "web"),
        ] {
            let mut r = f["renderer"].clone();
            r[key] = json!(value);
            assert!(
                decode(synthetic(
                    &f["packageInfo"].to_string(),
                    &r.to_string(),
                    |_| {}
                ))
                .is_err()
            );
        }
    }

    #[test]
    fn production_provider_refuses_uninstalled_test_executable() {
        assert!(collect_installed_windows_program_identity().is_err());
    }
}
