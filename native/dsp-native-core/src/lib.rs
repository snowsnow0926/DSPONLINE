//! Deterministic Windows-native simulation state and protocol primitives.
//!
//! The crate deliberately has no Electron, Node or filesystem dependency. The
//! host process supplies already verified checkpoint records; this library
//! owns the compact runtime state and exposes bounded summaries/operations.

mod belts;
mod blueprint_command;
mod blueprint_import;
mod blueprint_workspace;
mod campaign;
pub mod canonical;
pub mod catalog;
pub mod command;
mod command_palette;
mod construction;
mod construction_belt_lane_context;
mod construction_belt_placement_context;
mod construction_belt_removal_context;
mod construction_inventory;
mod construction_placement_context;
mod construction_planner;
mod construction_queue_command;
mod construction_removal_context;
mod construction_stack_context;
mod deterministic_runtime;
mod dyson;
mod dyson_workspace;
mod entity_raw;
mod factory_canvas_presentation;
mod factory_inventory;
mod factory_read_model;
mod galactic_exports;
mod global_progress;
mod infinite_research;
mod interstellar_logistics;
mod local_logistics;
mod logistics_buffers;
mod manual_mining;
pub mod orbital_contract_command;
mod orbital_station;
pub mod production_history;
mod profile_evidence;
mod pure_idle;
mod quantum_logistics;
mod recipe_command;
mod recipe_workspace;
pub mod replay;
mod simple_factory;
pub mod simulation;
mod speedrun;
pub mod state;
mod station_contracts;
mod station_route_ledger;
mod stellar_workspace;
mod system_space_station;
pub mod system_space_station_command;
mod system_space_station_workspace;
pub mod v47_import;

pub use belts::BeltSchedulerDiagnostics;
pub use catalog::{
    BeltDefinition, BuildingDefinition, CatalogSnapshot, ConstructionDefinition, ItemAmount,
    ItemDefinition, PlanetDefinition, ProliferatorDefinition, RecipeDefinition,
    TechnologyDefinition,
};
pub use command::{CommandApplyResult, SimulationCommandPatch};
pub use profile_evidence::{
    ProfileOperationBinding, ProfileOperationCapture, ProfileOperationPurpose,
    with_profile_operation_binding,
};
pub use simulation::{CoreAdvanceMode, CoreAdvanceRequest, CoreAdvanceResult};
pub use state::{
    CoreCheckpointIdentity, CoreState, CoreStateSummary, DomainCoverage,
    EntityRawWritebackDiagnostics, InternalCheckpointVisitResult, RuntimeMemoryEstimate,
    V47EnvelopeExportResult,
};
pub use v47_import::{
    MAX_V47_IMPORT_BYTES, ParsedV47Envelope, V47_IMPORT_JS_COMPATIBILITY_REQUIRED_CODE,
    V47ImportJavascriptCompatibilityRequired, V47ImportProof, parse_v47_envelope,
    parse_v47_envelope_stream,
};

pub const CORE_PROTOCOL_VERSION: u16 = 1;
pub const CORE_STATE_FORMAT_VERSION: u16 = 1;
