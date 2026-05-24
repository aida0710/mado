#!/bin/sh
# 本番デプロイ: main を pull して compose.prod.yaml で再ビルド + 再起動。
# 想定: prod ホスト (mado-prod project) でこのスクリプトを実行。
# dev は触らない。

set -eu

cd "$(dirname "$0")"

branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$branch" != "main" ]; then
  echo "Error: not on main (current: $branch)" >&2
  echo "  本番デプロイは main からのみ。git checkout main してから再実行してください。" >&2
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Error: working tree が dirty です" >&2
  echo "  追跡対象のローカル変更を commit / stash / restore してから再実行してください。" >&2
  exit 1
fi

echo "==> git pull origin main"
git pull origin main

# About 表示用のコミット情報を front ビルドへ渡す (compose の build.args が参照)。
VITE_GIT_COMMIT="$(git rev-parse --short HEAD)"
VITE_GIT_DATE="$(git log -1 --format=%cI)"
export VITE_GIT_COMMIT VITE_GIT_DATE

echo "==> docker compose -f compose.prod.yaml up -d --build (commit ${VITE_GIT_COMMIT})"
docker compose -f compose.prod.yaml up -d --build

echo "==> docker compose -f compose.prod.yaml ps"
docker compose -f compose.prod.yaml ps
