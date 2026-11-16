#!/usr/bin/env bash
# Fast dry run of the image and site pipeline on a miniature, fake ISO:
# scripts/prepare-image.sh -> scripts/assemble-site.sh, then structural
# checks on the result.  No QEMU and no Android image are needed, so this
# runs in the "checks" job before the expensive build starts.
#
# usage: tests/site-smoke.sh <empty-work-dir>
# needs: xorriso, squashfs-tools, e2fsprogs, qemu-img (qemu-utils), cpio,
# node, python3, and web/node_modules (npm ci).
set -euo pipefail

work="${1:?usage: site-smoke.sh <empty-work-dir>}"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$work"
[[ -z "$(ls -A "$work")" ]] || { echo "$work must be empty" >&2; exit 2; }
fail() { echo "FAIL  $*" >&2; exit 1; }
pass() { echo "PASS  $*"; }
PATH="$PATH:/usr/sbin:/sbin"   # e2fsprogs

# --- a fake ISO with the Android-x86 layout ---------------------------------
# system.sfs is a gzip squashfs holding system.img, an ext4 image with
# build.prop at its root; here with two "Google" packages and two others.
mkdir -p "$work"/{iso/isolinux,sfs,initrd,qemu/pc-bios} \
    "$work"/sys/{app/Launcher3,app/GoogleContactsSyncAdapter/oat/x86_64,priv-app/PrebuiltGmsCore/lib,priv-app/SystemUI,etc/permissions}
echo "ro.build.version.release=9" > "$work/sys/build.prop"
head -c 700000 /dev/urandom > "$work/sys/priv-app/PrebuiltGmsCore/PrebuiltGmsCore.apk"
head -c 90000 /dev/urandom > "$work/sys/priv-app/PrebuiltGmsCore/lib/libgms.so"
ln -s libgms.so "$work/sys/priv-app/PrebuiltGmsCore/lib/libgms.so.1"
head -c 50000 /dev/urandom > "$work/sys/app/GoogleContactsSyncAdapter/GoogleContactsSyncAdapter.apk"
head -c 20000 /dev/urandom > "$work/sys/app/GoogleContactsSyncAdapter/oat/x86_64/GoogleContactsSyncAdapter.odex"
head -c 200000 /dev/urandom > "$work/sys/app/Launcher3/Launcher3.apk"
head -c 100000 /dev/urandom > "$work/sys/priv-app/SystemUI/SystemUI.apk"
echo "<permissions/>" > "$work/sys/etc/permissions/privapp-permissions-google.xml"
mke2fs -q -t ext4 -O ^has_journal -d "$work/sys" "$work/sfs/system.img" 8M >/dev/null
mksquashfs "$work/sfs" "$work/iso/system.sfs" -noappend -comp gzip -quiet >/dev/null
cat > "$work/slim.list" <<'LIST'
# what the miniature image loses
/priv-app/PrebuiltGmsCore
/app/GoogleContactsSyncAdapter/
/priv-app/NotInThisImage
LIST
export PORTY_SLIM_LIST="$work/slim.list"
# 514 bytes of padding, then the bzImage signature the real check looks for
{ head -c 514 /dev/zero; printf 'HdrS'; head -c 4096 /dev/urandom; } > "$work/iso/kernel"
# The initrd's init must accept a bare system filesystem (build.prop at the
# root of the disk); prepare-image.sh checks for that line.
cat > "$work/initrd/init" <<'INIT'
#!/bin/busybox sh
check_root()
{
	try_mount ro $dev /mnt || return 1
	if [ -e /mnt/$SRC/system.sfs ]; then
		mount -o loop,noatime /mnt/$SRC/system.sfs system
	elif [ -e /mnt/build.prop ]; then
		mount --bind /mnt system
	fi
}
INIT
( cd "$work/initrd" && echo init | cpio -o -H newc 2>/dev/null | gzip ) > "$work/iso/initrd.img"
echo ramdisk | gzip > "$work/iso/ramdisk.img"
cat > "$work/iso/isolinux/isolinux.cfg" <<'CFG'
default vesamenu.c32
timeout 600
label livem
	menu label Live CD - ^Run Android-x86 without installation
	kernel /kernel
	append initrd=/initrd.img root=/dev/ram0 androidboot.selinux=permissive buildvariant=userdebug quiet SRC= DATA=
label debug
	kernel /kernel
	append initrd=/initrd.img root=/dev/ram0 DEBUG=2 SRC= DATA=
CFG
xorriso -as mkisofs -quiet -V SMOKE -J -r -o "$work/fake.iso" "$work/iso" 2>/dev/null

"$repo/scripts/prepare-image.sh" "$work/fake.iso" "$work/image" 65536 > "$work/prepare.log"
pass "prepare-image.sh accepted the fake ISO"

# --- the published disk: a compressed qcow2 of the slimmed ext4 image ---------
disk_dir="$(python3 -I - "$work/image/manifest.json" <<'PY'
import json, sys
m = json.load(open(sys.argv[1], encoding="utf-8"))
d = m["disk"]
assert m["format"] == 2 and d["format"] == "qcow2" and d["content"] == "ext4", d
assert d["virtual_size"] == 8 << 20 and d["cluster_size"] == 65536, d
assert d["dir"] == "system-" + d["sha256"][:16], d
assert [r["path"] for r in d["removed"]] == ["/priv-app/PrebuiltGmsCore", "/app/GoogleContactsSyncAdapter"], d
assert d["removed"][0]["bytes"] == 790000 and d["removed_bytes"] == 860000, d
assert m["source"]["system_sfs_compression"] == "gzip", m
print(d["dir"])
PY
)"
cat "$work/image/$disk_dir"/*.bin > "$work/disk.qcow2"
qemu-img convert -f qcow2 -O raw "$work/disk.qcow2" "$work/disk.img"
[[ "$(sha256sum "$work/disk.img" | cut -d' ' -f1)" == "$(grep -o '"content_sha256": "[0-9a-f]*' "$work/image/manifest.json" | cut -d'"' -f4)" ]] \
    || fail "the chunks do not hold the system image the manifest describes"
e2fsck -fn "$work/disk.img" >/dev/null 2>&1 || fail "the published system image does not pass e2fsck"
listing="$(debugfs -R 'ls -p /priv-app' "$work/disk.img" 2>/dev/null; debugfs -R 'ls -p /app' "$work/disk.img" 2>/dev/null)"
[[ "$listing" == *"/SystemUI/"* && "$listing" == *"/Launcher3/"* ]] || fail "packages that were to stay are gone"
[[ "$listing" != *Gms* && "$listing" != *Google* ]] || fail "the listed packages are still in the image"
[[ "$(debugfs -R 'cat /build.prop' "$work/disk.img" 2>/dev/null)" == "ro.build.version.release=9" ]] \
    || fail "build.prop is not at the root of the published disk"
# Nothing of the removed files may be left in the free space either.
python3 -I - "$work/disk.img" "$work/sys/priv-app/PrebuiltGmsCore/PrebuiltGmsCore.apk" <<'PY' || fail "removed data is still on the disk"
import sys
disk = open(sys.argv[1], "rb").read()
apk = open(sys.argv[2], "rb").read()
sys.exit(1 if any(apk[i:i + 4096] in disk for i in range(0, len(apk) - 4096, 65536)) else 0)
PY
pass "published disk is a compressed qcow2 of the slimmed ext4 image"

# The ISO's own squashfs can still be published as it is.
PORTY_DISK_FORMAT=sfs "$repo/scripts/prepare-image.sh" "$work/fake.iso" "$work/image-sfs" 65536 > "$work/prepare-sfs.log"
sfs_dir="$(grep -o '"dir": "[^"]*' "$work/image-sfs/manifest.json" | cut -d'"' -f4)"
cat "$work/image-sfs/$sfs_dir"/*.bin | cmp -s - "$work/iso/system.sfs" || fail "sfs chunks differ from system.sfs"
node "$repo/tests/print-qemu-args.mjs" "$work/image-sfs/manifest.json" /img /pc-bios > "$work/argv-sfs.txt"
grep -q -- 'format=raw,read-only=on,file.driver=porty' "$work/argv-sfs.txt" || fail "sfs manifest does not give a raw drive"
pass "PORTY_DISK_FORMAT=sfs publishes system.sfs unmodified"

# A list that names something Android cannot boot without is refused.
echo "/priv-app/SystemUI" > "$work/bad.list"
if PORTY_SLIM_LIST="$work/bad.list" "$repo/scripts/prepare-image.sh" "$work/fake.iso" "$work/image-prot" 65536 >/dev/null 2>&1; then
    fail "prepare-image.sh removed a protected package"
fi
pass "prepare-image.sh refuses to remove a protected package"

# --- negative cases: the pipeline must refuse broken input --------------------
printf 'not a kernel' > "$work/iso/kernel"
xorriso -as mkisofs -quiet -V SMOKE -J -r -o "$work/bad.iso" "$work/iso" 2>/dev/null
if "$repo/scripts/prepare-image.sh" "$work/bad.iso" "$work/image-bad" 65536 >/dev/null 2>&1; then
    fail "prepare-image.sh accepted an ISO without a bzImage kernel"
fi
pass "prepare-image.sh rejects a bad kernel"
if "$repo/scripts/prepare-image.sh" "$work/fake.iso" "$work/image-odd" 100000 >/dev/null 2>&1; then
    fail "prepare-image.sh accepted a chunk size that is not a power of two"
fi
pass "prepare-image.sh rejects a non power-of-two chunk size"

# --- a fake QEMU build output ---------------------------------------------------
# shellcheck source-path=SCRIPTDIR source=../build/versions.env
source "$repo/build/versions.env"
python3 -I - "$work/qemu/qemu-system-x86_64.wasm" "$WASM_MEMORY_MB" <<'PY'
import sys
def leb(n):
    out = []
    while True:
        b = n & 0x7F
        n >>= 7
        out.append(b | (0x80 if n else 0))
        if not n:
            return out
name = lambda t: leb(len(t)) + list(t.encode())
section = lambda i, body: [i] + leb(len(body)) + body
pages = int(sys.argv[2]) * 16
module = [0, 0x61, 0x73, 0x6D, 1, 0, 0, 0] + section(
    2, [1] + name("env") + name("memory") + [2, 3] + leb(pages) + leb(pages))
open(sys.argv[1], "wb").write(bytes(module))
PY
echo "export default async function () { return {}; }" > "$work/qemu/out.js"
echo "// worker stub" > "$work/qemu/qemu-system-x86_64.worker.js"
while read -r rom; do
    [[ -n "$rom" ]] && echo "$rom" > "$work/qemu/pc-bios/$rom"
done < "$repo/build/pc-bios.list"
python3 "$repo/scripts/wasm-info.py" "$work/qemu/qemu-system-x86_64.wasm" \
    --json "$work/qemu/build-info.json" --expect-memory-mb "$WASM_MEMORY_MB" > /dev/null
pass "wasm-info.py reads the memory import"

"$repo/scripts/assemble-site.sh" --qemu "$work/qemu" --image "$work/image" \
    --out "$work/dist" --id smoke-test > "$work/assemble.log"
pass "assemble-site.sh produced a site"

# --- structure -----------------------------------------------------------------------
for f in index.html coi-serviceworker.js css/style.css js/main.js js/emulator.js \
         vendor/xterm.js vendor/xterm.css vendor/xterm-pty.js \
         vendor/licenses/xterm.txt vendor/licenses/xterm-pty.txt vendor/licenses/coi-serviceworker.txt \
         LICENSE.txt NOTICE.txt build.json _headers \
         qemu/out.js qemu/qemu-system-x86_64.wasm qemu/qemu-system-x86_64.worker.js qemu/build-info.json \
         image/manifest.json image/kernel image/initrd.img image/ramdisk.img "image/$disk_dir/000000.bin"; do
    [[ -s "$work/dist/$f" ]] || fail "site is missing $f"
done
pass "site has every file the page loads"

# Every local file index.html and the JS modules refer to must exist.
node - "$work/dist" <<'JS'
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const refs = [...html.matchAll(/(?:src|href)="([^"#?]+)"/g)].map((m) => m[1])
    .filter((r) => !/^[a-z]+:/i.test(r));
for (const file of fs.readdirSync(path.join(root, 'js'))) {
    const text = fs.readFileSync(path.join(root, 'js', file), 'utf8');
    for (const m of text.matchAll(/from '(\.\/[^']+)'/g)) {
        refs.push(path.posix.join('js', m[1]));
    }
}
const missing = refs.filter((r) => !fs.existsSync(path.join(root, r)));
if (missing.length) {
    console.error('FAIL  missing files referenced by the page: ' + missing.join(', '));
    process.exit(1);
}
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const main = fs.readFileSync(path.join(root, 'js', 'main.js'), 'utf8');
const wanted = [...main.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]);
const absent = [...new Set(wanted)].filter((id) => !ids.has(id));
if (absent.length) {
    console.error('FAIL  main.js uses element ids missing from index.html: ' + absent.join(', '));
    process.exit(1);
}
console.log(`PASS  ${refs.length} local references and ${new Set(wanted).size} element ids resolve`);
JS

# The page's own code must be able to turn this manifest into a QEMU argv.
node "$repo/tests/print-qemu-args.mjs" "$work/dist/image/manifest.json" /img /pc-bios '?mem=1024' > "$work/argv.txt"
grep -q -- 'root=/dev/ram0 androidboot.selinux=permissive buildvariant=userdebug console=ttyS0 androidboot.console=ttyS0 RAMDISK=vdb' "$work/argv.txt" \
    || fail "kernel command line was not derived from isolinux.cfg"
grep -q -- "if=virtio,index=0,media=disk,format=qcow2,read-only=on,file.driver=porty,file.url=/img/$disk_dir," "$work/argv.txt" \
    || fail "no read-only qcow2 drive over porty in argv"
pass "manifest -> QEMU argv"

# Size limits are enforced.
if "$repo/scripts/assemble-site.sh" --qemu "$work/qemu" --image "$work/image" \
       --out "$work/dist" --id smoke-test >/dev/null 2>&1; then
    fail "assemble-site.sh overwrote a non-empty output directory"
fi
pass "assemble-site.sh refuses a non-empty output directory"
echo "site-smoke: all checks passed"
