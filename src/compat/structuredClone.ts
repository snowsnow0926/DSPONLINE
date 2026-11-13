import cloneStructuredValue from "core-js-pure/actual/structured-clone.js";

// Each window and Worker keeps its native implementation when available.
if (typeof globalThis.structuredClone !== "function") {
  globalThis.structuredClone = cloneStructuredValue;
}
