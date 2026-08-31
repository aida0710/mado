#!/bin/sh
set -eu

: "${RELEASE_TAG:?RELEASE_TAG is required}"
: "${RELEASE_REPOSITORY:?RELEASE_REPOSITORY is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"

printf '%s\n' "$RELEASE_TAG" | grep -Eq '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' || {
  echo "Error: release tag is not canonical SemVer: $RELEASE_TAG" >&2
  exit 1
}

[ "$(git cat-file -t "$RELEASE_TAG")" = tag ] || {
  echo "Error: release tag must be annotated: $RELEASE_TAG" >&2
  exit 1
}

release_sha=$(git rev-parse "$RELEASE_TAG^{commit}")
git fetch --no-tags origin main
git merge-base --is-ancestor "$release_sha" refs/remotes/origin/main || {
  echo "Error: release commit is not an ancestor of origin/main" >&2
  exit 1
}

runs=$(gh api --paginate \
  -H 'Accept: application/vnd.github+json' \
  "repos/$RELEASE_REPOSITORY/actions/workflows/ci.yml/runs?head_sha=$release_sha&per_page=100" \
  | jq -s '[.[].workflow_runs[]]')
printf '%s' "$runs" | jq -e --arg sha "$release_sha" '
  any(.[];
    .head_sha == $sha and
    .head_branch == "main" and
    (.event == "push" or .event == "workflow_dispatch") and
    .status == "completed" and
    .conclusion == "success")
' >/dev/null || {
  echo "Error: exact release SHA has no successful main CI run: $release_sha" >&2
  exit 1
}

echo "$release_sha"
