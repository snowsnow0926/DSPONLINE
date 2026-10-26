import { parseTrustedWorkerEnvelopeChunked } from "../../src/game/storage";
import { runTerminalDecodeProbe } from "./terminal-decode";

Object.assign(globalThis, {
  runTerminalDecodeCooperativeProbe: () => runTerminalDecodeProbe("cooperative", parseTrustedWorkerEnvelopeChunked),
});
