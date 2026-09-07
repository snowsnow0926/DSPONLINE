//! Metadata replay for a proved one-second physical steady state. Nothing in
//! this module grants production or writes an inventory, route or machine.

use super::*;

const CYCLE_SECONDS: usize = 10;
const PROBE_SECONDS: usize = 3 * CYCLE_SECONDS;
const MAX_PROBE_RECORD_STEPS: usize = 60_000;
const MAX_RAW_BYTES: u64 = 8 * 1024 * 1024;
const MAX_RUNTIME_BYTES: u64 = 32 * 1024 * 1024;
const MAX_HISTORY_SAMPLE_BYTES: usize = 2 * 1024 * 1024;
const MAX_CLOCK_SECONDS: f64 = 1_000_000_000.0;

#[derive(Debug)]
pub(super) struct OfflineFlowProof {
    prefix_sha256: String,
    prefix_revision: u64,
    source_identity: Value,
    catalog: Arc<crate::catalog::RuntimeCatalog>,
    prefix_elapsed: f64,
    final_elapsed: f64,
    tail_seconds: usize,
    certificate: OrdinaryFlowCertificate,
    physical_signature: String,
    prefix_belts: Vec<Value>,
    belt_units_per_second: Vec<i128>,
    prefix_quantum_flow: Value,
    quantum_phases: Vec<Value>,
    observed_history_samples: Vec<Value>,
}

impl OfflineFlowProof {
    pub(super) fn observed_history_samples(&self) -> &[Value] {
        &self.observed_history_samples
    }

    pub(super) fn matches_prefix_and_tail(
        &self,
        prefix: &CoreState,
        tail_seconds: f64,
    ) -> Result<(), String> {
        if checked_tail(tail_seconds)? != self.tail_seconds
            || prefix.revision != self.prefix_revision
            || !Arc::ptr_eq(&prefix.catalog, &self.catalog)
            || serde_json::to_value(&prefix.identity).map_err(|error| error.to_string())?
                != self.source_identity
            || prefix
                .canonical_sha256()
                .map_err(|error| error.to_string())?
                != self.prefix_sha256
        {
            return Err("offline flow proof belongs to a different prefix or tail".to_owned());
        }
        Ok(())
    }
}

fn checked_tail(seconds: f64) -> Result<usize, String> {
    if !seconds.is_finite() || !(1.0..=28_800.0).contains(&seconds) || seconds.fract() != 0.0 {
        return Err("offline flow tail must contain 1..28800 whole seconds".to_owned());
    }
    Ok(seconds as usize)
}

fn check_memory_and_work(state: &CoreState) -> Result<(), String> {
    let records = state
        .entity_index
        .len()
        .checked_add(state.belt_index.len())
        .ok_or_else(|| "offline flow record count overflowed".to_owned())?;
    let work = records
        .max(1)
        .checked_mul(PROBE_SECONDS)
        .ok_or_else(|| "offline flow probe work overflowed".to_owned())?;
    let memory = state.memory_estimate();
    if work > MAX_PROBE_RECORD_STEPS
        || memory.raw_record_bytes > MAX_RAW_BYTES
        || memory.estimated_runtime_bytes > MAX_RUNTIME_BYTES
    {
        return Err("offline flow probe exceeds its record or memory budget".to_owned());
    }
    Ok(())
}

fn checked_clock_schedule(start: f64, seconds: usize) -> Result<f64, String> {
    if !start.is_finite()
        || !(0.0..=MAX_CLOCK_SECONDS).contains(&start)
        || crate::simulation::exact_elapsed_after_step(start, 0.0) != start
    {
        return Err("offline flow source clock is outside the proved range".to_owned());
    }
    let mut clock = start;
    for step in 1..=seconds {
        clock = crate::simulation::exact_elapsed_after_step(clock, 1.0);
        let bulk = crate::simulation::exact_elapsed_after_step(start, step as f64);
        if clock != bulk
            || clock.floor() != start.floor() + step as f64
            || clock > MAX_CLOCK_SECONDS
        {
            return Err("offline flow exact clock schedule changed quantum phase".to_owned());
        }
    }
    Ok(clock)
}

fn counter(value: Option<&Value>, label: &str) -> Result<i128, String> {
    let amount = proof_counter(value, label).map_err(|error| error.to_string())?;
    if amount > MAX_SAFE_INTEGER as i128 {
        return Err(format!("{label} exceeds the exact integer metadata range"));
    }
    Ok(amount)
}

fn checked_counter_advance(initial: i128, rate: i128, seconds: usize) -> Result<i128, String> {
    if initial < 0 || rate < 0 {
        return Err("offline flow counter or rate is negative".to_owned());
    }
    initial
        .checked_add(
            rate.checked_mul(seconds as i128)
                .ok_or_else(|| "offline flow counter product overflowed".to_owned())?,
        )
        .filter(|value| *value <= MAX_SAFE_INTEGER as i128)
        .ok_or_else(|| "offline flow cumulative counter exceeds the exact integer range".to_owned())
}

fn check_inactive_system_station_directory(state: &CoreState) -> Result<(), String> {
    let stations = state
        .base_value()
        .get("systemSpaceStations")
        .and_then(Value::as_object)
        .ok_or("offline flow system station directory is malformed")?;
    // system_space_station::settle_construction requires a building hub and
    // launcher; settle_hubs requires operational hubs with elevator entities.
    // Neither can activate these empty not-started records. The entity guard
    // below also excludes launchers, elevators and transitions. Keep the full
    // directory inside the physical signature, including presentation metadata.
    const FIELDS: [&str; 13] = [
        "systemId",
        "status",
        "costRevision",
        "costMultiplierBasisPoints",
        "phaseIndex",
        "delivered",
        "constructionBuffer",
        "inventory",
        "itemPolicies",
        "modules",
        "routingCursors",
        "viewport",
        "decorations",
    ];
    for (system_id, value) in stations {
        let station = value
            .as_object()
            .ok_or("offline flow system station record is malformed")?;
        if station.len() != FIELDS.len()
            || station.keys().any(|key| !FIELDS.contains(&key.as_str()))
            || station.get("systemId").and_then(Value::as_str) != Some(system_id.as_str())
            || !state
                .catalog
                .planets
                .iter()
                .any(|planet| planet.system_id == *system_id)
            || station.get("status").and_then(Value::as_str) != Some("not-started")
            || station.get("costRevision").and_then(Value::as_f64) != Some(0.0)
            || station
                .get("costMultiplierBasisPoints")
                .and_then(Value::as_f64)
                != Some(10_000.0)
            || station.get("phaseIndex").and_then(Value::as_f64) != Some(0.0)
            || [
                "delivered",
                "constructionBuffer",
                "inventory",
                "itemPolicies",
                "routingCursors",
            ]
            .into_iter()
            .any(|field| {
                station
                    .get(field)
                    .and_then(Value::as_object)
                    .is_none_or(|map| !map.is_empty())
            })
            || station
                .get("decorations")
                .and_then(Value::as_array)
                .is_none_or(|rows| !rows.is_empty())
        {
            return Err(
                "offline flow system station is active or outside the empty default schema"
                    .to_owned(),
            );
        }
        let modules = station
            .get("modules")
            .and_then(Value::as_object)
            .ok_or("offline flow system station modules are malformed")?;
        if modules.len() != 3
            || ["backbone", "energy", "interstellar"]
                .into_iter()
                .any(|field| modules.get(field).and_then(Value::as_f64) != Some(0.0))
        {
            return Err("offline flow system station has active or malformed modules".to_owned());
        }
        let viewport = station
            .get("viewport")
            .and_then(Value::as_object)
            .ok_or("offline flow system station viewport is malformed")?;
        if viewport.len() != 3
            || ["x", "y", "zoom"].into_iter().any(|field| {
                viewport
                    .get(field)
                    .and_then(Value::as_f64)
                    .is_none_or(|value| !value.is_finite())
            })
            || viewport
                .get("zoom")
                .and_then(Value::as_f64)
                .is_none_or(|zoom| zoom <= 0.0)
        {
            return Err("offline flow system station viewport is malformed".to_owned());
        }
    }
    // Fleet returns are an independent future clock writer even without an
    // operational hub. Empty returns alone are insufficient: keep all fleet,
    // warper and routing state at its explicit inactive value as well.
    let network = state
        .base_value()
        .get("galacticHubNetwork")
        .and_then(Value::as_object)
        .ok_or("offline flow galactic hub network is malformed")?;
    const NETWORK_FIELDS: [&str; 6] = [
        "fleetInstalled",
        "fleetBusy",
        "fleetReturns",
        "warpers",
        "warperTarget",
        "routingCursors",
    ];
    if network.len() != NETWORK_FIELDS.len()
        || network
            .keys()
            .any(|key| !NETWORK_FIELDS.contains(&key.as_str()))
        || ["fleetInstalled", "fleetBusy"]
            .into_iter()
            .any(|field| network.get(field).and_then(Value::as_f64) != Some(0.0))
        || ["warpers", "warperTarget"]
            .into_iter()
            .any(|field| network.get(field).and_then(Value::as_str) != Some("0"))
        || network
            .get("fleetReturns")
            .and_then(Value::as_array)
            .is_none_or(|rows| !rows.is_empty())
        || network
            .get("routingCursors")
            .and_then(Value::as_object)
            .is_none_or(|map| !map.is_empty())
    {
        return Err("offline flow galactic hub network has active or malformed state".to_owned());
    }
    Ok(())
}

fn reject_external_writers(
    state: &CoreState,
    certificate: &OrdinaryFlowCertificate,
) -> Result<(), String> {
    let base = state.base_value();
    if certificate.research.is_some()
        || certificate.dyson_rocket.is_some()
        || certificate.dyson_sail.is_some()
        || certificate.galactic_export.is_some()
        || certificate.orbital_contracts.is_some()
        || certificate.renewable_power.is_some()
        || collection_has_entries(base.get("handcraftQueue"))
        || collection_has_entries(base.get("constructionQueue"))
        || construction_tail_requested(state)
        || base
            .get("constructionAutomation")
            .and_then(|value| value.get("enabled"))
            == Some(&Value::Bool(true))
        || collection_has_entries(
            base.get("constructionAutomation")
                .and_then(|value| value.get("jobs")),
        )
        || collection_has_entries(
            base.get("exploration")
                .and_then(|value| value.get("missions")),
        )
        || collection_has_entries(
            base.get("orbitalStation")
                .and_then(|value| value.get("contractBoard"))
                .and_then(|value| value.get("accepted")),
        )
        || base
            .get("research")
            .and_then(|value| value.get("selectedTechId"))
            .is_some_and(|value| !value.is_null())
        || collection_has_entries(
            base.get("research")
                .and_then(|value| value.get("queuedTechIds")),
        )
        || base
            .get("endgame")
            .and_then(|value| value.get("activeInfiniteResearchId"))
            .is_some_and(|value| !value.is_null())
        || base
            .get("endgame")
            .and_then(|value| value.get("constructionActivity"))
            .and_then(|value| value.get("activityId"))
            .is_some_and(|value| !value.is_null())
        || number_at(base.get("dysonSwarm"), &["sailsInOrbit"]) != 0.0
        || base.get("timeWarp").and_then(|value| value.get("enabled")) == Some(&Value::Bool(true))
    {
        return Err("offline flow has an independent timed or material writer".to_owned());
    }
    check_inactive_system_station_directory(state)?;
    crate::simulation::capture_offline_no_export_progress(state)?;
    if let Some(systems) = base
        .get("dysonEngineering")
        .and_then(|value| value.get("orbitsBySystem"))
    {
        let systems = systems
            .as_object()
            .ok_or("offline flow Dyson orbit directory is malformed")?;
        for orbits in systems.values() {
            for orbit in orbits
                .as_array()
                .ok_or("offline flow Dyson orbit rows are malformed")?
            {
                if counter(orbit.get("sailsInOrbit"), "dyson.orbit.sailsInOrbit")? != 0 {
                    return Err("offline flow has an active per-orbit Dyson lifecycle".to_owned());
                }
            }
        }
    }
    if certificate
        .produced_units_per_second
        .iter()
        .any(|(item, rate)| *rate > 0 && !matches!(item.as_str(), "iron_ore" | "iron_ingot"))
    {
        return Err(
            "offline flow has production outside the bounded iron campaign scope".to_owned(),
        );
    }
    if certificate
        .produced_units_per_second
        .get("iron_ingot")
        .copied()
        .unwrap_or(0)
        > 0
    {
        for field in ["completedTaskIds", "rewardedTaskIds"] {
            if !base
                .get("campaign")
                .and_then(|value| value.get(field))
                .and_then(Value::as_array)
                .is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some("smelt_iron")))
            {
                return Err(
                    "offline flow cannot cross an unclaimed iron-production campaign reward"
                        .to_owned(),
                );
            }
        }
    }
    for recipe_id in &certificate.recipe_ids {
        if recipe_id != "iron_ingot" {
            return Err("offline flow recipe is outside the proved iron-chain scope".to_owned());
        }
    }
    let mut kinds = BTreeMap::<String, String>::new();
    for index in 0..state.entity_index.len() {
        let entity = state
            .parse_entity(index)
            .map_err(|error| error.to_string())?;
        let id = entity
            .get("id")
            .and_then(Value::as_str)
            .ok_or("offline flow entity has no ID")?;
        let kind = entity
            .get("kind")
            .and_then(Value::as_str)
            .ok_or("offline flow entity has no kind")?;
        let building = entity.get("buildingId").and_then(Value::as_str);
        let supported = match kind {
            "vein" if number_at(Some(&entity), &["minerCount"]) == 0.0 => true,
            "vein" => {
                entity.get("resourceId").and_then(Value::as_str) == Some("iron_ore")
                    && entity.get("extractorBuildingId").and_then(Value::as_str)
                        == Some("mining_machine")
            }
            "power" => building == Some("wind_turbine"),
            "machine" if building == Some("time_warp_device") => {
                !collection_has_entries(entity.get("inputs"))
                    && !collection_has_entries(entity.get("outputs"))
            }
            "machine" => {
                building == Some("arc_smelter")
                    && entity.get("recipeId").and_then(Value::as_str) == Some("iron_ingot")
                    && certificate
                        .recipe_ids
                        .iter()
                        .any(|recipe| recipe == "iron_ingot")
            }
            "station" => {
                is_ordinary_quantum_upload_endpoint(state, &entity)
                    && matches!(
                        entity.get("stationOperationMode").and_then(Value::as_str),
                        None | Some("legacy")
                    )
            }
            _ => false,
        };
        if !supported
            || entity.get("sprayCoaterInstalled") == Some(&Value::Bool(true))
            || collection_has_entries(entity.get("stationRoutes"))
        {
            return Err(format!(
                "offline flow entity {id} is outside the static supported scope"
            ));
        }
        if let Some(building) = building.and_then(|id| state.catalog.buildings.get(id))
            && (!building.fuel_item_ids.is_empty()
                || building.energy_capacity_mj > 0.0
                || building.power_charge_kw > 0.0)
        {
            return Err(format!(
                "offline flow entity {id} has a finite energy source"
            ));
        }
        kinds.insert(id.to_owned(), kind.to_owned());
    }
    let mut incoming = BTreeSet::new();
    let mut outgoing = BTreeSet::new();
    for index in 0..state.belt_index.len() {
        let belt = state.parse_belt(index).map_err(|error| error.to_string())?;
        let source = belt
            .get("source")
            .and_then(Value::as_str)
            .ok_or("offline flow belt has no source")?;
        let target = belt
            .get("target")
            .and_then(Value::as_str)
            .ok_or("offline flow belt has no target")?;
        if !incoming.insert(target.to_owned())
            || !outgoing.insert(source.to_owned())
            || !matches!(
                kinds.get(source).map(String::as_str),
                Some("vein" | "machine")
            )
            || !matches!(
                kinds.get(target).map(String::as_str),
                Some("machine" | "station")
            )
            || source == target
        {
            return Err("offline flow requires unambiguous non-cyclic belt endpoints".to_owned());
        }
    }
    let quantum = base
        .get("quantumLogisticsNetwork")
        .and_then(Value::as_object)
        .ok_or("offline flow quantum ledger is missing")?;
    if quantum.get("enabled") != Some(&Value::Bool(true))
        || quantum.keys().any(|key| {
            !matches!(
                key.as_str(),
                "enabled"
                    | "inventory"
                    | "itemCapacities"
                    | "routingCursors"
                    | "uploadRoutingCursors"
                    | "runtimeFlow"
            )
        })
    {
        return Err("offline flow has an unmodelled quantum writer or mode".to_owned());
    }
    Ok(())
}

fn normalize_quantity_record(
    value: &mut Value,
    rates: &MaterialTotals,
    seconds: usize,
    label: &str,
) -> Result<(), String> {
    let record = value
        .as_object_mut()
        .ok_or_else(|| format!("{label} is not an object"))?;
    for (item_id, rate) in rates {
        if *rate < 0 {
            return Err(format!("{label}.{item_id} has a negative certified rate"));
        }
        if *rate == 0 {
            continue;
        }
        let current = proof_counter(record.get(item_id), &format!("{label}.{item_id}"))
            .map_err(|error| error.to_string())?;
        let delta = rate
            .checked_mul(seconds as i128)
            .ok_or_else(|| format!("{label} rate product overflowed"))?;
        let original = current
            .checked_sub(delta)
            .filter(|value| *value >= 0)
            .ok_or_else(|| {
                format!("{label}.{item_id} did not advance at the certified per-second rate")
            })?;
        record.insert(item_id.clone(), Value::String(original.to_string()));
    }
    Ok(())
}

fn normalized_physical_state(
    state: &CoreState,
    certificate: &OrdinaryFlowCertificate,
    seconds: usize,
) -> Result<Value, String> {
    let mut value = state.materialize().map_err(|error| error.to_string())?;
    normalize_quantity_record(
        value
            .get_mut("totalProduced")
            .ok_or("offline flow production ledger missing")?,
        &certificate.produced_units_per_second,
        seconds,
        "totalProduced",
    )?;
    normalize_quantity_record(
        value
            .get_mut("quantumLogisticsNetwork")
            .and_then(|value| value.get_mut("inventory"))
            .ok_or("offline flow quantum inventory missing")?,
        &certificate.units_per_second,
        seconds,
        "quantum.inventory",
    )?;
    let entities = value
        .get_mut("entities")
        .and_then(Value::as_array_mut)
        .ok_or("offline flow entities missing")?;
    for finite in &certificate.finite_veins {
        let actual = finite_vein_snapshot_at(state, finite.expected.entity_index)
            .map_err(|error| error.to_string())?
            .ok_or("offline flow finite reserve changed mode")?;
        let extracted = finite_vein_extracted_units(&finite.expected, &actual)?;
        let expected = finite
            .units_per_second
            .checked_mul(seconds as i128)
            .ok_or("offline flow finite rate overflowed")?;
        if extracted != expected {
            return Err(
                "offline flow finite debit differs from its exact per-second certificate"
                    .to_owned(),
            );
        }
        let entity = entities
            .get_mut(finite.expected.entity_index)
            .and_then(Value::as_object_mut)
            .ok_or("offline flow finite entity disappeared")?;
        entity.insert(
            "resourceRemaining".to_owned(),
            Value::String(finite.expected.remaining.to_string()),
        );
        if finite.expected.tracks_depletion_remainder {
            entity.insert(
                "resourceDepletionRemainder".to_owned(),
                Value::String(finite.expected.depletion_remainder.to_string()),
            );
        }
    }
    let belts = value
        .get_mut("belts")
        .and_then(Value::as_array_mut)
        .ok_or("offline flow belts missing")?;
    for belt in belts {
        counter(belt.get("totalTransferred"), "belt.totalTransferred")?;
        belt.as_object_mut()
            .ok_or("offline flow belt malformed")?
            .remove("totalTransferred");
    }
    let base = value.as_object_mut().ok_or("offline flow base missing")?;
    // The history module uses the same real samples; the existing no-export
    // clock certificate owns its sole window field. No other base field is
    // excluded, so changes in diagnostics, queues, devices or progress fail.
    for field in ["elapsedSeconds", "productionHistory", "historyRecordedAt"] {
        base.remove(field);
    }
    base.get_mut("endgame")
        .and_then(Value::as_object_mut)
        .ok_or("offline flow endgame missing")?
        .remove("exportWindowStartedAt");
    base.get_mut("quantumLogisticsNetwork")
        .and_then(Value::as_object_mut)
        .ok_or("offline flow quantum missing")?
        .remove("runtimeFlow");
    Ok(value)
}

fn physical_signature(
    state: &CoreState,
    certificate: &OrdinaryFlowCertificate,
    seconds: usize,
) -> Result<String, String> {
    normalized_physical_state(state, certificate, seconds)
        .map(|value| crate::canonical::canonical_sha256(&value))
}

fn normalized_quantum_flow(
    state: &CoreState,
    elapsed: f64,
    certificate: &OrdinaryFlowCertificate,
) -> Result<Value, String> {
    let mut flow = state
        .base_value()
        .get("quantumLogisticsNetwork")
        .and_then(|value| value.get("runtimeFlow"))
        .cloned()
        .ok_or("offline flow quantum runtime sample missing")?;
    let object = flow
        .as_object_mut()
        .ok_or("offline flow quantum runtime sample malformed")?;
    let expected_keys = [
        "boundarySecond",
        "uploaded",
        "downloaded",
        "globalUploadPerMinute",
        "globalDownloadPerMinute",
        "quantumTowerStacks",
        "quantumCollectorStacks",
    ];
    if object.len() != expected_keys.len()
        || expected_keys.iter().any(|key| !object.contains_key(*key))
    {
        return Err("offline flow runtime has an unknown or missing field".to_owned());
    }
    let boundary = counter(object.get("boundarySecond"), "runtimeFlow.boundarySecond")?;
    let offset = boundary - elapsed.floor() as i128;
    if !(0..5).contains(&offset) || boundary % 5 != 0 {
        return Err(
            "offline flow runtime boundary is not its observed five-second phase".to_owned(),
        );
    }
    for key in [
        "globalUploadPerMinute",
        "globalDownloadPerMinute",
        "quantumTowerStacks",
        "quantumCollectorStacks",
    ] {
        let number = object
            .get(key)
            .and_then(Value::as_f64)
            .filter(|number| number.is_finite() && *number >= 0.0 && *number <= MAX_SAFE_INTEGER)
            .ok_or_else(|| format!("offline flow {key} is invalid"))?;
        if key == "quantumCollectorStacks" && number != 0.0 {
            return Err("offline flow collectors are not covered".to_owned());
        }
    }
    for key in ["uploaded", "downloaded"] {
        let amounts = object
            .get(key)
            .and_then(Value::as_object)
            .ok_or("offline flow runtime amounts malformed")?;
        for (item, amount) in amounts {
            let quantity = counter(Some(amount), "runtimeFlow.quantity")?;
            let maximum = certificate
                .units_per_second
                .get(item)
                .copied()
                .unwrap_or(0)
                .checked_mul(5)
                .ok_or("offline flow quantum rate overflowed")?;
            if quantity < 0 || quantity > maximum || key == "downloaded" && quantity != 0 {
                return Err(
                    "offline flow quantum transfer has no certified upload-only source".to_owned(),
                );
            }
        }
    }
    object.insert("boundarySecond".to_owned(), Value::from(offset as i64));
    Ok(flow)
}

pub(super) fn prepare(
    prefix: &CoreState,
    certificate: &OrdinaryFlowCertificate,
    tail_seconds: f64,
) -> Result<OfflineFlowProof, String> {
    let tail = checked_tail(tail_seconds)?;
    check_memory_and_work(prefix)?; // Before cloning even a small-row / huge-base save.
    reject_external_writers(prefix, certificate)?;
    let start = prefix
        .base_value()
        .get("elapsedSeconds")
        .and_then(Value::as_f64)
        .ok_or("offline flow elapsed clock missing")?;
    let final_elapsed = checked_clock_schedule(start, tail.max(PROBE_SECONDS))?;
    let final_elapsed = if tail < PROBE_SECONDS {
        checked_clock_schedule(start, tail)?
    } else {
        final_elapsed
    };
    let signature = physical_signature(prefix, certificate, 0)?;
    let prefix_belts = (0..prefix.belt_index.len())
        .map(|index| prefix.parse_belt(index).map_err(|error| error.to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    let prefix_flow = prefix.base_value()["quantumLogisticsNetwork"]["runtimeFlow"].clone();
    let phase_zero = normalized_quantum_flow(prefix, start, certificate)?;
    let mut phases = vec![phase_zero];
    let mut rates = vec![0_i128; prefix_belts.len()];
    let mut previous = prefix_belts
        .iter()
        .map(|belt| counter(belt.get("totalTransferred"), "belt.totalTransferred"))
        .collect::<Result<Vec<_>, _>>()?;
    let mut samples = Vec::with_capacity(PROBE_SECONDS);
    let mut sample_bytes = 0_usize;
    let mut probe = prefix.clone();
    probe.pure_idle_macro_runtime = None;
    let mut elapsed = start;
    for step in 1..=PROBE_SECONDS {
        let revision = probe.revision;
        let result = probe
            .advance_exact(&exact_request(revision, 1.0, 1.0))
            .map_err(|error| error.to_string())?;
        if !result.supported {
            return Err(format!(
                "offline flow exact probe rejected: {:?}",
                result.reason
            ));
        }
        check_memory_and_work(&probe)?;
        elapsed = crate::simulation::exact_elapsed_after_step(elapsed, 1.0);
        if probe
            .base_value()
            .get("elapsedSeconds")
            .and_then(Value::as_f64)
            != Some(elapsed)
            || physical_signature(&probe, certificate, step)? != signature
        {
            return Err(format!(
                "offline flow has no one-second physical steady state at probe step {step}"
            ));
        }
        for (index, previous_counter) in previous.iter_mut().enumerate() {
            let belt = probe.parse_belt(index).map_err(|error| error.to_string())?;
            let current = counter(belt.get("totalTransferred"), "belt.totalTransferred")?;
            let delta = current
                .checked_sub(*previous_counter)
                .filter(|delta| *delta >= 0)
                .ok_or("offline flow belt counter regressed")?;
            if step == 1 {
                rates[index] = delta;
            } else if delta != rates[index] {
                return Err("offline flow belt transfer is not stable each real second".to_owned());
            }
            *previous_counter = current;
        }
        let flow = normalized_quantum_flow(&probe, elapsed, certificate)?;
        let phase = step % CYCLE_SECONDS;
        if step < CYCLE_SECONDS {
            phases.push(flow);
        } else if crate::canonical::canonical_sha256(&flow)
            != crate::canonical::canonical_sha256(&phases[phase])
        {
            return Err(
                "offline flow quantum runtime phase did not repeat across three exact cycles"
                    .to_owned(),
            );
        }
        let sample = probe
            .base_value()
            .get("productionHistory")
            .and_then(Value::as_array)
            .and_then(|history| history.last())
            .cloned()
            .ok_or("offline flow exact probe did not record a history sample")?;
        sample_bytes = sample_bytes
            .checked_add(
                serde_json::to_vec(&sample)
                    .map_err(|error| error.to_string())?
                    .len(),
            )
            .filter(|bytes| *bytes <= MAX_HISTORY_SAMPLE_BYTES)
            .ok_or("offline flow history sample memory budget exceeded")?;
        samples.push(sample);
    }
    for (index, belt) in prefix_belts.iter().enumerate() {
        checked_counter_advance(
            counter(belt.get("totalTransferred"), "belt.totalTransferred")?,
            rates[index],
            tail,
        )?;
    }
    Ok(OfflineFlowProof {
        prefix_sha256: prefix
            .canonical_sha256()
            .map_err(|error| error.to_string())?,
        prefix_revision: prefix.revision,
        source_identity: serde_json::to_value(&prefix.identity)
            .map_err(|error| error.to_string())?,
        catalog: Arc::clone(&prefix.catalog),
        prefix_elapsed: start,
        final_elapsed,
        tail_seconds: tail,
        certificate: certificate.clone(),
        physical_signature: signature,
        prefix_belts,
        belt_units_per_second: rates,
        prefix_quantum_flow: prefix_flow,
        quantum_phases: phases,
        observed_history_samples: samples,
    })
}

pub(super) fn apply(candidate: &mut CoreState, proof: &OfflineFlowProof) -> Result<(), String> {
    check_memory_and_work(candidate)?;
    if !Arc::ptr_eq(&candidate.catalog, &proof.catalog)
        || serde_json::to_value(&candidate.identity).map_err(|error| error.to_string())?
            != proof.source_identity
    {
        return Err(
            "offline flow candidate belongs to a different checkpoint or catalog".to_owned(),
        );
    }
    if candidate
        .base_value()
        .get("elapsedSeconds")
        .and_then(Value::as_f64)
        != Some(proof.prefix_elapsed)
    {
        return Err(
            "offline flow metadata must replay before the final clock is published".to_owned(),
        );
    }
    if physical_signature(candidate, &proof.certificate, proof.tail_seconds)?
        != proof.physical_signature
    {
        return Err(
            "offline flow candidate contains an unproved physical or base mutation".to_owned(),
        );
    }
    if candidate.base_value()["quantumLogisticsNetwork"]["runtimeFlow"] != proof.prefix_quantum_flow
    {
        return Err("offline flow quantum source runtime changed before replay".to_owned());
    }
    verify_campaign_endpoint_no_write(candidate)?;
    let mut patches = Vec::with_capacity(proof.prefix_belts.len());
    for (index, expected) in proof.prefix_belts.iter().enumerate() {
        let current = candidate
            .parse_belt(index)
            .map_err(|error| error.to_string())?;
        if crate::canonical::canonical_sha256(&current)
            != crate::canonical::canonical_sha256(expected)
        {
            return Err("offline flow source belt changed before metadata replay".to_owned());
        }
        let mut updated = current;
        let total = checked_counter_advance(
            counter(updated.get("totalTransferred"), "belt.totalTransferred")?,
            proof.belt_units_per_second[index],
            proof.tail_seconds,
        )?;
        if proof.belt_units_per_second[index] == 0 {
            continue;
        }
        updated
            .as_object_mut()
            .ok_or("offline flow belt became malformed")?
            .insert("totalTransferred".to_owned(), Value::from(total as f64));
        patches.push((
            index,
            serde_json::to_string(&updated).map_err(|error| error.to_string())?,
        ));
    }
    let mut flow = proof.quantum_phases[proof.tail_seconds % CYCLE_SECONDS].clone();
    let phase = counter(flow.get("boundarySecond"), "runtimeFlow.phase")?;
    let boundary = (proof.final_elapsed.floor() as i128)
        .checked_add(phase)
        .filter(|value| *value <= MAX_SAFE_INTEGER as i128)
        .ok_or("offline flow final quantum clock overflowed")?;
    flow.as_object_mut()
        .ok_or("offline flow phase is malformed")?
        .insert("boundarySecond".to_owned(), Value::from(boundary as f64));
    // All validation, arithmetic and serialization completes before the first
    // mutation. Index refresh and candidate replacement are transactional too.
    let mut updated = candidate.clone();
    for (index, raw) in patches {
        updated.replace_belt_raw(index, raw.into());
    }
    updated
        .base_value_mut()
        .get_mut("quantumLogisticsNetwork")
        .and_then(Value::as_object_mut)
        .ok_or("offline flow quantum ledger disappeared")?
        .insert("runtimeFlow".to_owned(), flow);
    updated
        .rebuild_indexes()
        .map_err(|error| error.to_string())?;
    *candidate = updated;
    Ok(())
}

fn verify_campaign_endpoint_no_write(candidate: &CoreState) -> Result<(), String> {
    // Certified iron counters are monotone; every other campaign metric and
    // the physical tray stay fixed. A real endpoint synchronization must be a
    // no-op, including deferred rewards. Never publish a discovered reward.
    let mut projected = Value::Object(candidate.base_value().clone());
    let before = crate::canonical::canonical_sha256(&projected);
    let entities = (0..candidate.entity_index.len())
        .map(|index| candidate.parse_entity(index))
        .collect::<anyhow::Result<Vec<_>>>()
        .map_err(|error| error.to_string())?;
    let base = projected
        .as_object_mut()
        .ok_or("offline flow projected campaign base missing")?;
    crate::campaign::synchronize_with_factory_metrics(candidate, base, &entities, None)
        .map_err(|error| error.to_string())?;
    crate::campaign::synchronize_orbital_station_eligibility(base)
        .map_err(|error| error.to_string())?;
    if crate::canonical::canonical_sha256(&projected) != before {
        return Err(
            "offline flow campaign or orbital eligibility would change at the projected endpoint"
                .to_owned(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> CoreState {
        let mut state = super::super::tests::offline_flow_steady_fixture();
        // The public fixture already has 30 seconds of factory warmup before
        // the offline request's real 30-second prefix. Reproduce both here:
        // the belt's smoothed lastFlow/congestion are still changing at 30s.
        let revision = state.revision;
        assert!(
            state
                .advance_exact(&exact_request(revision, 30.0, 30.0))
                .unwrap()
                .supported
        );
        state
    }

    fn certificate(state: &CoreState) -> OrdinaryFlowCertificate {
        let request = exact_request(state.revision, 30.0, 30.0);
        let request = CoreAdvanceRequest {
            advance_mode: CoreAdvanceMode::OfflineMacroV1,
            ..request
        };
        let windows = exact_three_window_probe(state, &request).unwrap();
        build_ordinary_flow_certificate(state, &windows).unwrap()
    }

    fn with_material_tail(
        prefix: &CoreState,
        certificate: &OrdinaryFlowCertificate,
        tail: f64,
    ) -> CoreState {
        let mut candidate = prefix.clone();
        let mut certificate = certificate.clone();
        let elapsed = prefix.base_value()["elapsedSeconds"].as_f64().unwrap();
        apply_ordinary_flow_certificate_with_wall(
            &mut candidate,
            &mut certificate,
            elapsed,
            crate::simulation::exact_elapsed_after_step(elapsed, tail),
            tail,
        )
        .unwrap();
        candidate
    }

    fn fixture_with_default_system_station_directory() -> CoreState {
        let mut state = fixture();
        let mut snapshot = state.catalog.snapshot.clone();
        let mut stations = Map::new();
        // Same eight empty records emitted by createEmptySystemSpaceStation in
        // src/game/systemSpaceStation.ts; all systems exist in this test catalog.
        for (index, system_id) in [
            "helios",
            "borealis",
            "aurora",
            "ember",
            "sirius",
            "white_dwarf",
            "neutron",
            "blue_giant",
        ]
        .into_iter()
        .enumerate()
        {
            if index > 0 {
                let mut planet = snapshot.planets[0].clone();
                planet.id = format!("empty-{system_id}");
                planet.system_id = system_id.to_owned();
                planet.simulation_order = index as u16;
                let profile = state.base_value()["galaxy"]["profiles"]["home"].clone();
                state.base_value_mut()["galaxy"]["profiles"][planet.id.as_str()] = profile;
                snapshot.planets.push(planet);
            }
            stations.insert(
                system_id.to_owned(),
                json!({
                    "systemId": system_id, "status": "not-started", "costRevision": 0,
                    "costMultiplierBasisPoints": 10000, "phaseIndex": 0, "delivered": {},
                    "constructionBuffer": {}, "inventory": {}, "itemPolicies": {},
                    "modules": {"backbone": 0, "energy": 0, "interstellar": 0},
                    "routingCursors": {}, "viewport": {"x": 0, "y": 0, "zoom": 0.85},
                    "decorations": [],
                }),
            );
        }
        state.catalog =
            Arc::new(crate::catalog::RuntimeCatalog::validate(snapshot, "pure-idle-test").unwrap());
        state.base_value_mut()["systemSpaceStations"] = Value::Object(stations);
        state.rebuild_indexes().unwrap();
        let revision = state.revision;
        assert!(
            state
                .advance_exact(&exact_request(revision, 30.0, 30.0))
                .unwrap()
                .supported
        );
        state
    }

    #[test]
    fn steady_flow_accepts_empty_default_system_directory_without_omitting_it_from_signature() {
        let prefix = fixture_with_default_system_station_directory();
        let certificate = certificate(&prefix);
        let proof = prepare(&prefix, &certificate, 31.0).unwrap();
        let mut candidate = with_material_tail(&prefix, &certificate, 31.0);
        apply(&mut candidate, &proof).unwrap();
        let mut exact = prefix.clone();
        let revision = exact.revision;
        assert!(
            exact
                .advance_exact(&exact_request(revision, 31.0, 31.0))
                .unwrap()
                .supported
        );
        for field in [
            "systemSpaceStations",
            "galacticHubNetwork",
            "dysonEngineering",
        ] {
            assert_eq!(candidate.base_value()[field], prefix.base_value()[field]);
            assert_eq!(candidate.base_value()[field], exact.base_value()[field]);
        }
        assert_eq!(
            candidate.materialize().unwrap()["belts"],
            exact.materialize().unwrap()["belts"]
        );
        assert_eq!(
            candidate.base_value()["quantumLogisticsNetwork"],
            exact.base_value()["quantumLogisticsNetwork"]
        );
        let mut changed = with_material_tail(&prefix, &certificate, 31.0);
        changed.base_value_mut()["systemSpaceStations"]["helios"]["viewport"]["x"] = json!(99);
        let before = changed.canonical_sha256().unwrap();
        assert!(apply(&mut changed, &proof).is_err());
        assert_eq!(changed.canonical_sha256().unwrap(), before);
    }

    #[test]
    fn steady_flow_rejects_active_or_malformed_system_directory_and_future_fleet_returns() {
        let prefix = fixture_with_default_system_station_directory();
        let certificate = certificate(&prefix);
        for (field, value) in [
            ("status", json!("building")),
            ("status", json!("operational")),
            ("systemId", json!("wrong-system")),
            ("phaseIndex", json!(1)),
            ("delivered", json!({"iron_ingot":"1"})),
            ("constructionBuffer", json!({"iron_ingot":"1"})),
            ("inventory", json!({"iron_ingot":"1"})),
            ("itemPolicies", json!({"iron_ingot":{"mode":"supply"}})),
            ("routingCursors", json!({"iron_ingot":1})),
            ("modules", json!({"backbone":1,"energy":0,"interstellar":0})),
            ("inventory", json!([])),
            ("modules", json!({})),
            ("futureTimedState", json!(1)),
        ] {
            let mut changed = prefix.clone();
            changed.base_value_mut()["systemSpaceStations"]["helios"][field] = value;
            let before = changed.canonical_sha256().unwrap();
            assert!(
                prepare(&changed, &certificate, 60.0)
                    .unwrap_err()
                    .contains("system station"),
                "{field}"
            );
            assert_eq!(changed.canonical_sha256().unwrap(), before);
        }
        for value in [json!([]), json!({"helios":null})] {
            let mut changed = prefix.clone();
            changed.base_value_mut()["systemSpaceStations"] = value;
            assert!(
                prepare(&changed, &certificate, 60.0)
                    .unwrap_err()
                    .contains("system station")
            );
        }
        for (field, value) in [
            ("fleetInstalled", json!(1)),
            ("fleetBusy", json!(1)),
            ("warpers", json!("1")),
            ("warperTarget", json!("1")),
            ("routingCursors", json!({"route":1})),
            (
                "fleetReturns",
                json!([{"routeKey":"future","returnAtSecond":500,"vesselCount":1}]),
            ),
            ("fleetReturns", json!({})),
        ] {
            let mut changed = prefix.clone();
            changed.base_value_mut()["galacticHubNetwork"][field] = value;
            let before = changed.canonical_sha256().unwrap();
            assert!(
                prepare(&changed, &certificate, 600.0)
                    .unwrap_err()
                    .contains("galactic hub network"),
                "{field}"
            );
            assert_eq!(changed.canonical_sha256().unwrap(), before);
        }
    }

    #[test]
    fn steady_flow_fixture_has_one_second_physical_fixed_point() {
        fn differences(before: &Value, after: &Value, path: &str, rows: &mut Vec<String>) {
            if crate::canonical::canonical_sha256(before)
                == crate::canonical::canonical_sha256(after)
            {
                return;
            }
            if let (Some(before), Some(after)) = (before.as_object(), after.as_object()) {
                let keys = before.keys().chain(after.keys()).collect::<BTreeSet<_>>();
                for key in keys {
                    differences(
                        before.get(key).unwrap_or(&Value::Null),
                        after.get(key).unwrap_or(&Value::Null),
                        &format!("{path}.{key}"),
                        rows,
                    );
                }
            } else if let (Some(before), Some(after)) = (before.as_array(), after.as_array()) {
                for index in 0..before.len().max(after.len()) {
                    differences(
                        before.get(index).unwrap_or(&Value::Null),
                        after.get(index).unwrap_or(&Value::Null),
                        &format!("{path}[{index}]"),
                        rows,
                    );
                }
            } else {
                rows.push(format!("{path}: {before} -> {after}"));
            }
        }
        let prefix = fixture();
        let certificate = certificate(&prefix);
        let mut next = prefix.clone();
        let revision = next.revision;
        next.advance_exact(&exact_request(revision, 1.0, 1.0))
            .unwrap();
        let mut changed = Vec::new();
        differences(
            &normalized_physical_state(&prefix, &certificate, 0).unwrap(),
            &normalized_physical_state(&next, &certificate, 1).unwrap(),
            "state",
            &mut changed,
        );
        assert!(changed.is_empty(), "{}", changed.join("\n"));
    }

    #[test]
    fn steady_flow_replays_every_belt_and_quantum_phase_without_changing_material() {
        for tail in [1.0, 4.0, 5.0, 9.0, 10.0, 11.0, 31.0] {
            let prefix = fixture();
            let certificate = certificate(&prefix);
            let proof = prepare(&prefix, &certificate, tail).unwrap();
            assert_eq!(proof.observed_history_samples().len(), PROBE_SECONDS);
            let mut candidate = with_material_tail(&prefix, &certificate, tail);
            let before = capture_settlement_snapshot(&candidate).unwrap();
            apply(&mut candidate, &proof).unwrap();
            let after = capture_settlement_snapshot(&candidate).unwrap();
            assert_eq!(before.owned, after.owned);
            assert_eq!(before.produced, after.produced);
            assert_eq!(before.finite_veins, after.finite_veins);
            let mut exact = prefix;
            for _ in 0..tail as usize {
                let revision = exact.revision;
                assert!(
                    exact
                        .advance_exact(&exact_request(revision, 1.0, 1.0))
                        .unwrap()
                        .supported
                );
            }
            assert_eq!(
                candidate.materialize().unwrap()["belts"],
                exact.materialize().unwrap()["belts"]
            );
            assert_eq!(
                candidate.base_value()["quantumLogisticsNetwork"],
                exact.base_value()["quantumLogisticsNetwork"]
            );
            candidate.validate_belt_runtime_topology().unwrap();
        }
    }

    #[test]
    fn steady_flow_fractional_clock_keeps_exact_quantum_remainder_phase() {
        for fraction in [0.0043, 0.25, 0.9999] {
            let mut prefix = fixture();
            let elapsed = prefix.base_value()["elapsedSeconds"].as_f64().unwrap();
            prefix.base_value_mut()["elapsedSeconds"] = Value::from(elapsed + fraction);
            prefix.base_value_mut()["historyRecordedAt"] = Value::from(elapsed + fraction);
            let certificate = certificate(&prefix);
            let proof = prepare(&prefix, &certificate, 11.0).unwrap();
            let mut candidate = with_material_tail(&prefix, &certificate, 11.0);
            apply(&mut candidate, &proof).unwrap();
            let mut exact = prefix;
            for _ in 0..11 {
                let revision = exact.revision;
                assert!(
                    exact
                        .advance_exact(&exact_request(revision, 1.0, 1.0))
                        .unwrap()
                        .supported
                );
            }
            assert_eq!(
                candidate.base_value()["quantumLogisticsNetwork"],
                exact.base_value()["quantumLogisticsNetwork"]
            );
        }
    }

    #[test]
    fn steady_flow_rejects_prefilled_drift_ambiguous_routing_and_unknown_runtime_fields() {
        let unsettled = super::super::tests::offline_flow_steady_fixture();
        let unsettled_certificate = certificate(&unsettled);
        let before = unsettled.canonical_sha256().unwrap();
        assert!(
            prepare(&unsettled, &unsettled_certificate, 60.0)
                .unwrap_err()
                .contains("physical steady state")
        );
        assert_eq!(unsettled.canonical_sha256().unwrap(), before);
        let initial = fixture();
        let certificate = certificate(&initial);
        let mut changed = initial.clone();
        let mut vein = changed.parse_entity(2).unwrap();
        vein["minerCount"] = Value::from(2);
        changed.replace_entity_raw(2, serde_json::to_string(&vein).unwrap().into());
        changed.rebuild_indexes().unwrap();
        let before = changed.canonical_sha256().unwrap();
        assert!(prepare(&changed, &certificate, 60.0).is_err());
        assert_eq!(changed.canonical_sha256().unwrap(), before);

        let mut solar = initial.clone();
        let mut power = solar.parse_entity(0).unwrap();
        power["buildingId"] = Value::from("solar_panel");
        solar.replace_entity_raw(0, serde_json::to_string(&power).unwrap().into());
        assert!(reject_external_writers(&solar, &certificate).is_err());

        let mut unknown = initial.clone();
        unknown.base_value_mut()["quantumLogisticsNetwork"]["runtimeFlow"]["futureCounter"] =
            Value::from(1);
        assert!(prepare(&unknown, &certificate, 60.0).is_err());

        let mut multiple = initial.clone();
        let belt = multiple.parse_belt(0).unwrap();
        let mut repeated = belt.clone();
        repeated["id"] = Value::from("additional-route");
        multiple
            .belt_raw_mut_topology()
            .push(serde_json::to_string(&repeated).unwrap().into());
        multiple.rebuild_indexes().unwrap();
        assert!(prepare(&multiple, &certificate, 60.0).is_err());

        let mut reward = initial.clone();
        reward.base_value_mut()["campaign"]["completedTaskIds"] = Value::Array(Vec::new());
        assert!(reject_external_writers(&reward, &certificate).is_err());
        let mut activity = initial;
        activity.base_value_mut()["endgame"]["constructionActivity"]["activityId"] =
            Value::from("future-timed-activity");
        assert!(reject_external_writers(&activity, &certificate).is_err());
        let mut orbits = fixture();
        orbits.base_value_mut()["dysonEngineering"]["orbitsBySystem"]["helios"][0]["sailsInOrbit"] =
            Value::from(1);
        assert!(reject_external_writers(&orbits, &certificate).is_err());
    }

    #[test]
    fn steady_flow_counter_overflow_and_wrong_candidate_fail_atomically() {
        let prefix = fixture();
        let certificate = certificate(&prefix);
        let mut proof = prepare(&prefix, &certificate, 60.0).unwrap();
        let mut candidate = with_material_tail(&prefix, &certificate, 60.0);
        proof.belt_units_per_second[0] = MAX_SAFE_INTEGER as i128;
        let before = candidate.canonical_sha256().unwrap();
        assert!(apply(&mut candidate, &proof).is_err());
        assert_eq!(candidate.canonical_sha256().unwrap(), before);

        let proof = prepare(&prefix, &certificate, 60.0).unwrap();
        let mut wrong = with_material_tail(&prefix, &certificate, 60.0);
        wrong.base_value_mut()["quantumLogisticsNetwork"]["inventory"]["iron_ingot"] =
            Value::from("9999");
        let before = wrong.canonical_sha256().unwrap();
        assert!(apply(&mut wrong, &proof).is_err());
        assert_eq!(wrong.canonical_sha256().unwrap(), before);
        assert!(proof.matches_prefix_and_tail(&prefix, 61.0).is_err());
    }

    #[test]
    fn steady_flow_checks_memory_tail_and_clock_before_any_probe() {
        let state = fixture();
        let certificate = certificate(&state);
        assert!(prepare(&state, &certificate, 0.5).is_err());
        assert!(prepare(&state, &certificate, 28_801.0).is_err());
        assert!(checked_clock_schedule(400_000_000_000.004_3, 600).is_err());
        let mut oversized = state;
        oversized.base_value_mut().insert(
            "unrelatedPayload".to_owned(),
            Value::String("x".repeat(40 * 1024 * 1024)),
        );
        assert!(check_memory_and_work(&oversized).is_err());
    }

    #[test]
    fn steady_flow_campaign_endpoint_rejects_completion_without_publishing_rewards() {
        let prefix = fixture();
        let certificate = certificate(&prefix);
        let mut candidate = with_material_tail(&prefix, &certificate, 60.0);
        verify_campaign_endpoint_no_write(&candidate).unwrap();
        candidate.base_value_mut()["campaign"]["completedTaskIds"] = Value::Array(Vec::new());
        let before = candidate.canonical_sha256().unwrap();
        assert!(verify_campaign_endpoint_no_write(&candidate).is_err());
        assert_eq!(candidate.canonical_sha256().unwrap(), before);
        let mut orbital = fixture();
        orbital.base_value_mut()["totalProduced"]["universe_matrix"] = Value::from(1);
        orbital.base_value_mut().insert(
            "orbitalStation".to_owned(),
            serde_json::json!({"status":"locked"}),
        );
        let before = orbital.canonical_sha256().unwrap();
        assert!(verify_campaign_endpoint_no_write(&orbital).is_err());
        assert_eq!(orbital.canonical_sha256().unwrap(), before);
    }
}
