// Included only in the Windows unit-test module. No fixture environment input
// or test publisher policy is compiled into the production Host.
const SIGNED_FIXTURE_BODY: &[u8] = b"{\"kind\":\"dsp-catalog-TEST_ONLY\",\"version\":1}";

fn signed_fixture_inputs() -> (PathBuf, [u8; 32]) {
    let root = PathBuf::from(
        std::env::var_os("DSP_CATALOG_TEST_ROOT").expect("explicit signed fixture root"),
    );
    assert!(root.is_absolute());
    let pin =
        std::env::var("DSP_CATALOG_TEST_PUBLISHER_SHA256").expect("independent test publisher pin");
    assert_eq!(pin.len(), 64);
    let pin = hex::decode(pin)
        .expect("hexadecimal publisher pin")
        .try_into()
        .unwrap();
    (root, pin)
}

#[test]
#[ignore = "requires an explicitly prepared signed fixture on the isolated Windows CI runner"]
fn signed_fixture_without_root_trust_is_rejected() {
    let (root, pin) = signed_fixture_inputs();
    for name in ["valid", "binding"] {
        let result = verify_windows_catalog_member(&root.join(name), &[pin]);
        assert!(
            matches!(result, Err(CatalogVerificationError::TrustRejected(_))),
            "signed but untrusted publisher must be rejected: {result:?}"
        );
    }
}

#[test]
#[ignore = "requires temporary TEST_ONLY root trust on the isolated Windows CI runner"]
fn signed_validation_body_binds_independent_program_and_session() {
    use crate::qualification_binding::{
        QualificationBindingError, ValidationBindingContext,
        bind_authenticated_validation_qualification,
    };
    let (root, pin) = signed_fixture_inputs();
    let vectors: serde_json::Value =
        serde_json::from_str(include_str!("../../fixtures/qualification-binding-v1.json")).unwrap();
    let mut context: ValidationBindingContext =
        serde_json::from_value(vectors["context"].clone()).unwrap();
    context.publisher_certificate_sha256 = hex::encode(pin);
    let member = verify_windows_catalog_member(&root.join("binding"), &[pin]).unwrap();
    assert_eq!(
        member.member_bytes(),
        vectors["body"].as_str().unwrap().as_bytes()
    );
    let bound = bind_authenticated_validation_qualification(&member, &context).unwrap();
    assert_eq!(bound.candidate(), &context.candidate);
    assert!(!bound.authority_eligible());
    let mut wrong_program = context.clone();
    wrong_program.candidate.host_sha256 = "f".repeat(64);
    assert_eq!(
        bind_authenticated_validation_qualification(&member, &wrong_program).unwrap_err(),
        QualificationBindingError::Candidate
    );
    let mut wrong_session = context.clone();
    wrong_session.session.profile_id = "f".repeat(32);
    assert_eq!(
        bind_authenticated_validation_qualification(&member, &wrong_session).unwrap_err(),
        QualificationBindingError::Session
    );
    context
        .revoked_qualification_ids
        .push(bound.qualification_id().to_owned());
    assert_eq!(
        bind_authenticated_validation_qualification(&member, &context).unwrap_err(),
        QualificationBindingError::Revoked
    );
    println!(
        "DSP_CATALOG_BOUND_VALIDATION accepted=true program_mismatch=true session_mismatch=true revoked=true authority_eligible=false evidenceClass=TEST_ONLY"
    );
}

#[test]
#[ignore = "requires temporary TEST_ONLY root trust on the isolated Windows CI runner"]
fn signed_fixture_member_publisher_and_tamper_validation() {
    let (root, pin) = signed_fixture_inputs();
    let temp = fixture();
    let carrier = temp.path().join("native-qualification");
    let cat_path = carrier.join("qualification.cat");
    let member_path = carrier.join("qualification.json");
    let cat = std::fs::read(root.join("valid/native-qualification/qualification.cat")).unwrap();
    let member = std::fs::read(root.join("valid/native-qualification/qualification.json")).unwrap();
    assert_eq!(member, SIGNED_FIXTURE_BODY);
    std::fs::write(&cat_path, &cat).unwrap();
    std::fs::write(&member_path, &member).unwrap();

    let accepted = verify_windows_catalog_member(temp.path(), &[pin])
        .expect("actual Windows signed member acceptance");
    assert_eq!(accepted.member_bytes(), SIGNED_FIXTURE_BODY);
    assert_eq!(
        accepted.member_sha256(),
        <[u8; 32]>::from(Sha256::digest(&member))
    );
    assert_eq!(
        accepted.catalog_sha256(),
        <[u8; 32]>::from(Sha256::digest(&cat))
    );
    assert_eq!(accepted.publisher_certificate_sha256(), pin);

    let mut wrong_pin = pin;
    wrong_pin[0] ^= 1;
    assert!(matches!(
        verify_windows_catalog_member(temp.path(), &[wrong_pin]),
        Err(CatalogVerificationError::PublisherMismatch)
    ));
    // A rotation list still has to contain the actual authenticated signer.
    assert_eq!(
        verify_windows_catalog_member(temp.path(), &[wrong_pin, pin])
            .unwrap()
            .publisher_certificate_sha256(),
        pin
    );

    // Mutating syntactically valid JSON must invalidate its catalog membership.
    std::fs::write(
        &member_path,
        b"{\"kind\":\"dsp-catalog-TEST_ONLY\",\"version\":2}",
    )
    .unwrap();
    assert!(matches!(
        verify_windows_catalog_member(temp.path(), &[pin]),
        Err(CatalogVerificationError::TrustRejected(_))
    ));
    assert_eq!(
        accepted.member_bytes(),
        SIGNED_FIXTURE_BODY,
        "authenticated result owns its immutable snapshot"
    );
    std::fs::write(&member_path, &member).unwrap();

    // A separately valid signature by the same publisher cannot authenticate a
    // member that is absent from that catalog.
    let unrelated = verify_windows_catalog_member(&root.join("unrelated"), &[pin])
        .expect("the replacement catalog is itself valid for its own member");
    assert_ne!(unrelated.member_sha256(), accepted.member_sha256());
    std::fs::copy(
        root.join("unrelated/native-qualification/qualification.cat"),
        &cat_path,
    )
    .unwrap();
    assert!(matches!(
        verify_windows_catalog_member(temp.path(), &[pin]),
        Err(CatalogVerificationError::TrustRejected(_))
    ));

    let mut broken_signature = cat.clone();
    *broken_signature.last_mut().unwrap() ^= 1;
    std::fs::write(&cat_path, broken_signature).unwrap();
    assert!(matches!(
        verify_windows_catalog_member(temp.path(), &[pin]),
        Err(CatalogVerificationError::TrustRejected(_))
    ));
    std::fs::write(&cat_path, &cat).unwrap();
    assert_eq!(
        verify_windows_catalog_member(temp.path(), &[pin])
            .unwrap()
            .member_bytes(),
        SIGNED_FIXTURE_BODY
    );

    // Success and all failed verifications release their locks; the returned
    // bytes remain unchanged after replacing the carrier directory.
    std::fs::rename(&carrier, temp.path().join("moved")).unwrap();
    assert_eq!(accepted.member_bytes(), SIGNED_FIXTURE_BODY);
    println!(
        "DSP_CATALOG_SIGNED_FIXTURE accepted=true publisher_mismatch=true rotation=true member_tamper=true unrelated_catalog=true signature_tamper=true locks_released=true authority_eligible=false evidenceClass=TEST_ONLY"
    );
}
