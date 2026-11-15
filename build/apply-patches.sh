#!/usr/bin/env bash
# Check out the pinned QEMU-Wasm commit into <dir> and apply patches/qemu-wasm.
#
# usage: build/apply-patches.sh <dir>
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR source=versions.env
source "$here/versions.env"

dest="${1:?usage: apply-patches.sh <dir>}"
mkdir -p "$dest"
[[ -z "$(ls -A "$dest")" ]] || { echo "::error::$dest is not empty" >&2; exit 1; }

git -C "$dest" init --quiet
git -C "$dest" remote add origin "$QEMU_WASM_REPO"
git -C "$dest" fetch --quiet --depth 1 origin "$QEMU_WASM_COMMIT"
git -C "$dest" -c advice.detachedHead=false checkout --quiet FETCH_HEAD
head="$(git -C "$dest" rev-parse HEAD)"
[[ "$head" == "$QEMU_WASM_COMMIT" ]] \
    || { echo "::error::checked out $head, wanted $QEMU_WASM_COMMIT" >&2; exit 1; }

shopt -s nullglob
patches=("$here"/../patches/qemu-wasm/*.patch)
(( ${#patches[@]} )) || { echo "::error::no patches found" >&2; exit 1; }
for patch in "${patches[@]}"; do
    echo "applying $(basename "$patch")"
    git -C "$dest" apply --verbose "$patch"
done
git -C "$dest" status --short
