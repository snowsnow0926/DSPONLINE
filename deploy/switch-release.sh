#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -n "${DSP_RELEASE_CONTROL_ROOT:-}" ]]; then
  control_root="$DSP_RELEASE_CONTROL_ROOT"
elif [[ -f "$script_dir/release-switch.mjs" ]]; then
  control_root="$script_dir"
else
  control_root="/usr/local/lib/dsp-idle-release/current"
fi
state_root="${DSP_RELEASE_STATE_ROOT:-/var/lib/dsp-idle-cloud/release-state}"
service_group="${DSP_SERVICE_GROUP:-ubuntu}"
install -d -m 2750 -o root -g "$service_group" "$state_root"
export DSP_API_ROOT="${DSP_API_ROOT:-/opt/dsp-idle-cloud}"
export DSP_API_PACKAGE_FILE="${DSP_API_PACKAGE_FILE:-$DSP_API_ROOT/current/package.json}"
exec 8>"$state_root/switch.lock"
flock --exclusive --nonblock 8 || {
  printf 'another DSP Idle release switch is already running\n' >&2
  exit 75
}
set +e
"${NODE:-/usr/bin/node}" "$control_root/release-switch.mjs" "$@"
status=$?
if [[ "$status" -ne 0 ]]; then
  # The protected SSH wrapper consumes this marker and reports only the
  # bounded category/exit code. Detailed Node errors stay out of transport
  # diagnostics and are never copied into release records.
  printf 'DSP_SAFE_ERROR:RELEASE_SWITCH_FAILED\n' >&2
fi
exit "$status"
