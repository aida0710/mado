#!/bin/sh
# dev 起動: compose.dev.yaml を up する。About 表示用に現在のコミット情報を
# front コンテナへ渡す (dev コンテナには git が無いので host 側で解決して export)。
# 引数はそのまま docker compose up に渡る。例: ./dev.sh / ./dev.sh -d / ./dev.sh --build

set -eu

cd "$(dirname "$0")"

VITE_GIT_COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo dev)"
VITE_GIT_DATE="$(git log -1 --format=%cI 2>/dev/null || echo '')"
export VITE_GIT_COMMIT VITE_GIT_DATE

echo "==> docker compose -f compose.dev.yaml up (commit ${VITE_GIT_COMMIT})"
exec docker compose -f compose.dev.yaml up "$@"
