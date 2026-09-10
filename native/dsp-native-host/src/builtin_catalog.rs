//! Built-in content carried by this binary, never learned from a renderer,
//! save or qualification body. Directory equality is not gameplay authority.
use dsp_native_core::{canonical::canonical_sha256, catalog::RuntimeCatalog};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::OnceLock;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltinCatalogIdentity {
    pub registry_fingerprint: String,
    pub catalog_sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Snapshot {
    schema_version: u32,
    kind: String,
    registry_fingerprint: String,
    catalog_sha256: String,
    catalog: Value,
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("builtin-catalog-invalid")]
pub struct BuiltinCatalogError;

fn parse(bytes: &[u8]) -> Result<BuiltinCatalogIdentity, BuiltinCatalogError> {
    if bytes.is_empty() || bytes.len() > 1024 * 1024 {
        return Err(BuiltinCatalogError);
    }
    let body: Snapshot = serde_json::from_slice(bytes).map_err(|_| BuiltinCatalogError)?;
    if body.schema_version != 1
        || body.kind != "native-builtin-catalog-v1"
        || body.registry_fingerprint.is_empty()
        || body.catalog_sha256 != canonical_sha256(&body.catalog)
    {
        return Err(BuiltinCatalogError);
    }
    // Validate the real full directory, including definitions/relations, with
    // the same parser used by CoreState, not merely the claimed digest.
    RuntimeCatalog::from_value(body.catalog, &body.registry_fingerprint)
        .map_err(|_| BuiltinCatalogError)?;
    Ok(BuiltinCatalogIdentity {
        registry_fingerprint: body.registry_fingerprint,
        catalog_sha256: body.catalog_sha256,
    })
}

pub fn builtin_catalog_identity() -> Result<&'static BuiltinCatalogIdentity, BuiltinCatalogError> {
    static IDENTITY: OnceLock<Result<BuiltinCatalogIdentity, BuiltinCatalogError>> =
        OnceLock::new();
    IDENTITY
        .get_or_init(|| {
            parse(include_bytes!(
                "../../../desktop/native-builtin-catalog-v1.json"
            ))
        })
        .as_ref()
        .map_err(Clone::clone)
}

pub fn matches_builtin_catalog(
    catalog: &Value,
    registry_fingerprint: &str,
) -> Result<bool, BuiltinCatalogError> {
    let expected = builtin_catalog_identity()?;
    Ok(registry_fingerprint == expected.registry_fingerprint
        && catalog.get("registryFingerprint").and_then(Value::as_str) == Some(registry_fingerprint)
        && canonical_sha256(catalog) == expected.catalog_sha256)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn body() -> Value {
        serde_json::from_slice(include_bytes!(
            "../../../desktop/native-builtin-catalog-v1.json"
        ))
        .unwrap()
    }

    #[test]
    fn compiled_builtin_catalog_uses_full_runtime_parser_and_digest() {
        let body = body();
        let identity = builtin_catalog_identity().unwrap();
        assert_eq!(identity.catalog_sha256, body["catalogSha256"]);
        assert!(matches_builtin_catalog(&body["catalog"], &identity.registry_fingerprint).unwrap());
        assert!(!matches_builtin_catalog(&body["catalog"], "forged-registry").unwrap());
    }

    #[test]
    fn same_registry_cannot_conceal_changed_recipe_building_order_or_unknown_data() {
        let source = body();
        let fingerprint = source["registryFingerprint"].as_str().unwrap();
        for case in 0..5 {
            let mut catalog = source["catalog"].clone();
            match case {
                0 => catalog["recipes"][0]["duration"] = 999.into(),
                1 => catalog["buildings"][0]["speed"] = 999.into(),
                2 => catalog["items"].as_array_mut().unwrap().reverse(),
                3 => catalog["unknownField"] = true.into(),
                _ => catalog["registryFingerprint"] = "forged-registry".into(),
            }
            assert!(
                !matches_builtin_catalog(&catalog, fingerprint).unwrap(),
                "case {case}"
            );
        }
    }

    #[test]
    fn invalid_embedded_snapshot_fails_closed() {
        for case in 0..7 {
            let mut source = body();
            match case {
                0 => source["schemaVersion"] = 2.into(),
                1 => source["kind"] = "other".into(),
                2 => source["catalogSha256"] = "0".repeat(64).into(),
                3 => source["registryFingerprint"] = "other".into(),
                4 => source["unknownField"] = true.into(),
                5 => source["catalog"]["protocolVersion"] = 2.into(),
                _ => {
                    source["catalog"]["items"][0]["id"] = "".into();
                    source["catalogSha256"] = canonical_sha256(&source["catalog"]).into();
                }
            }
            assert_eq!(
                parse(&serde_json::to_vec(&source).unwrap()),
                Err(BuiltinCatalogError),
                "case {case}"
            );
        }
        assert_eq!(parse(b"{}"), Err(BuiltinCatalogError));
        assert_eq!(
            parse(&vec![b' '; 1024 * 1024 + 1]),
            Err(BuiltinCatalogError)
        );
    }
}
