#!/usr/bin/env bash
# Regenerate sample.tar / sample.tar.gz / sample.tar.xz from a fixed
# directory tree. Run from repo root: bash api/lib/test-fixtures/build.sh
set -euo pipefail
cd "$(dirname "$0")"

# Prevent macOS tar from embedding `._*` AppleDouble resource-fork entries
# in the archive — they would pollute the test fixtures cross-platform.
export COPYFILE_DISABLE=1

mkdir -p tmp/d
printf 'alpha\n'        > tmp/d/a.txt
printf 'beta-beta\n'    > tmp/d/b.txt
printf 'gamma-gamma\n'  > tmp/d/c.txt

tar -cf  sample.tar    -C tmp d
tar -czf sample.tar.gz -C tmp d
tar -cJf sample.tar.xz -C tmp d

rm -rf tmp
