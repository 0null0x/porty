#!/usr/bin/env bash
# End-to-end check of resuming in the browser with the real QEMU-Wasm build:
#
#   1. tests/snapshot-native.sh saves a small Linux guest on a native QEMU
#      built from the patched tree and packs the stream as published;
#   2. scripts/assemble-site.sh puts the QEMU-Wasm build, that guest's image
#      and the snapshot into a site;
#   3. headless Chrome opens the site and presses Start
#      (tests/ui/snapshot-e2e.mjs): the page must resume the guest through
#      "-incoming porty:", and the guest must carry on inside QEMU-Wasm with
#      the token it had in RAM when it was saved.
#
# This covers what the native test cannot: the chunk fetches by synchronous
# XMLHttpRequest from a pthread, the fetching thread and its condition
# variable under Emscripten, and a stream written by a 64-bit native QEMU
# being loaded by the 32-bit WebAssembly build.  The guest is not Android.
#
# usage: tests/snapshot-browser.sh <native qemu-system-x86_64> <pc-bios-dir> <vmlinuz>
#                                  <qemu-wasm-build-dir> <work-dir>
#   <qemu-wasm-build-dir> is the output of build/build-qemu.sh.
#   PORT, PUPPETEER_DIR, CHROME as for tests/ui/run.sh; MINUTES limits the
#   wait for the guest (default 15).
set -euo pipefail

qemu="${1:?native qemu binary}"; bios="${2:?pc-bios dir}"; vmlinuz="${3:?vmlinuz}"
wasm="${4:?QEMU-Wasm build dir}"; work="${5:?work dir}"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
port="${PORT:-8765}"

mkdir -p "$work"
[[ -z "$(ls -A "$work")" ]] || { echo "$work must be empty" >&2; exit 2; }
work="$(cd "$work" && pwd)"

"$repo/tests/snapshot-native.sh" "$qemu" "$bios" "$vmlinuz" "$work/native"
# shellcheck source=/dev/null
source "$work/native/guest.env"

"$repo/scripts/assemble-site.sh" --qemu "$wasm" --image "$work/native/image" \
    --snapshot "$work/native/snapshot" --out "$work/dist" --id snapshot-e2e > "$work/assemble.log"
[[ -s "$work/dist/snapshot/manifest.json" ]] || { cat "$work/assemble.log"; echo "FAIL  the snapshot was not published" >&2; exit 1; }
echo "PASS  site assembled with the QEMU-Wasm build and the snapshot"

python3 "$repo/tests/ui/serve.py" "$work/dist" "$port" &
server=$!
trap 'kill "$server" 2>/dev/null || true' EXIT
for _ in $(seq 50); do
    curl -fsS -o /dev/null "http://localhost:$port/index.html" 2>/dev/null && break
    sleep 0.1
done

# shellcheck disable=SC2154  # token, saved_at and blob_md5 come from guest.env
node "$repo/tests/ui/snapshot-e2e.mjs" "http://localhost:$port/" "$token" "$saved_at" "$blob_md5"
