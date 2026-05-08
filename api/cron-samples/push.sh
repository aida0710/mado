#!/usr/bin/env bash
# コマンドの stdout を mado にプッシュする。
#
# 使い方:
#   DASHBOARD_URL=http://mado.lan \
#   WRITE_TOKEN=xxx \
#     ./push.sh <host-label> <command-label> -- <command...>
#
# 例:
#   ./push.sh example uptime -- uptime
#
# 各メトリクスソースホストの cron から呼び出す。
# DASHBOARD_URL は接続元によって異なる:
#   - prod LAN 内 (10.15.0.0/16):  http://mado.lan      (nginx :80)
#   - prod LAN 外 (HPC ノード等):  http://<server>:81   (nginx :81、/api/external/ 専用)
#   - dev:                          http://mado.lan:5173 (vite dev server)
set -euo pipefail

HOST=${1:?host label required (e.g. example)}; shift
COMMAND=${1:?command label required (e.g. uptime)}; shift
[[ "${1:-}" == "--" ]] && shift

: "${DASHBOARD_URL:?set DASHBOARD_URL=http://mado.lan}"
: "${WRITE_TOKEN:?set WRITE_TOKEN}"

"$@" | curl -sS --fail -X POST \
  -H "Authorization: Bearer $WRITE_TOKEN" \
  -H "Content-Type: text/plain" \
  --data-binary @- \
  "$DASHBOARD_URL/api/external/metrics/push?host=$HOST&command=$COMMAND"
