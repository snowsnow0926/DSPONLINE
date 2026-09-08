use std::{cell::RefCell, sync::OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

const MAX_PROFILE_OPERATION_RECORDS: usize = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProfileOperationPurpose {
    LocalDispatchTimingV1,
    LocalDispatchShapeV1,
    QuantumOactiveShapeV1,
}

impl ProfileOperationPurpose {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::LocalDispatchTimingV1 => "local-dispatch-timing-v1",
            Self::LocalDispatchShapeV1 => "local-dispatch-shape-v1",
            Self::QuantumOactiveShapeV1 => "quantum-oactive-shape-v1",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileOperationBinding {
    request_id: u64,
    session_id_sha256: [u8; 32],
    base_revision: u64,
    expected_measured_revision: u64,
    purpose: ProfileOperationPurpose,
}

impl ProfileOperationBinding {
    pub fn new(
        request_id: u64,
        session_id: &str,
        base_revision: u64,
        purpose: ProfileOperationPurpose,
    ) -> Option<Self> {
        if request_id == 0 || session_id.is_empty() {
            return None;
        }
        Some(Self {
            request_id,
            session_id_sha256: Sha256::digest(session_id.as_bytes()).into(),
            base_revision,
            expected_measured_revision: base_revision.checked_add(1)?,
            purpose,
        })
    }

    pub(crate) const fn request_id(&self) -> u64 {
        self.request_id
    }

    pub(crate) const fn session_id_sha256(&self) -> &[u8; 32] {
        &self.session_id_sha256
    }

    pub(crate) const fn base_revision(&self) -> u64 {
        self.base_revision
    }

    pub(crate) const fn expected_measured_revision(&self) -> u64 {
        self.expected_measured_revision
    }

    pub(crate) const fn purpose(&self) -> ProfileOperationPurpose {
        self.purpose
    }
}

#[derive(Debug)]
struct ProfileOperationContext {
    binding: ProfileOperationBinding,
    records: Vec<Value>,
    overflowed: bool,
}

#[derive(Debug)]
pub struct ProfileOperationCapture<T> {
    pub result: T,
    pub records: Vec<Value>,
    pub overflowed: bool,
}

thread_local! {
    static PROFILE_OPERATION: RefCell<Option<ProfileOperationContext>> = const { RefCell::new(None) };
}

struct ProfileOperationGuard(Option<ProfileOperationContext>);

impl Drop for ProfileOperationGuard {
    fn drop(&mut self) {
        PROFILE_OPERATION.with(|slot| {
            slot.replace(self.0.take());
        });
    }
}

pub fn with_profile_operation_binding<T>(
    binding: ProfileOperationBinding,
    operation: impl FnOnce() -> T,
) -> ProfileOperationCapture<T> {
    let previous = PROFILE_OPERATION.with(|slot| {
        slot.replace(Some(ProfileOperationContext {
            binding,
            records: Vec::new(),
            overflowed: false,
        }))
    });
    let _guard = ProfileOperationGuard(previous);
    let result = operation();
    let (records, overflowed) = PROFILE_OPERATION.with(|slot| {
        let mut slot = slot.borrow_mut();
        let context = slot
            .as_mut()
            .expect("profile operation context must remain installed");
        (std::mem::take(&mut context.records), context.overflowed)
    });
    ProfileOperationCapture {
        result,
        records,
        overflowed,
    }
}

pub(crate) fn current_profile_operation_binding() -> Option<ProfileOperationBinding> {
    PROFILE_OPERATION.with(|slot| {
        slot.borrow()
            .as_ref()
            .map(|context| context.binding.clone())
    })
}

pub(crate) fn current_profile_operation_purpose() -> Option<ProfileOperationPurpose> {
    PROFILE_OPERATION.with(|slot| {
        slot.borrow()
            .as_ref()
            .map(|context| context.binding.purpose())
    })
}

pub(crate) fn record_profile_operation_evidence(record: Value) -> bool {
    PROFILE_OPERATION.with(|slot| {
        let mut slot = slot.borrow_mut();
        let Some(context) = slot.as_mut() else {
            return false;
        };
        if context.records.len() < MAX_PROFILE_OPERATION_RECORDS {
            context.records.push(record);
        } else {
            context.overflowed = true;
        }
        true
    })
}

pub(crate) fn profile_environment_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var_os("DSP_NATIVE_CORE_PROFILE").is_some())
}

/// Opt-in cold-open diagnostics. Only fixed phase labels and process timing
/// are emitted; these observations never participate in game state or proofs.
#[doc(hidden)]
pub struct OpenPhaseProfile {
    scope: &'static str,
    started: Option<std::time::Instant>,
    checkpoint: Option<std::time::Instant>,
}

impl OpenPhaseProfile {
    pub fn new(scope: &'static str) -> Self {
        let started = (std::env::var_os("DSP_NATIVE_CORE_OPEN_PROFILE").as_deref()
            == Some(std::ffi::OsStr::new("1")))
        .then(std::time::Instant::now);
        let mut profile = Self {
            scope,
            started,
            checkpoint: started,
        };
        profile.mark("start");
        profile
    }

    pub fn mark(&mut self, phase: &'static str) {
        let (Some(started), Some(checkpoint)) = (self.started, self.checkpoint) else {
            return;
        };
        let now = std::time::Instant::now();
        let unix_millis = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .map(|duration| duration.as_millis());
        let record = serde_json::json!({
            "schemaVersion": 1,
            "pid": std::process::id(),
            "scope": self.scope,
            "phase": phase,
            "durationMicros": now.duration_since(checkpoint).as_micros(),
            "elapsedMicros": now.duration_since(started).as_micros(),
            "unixMillis": unix_millis,
        });
        // A closed diagnostic pipe must not turn a valid load into a failure.
        use std::io::Write;
        let _ = writeln!(
            std::io::stderr().lock(),
            "DSP_NATIVE_CORE_OPEN_PHASE\t{record}"
        );
        self.checkpoint = Some(now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_operation_binding_is_scoped_and_restored() {
        assert!(current_profile_operation_binding().is_none());
        let outer = ProfileOperationBinding::new(
            7,
            "session-a",
            11,
            ProfileOperationPurpose::LocalDispatchTimingV1,
        )
        .unwrap();
        let outer_capture = with_profile_operation_binding(outer.clone(), || {
            assert_eq!(current_profile_operation_binding(), Some(outer.clone()));
            assert!(record_profile_operation_evidence(Value::from(
                "outer-before"
            )));
            let inner = ProfileOperationBinding::new(
                8,
                "session-b",
                12,
                ProfileOperationPurpose::LocalDispatchShapeV1,
            )
            .unwrap();
            let inner_capture = with_profile_operation_binding(inner.clone(), || {
                assert_eq!(current_profile_operation_binding(), Some(inner));
                assert!(record_profile_operation_evidence(Value::from("inner")));
            });
            assert_eq!(inner_capture.records, vec![Value::from("inner")]);
            assert!(!inner_capture.overflowed);
            assert_eq!(current_profile_operation_binding(), Some(outer));
            assert!(record_profile_operation_evidence(Value::from(
                "outer-after"
            )));
        });
        assert_eq!(
            outer_capture.records,
            vec![Value::from("outer-before"), Value::from("outer-after")]
        );
        assert!(!outer_capture.overflowed);
        assert!(current_profile_operation_binding().is_none());
        assert!(!record_profile_operation_evidence(Value::Null));
    }

    #[test]
    fn profile_operation_capture_is_bounded_and_marks_overflow() {
        let binding = ProfileOperationBinding::new(
            9,
            "session-c",
            13,
            ProfileOperationPurpose::LocalDispatchShapeV1,
        )
        .unwrap();
        let capture = with_profile_operation_binding(binding, || {
            assert!(record_profile_operation_evidence(Value::from(1)));
            assert!(record_profile_operation_evidence(Value::from(2)));
            assert!(record_profile_operation_evidence(Value::from(3)));
        });
        assert_eq!(capture.records, vec![Value::from(1), Value::from(2)]);
        assert!(capture.overflowed);
    }
}
