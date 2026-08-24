#!/usr/bin/env bash
set -euo pipefail

# This script is intentionally read-only.  The report CLI opens SQLite with
# readonly/query_only and only prints a privacy-safe queue projection.
cd /opt/dsp-idle-cloud/current
exec /usr/bin/node leaderboard-review-report.mjs \
  --database /var/lib/dsp-idle-cloud/cloud.sqlite \
  --limit 200
