#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
tag=${1:-"v$(tr -d '[:space:]' < "$root/VERSION")"}

"$root/scripts/release/verify-version.sh" "$tag"

for workflow in "$root/.github/workflows/ci.yml" "$root/.github/workflows/release.yml"; do
  [ -s "$workflow" ] || { echo "Error: missing workflow: $workflow" >&2; exit 1; }
  bad=$(sed -E -n 's/^[[:space:]]*(-[[:space:]]*)?uses:[[:space:]]*[^@]+@([^[:space:]#]+).*/\2/p' "$workflow" \
    | grep -Ev '^[0-9a-f]{40}$' || true)
  [ -z "$bad" ] || {
    echo "Error: $workflow contains non-SHA action refs:" >&2
    echo "$bad" >&2
    exit 1
  }
done

grep -F 'branches:' "$root/.github/workflows/release.yml" >/dev/null && {
  echo "Error: release workflow must not publish from branch pushes" >&2
  exit 1
}

release="$root/.github/workflows/release.yml"
for required in \
  'tags: ["v*"]' \
  'scripts/ci/verify-release-source.sh' \
  'scripts/release/build-bundle.sh' \
  'docs/releases/$RELEASE_TAG.md' \
  'linux/amd64,linux/arm64' \
  'provenance: mode=max' \
  'sbom: true' \
  'gh release create' \
  'environment: release'; do
  grep -F "$required" "$release" >/dev/null || {
    echo "Error: release workflow lacks contract: $required" >&2
    exit 1
  }
done

case $(find "$root/docs/releases" -maxdepth 1 -name 'v*.md' -type f | wc -l | tr -d ' ') in
  0) echo "Error: no versioned release notes found" >&2; exit 1 ;;
esac

[ -s "$root/docs/registry-api-contract.md" ] || {
  echo "Error: missing Dataset Registry API contract" >&2
  exit 1
}
grep -F 'REGISTRY_API_CONTRACT.md' "$root/scripts/release/build-bundle.sh" >/dev/null || {
  echo "Error: release bundle does not include the Registry contract" >&2
  exit 1
}

echo "release workflow contract: ok"
