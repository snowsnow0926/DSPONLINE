use super::*;
use serde_json::Value;

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../fixtures/qualification-binding-v1.json"
    ))
    .unwrap()
}

#[test]
fn shared_validation_body_vectors() {
    let fixture = fixture();
    let vectors = fixture["cases"].as_array().unwrap();
    assert_eq!(vectors.len(), 76);
    for vector in vectors {
        let mut context = fixture["context"].clone();
        for patch in vector["contextPatch"].as_array().unwrap() {
            let keys = patch["path"].as_array().unwrap();
            let mut target = &mut context;
            for key in &keys[..keys.len() - 1] {
                target = &mut target[key.as_str().unwrap()];
            }
            target[keys.last().unwrap().as_str().unwrap()] = patch["value"].clone();
        }
        let context: Result<ValidationBindingContext, _> = serde_json::from_value(context);
        let member = VerifiedCatalogMember::test_only_member(
            vector["body"].as_str().unwrap().as_bytes().to_vec(),
            [0xaa; 32],
        );
        let result = context
            .map_err(|_| QualificationBindingError::Context)
            .and_then(|context| bind_authenticated_validation_qualification(&member, &context));
        let expected = vector["expected"].as_str().unwrap();
        match result {
            Ok(bound) => {
                assert_eq!(expected, "PASS", "{}", vector["name"]);
                assert!(!bound.authority_eligible());
                assert_eq!(bound.member_sha256(), member.member_sha256());
                assert_eq!(bound.carrier_catalog_sha256(), member.catalog_sha256());
                assert_eq!(bound.publisher_certificate_sha256(), [0xaa; 32]);
                assert_eq!(bound.qualification_id(), "public-synthetic-validation-1");
                assert_eq!(bound.producer_set_sha256(), "b".repeat(64));
                assert_eq!(bound.proof_set_sha256(), "c".repeat(64));
                assert_eq!(bound.revocation_generation(), 3);
                assert!(bound.expires_at_ms() > bound.checked_at_ms());
            }
            Err(error) => assert_eq!(error.to_string(), expected, "{}", vector["name"]),
        }
    }
}

#[test]
fn body_and_context_do_not_alias_the_bound_credential() {
    let fixture = fixture();
    let mut context: ValidationBindingContext =
        serde_json::from_value(fixture["context"].clone()).unwrap();
    let member = VerifiedCatalogMember::test_only_member(
        fixture["body"].as_str().unwrap().as_bytes().to_vec(),
        [0xaa; 32],
    );
    let bound = bind_authenticated_validation_qualification(&member, &context).unwrap();
    context.candidate.host_sha256 = "0".repeat(64);
    context.session.cloud_writes = true;
    drop(member);
    assert_eq!(bound.candidate().host_sha256, "2".repeat(64));
    assert!(!bound.session().cloud_writes);
    assert!(!bound.authority_eligible());
}

#[test]
fn invalid_utf8_cannot_be_decoded_lossily() {
    let fixture = fixture();
    let context = serde_json::from_value(fixture["context"].clone()).unwrap();
    let mut bytes = fixture["body"].as_str().unwrap().as_bytes().to_vec();
    let index = bytes.windows(6).position(|w| w == b"public").unwrap();
    bytes[index] = 0xff;
    let member = VerifiedCatalogMember::test_only_member(bytes, [0xaa; 32]);
    assert_eq!(
        bind_authenticated_validation_qualification(&member, &context).unwrap_err(),
        QualificationBindingError::Format
    );
}
