pub mod builtin_catalog;
pub mod core_runtime;
mod disk_budget;
pub mod exact_realtime_lease;
pub mod frame;
pub mod installed_program;
pub mod protocol;
pub mod qualification_binding;
pub mod qualification_catalog;
pub mod save_store;
pub mod v47_import;
pub mod validation_candidate;

pub const NATIVE_FORMAT_VERSION: u16 = 1;
pub const NATIVE_PROTOCOL_VERSION: u16 = 1;
