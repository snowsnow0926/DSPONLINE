//! Deterministic Windows-native simulation state and protocol primitives.
//!
//! The crate deliberately has no Electron, Node or filesystem dependency. The
//! host process supplies already verified checkpoint records; this library
//! owns the compact runtime state and exposes bounded summaries/operations.

mod belts;
pub mod canonical;
pub mod catalog;
pub mod command;
mod infinite_research;
mod local_logistics;
pub mod production_history;
pub mod replay;
mod simple_factory;
pub mod simulation;
pub mod state;

pub use catalog::{
    BeltDefinition, BuildingDefinition, CatalogSnapshot, ItemAmount, ItemDefinition,
    PlanetDefinition, ProliferatorDefinition, RecipeDefinition, TechnologyDefinition,
};
pub use command::{CommandApplyResult, SimulationCommandPatch};
pub use simulation::{CoreAdvanceRequest, CoreAdvanceResult};
pub use state::{
    CoreCheckpointIdentity, CoreState, CoreStateSummary, DomainCoverage, RuntimeMemoryEstimate,
};

pub const CORE_PROTOCOL_VERSION: u16 = 1;
pub const CORE_STATE_FORMAT_VERSION: u16 = 1;
