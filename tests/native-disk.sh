#!/usr/bin/env bash
# Reads a prepared system disk back through the block drivers the browser
# build uses, with a *native* qemu-img built from the patched QEMU-Wasm tree
# (no browser, no Emscripten, no guest): block/qcow2.c (or raw) on top of
# block/porty.c, opened read-only with the same options as the page's
# -drive (web/js/qemu-args.js).  The result must be, bit for bit, what
# image/manifest.json says the guest sees.
#
# usage: tests/native-disk.sh <qemu-img> <image-dir>
#   <qemu-img>   from the tree made by build/apply-patches.sh, e.g.
#                configure --without-default-features --enable-tools
#                --disable-system --disable-user --with-coroutine=ucontext
#                && ninja qemu-img
#   <image-dir>  output of scripts/prepare-image.sh
set -euo pipefail

qemu_img="${1:?usage: native-disk.sh <qemu-img> <image-dir>}"
image="${2:?usage: native-disk.sh <qemu-img> <image-dir>}"
fail() { echo "FAIL  $*" >&2; exit 1; }
pass() { echo "PASS  $*"; }

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

read -r format dir size chunk want_sha want_size < <(python3 -I - "$image/manifest.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))["disk"]
qcow2 = d.get("format") == "qcow2"
print("qcow2" if qcow2 else "raw", d["dir"], d["size"], d["chunk_size"],
      d["content_sha256"] if qcow2 else d["sha256"], d["virtual_size"] if qcow2 else d["size"])
PY
)
opts="driver=$format,read-only=on,file.driver=porty,file.url=$image/$dir,file.size=$size,file.chunk-size=$chunk"

"$qemu_img" info --image-opts "$opts,file.cache-chunks=4,file.parallel=3" > "$work/info.txt" \
    || fail "qemu-img cannot open the disk ($format over porty)"
grep -q "^virtual size: .*($want_size bytes)" "$work/info.txt" \
    || { cat "$work/info.txt" >&2; fail "the disk is not $want_size bytes"; }
pass "$format over porty opens read-only; virtual size $want_size bytes"

# Twice: a cache that holds only a few chunks with parallel fetches, and one
# that holds everything.
for cache in "file.cache-chunks=4,file.parallel=3" "file.cache-chunks=4096,file.parallel=1"; do
    "$qemu_img" convert --image-opts "$opts,$cache" -O raw "$work/disk.img" \
        || fail "reading the disk failed ($cache)"
    [[ "$(stat -c %s "$work/disk.img")" == "$want_size" ]] || fail "read back $(stat -c %s "$work/disk.img") bytes ($cache)"
    [[ "$(sha256sum "$work/disk.img" | cut -d' ' -f1)" == "$want_sha" ]] \
        || fail "the data read back differs from the manifest's hash ($cache)"
    pass "every byte reads back as the manifest says ($cache)"
done

if [[ "$format" == qcow2 ]]; then
    "$qemu_img" check --image-opts "$opts" > "$work/check.txt" 2>&1 \
        || { cat "$work/check.txt" >&2; fail "qemu-img check reports errors"; }
    pass "qemu-img check: $(tail -1 "$work/check.txt")"
    # A write must be refused, not attempted.
    if "$qemu_img" bench -w -c 1 --image-opts "${opts/read-only=on/read-only=off}" >/dev/null 2>&1; then
        fail "the disk could be opened for writing"
    fi
    pass "the disk cannot be opened for writing"
fi
echo "native-disk: all checks passed"
