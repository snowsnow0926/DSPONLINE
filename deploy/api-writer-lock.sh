#!/usr/bin/env bash
set -Eeuo pipefail

if (($# == 0)); then
  printf 'Usage: api-writer-lock.sh <command> [argument ...]\n' >&2
  exit 2
fi

lock_file="${DSP_API_WRITER_LOCK_FILE:-/run/dsp-idle-cloud/writer.lock}"
lock_directory="$(dirname "$lock_file")"
if [[ ! -d "$lock_directory" || ! -w "$lock_directory" ]]; then
  printf 'DSP Idle writer lock directory is missing or not writable: %s\n' "$lock_directory" >&2
  exit 78
fi
if [[ -L "$lock_file" || (-e "$lock_file" && (! -f "$lock_file" || ! -w "$lock_file")) ]]; then
  printf 'DSP Idle writer lock file is unsafe or not writable: %s\n' "$lock_file" >&2
  exit 78
fi
umask 0007
if ! { exec 9>>"$lock_file"; } 2>/dev/null; then
  printf 'DSP Idle writer lock file cannot be opened by the service account: %s\n' "$lock_file" >&2
  exit 78
fi
flock --exclusive --nonblock 9 || {
  printf 'another DSP Idle API writer owns %s\n' "$lock_file" >&2
  exit 75
}
exec "$@"
