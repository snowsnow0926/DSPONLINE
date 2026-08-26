use anyhow::{anyhow, bail};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Settlement {
    pub level: u32,
    pub progress: u128,
    pub consumed: u128,
    pub completed_levels: Vec<u32>,
    pub reached_maximum: bool,
}

#[derive(Debug, Clone, Copy)]
struct Curve {
    maximum_level: u32,
    growth_numerator: u128,
    base_cost: f64,
    legacy_growth: f64,
}

fn curve(id: &str) -> Option<Curve> {
    Some(match id {
        "matrix_compression" => Curve {
            maximum_level: 1_000,
            growth_numerator: 1_051,
            base_cost: 250.0,
            legacy_growth: 1.55,
        },
        "vein_utilization" => Curve {
            maximum_level: 1_000,
            growth_numerator: 1_048,
            base_cost: 300.0,
            legacy_growth: 1.58,
        },
        "galactic_logistics" => Curve {
            maximum_level: 1_000,
            growth_numerator: 1_052,
            base_cost: 350.0,
            legacy_growth: 1.6,
        },
        "stellar_harnessing" => Curve {
            maximum_level: 1_000,
            growth_numerator: 1_050,
            base_cost: 400.0,
            legacy_growth: 1.62,
        },
        "continuum_simulation" => Curve {
            maximum_level: 23,
            growth_numerator: 1_045,
            base_cost: 500.0,
            legacy_growth: 1.65,
        },
        _ => return None,
    })
}

pub(crate) fn valid_id(id: &str) -> bool {
    curve(id).is_some()
}

pub(crate) fn maximum_level(id: &str) -> Option<u32> {
    curve(id).map(|value| value.maximum_level)
}

/// Reproduces the JavaScript curve exactly. Only the legacy first ten levels
/// use binary floating point; every later level is an integer ratio rounded to
/// the nearest ten. The largest current Lv.1000 cost remains well within u128.
pub(crate) fn cost(id: &str, current_level: u32) -> anyhow::Result<u128> {
    let definition = curve(id).ok_or_else(|| anyhow!("unknown infinite research ID"))?;
    let target = (current_level.saturating_add(1)).clamp(1, definition.maximum_level);
    let first_target = target.min(10);
    let mut value = 0_u128;
    for level in 1..=first_target {
        let exponent = i32::try_from(level - 1).expect("legacy infinite research exponent");
        let rounded_tens =
            (definition.base_cost * definition.legacy_growth.powi(exponent) / 10.0).round();
        value = ((rounded_tens.max(1.0)) as u128) * 10;
    }
    for _ in 11..=target {
        value = value
            .checked_mul(definition.growth_numerator)
            .and_then(|product| product.checked_add(5_000))
            .map(|rounded| rounded / 10_000 * 10)
            .ok_or_else(|| anyhow!("infinite research curve overflow"))?;
    }
    Ok(value)
}

pub(crate) fn settle(
    id: &str,
    current_level: u32,
    current_progress: u128,
    requested: u128,
    auto_research: bool,
) -> anyhow::Result<Settlement> {
    let maximum = maximum_level(id).ok_or_else(|| anyhow!("unknown infinite research ID"))?;
    let mut level = current_level.min(maximum);
    let mut progress = current_progress;
    let mut remaining = requested;
    let mut completed_levels = Vec::new();
    while level < maximum {
        let required = cost(id, level)?;
        progress = progress.min(required);
        if progress >= required {
            level += 1;
            progress = 0;
            completed_levels.push(level);
            if !auto_research {
                break;
            }
            continue;
        }
        if remaining == 0 {
            break;
        }
        let invested = remaining.min(required - progress);
        progress += invested;
        remaining -= invested;
    }
    let consumed = requested
        .checked_sub(remaining)
        .ok_or_else(|| anyhow!("infinite research consumed budget underflow"))?;
    if progress > cost(id, level.min(maximum.saturating_sub(1)))? && level < maximum {
        bail!("infinite research progress exceeded its cost");
    }
    Ok(Settlement {
        level,
        progress,
        consumed,
        completed_levels,
        reached_maximum: level >= maximum,
    })
}

#[cfg(test)]
mod tests {
    use super::{cost, settle};

    #[test]
    fn cost_curve_matches_javascript_bigint_fixtures() {
        let cases = [
            ("matrix_compression", 0, "250"),
            ("matrix_compression", 9, "12910"),
            ("matrix_compression", 24, "27220"),
            ("matrix_compression", 499, "496760755291850"),
            ("matrix_compression", 999, "31441647386989570364354250"),
            ("vein_utilization", 999, "2647802975164680627175490"),
            ("galactic_logistics", 999, "150199719791816213690635070"),
            ("stellar_harnessing", 999, "29168681802280940068235780"),
            ("continuum_simulation", 22, "80330"),
        ];
        for (id, level, expected) in cases {
            assert_eq!(cost(id, level).unwrap().to_string(), expected);
        }
    }

    #[test]
    fn settlement_stops_or_continues_at_exact_level_boundaries() {
        let first = cost("matrix_compression", 263).unwrap();
        let second = cost("matrix_compression", 264).unwrap();
        let automatic = settle("matrix_compression", 263, 0, first + second, true).unwrap();
        assert_eq!(automatic.level, 265);
        assert_eq!(automatic.progress, 0);
        assert_eq!(automatic.completed_levels, vec![264, 265]);
        assert_eq!(automatic.consumed, first + second);

        let manual = settle("matrix_compression", 263, 0, first + second, false).unwrap();
        assert_eq!(manual.level, 264);
        assert_eq!(manual.completed_levels, vec![264]);
        assert_eq!(manual.consumed, first);

        let pre_funded = settle("matrix_compression", 263, first, 0, true).unwrap();
        assert_eq!(pre_funded.level, 264);
        assert_eq!(pre_funded.consumed, 0);
    }
}
