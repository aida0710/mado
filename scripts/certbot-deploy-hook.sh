#!/bin/sh
set -eu

script_path=$(readlink -f "$0")
project_dir=$(cd -P -- "$(dirname -- "$script_path")/.." && pwd)

cd "$project_dir"
docker compose -f compose.mdx.yaml exec -T edge nginx -t
docker compose -f compose.mdx.yaml exec -T edge nginx -s reload
