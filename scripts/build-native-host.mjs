import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const manifestPath = resolve("native", "Cargo.toml");
const binaryPath = resolve("native", "target", "release", process.platform === "win32" ? "dsp-native-host.exe" : "dsp-native-host");

const child = spawn("cargo", ["build", "--manifest-path", manifestPath, "--release", "--locked"], {
  stdio: "inherit",
  windowsHide: true,
  shell: false,
});

child.once("error", (error) => {
  console.error(`Unable to start Rust native-host build: ${error.message}`);
  process.exitCode = 1;
});

child.once("exit", (code) => {
  if (code !== 0) {
    process.exitCode = code ?? 1;
    return;
  }
  if (!existsSync(binaryPath)) {
    console.error(`Native-host build did not produce ${binaryPath}`);
    process.exitCode = 1;
  }
});

