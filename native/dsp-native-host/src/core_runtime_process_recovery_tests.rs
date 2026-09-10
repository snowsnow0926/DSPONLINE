// Kept inside core_runtime::tests so no subprocess fixture or activation
// override is compiled into the production Host.
mod process_recovery {
    use super::*;
    use std::fs;
    use std::process::{Command, Stdio};

    const CHILD_TEST: &str = "core_runtime::tests::process_recovery::subprocess_fixture";
    const COMMAND_ID: &str = "process-boundary-command";
    const OWNER_MARKER: &str = "process-recovery-test-owner";
    const RECEIPT: &str = "process-recovery-test-receipt.json";

    fn run_child(root: &Path, phase: &str, expected_exit: i32, base_revision: u64) -> Value {
        let mut child = Command::new(std::env::current_exe().unwrap());
        child
            .args([CHILD_TEST, "--exact", "--ignored", "--test-threads=1"])
            .env("DSP_RUST_TEST_PROCESS_ROOT", root)
            .env("DSP_RUST_TEST_PROCESS_PHASE", phase)
            .env(
                "DSP_RUST_TEST_PROCESS_OWNER",
                std::process::id().to_string(),
            )
            .env(
                "DSP_RUST_TEST_PROCESS_BASE_REVISION",
                base_revision.to_string(),
            )
            .stdin(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS.
            child.creation_flags(0x0800_0000 | 0x0000_4000);
        }
        let result = child.output().expect("start owned test subprocess");
        assert_eq!(
            result.status.code(),
            Some(expected_exit),
            "{phase}: {} {}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        let receipt: Value =
            serde_json::from_slice(&fs::read(root.join(RECEIPT)).unwrap()).unwrap();
        assert_eq!(receipt["phase"], phase);
        assert_ne!(receipt["pid"], std::process::id());
        receipt
    }

    #[test]
    fn command_recovers_after_abrupt_subprocess_exit_at_every_durable_boundary() {
        let (
            _reference_root,
            mut reference_store,
            mut reference_registry,
            reference_session,
            entry,
        ) = player_authority_fixture();
        let expected_command = reference_registry
            .commit_player_authority_command(
                &mut reference_store,
                &reference_session,
                player_authority_command(entry.revision, COMMAND_ID, json!(17.0)),
            )
            .unwrap();
        let expected_tick = reference_registry
            .commit_player_authority_tick(
                &mut reference_store,
                &reference_session,
                CoreCommitPlayerAuthorityTickRequest {
                    run_id: "player-authority-run".to_owned(),
                    sequence: 2,
                },
            )
            .unwrap();

        for phase in ["stage", "wal", "checkpoint", "receipt", "acknowledge"] {
            let (root, store, registry, _session, checkpoint) = player_authority_fixture();
            assert_eq!(checkpoint.revision, entry.revision);
            fs::write(
                root.path().join(OWNER_MARKER),
                std::process::id().to_string(),
            )
            .unwrap();
            drop(registry);
            drop(store);

            // Each child exits without Rust destructors, not merely drop/open
            // of a registry in the same process. The first recovery receipt is
            // deliberately lost before another process retries the command.
            run_child(root.path(), phase, 73, checkpoint.revision);
            let recovered = run_child(root.path(), "recover", 74, checkpoint.revision);
            let continued = run_child(root.path(), "retry-and-tick", 75, checkpoint.revision);
            assert_eq!(recovered["revision"], entry.revision + 1);
            assert_eq!(recovered["nextSequence"], 2);
            assert_eq!(
                recovered["canonicalSha256"],
                expected_command.summary.canonical_sha256
            );
            assert_eq!(
                recovered["domainSha256"],
                expected_command.summary.domain_sha256
            );
            assert_eq!(continued["revision"], entry.revision + 2);
            assert_eq!(
                continued["canonicalSha256"],
                expected_tick.summary.canonical_sha256
            );
            assert_eq!(
                continued["domainSha256"],
                expected_tick.summary.domain_sha256
            );

            let mut final_store = SaveStore::open(root.path()).unwrap();
            let lease = final_store.require_exact_realtime_lease().unwrap();
            assert_eq!(lease.acknowledged.sequence, 2);
            assert_eq!(lease.acknowledged.revision, entry.revision + 2);
            assert!(lease.pending_command.is_none());
            // Subprocess fixture success must not make production coverage
            // eligible or mutate an acknowledged lease on rejected startup.
            let mut production_registry = CoreRegistry::default();
            let error = production_registry
                .recover_player_authority_pending_command_on_startup(&mut final_store)
                .unwrap_err();
            assert!(format!("{error:#}").contains("not player-authority eligible"));
            assert_eq!(final_store.require_exact_realtime_lease().unwrap(), lease);
        }
    }

    #[test]
    #[ignore = "owned subprocess fixture; invoked explicitly by the parent recovery test"]
    fn subprocess_fixture() {
        let root =
            std::path::PathBuf::from(std::env::var_os("DSP_RUST_TEST_PROCESS_ROOT").unwrap());
        let owner = std::env::var("DSP_RUST_TEST_PROCESS_OWNER").unwrap();
        assert_eq!(fs::read_to_string(root.join(OWNER_MARKER)).unwrap(), owner);
        // Only the parent's fresh temporary fixture is accepted. A player
        // profile cannot accidentally become the subprocess's data root.
        assert_eq!(
            root.canonicalize().unwrap().parent().unwrap(),
            std::env::temp_dir().canonicalize().unwrap()
        );
        let phase = std::env::var("DSP_RUST_TEST_PROCESS_PHASE").unwrap();
        let base_revision: u64 = std::env::var("DSP_RUST_TEST_PROCESS_BASE_REVISION")
            .unwrap()
            .parse()
            .unwrap();
        let mut store = SaveStore::open(&root).unwrap();
        let mut registry = resumable_player_authority_registry_for_test();
        let opened = registry
            .recover_player_authority_pending_command_on_startup(&mut store)
            .unwrap()
            .expect("fixture active lease must be recoverable");
        let (exit_code, observation) = if phase == "recover" {
            assert_eq!(opened.revision, base_revision + 1);
            assert_eq!(opened.next_sequence, 2);
            let lease = store.require_exact_realtime_lease().unwrap();
            assert!(lease.pending_command.is_none());
            (
                74,
                json!({
                    "revision": opened.revision,
                    "nextSequence": opened.next_sequence,
                    "canonicalSha256": opened.summary.canonical_sha256,
                    "domainSha256": opened.summary.domain_sha256
                }),
            )
        } else if phase == "retry-and-tick" {
            let duplicate = registry
                .commit_player_authority_command(
                    &mut store,
                    &opened.session_id,
                    player_authority_command(base_revision, COMMAND_ID, json!(17.0)),
                )
                .unwrap();
            assert!(duplicate.duplicate);
            assert_eq!(duplicate.sequence, 1);
            assert_eq!(duplicate.revision, base_revision + 1);
            let tick = registry
                .commit_player_authority_tick(
                    &mut store,
                    &opened.session_id,
                    CoreCommitPlayerAuthorityTickRequest {
                        run_id: opened.run_id,
                        sequence: opened.next_sequence,
                    },
                )
                .unwrap();
            assert_eq!(tick.sequence, 2);
            (
                75,
                json!({
                    "revision": tick.revision,
                    "canonicalSha256": tick.summary.canonical_sha256,
                    "domainSha256": tick.summary.domain_sha256
                }),
            )
        } else {
            let fault = match phase.as_str() {
                "stage" => PlayerAuthorityCommandFault::AfterStage,
                "wal" => PlayerAuthorityCommandFault::AfterWal,
                "checkpoint" => PlayerAuthorityCommandFault::AfterCheckpoint,
                "receipt" => PlayerAuthorityCommandFault::AfterReceipt,
                "acknowledge" => PlayerAuthorityCommandFault::AfterLeaseAcknowledge,
                _ => panic!("unknown owned subprocess phase"),
            };
            let error = registry
                .commit_player_authority_command_internal(
                    &mut store,
                    &opened.session_id,
                    player_authority_command(base_revision, COMMAND_ID, json!(17.0)),
                    PlayerAuthorityCommandKind::Gameplay,
                    fault,
                )
                .unwrap_err();
            assert!(format!("{error:#}").contains("lost response"));
            (73, json!({}))
        };
        let mut observation = observation;
        observation["pid"] = json!(std::process::id());
        observation["phase"] = json!(phase);
        fs::write(
            root.join(RECEIPT),
            serde_json::to_vec(&observation).unwrap(),
        )
        .unwrap();
        // Intentionally skip SaveStore/CoreRegistry destructors and libtest's
        // normal completion. The parent requires this exact exit + receipt.
        std::process::exit(exit_code);
    }
}
