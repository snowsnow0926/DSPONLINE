/// <reference lib="webworker" />
// Public compatibility fixtures compare legacy initializations under exactly
// the same clock. Production code and validation remain unchanged.
import "../../src/game/canonicalTerminalOwner.worker";
Date.now = () => 1_800_000_000_000;
