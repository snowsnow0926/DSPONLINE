const { execFileSync } = require("node:child_process");
const path = require("node:path");
function packageProcesses(packageDirectory) {
  if (process.platform !== "win32") throw new Error("Windows package process audit is unavailable");
  const prefix = (path.resolve(packageDirectory) + path.sep).replaceAll("'", "''");
  const script = `$prefix = '${prefix}'; @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) } | Select-Object ProcessId,ParentProcessId,Name) | ConvertTo-Json -Compress`;
  const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 15000 }).trim();
  const value = output ? JSON.parse(output) : [];
  return Array.isArray(value) ? value : [value];
}
module.exports = { packageProcesses };
