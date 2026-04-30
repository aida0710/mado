#!/usr/bin/env bash
# Push the stdout of a command to the web-dashboard.
#
# Usage:
#   DASHBOARD_URL=http://dashboard.lan:3000 \
#   WRITE_TOKEN=xxx \
#     ./push.sh <host-label> <command-label> -- <command...>
#
# Example:
#   ./push.sh miyabi qstat -- qstat -a
#
# Use this from cron on each HPC login node.
set -euo pipefail

HOST=${1:?host label required (e.g. miyabi)}; shift
COMMAND=${1:?command label required (e.g. qstat)}; shift
[[ "${1:-}" == "--" ]] && shift

: "${DASHBOARD_URL:?set DASHBOARD_URL=http://dashboard.lan:3000}"
: "${WRITE_TOKEN:?set WRITE_TOKEN}"

"$@" | curl -sS --fail -X POST \
  -H "Authorization: Bearer $WRITE_TOKEN" \
  -H "Content-Type: text/plain" \
  --data-binary @- \
  "$DASHBOARD_URL/api/hpc/push?host=$HOST&command=$COMMAND"
