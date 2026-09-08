#!/usr/bin/env bash
set -Eeuo pipefail

control_root="${DSP_RELEASE_CONTROL_ROOT:-/usr/local/lib/dsp-idle-release/current}"
state_file="${DSP_RELEASE_SWITCH_STATE_FILE:-/var/lib/dsp-idle-cloud/release-state/switch-state.json}"
start_state_file="${DSP_RELEASE_ACTIVE_START_FILE:-/var/lib/dsp-idle-cloud/release-state/pending-switch.json}"
api_root="${DSP_API_ROOT:-/opt/dsp-idle-cloud}"

if [[ -s "$start_state_file" ]]; then
  state_file="$start_state_file"
fi

if ! active_environment="$(/usr/bin/node "$control_root/active-api-environment.mjs" "$state_file" "$api_root")"; then
  printf 'active DSP Idle API release state could not be read\n' >&2
  exit 78
fi
IFS=$'\t' read -r release_directory active_port pending_phase <<<"$active_environment"

if [[ "$pending_phase" == "recovering" ]]; then
  # A failed handoff must restore the old writer without an immediate
  # multi-gigabyte snapshot. 1.0.39 already honors the configured daily
  # window, while 1.0.41 additionally enforces startup grace. Refuse recovery
  # if that shared protection is absent instead of silently disabling backups.
  [[ -n "${DSP_CLOUD_BACKUP_WINDOW:-}" ]] || {
    printf 'DSP_CLOUD_BACKUP_WINDOW must protect an interrupted recovery\n' >&2
    exit 78
  }
fi

if [[ "$pending_phase" == "prepared" || "$pending_phase" == "publishing" || "$pending_phase" == "recovering" ]]; then
  backup_window="${DSP_CLOUD_BACKUP_WINDOW:-}"
  if [[ ! "$backup_window" =~ ^([0-9]{2}):([0-9]{2})-([0-9]{2}):([0-9]{2})$ ]]; then
    printf 'DSP_CLOUD_BACKUP_WINDOW must be configured before a release handoff starts\n' >&2
    exit 78
  fi
  start_hour="${BASH_REMATCH[1]}"
  start_minute="${BASH_REMATCH[2]}"
  end_hour="${BASH_REMATCH[3]}"
  end_minute="${BASH_REMATCH[4]}"
  if ((10#$start_hour > 23 || 10#$end_hour > 23 || 10#$start_minute > 59 || 10#$end_minute > 59)); then
    printf 'DSP_CLOUD_BACKUP_WINDOW contains an invalid time\n' >&2
    exit 78
  fi
  start_total=$((10#$start_hour * 60 + 10#$start_minute))
  end_total=$((10#$end_hour * 60 + 10#$end_minute))
  current_total=$((10#$(date +%H) * 60 + 10#$(date +%M)))
  if ((start_total == end_total)); then
    printf 'DSP_CLOUD_BACKUP_WINDOW cannot cover the full day\n' >&2
    exit 78
  fi
  if ((start_total < end_total)); then
    within_backup_window=$((current_total >= start_total && current_total < end_total))
  else
    within_backup_window=$((current_total >= start_total || current_total < end_total))
  fi
  if ((within_backup_window)); then
    printf 'release handoff is blocked during the configured backup window\n' >&2
    exit 78
  fi
fi

[[ -n "$release_directory" && "$active_port" =~ ^[0-9]+$ ]] || {
  printf 'active DSP Idle API release state is incomplete\n' >&2
  exit 78
}

export HOST=127.0.0.1
export PORT="$active_port"
exec "$control_root/api-writer-lock.sh" /usr/bin/node "$release_directory/index.mjs"
