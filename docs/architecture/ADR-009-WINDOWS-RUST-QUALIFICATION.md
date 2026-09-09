# ADR-009: Separate development evidence from Windows Rust authority

- Date: 2026-09-09
- Status: development evidence contract and fixed Rust library test collection implemented; production trust and activation design pending
- Extends: [ADR-008](./ADR-008-WINDOWS-PERFORMANCE-EDITION.md)
- Compatibility: no GameState, envelope, cloud, Host protocol or player-authority change

The implementation route is specified in [the catalog carrier plan](../rust/windows-qualification-carrier.md): external catalog/member binding, independent main platform helper and Host Windows API verification, explicit no-UI/offline policy, and a separate recovery capability after gameplay qualification expires. The Host has an initial standalone catalog member verifier with bounded locked inputs and negative Windows tests; it is not connected to activation and lacks a trusted signed positive fixture. See [its evidence and remaining work](../reviews/rust-windows-catalog-verifier-2026-09-09.md). The main verifier, publisher credentials, authenticated producers, revocation/clock anti-rollback and actual activation remain open.

## Context

The user expanded the development objective to a complete Windows Rust edition. Existing domain coverage and player-authority brokers are implementation evidence, while the production Host still reports `authority_eligible=false`. Historical test results are bound to different source and package identities. Neither a green implementation inventory nor successful fallback to JavaScript qualifies a new native player session.

## Decision for this increment

Introduce an offline, bounded development evidence auditor, outside renderer and Host runtime. It compares every report with a separately frozen candidate identity, verifies exact report bytes, requires the complete initial check roster, and rejects stale, revoked, missing, failed, skipped, mixed-backend and retry-only results. The report schema is TEST_ONLY. Its output always denies producer authentication, player authority and release permission.

Reuse the existing desktop artifact path checks; hash bounded metadata from the same byte snapshot used for parsing. Build manifests remain integrity evidence, not signatures. No signing key, environment activation flag, UI override, runtime grant or change to the Host eligibility boolean is introduced.

The initial roster covers only the normal-mode, 1x, built-in-content realtime foundation. Full game coverage, speedrun, content combinations, numerical acceptance thresholds, hardware and release qualification remain separate required work. A producer's self-reported Rust execution label is not independent proof of execution.

## Production decisions still required

The producer runs eight fixed optimized Host library tests and binds their actual executable, input sources and raw logs. Seven reports identify process-local registry reopening; the eighth identifies actual child-process exits at five durable command boundaries, followed by restart, duplicate-command and next-tick checks. This still uses a directly activated fixture and a synthetic position change. It does not qualify production Host RPC, desktop handoff, power loss, independent JS parity, conservation or performance, and cannot populate a complete passing qualification bundle. See [the execution evidence](../reviews/rust-windows-process-recovery-2026-09-09.md).

Before runtime integration, specify and implement authenticated producer provenance, the Windows publisher-bound qualification carrier, verifier placement in both main and Host, bounded validation-only execution, expiry/revocation freshness and anti-rollback, exact content/mode matching, and active-session failure handling. Preserve the existing Windows signing and artifact trust boundary; do not replace it with a self-authored JSON allowlist.

The qualification carrier must sit outside the frozen Host/ASAR it identifies, avoiding a self-referential build hash. Formal package validation cannot inherit TEST_ONLY evidence as authority. Missing external signing or hardware evidence remains a gap while independent development continues.

## Consequences and verification

Development can prevent accidental evidence mixing before the activation chain exists. It cannot certify report truth, sufficient assertions, real performance thresholds, or a release-ready binary. [The design](../rust/qualification-design.md) records producers, identity, invalidation and the unresolved validation bootstrap. [The auditor tests](../../scripts/native-qualification-evidence.test.mjs) exercise valid test bundles and negative boundaries; their synthetic fixtures are not a current candidate's qualification.
