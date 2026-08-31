#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
tag=${1:-}

printf '%s\n' "$tag" | grep -Eq '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' || {
  echo "Error: tag must be canonical SemVer (vMAJOR.MINOR.PATCH): ${tag:-missing}" >&2
  exit 1
}

version=${tag#v}
expected=$(tr -d '[:space:]' < "$root/VERSION")
[ "$version" = "$expected" ] || {
  echo "Error: tag $tag does not match VERSION ($expected)" >&2
  exit 1
}

for file in api/package.json front/package.json; do
  actual=$(jq -er '.version' "$root/$file")
  [ "$actual" = "$version" ] || {
    echo "Error: $file version is $actual, want $version" >&2
    exit 1
  }
done

for file in api/package-lock.json front/package-lock.json; do
  actual=$(jq -er '.version' "$root/$file")
  root_actual=$(jq -er '.packages[""].version' "$root/$file")
  [ "$actual" = "$version" ] && [ "$root_actual" = "$version" ] || {
    echo "Error: $file root versions do not both equal $version" >&2
    exit 1
  }
done

notes="$root/docs/releases/$tag.md"
[ -s "$notes" ] || {
  echo "Error: version-controlled release notes are missing: docs/releases/$tag.md" >&2
  exit 1
}

echo "release version contract: $tag"
