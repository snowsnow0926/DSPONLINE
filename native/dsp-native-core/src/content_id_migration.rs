//! Typed ID migration after the original import checksum has been verified.
//! Entity IDs and author text are never content references.
use anyhow::{Result, bail};
use num_bigint::BigUint;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IdMigration {
    pub kind: String,
    pub from: String,
    pub to: String,
}

fn scalar_kind(key: &str) -> Option<&'static str> {
    match key {
        "itemId" | "resourceId" | "fuelItemId" | "storedItemId" | "proliferatorItemId"
        | "currentItemId" | "outputItemId" => Some("items"),
        "buildingId"
        | "extractorBuildingId"
        | "targetBuildingId"
        | "upgradeTargetId"
        | "constructionId"
        | "lastCraftedId" => Some("buildings"),
        "recipeId" | "sourceRecipeId" | "targetRecipeId" => Some("recipes"),
        "selectedTechId" | "pausedTechId" | "requiredTechId" | "technologyId" => {
            Some("technologies")
        }
        _ => None,
    }
}
fn array_kind(key: &str) -> Option<&'static str> {
    match key {
        "completedTechIds" | "queuedTechIds" | "prerequisites" => Some("technologies"),
        "deliveryItemIds"
        | "orbitalCargoPortItems"
        | "resourceIds"
        | "rareResourceIds"
        | "itemIds" => Some("items"),
        _ => None,
    }
}
fn map_kind(key: &str) -> Option<&'static str> {
    match key {
        "inputs"
        | "outputs"
        | "tray"
        | "totalProduced"
        | "inventory"
        | "itemCapacities"
        | "delivered"
        | "exportedByItem"
        | "uploaded"
        | "downloaded"
        | "needed"
        | "requested"
        | "constructionBuffer"
        | "itemPolicies"
        | "currentRunProduction"
        | "totalProduction"
        | "proliferatorBonusProgress"
        | "productionPerMinute"
        | "consumptionPerMinute"
        | "researchInvestmentByItem"
        | "destroyedByproducts"
        | "completedItems"
        | "orbitalYields"
        | "routingCursors"
        | "uploadRoutingCursors"
        | "recipeSelections" => Some("items"),
        "construction" | "reservedConstruction" | "targetStock" | "jobs" => Some("buildings"),
        "progressByTech" => Some("technologies"),
        "recipeOverrides" => Some("recipes"),
        _ => None,
    }
}
fn remap(value: &str, kind: &str, rules: &[IdMigration]) -> String {
    rules
        .iter()
        .find(|rule| {
            (rule.kind == kind || kind == "buildings" && rule.kind == "belts") && rule.from == value
        })
        .map_or_else(|| value.to_owned(), |rule| rule.to.clone())
}
fn merge(left: &mut Value, right: Value, maximum: bool) -> Result<()> {
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => {
            let a_value = a
                .as_f64()
                .ok_or_else(|| anyhow::anyhow!("invalid migration number"))?;
            let b_value = b
                .as_f64()
                .ok_or_else(|| anyhow::anyhow!("invalid migration number"))?;
            let result = if maximum {
                a_value.max(b_value)
            } else {
                a_value + b_value
            };
            if !result.is_finite() || result.abs() > 9_007_199_254_740_991.0 {
                bail!("content ID merge exceeds safe integer range");
            }
            *a = serde_json::Number::from_f64(result)
                .ok_or_else(|| anyhow::anyhow!("invalid migration sum"))?;
        }
        (Value::String(a), Value::String(b))
            if !a.is_empty()
                && !b.is_empty()
                && a.bytes().all(|byte| byte.is_ascii_digit())
                && b.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            let left = BigUint::parse_bytes(a.as_bytes(), 10).unwrap();
            let right = BigUint::parse_bytes(b.as_bytes(), 10).unwrap();
            *a = if maximum {
                left.max(right)
            } else {
                left + right
            }
            .to_string();
        }
        (Value::Object(a), Value::Object(b)) => {
            for (key, value) in b {
                if let Some(existing) = a.get_mut(&key) {
                    merge(existing, value, maximum)?;
                } else {
                    a.insert(key, value);
                }
            }
        }
        (Value::Array(a), Value::Array(b)) => a.extend(b),
        (a, b) if *a == b => {}
        _ => bail!("content ID merge has conflicting nonnumeric records"),
    }
    Ok(())
}

pub(crate) fn migrate_value(value: &mut Value, key: &str, rules: &[IdMigration]) -> Result<()> {
    if rules.is_empty() {
        return Ok(());
    }
    match value {
        Value::String(text) => {
            if let Some(kind) = scalar_kind(key) {
                *text = remap(text, kind, rules);
            }
        }
        Value::Array(entries) => {
            for entry in entries.iter_mut() {
                if let (Some(kind), Value::String(text)) = (array_kind(key), &mut *entry) {
                    *text = remap(text, kind, rules);
                } else {
                    migrate_value(entry, "", rules)?;
                }
            }
            if matches!(key, "completedTechIds" | "queuedTechIds") {
                let mut unique = Vec::new();
                entries.retain(|entry| {
                    if unique.contains(entry) {
                        false
                    } else {
                        unique.push(entry.clone());
                        true
                    }
                });
            }
        }
        Value::Object(object) => {
            let mut result = Map::new();
            for (old_key, mut entry) in std::mem::take(object) {
                let next_key = map_kind(key)
                    .map_or_else(|| old_key.clone(), |kind| remap(&old_key, kind, rules));
                if matches!(
                    key,
                    "planetTrays"
                        | "planetProductionPerMinute"
                        | "planetConsumptionPerMinute"
                        | "quantumMaterialBuffer"
                        | "progressByTech"
                ) {
                    migrate_value(&mut entry, "inventory", rules)?;
                } else if matches!(key, "recipeSelections" | "recipeOverrides") && entry.is_string()
                {
                    entry = Value::String(remap(entry.as_str().unwrap(), "recipes", rules));
                } else {
                    migrate_value(&mut entry, &old_key, rules)?;
                }
                if let Some(existing) = result.get_mut(&next_key) {
                    merge(existing, entry, key == "progressByTech")?;
                } else {
                    result.insert(next_key, entry);
                }
            }
            *object = result;
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn rules() -> Vec<IdMigration> {
        vec![
            IdMigration {
                kind: "items".into(),
                from: "old_item".into(),
                to: "new_item".into(),
            },
            IdMigration {
                kind: "technologies".into(),
                from: "old_tech".into(),
                to: "new_tech".into(),
            },
        ]
    }
    #[test]
    fn preserves_entity_identity_and_sums_every_inventory_exactly() {
        let mut value = json!({"entities":[{"id":"old_item","resourceId":"old_item","inputs":{"old_item":7,"new_item":11}}],"inventory":{"old_item":"999999999999999999999","new_item":"1"},"currentItemId":"old_item","outputItemId":"old_item"});
        migrate_value(&mut value, "", &rules()).unwrap();
        assert_eq!(value["entities"][0]["id"], "old_item");
        assert_eq!(value["entities"][0]["resourceId"], "new_item");
        assert_eq!(
            value["entities"][0]["inputs"]["new_item"].as_f64(),
            Some(18.0)
        );
        assert_eq!(value["inventory"]["new_item"], "1000000000000000000000");
        assert_eq!(value["currentItemId"], "new_item");
        assert_eq!(value["outputItemId"], "new_item");
    }
    #[test]
    fn coalesces_research_and_keeps_blueprint_links() {
        let mut value = json!({"research":{"completedTechIds":["old_tech","new_tech"],"progressByTech":{"old_tech":{"new_item":7},"new_tech":{"new_item":4}}},"blueprints":[{"key":"old_item","resourceId":"old_item"}]});
        migrate_value(&mut value, "", &rules()).unwrap();
        assert_eq!(value["research"]["completedTechIds"], json!(["new_tech"]));
        assert_eq!(
            value["research"]["progressByTech"]["new_tech"]["new_item"].as_f64(),
            Some(7.0)
        );
        assert_eq!(value["blueprints"][0]["key"], "old_item");
    }
    #[test]
    fn rejects_overflow_and_conflicts() {
        assert!(
            migrate_value(
                &mut json!({"tray":{"old_item":9007199254740991_u64,"new_item":1}}),
                "",
                &rules()
            )
            .is_err()
        );
        assert!(migrate_value(&mut json!({"itemPolicies":{"old_item":{"mode":"supply"},"new_item":{"mode":"demand"}}}), "", &rules()).is_err());
    }
}
