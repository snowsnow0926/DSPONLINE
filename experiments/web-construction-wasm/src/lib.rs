//! Measurement adapter for the UNMODIFIED native planner, never a save owner.
//! The small state shell exposes only the catalog used by that source file.
//! JSON encoding, WASM calls and decoding are included by the browser harness.

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};

use serde::Deserialize;
use serde_json::{Map, Value, json};

mod catalog {
    pub use dsp_native_core::catalog::{ItemAmount, RecipeDefinition, RuntimeCatalog};
}

mod state {
    pub struct CoreState {
        pub catalog: super::catalog::RuntimeCatalog,
    }
}

#[allow(dead_code)]
#[path = "../../../native/dsp-native-core/src/construction_planner.rs"]
mod construction_planner;

struct Session {
    state: state::CoreState,
    targets: HashMap<String, construction_planner::Target>,
    prepared: Vec<(
        construction_planner::Target,
        Map<String, Value>,
        BTreeMap<String, f64>,
    )>,
}

thread_local! {
    static INPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static SESSION: RefCell<Option<Session>> = const { RefCell::new(None) };
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    target_id: String,
    inventory: BTreeMap<String, f64>,
    completed_technology_ids: Vec<String>,
}

fn output(result: Result<Value, String>) -> u32 {
    OUTPUT.with(|output| {
        let value = result.unwrap_or_else(|error| json!({ "error": error }));
        *output.borrow_mut() = serde_json::to_vec(&value).expect("serializable probe result");
        output.borrow().len() as u32
    })
}

// Storage belongs to Rust. JS writes through this pointer before the next
// exported call; no raw pointer supplied by JS is dereferenced by this adapter.
#[unsafe(no_mangle)]
pub extern "C" fn reserve_input(length: u32) -> *mut u8 {
    if length > 8 * 1024 * 1024 {
        return std::ptr::null_mut();
    }
    INPUT.with(|input| {
        let mut input = input.borrow_mut();
        input.resize(length as usize, 0);
        input.as_mut_ptr()
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn initialize() -> u32 {
    // A failed reinitialization must not retain a previous catalog.
    SESSION.with(|session| *session.borrow_mut() = None);
    output(INPUT.with(|input| {
        let snapshot: dsp_native_core::CatalogSnapshot =
            serde_json::from_slice(&input.borrow()).map_err(|error| error.to_string())?;
        let fingerprint = snapshot.registry_fingerprint.clone();
        let catalog = catalog::RuntimeCatalog::validate(snapshot, &fingerprint)
            .map_err(|error| error.to_string())?;
        let state = state::CoreState { catalog };
        let targets = construction_planner::targets(&state)
            .into_iter()
            .map(|target| (target.id.clone(), target))
            .collect();
        SESSION.with(|session| {
            *session.borrow_mut() = Some(Session {
                state,
                targets,
                prepared: Vec::new(),
            })
        });
        Ok(json!({ "ready": true }))
    }))
}

#[unsafe(no_mangle)]
pub extern "C" fn probe() -> u32 {
    output(INPUT.with(|input| {
        let request: Request =
            serde_json::from_slice(&input.borrow()).map_err(|error| error.to_string())?;
        SESSION.with(|session| {
            let session = session.borrow();
            let session = session.as_ref().ok_or("probe is not initialized")?;
            let target = session
                .targets
                .get(&request.target_id)
                .ok_or("unknown target")?;
            let base: Map<String, Value> = json!({
                "research": { "completedTechIds": request.completed_technology_ids }
            })
            .as_object()
            .expect("object")
            .clone();
            use construction_planner::{PlanOutcome, PlannedStep};
            Ok(
                match construction_planner::probe_plan(
                    &session.state,
                    &base,
                    target,
                    request.inventory,
                ) {
                    PlanOutcome::Ready(plan) => {
                        let steps = plan
                            .steps
                            .into_iter()
                            .filter_map(|step| match step {
                                PlannedStep::Material {
                                    recipe_id,
                                    batches,
                                    output_item_id,
                                    output_amount,
                                } => Some(json!({ "recipeId": recipe_id, "batches": batches,
                                "outputItemId": output_item_id, "outputAmount": output_amount })),
                                PlannedStep::Building { .. } | PlannedStep::Fleet { .. } => None,
                            })
                            .collect::<Vec<_>>();
                        let decisions = plan
                            .decisions
                            .into_iter()
                            .map(|decision| {
                                json!({
                                    "itemId": decision.item_id, "recipeId": decision.recipe_id,
                                    "fallbackReason": decision.fallback_reason,
                                })
                            })
                            .collect::<Vec<_>>();
                        json!({ "possible": true, "steps": steps, "decisions": decisions })
                    }
                    PlanOutcome::RawShortage {
                        item_id,
                        current,
                        required,
                    } => json!({
                        "possible": false,
                        "blocker": { "itemId": item_id, "current": current, "required": required,
                            "reason": "raw-shortage" }
                    }),
                    PlanOutcome::Blocked => json!({ "possible": false }),
                },
            )
        })
    }))
}

#[unsafe(no_mangle)]
pub extern "C" fn output_pointer() -> *const u8 {
    OUTPUT.with(|output| output.borrow().as_ptr())
}

// Best-case computation measurement: parse requests and build the technology
// snapshot once, then omit JSON/transfer/results. Never used as end-to-end data.
#[unsafe(no_mangle)]
pub extern "C" fn prepare() -> u32 {
    output(INPUT.with(|input| {
        let requests: Vec<Request> =
            serde_json::from_slice(&input.borrow()).map_err(|error| error.to_string())?;
        SESSION.with(|session| {
            let mut session = session.borrow_mut();
            let session = session.as_mut().ok_or("probe is not initialized")?;
            session.prepared.clear();
            for request in requests {
                let target = session
                    .targets
                    .get(&request.target_id)
                    .ok_or("unknown target")?
                    .clone();
                let base =
                    json!({ "research": { "completedTechIds": request.completed_technology_ids } })
                        .as_object()
                        .expect("object")
                        .clone();
                session.prepared.push((target, base, request.inventory));
            }
            Ok(json!({ "prepared": session.prepared.len() }))
        })
    }))
}

#[unsafe(no_mangle)]
pub extern "C" fn measure_prepared(repeats: u32) -> u32 {
    SESSION.with(|session| {
        let session = session.borrow();
        let Some(session) = session.as_ref() else {
            return 0;
        };
        let mut checksum = 0_u32;
        for _ in 0..repeats.min(100_000) {
            for (target, base, inventory) in &session.prepared {
                let outcome = construction_planner::probe_plan(
                    &session.state,
                    base,
                    target,
                    inventory.clone(),
                );
                if let construction_planner::PlanOutcome::Ready(plan) =
                    std::hint::black_box(&outcome)
                {
                    checksum = checksum.wrapping_add(plan.steps.len() as u32);
                }
            }
        }
        checksum
    })
}
