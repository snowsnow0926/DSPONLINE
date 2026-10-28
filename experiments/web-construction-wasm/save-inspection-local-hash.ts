import { inspectCanonicalSaveEnvelope } from "../web-save-checkpoints/inspection-local-hash";
import { runInspectionComparison } from "./save-inspection-stack";

const runSaveInspectionLocalHash = () => runInspectionComparison(inspectCanonicalSaveEnvelope, "local-hash-accumulator");
Object.assign(globalThis, { runSaveInspectionLocalHash });
