#!/usr/bin/env bash
# End-to-end check of the snapshot source (QEMU patch 0012,
# migration/porty-snapshot.c) with a *native* QEMU built from the patched
# QEMU-Wasm tree (no browser, no Emscripten):
#
#   1. builds a miniature ISO like tests/native-e2e.sh (stock Linux kernel,
#      busybox initrd) and runs scripts/prepare-image.sh on it;
#   2. boots it with the argv of web/js/qemu-args.js, lets the guest write a
#      random token into its RAM, and saves the machine with the monitor
#      command "migrate file:<path>", as the snapshot producer does;
#   3. packs the stream into zlib chunks with a manifest in the published
#      format (tests/pack-snapshot.py) and lets the page's own code write the
#      chunk index (tests/print-snapshot-index.mjs);
#   4. starts a second QEMU with the same argv plus
#      "-incoming porty:<index>" and checks that the guest carries on where
#      it was: same token, counter continuing, no second boot, and the
#      chunked disk (block/porty.c) still readable;
#   5. checks that damaged snapshots fail the start with a message that
#      names the chunk: wrong hash, corrupt data, missing file, short
#      stream, and an index that does not cover the stream.
#
# Natively the chunks are read from a directory instead of being fetched
# with XMLHttpRequest; everything else (index parsing, the fetching thread,
# hash and size checks, inflating, hand-over to the migration code) is the
# code the browser build runs.
#
# usage: tests/snapshot-native.sh <qemu-system-x86_64> <pc-bios-dir> <vmlinuz> <work-dir>
#   Leaves <work-dir>/image (the prepared image), <work-dir>/snapshot (the
#   packed snapshot) and <work-dir>/guest.env (what the guest must show).
set -euo pipefail

qemu="${1:?qemu binary}"; bios="${2:?pc-bios dir}"; vmlinuz="${3:?vmlinuz}"; work="${4:?work dir}"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
busybox="$(command -v busybox)"
# shellcheck source-path=SCRIPTDIR source=../build/versions.env
source "$repo/build/versions.env"

for tool in xorriso mksquashfs cpio gzip node md5sum python3; do
    command -v "$tool" >/dev/null || { echo "missing $tool" >&2; exit 2; }
done
mkdir -p "$work"
[[ -z "$(ls -A "$work")" ]] || { echo "$work must be empty" >&2; exit 2; }
work="$(cd "$work" && pwd)"
mkdir -p "$work"/{iso/isolinux,sfs,initrd/{bin,proc,sys,dev,mnt,tmp},ramdisk}

fail=0
pass() { echo "PASS  $*"; }
bad() { echo "FAIL  $*"; fail=1; }
# check <description> <grep pattern> <file>
check() { if grep -a -q -- "$2" "$3"; then pass "$1"; else bad "$1"; fi; }

# --- the guest ---------------------------------------------------------------
head -c $((3 * 1024 * 1024 + 123)) /dev/urandom > "$work/sfs/blob.bin"
blob_md5="$(md5sum "$work/sfs/blob.bin" | cut -d' ' -f1)"
mksquashfs "$work/sfs" "$work/iso/system.sfs" -noappend -comp gzip -noI -noD -noF -noX -quiet >/dev/null
echo marker > "$work/ramdisk/marker.txt"
( cd "$work/ramdisk" && echo marker.txt | cpio -o -H newc 2>/dev/null | gzip -9 ) > "$work/iso/ramdisk.img"

cp "$busybox" "$work/initrd/bin/busybox"
cat > "$work/initrd/init" <<'INIT'
#!/bin/busybox sh
/bin/busybox --install -s /bin
export PATH=/bin
mount -t proc proc /proc; mount -t sysfs sys /sys; mount -t devtmpfs dev /dev
mount -t squashfs -o ro /dev/vda /mnt || echo "PORTY-SNAP: mount failed"
# The token exists only in this machine's RAM (the root is a ramfs).
token="$(head -c 16 /dev/urandom | md5sum | cut -c1-32)"
echo "$token" > /token
echo "PORTY-SNAP: booted $token"
i=0
while :; do
    i=$((i + 1))
    # Drop the page cache so that every round reads the disk again.
    echo 3 > /proc/sys/vm/drop_caches
    echo "PORTY-SNAP: alive $(cat /token) $i $(md5sum /mnt/blob.bin | cut -d' ' -f1)"
    sleep 1
done
INIT
chmod +x "$work/initrd/init"
( cd "$work/initrd" && find . | cpio -o -H newc 2>/dev/null | gzip -1 ) > "$work/iso/initrd.img"
cp "$vmlinuz" "$work/iso/kernel"
cat > "$work/iso/isolinux/isolinux.cfg" <<'CFG'
default vesamenu.c32
label livem
	menu label Live CD - ^Run test without installation
	kernel /kernel
	append initrd=/initrd.img root=/dev/ram0 androidboot.selinux=permissive buildvariant=userdebug quiet SRC= DATA=
CFG
xorriso -as mkisofs -quiet -V PORTYSNAP -J -r -o "$work/test.iso" "$work/iso" 2>/dev/null
"$repo/scripts/prepare-image.sh" "$work/test.iso" "$work/image" 1048576 > "$work/prepare.log"

mkdir "$work/bios"
while read -r rom; do
    [[ -n "$rom" ]] && cp "$bios/$rom" "$work/bios/"
done < "$repo/build/pc-bios.list"

query='mem=512&tb=64&cache=4&append=panic=-1'
node "$repo/tests/print-qemu-args.mjs" "$work/image/manifest.json" "$work/image" "$work/bios" "?$query" > "$work/argv.txt"
mapfile -t args < "$work/argv.txt"

# --- running QEMU with its monitor on a pipe ------------------------------------
# The page's argv has "-serial mon:stdio": the guest console and the monitor
# share stdio, and Ctrl-A c switches between them.
qemu_pid=""
start_qemu() { # <log> <extra args...>: stdin from fd 3
    local log="$1"; shift
    rm -f "$work/stdin"
    mkfifo "$work/stdin"
    "$qemu" "${args[@]}" -no-reboot "$@" < "$work/stdin" > "$log" 2>&1 &
    qemu_pid=$!
    exec 3> "$work/stdin"
}
wait_for() { # <seconds> <grep pattern> <log>
    local deadline=$(( SECONDS + $1 ))
    until grep -a -q -- "$2" "$3"; do
        kill -0 "$qemu_pid" 2>/dev/null || return 1
        (( SECONDS < deadline )) || return 1
        sleep 0.5
    done
}
monitor() { printf '%s\n' "$@" >&3; }
finish_qemu() { # <seconds>: wait for the exit, kill after the deadline
    local deadline=$(( SECONDS + $1 )) rc=0
    while kill -0 "$qemu_pid" 2>/dev/null && (( SECONDS < deadline )); do sleep 0.5; done
    if kill -0 "$qemu_pid" 2>/dev/null; then
        kill -9 "$qemu_pid" 2>/dev/null || true
        rc=124
    fi
    wait "$qemu_pid" 2>/dev/null || rc=$(( rc ? rc : $? ))
    exec 3>&-
    return "$rc"
}
trap '[[ -z "$qemu_pid" ]] || kill -9 "$qemu_pid" 2>/dev/null || true' EXIT

# --- 1. boot and save -----------------------------------------------------------------
start_qemu "$work/boot.log"
if wait_for 300 'PORTY-SNAP: alive [0-9a-f]* 3 ' "$work/boot.log"; then
    pass "the guest booted (run 1)"
else
    bad "the guest did not boot within 300 s"
    tail -30 "$work/boot.log" | sed 's/^/    /'
    exit 1
fi
printf '\001c' >&3
monitor "migrate file:$work/vm.state" "info migrate" "quit"
finish_qemu 180 || bad "QEMU did not exit after saving (status $?)"
check "the machine was saved with 'migrate file:'" 'Migration status: completed' "$work/boot.log"
[[ -s "$work/vm.state" ]] || { bad "no migration stream was written"; tail -20 "$work/boot.log"; exit 1; }
token="$(grep -a -o 'PORTY-SNAP: booted [0-9a-f]*' "$work/boot.log" | head -1 | cut -d' ' -f3)"
# Only complete lines count: the save may have cut one in the middle.
rounds() { grep -a -o -E "PORTY-SNAP: alive $token [0-9]+ [0-9a-f]{32}" "$1" | cut -d' ' -f4; }
saved_at="$(rounds "$work/boot.log" | tail -1)"
echo "      token $token, saved after round $saved_at, stream $(stat -c %s "$work/vm.state") bytes"

# --- 2. pack as published -------------------------------------------------------------
patches_sha="$(cat "$repo"/patches/qemu-wasm/*.patch | sha256sum | cut -d' ' -f1)"
python3 -I "$repo/tests/pack-snapshot.py" "$work/vm.state" "$work/snapshot" \
    --argv "$work/argv.txt" --query "$query" --qemu-commit "$QEMU_WASM_COMMIT" \
    --patches-sha256 "$patches_sha" --image-manifest "$work/image/manifest.json" --booted-seconds "$saved_at"
node "$repo/tests/print-snapshot-index.mjs" "$work/snapshot/manifest.json" > "$work/snapshot/index.txt"
chunks="$(grep -c '^chunk ' "$work/snapshot/index.txt")"
# For tests/snapshot-browser.sh, which resumes this guest in QEMU-Wasm.
printf 'token=%s\nsaved_at=%s\nblob_md5=%s\n' "$token" "$saved_at" "$blob_md5" > "$work/guest.env"
(( chunks >= 3 )) || bad "the stream has only $chunks chunks: too small to test the hand-over between buffers"
last="$(printf '%06d' $(( chunks - 1 )))"

# --- 3. resume ---------------------------------------------------------------------------
start_qemu "$work/resume.log" -incoming "porty:$work/snapshot/index.txt"
next=$(( saved_at + 3 ))
if wait_for 180 "PORTY-SNAP: alive $token $next $blob_md5" "$work/resume.log"; then
    pass "the guest carries on after the resume: same token, round $next, disk readable"
else
    bad "the resumed guest did not reach round $next with token $token"
    tail -30 "$work/resume.log" | sed 's/^/    /'
fi
printf '\001c' >&3
monitor "info status" "quit"
finish_qemu 60 || bad "the resumed QEMU did not quit cleanly (status $?)"
check "the resumed machine is running" 'VM status: running' "$work/resume.log"
first="$(rounds "$work/resume.log" | head -1)"
if [[ -n "$first" ]] && (( first > saved_at - 1 && first <= saved_at + 2 )); then
    pass "the counter continues where it was saved (round $saved_at, then $first)"
else
    bad "the counter did not continue (saved at $saved_at, first round after resume '${first:-none}')"
fi
if grep -a -q -e 'PORTY-SNAP: booted' -e 'Linux version' "$work/resume.log"; then
    bad "the second QEMU booted instead of resuming"
else
    pass "no boot happened in the second QEMU"
fi
if grep -a -q 'porty-snapshot' "$work/resume.log"; then
    bad "the snapshot source complained: $(grep -a 'porty-snapshot' "$work/resume.log" | head -3)"
fi

# --- 4. damaged snapshots must fail, naming the chunk -------------------------------------
# refuse <description> <index file> <expected message>
refuse() {
    local log="$work/refuse.log" rc=0
    timeout -k 5 120 "$qemu" "${args[@]}" -no-reboot -incoming "porty:$2" < /dev/null > "$log" 2>&1 || rc=$?
    if (( rc == 1 )) && grep -a -q -- "$3" "$log" && ! grep -a -q 'PORTY-SNAP: alive' "$log"; then
        pass "$1: $(grep -a -o -- "porty-snapshot: .*" "$log" | head -1 | cut -c1-150)"
    else
        bad "$1 (exit status $rc, wanted 1 and '$3')"
        tail -5 "$log" | sed 's/^/    /'
    fi
}
variant() { rm -rf "$work/bad"; cp -r "$work/snapshot" "$work/bad"; }
flip() { # <file>: invert one byte in the middle
    python3 -I -c '
import sys
data = bytearray(open(sys.argv[1], "rb").read())
data[len(data) // 2] ^= 0xFF
open(sys.argv[1], "wb").write(data)' "$1"
}

variant; flip "$work/bad/000001.zz"
refuse "a chunk that does not match its SHA-256 is refused" "$work/bad/index.txt" 'chunk 1 (.*000001.zz): SHA-256 mismatch'

variant; flip "$work/bad/000001.zz"
sed -i -E 's/^(chunk [0-9]+) [0-9a-f]{64} (000001\.zz)$/\1 - \2/' "$work/bad/index.txt"
refuse "corrupt data is refused even without a hash" "$work/bad/index.txt" 'chunk 1 (.*000001.zz): zlib error'

variant; rm "$work/bad/$last.zz"
refuse "a missing chunk file is refused" "$work/bad/index.txt" "chunk $(( chunks - 1 )) (.*$last.zz): No such file"

variant; sed -i '$ d' "$work/bad/index.txt"
refuse "an index that does not cover the stream is refused" "$work/bad/index.txt" "lists $(( chunks - 1 )) chunks"

# A stream that ends early: the last chunk holds less than the sizes promise.
variant
python3 -I -c '
import hashlib, sys, zlib
path, index = sys.argv[1], sys.argv[2]
plain = zlib.decompress(open(path, "rb").read())
packed = zlib.compress(plain[: len(plain) // 2])
open(path, "wb").write(packed)
lines = open(index).read().splitlines()
name = lines[-1].split(" ")[3]
lines[-1] = f"chunk {len(packed)} {hashlib.sha256(packed).hexdigest()} {name}"
open(index, "w").write("\n".join(lines) + "\n")' "$work/bad/$last.zz" "$work/bad/index.txt"
refuse "a short stream is refused" "$work/bad/index.txt" "chunk $(( chunks - 1 )) (.*$last.zz): inflates to .* (short stream)"

refuse "a missing index is refused" "$work/bad/none.txt" 'cannot read the index'

exit "$fail"
