#!/usr/bin/env bash
# Fast dry run of the image and site pipeline on a miniature, fake ISO:
# scripts/prepare-image.sh -> scripts/assemble-site.sh, then structural
# checks on the result.  No QEMU and no Android image are needed, so this
# runs in the "checks" job before the expensive build starts.
#
# usage: tests/site-smoke.sh <empty-work-dir>
# needs: xorriso, mksquashfs, node, python3, and web/node_modules (npm ci).
set -euo pipefail

work="${1:?usage: site-smoke.sh <empty-work-dir>}"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$work"
[[ -z "$(ls -A "$work")" ]] || { echo "$work must be empty" >&2; exit 2; }
fail() { echo "FAIL  $*" >&2; exit 1; }
pass() { echo "PASS  $*"; }

# --- a fake ISO with the Android-x86 layout ---------------------------------
mkdir -p "$work"/{iso/isolinux,sfs,qemu/pc-bios}
head -c 300000 /dev/urandom > "$work/sfs/system.img"
mksquashfs "$work/sfs" "$work/iso/system.sfs" -noappend -noI -noD -noF -noX -quiet >/dev/null
# 514 bytes of padding, then the bzImage signature the real check looks for
{ head -c 514 /dev/zero; printf 'HdrS'; head -c 4096 /dev/urandom; } > "$work/iso/kernel"
echo initrd | gzip > "$work/iso/initrd.img"
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
         image/manifest.json image/kernel image/initrd.img image/ramdisk.img image/system/000000.bin; do
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
grep -q -- 'file.driver=porty' "$work/argv.txt" || fail "no porty drive in argv"
pass "manifest -> QEMU argv"

# Size limits are enforced.
if "$repo/scripts/assemble-site.sh" --qemu "$work/qemu" --image "$work/image" \
       --out "$work/dist" --id smoke-test >/dev/null 2>&1; then
    fail "assemble-site.sh overwrote a non-empty output directory"
fi
pass "assemble-site.sh refuses a non-empty output directory"
echo "site-smoke: all checks passed"
