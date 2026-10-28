// Experimental replacement compiled inside save-field-contract.mjs by the lab.
// Keep the original frozen plans and default resolution; remove only the extra
// tagged object built around each own property descriptor.
export function omitSaveContractDefaults(record, scope, gameStateVersion) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return record;
  const plan = projectionPlans.get(scope)?.get(gameStateVersion);
  if (!plan) return record;
  const dynamicValues = plan.dynamic.length
    ? plan.dynamic.map(({ descriptor }) => resolveDefaultDescriptor(descriptor, record)) : null;
  for (const { field, descriptor, value, dynamicIndex } of plan.entries) {
    const own = Object.getOwnPropertyDescriptor(record, field);
    if (!own || !("value" in own)) continue;
    if (own.value === undefined) {
      delete record[field];
      continue;
    }
    const defaultValue = dynamicIndex < 0 ? value : dynamicValues[dynamicIndex];
    if (exactDefaultMatch(own.value, descriptor, defaultValue)) delete record[field];
  }
  return record;
}
