#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
tag=${1:-}
output_dir=${2:-"$root/dist/release"}
manifest_dir=${3:-}

"$root/scripts/release/verify-version.sh" "$tag"
version=${tag#v}

manifest_value() {
  key=$1
  file=$2
  sed -n "s/^${key}=//p" "$file" | tail -1
}

if [ -n "$manifest_dir" ]; then
  for file in api.env worker.env web.env; do
    [ -s "$manifest_dir/$file" ] || {
      echo "Error: missing release manifest: $manifest_dir/$file" >&2
      exit 1
    }
  done
  api_image=$(manifest_value ref "$manifest_dir/api.env")
  worker_image=$(manifest_value ref "$manifest_dir/worker.env")
  web_image=$(manifest_value ref "$manifest_dir/web.env")
else
  api_image="ghcr.io/aida0710/mado-api:$tag"
  worker_image="ghcr.io/aida0710/mado-media-worker:$tag"
  web_image="ghcr.io/aida0710/mado-web:$tag"
fi

validate_ref() {
  ref=$1
  image=$2
  if [ -n "$manifest_dir" ]; then
    ref_pattern="^ghcr\\.io/aida0710/${image}@sha256:[0-9a-f]{64}$"
  else
    ref_pattern="^ghcr\\.io/aida0710/${image}:v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$"
  fi
  printf '%s\n' "$ref" | grep -Eq "$ref_pattern" || {
    echo "Error: invalid release image reference: $ref" >&2
    exit 1
  }
}
validate_ref "$api_image" mado-api
validate_ref "$worker_image" mado-media-worker
validate_ref "$web_image" mado-web

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT HUP INT TERM
bundle="mado-$tag"
base="$stage/$bundle"
mkdir -p "$base/db" "$output_dir"

sed \
  -e "s|@@MADO_API_IMAGE@@|$api_image|g" \
  -e "s|@@MADO_WORKER_IMAGE@@|$worker_image|g" \
  -e "s|@@MADO_WEB_IMAGE@@|$web_image|g" \
  "$root/deploy/release/compose.template.yaml" > "$base/compose.yaml"

cp "$root/deploy/release/README.md" "$base/README.md"
cp "$root/deploy/release/.env.example" "$base/.env.example"
cp "$root/docs/registry-api-contract.md" "$base/REGISTRY_API_CONTRACT.md"
cp "$root/LICENSE" "$root/NOTICE" "$base/"
cp -R "$root/db/init" "$root/db/migrations" "$base/db/"
cp "$root/db/README.md" "$base/db/README.md"
printf '%s\n' "$version" > "$base/VERSION"
printf '%s\n%s\n%s\n' "$api_image" "$worker_image" "$web_image" > "$base/images.txt"

archive="$output_dir/$bundle.tar.gz"
checksum="$archive.sha256"
epoch=${SOURCE_DATE_EPOCH:-$(git -C "$root" log -1 --format=%ct)}
rm -f "$archive" "$checksum"
tar --sort=name --mtime="@$epoch" --owner=0 --group=0 --numeric-owner \
  -C "$stage" -czf "$archive" "$bundle"
(
  cd "$output_dir"
  sha256sum "$(basename "$archive")" > "$(basename "$checksum")"
)

echo "$archive"
echo "$checksum"
