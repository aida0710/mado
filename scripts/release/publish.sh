#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
verify_only=false
if [ "${1:-}" = --verify-only ]; then
  verify_only=true
  shift
fi
tag=${1:-}

"$root/scripts/release/verify-contract.sh" "$tag"

[ "$(git -C "$root" rev-parse --abbrev-ref HEAD)" = main ] || {
  echo "Error: releases must be prepared from main" >&2; exit 1;
}
[ -z "$(git -C "$root" status --porcelain --untracked-files=all)" ] || {
  echo "Error: working tree is not clean" >&2; exit 1;
}

git -C "$root" fetch origin main --tags
head_sha=$(git -C "$root" rev-parse HEAD)
remote_main=$(git -C "$root" rev-parse refs/remotes/origin/main)
[ "$head_sha" = "$remote_main" ] || {
  echo "Error: HEAD is not the exact origin/main commit" >&2; exit 1;
}

runs=$(gh api --paginate \
  "repos/aida0710/mado/actions/workflows/ci.yml/runs?head_sha=$head_sha&per_page=100" \
  | jq -s '[.[].workflow_runs[]]')
printf '%s' "$runs" | jq -e --arg sha "$head_sha" '
  any(.[]; .head_sha == $sha and .head_branch == "main" and
    (.event == "push" or .event == "workflow_dispatch") and
    .status == "completed" and .conclusion == "success")
' >/dev/null || {
  echo "Error: HEAD has no successful main CI run" >&2; exit 1;
}

if git -C "$root" show-ref --verify --quiet "refs/tags/$tag" \
   || git -C "$root" ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null 2>&1; then
  echo "Error: tag already exists and will not be moved: $tag" >&2
  exit 1
fi

echo "release source verified: $tag at $head_sha"
$verify_only && exit 0

printf 'Type %s to create and push the immutable release tag: ' "$tag"
IFS= read -r confirmation
[ "$confirmation" = "$tag" ] || { echo "Cancelled." >&2; exit 1; }

git -C "$root" tag -a "$tag" "$head_sha" -m "Mado $tag"
git -C "$root" push origin "refs/tags/$tag"
echo "release workflow triggered for $tag"
