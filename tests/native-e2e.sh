#!/usr/bin/env bash
# End-to-end check of the QEMU patches with a *native* QEMU binary built
# from the patched QEMU-Wasm tree (no browser, no Emscripten):
#
#   1. builds a miniature ISO with the same layout as the Android-x86 ISO
#      (kernel, initrd.img, ramdisk.img, system.sfs, isolinux/isolinux.cfg),
#      using a stock Linux kernel and a busybox initrd as the "guest OS";
#   2. runs scripts/prepare-image.sh on it (the real image pipeline: the
#      ext4 system.img inside system.sfs is slimmed and published as a
#      compressed qcow2; DISK_FORMAT=sfs publishes the squashfs instead);
#   3. boots it with the argv produced by web/js/qemu-args.js;
#   4. checks, from the guest's serial output and from a framebuffer dump:
#        - block/qcow2.c on top of block/porty.c returns bit-exact data
#          (whole-device and file hashes, with several readers in
#          parallel), and the guest finds build.prop at the root of the
#          disk, as Android-x86's initrd requires, and not the removed file,
#        - ramdisk.img is readable from the second drive,
#        - ui/wasmfb.c publishes the guest framebuffer at the requested
#          resolution and sees guest drawing,
#        - input pushed into the ring reaches the guest as USB tablet and
#          keyboard events,
#        - the kernel unpacks the boot-diet archive the page appends to
#          initrd.img, and the script in it edits default.prop when sourced
#          the way Android-x86's /init sources /scripts/*.
#
# usage: tests/native-e2e.sh <qemu-system-x86_64> <pc-bios-dir> <vmlinuz> <modules-dir> <work-dir> [virtio|ide]
#   <modules-dir> is lib/modules/<version> of the same kernel (uncompressed
#   .ko or .ko.zst).
set -euo pipefail

qemu="${1:?qemu binary}"; bios="${2:?pc-bios dir}"; vmlinuz="${3:?vmlinuz}"
moddir="${4:?modules dir}"; work="${5:?work dir}"; bus="${6:-virtio}"
case "$bus" in
    virtio) sys=vda; rd=vdb ;;
    ide)    sys=sr0; rd=sr1 ;;
    *) echo "bus must be virtio or ide" >&2; exit 2 ;;
esac
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
busybox="$(command -v busybox)"
# EXTRA_QUERY adds URL parameters; W/H are the framebuffer size to expect.
# e.g. EXTRA_QUERY='&gfx=vesa' W=800 H=600 SKIP_PAINT=1 exercises the VBE
# ("vga=") path.  SKIP_PAINT=1 drops the drawing check: with a firmware
# framebuffer the test kernel's simpledrm does not flush writes to /dev/fb0
# into video memory (confirmed by dumping guest VRAM), so there is nothing
# for any display backend to show.
extra_query="${EXTRA_QUERY:-}"
W="${W:-480}"; H="${H:-800}"
REQ_W=480; REQ_H=800

disk_format="${DISK_FORMAT:-qcow2}"
PATH="$PATH:/usr/sbin:/sbin"   # e2fsprogs
for tool in xorriso mksquashfs mke2fs cpio gzip zstd node md5sum sha256sum; do
    command -v "$tool" >/dev/null || { echo "missing $tool" >&2; exit 2; }
done
mkdir -p "$work"
[[ -z "$(ls -A "$work")" ]] || { echo "$work must be empty" >&2; exit 2; }
mkdir -p "$work"/{iso/isolinux,sfs,sys/app/Gone,initrd/{bin,proc,sys,dev,mnt,lib/modules},ramdisk}

# --- guest modules: resolve dependencies on the host, insmod in order ------
want="bochs usbhid hid-generic"
: > "$work/initrd/lib/modules/order"
resolve() { # prints module paths, dependencies first
    local name="$1" line path dep
    line="$(grep -E "/${name//-/[-_]}\.ko(\.zst)?:" "$moddir/modules.dep" | head -1)" || true
    [[ -n "$line" ]] || return 0   # built in
    path="${line%%:*}"
    for dep in ${line#*:}; do
        resolve "$(basename "${dep%%.ko*}")"
    done
    echo "$path"
}
for m in $want; do resolve "$m"; done | awk '!seen[$0]++' | while read -r path; do
    base="$(basename "${path%.zst}")"
    if [[ "$path" == *.zst ]]; then
        zstd -q -d -f "$moddir/$path" -o "$work/initrd/lib/modules/$base"
    else
        cp "$moddir/$path" "$work/initrd/lib/modules/$base"
    fi
    echo "$base" >> "$work/initrd/lib/modules/order"
done

# --- "system.sfs": a squashfs holding system.img, as in the Android-x86 ISO.
# system.img is ext4 with build.prop at its root, a blob spanning many
# chunks (random, so stored uncompressed in the qcow2), a compressible file
# (stored as compressed clusters) and a file the slim list removes.
head -c $((23 * 1024 * 1024 + 4321)) /dev/urandom > "$work/sys/blob.bin"
head -c $((5 * 1024 * 1024 + 123)) /dev/zero | tr '\0' 'p' > "$work/sys/text.bin"
head -c 300000 /dev/urandom > "$work/sys/app/Gone/Gone.apk"
echo "porty-test-system" > "$work/sys/build.prop"
mke2fs -q -t ext4 -O ^has_journal -d "$work/sys" "$work/sfs/system.img" 48M >/dev/null
mksquashfs "$work/sfs" "$work/iso/system.sfs" -noappend -comp gzip -quiet >/dev/null
echo "/app/Gone" > "$work/slim.list"
blob_md5="$(md5sum "$work/sys/blob.bin" | cut -d' ' -f1)"
text_md5="$(md5sum "$work/sys/text.bin" | cut -d' ' -f1)"

# --- "ramdisk.img": gzip cpio with a marker ---------------------------------
echo "porty-ramdisk-marker" > "$work/ramdisk/marker.txt"
( cd "$work/ramdisk" && echo marker.txt | cpio -o -H newc 2>/dev/null | gzip -9 ) > "$work/iso/ramdisk.img"

# --- "initrd.img": busybox + test script -------------------------------------
cp "$busybox" "$work/initrd/bin/busybox"
cat > "$work/initrd/init" <<INIT
#!/bin/busybox sh
/bin/busybox --install -s /bin
export PATH=/bin
mount -t proc proc /proc; mount -t sysfs sys /sys; mount -t devtmpfs dev /dev
say() { echo "PORTY-TEST: \$*"; }
for m in \$(cat /lib/modules/order); do insmod /lib/modules/\$m || say "insmod \$m failed"; done
sleep 2
say "cmdline \$(cat /proc/cmdline)"
say "fb \$(cat /proc/fb) size \$(cat /sys/class/graphics/fb0/virtual_size 2>/dev/null)"

# boot diet: Android-x86's /init, in the directory holding the unpacked ramdisk
mkdir /android; cd /android
printf 'ro.zygote=zygote64_32\npm.dexopt.first-boot=quicken\nro.debuggable=1\n' > default.prop
for s in \`ls /scripts/* /src/scripts/*\`; do
	test -e "\$s" && source \$s
done
say "diet \$(grep -v '^\$' default.prop | tr '\n' ' ')"
cd /

# block driver: whole device, twice in parallel with a file read.  The
# disk is what Android-x86's initrd would see: with the qcow2 image, a
# filesystem with build.prop at its root (its check_root() then does
# "[ -s /mnt/build.prop ] && mount --bind /mnt system"); with DISK_FORMAT=sfs
# a squashfs holding system.img.
size=\$(( \$(cat /sys/block/$sys/size) * 512 ))
mount -o ro,noatime /dev/$sys /mnt || say "mount failed"
say "disk-fs \$(grep " /mnt " /proc/mounts | cut -d' ' -f3,4 | cut -d, -f1)"
if [ -e /mnt/system.img ]; then
    mkdir /sysimg; mount -o loop,ro /mnt/system.img /sysimg; sysroot=/sysimg
else
    sysroot=/mnt
fi
[ -s \$sysroot/build.prop ] && say "build-prop \$(cat \$sysroot/build.prop)"
[ -e \$sysroot/app/Gone ] && say "removed-path still-there" || say "removed-path gone"
( head -c \$size /dev/$sys | sha256sum | cut -d' ' -f1 > /tmp-a ) &
( md5sum \$sysroot/blob.bin | cut -d' ' -f1 > /tmp-b ) &
( dd if=/dev/$sys bs=1M skip=3 count=9 2>/dev/null | md5sum | cut -d' ' -f1 > /tmp-c ) &
( md5sum \$sysroot/text.bin | cut -d' ' -f1 > /tmp-d ) &
wait
say "disk-sha256 \$(cat /tmp-a)"
say "blob-md5 \$(cat /tmp-b)"
say "text-md5 \$(cat /tmp-d)"
say "disk-sha256-again \$(head -c \$size /dev/$sys | sha256sum | cut -d' ' -f1)"
say "disk-sectors \$(cat /sys/block/$sys/size)"
say "ramdisk \$(zcat /dev/$rd 2>/dev/null | cpio -t 2>/dev/null | head -1)"

# framebuffer: paint the first 100 rows white
head -c \$(( $W * 4 * 100 )) /dev/zero | tr '\\0' '\\377' > /dev/fb0
say "painted"

# input: count events for 25 s
tablet=""; kbd=""
for d in /sys/class/input/event*; do
    n="\$(cat \$d/device/name)"
    case "\$n" in
        *"USB Tablet"*) tablet=/dev/input/\$(basename \$d) ;;
        *"AT Translated"*) kbd=/dev/input/\$(basename \$d) ;;
    esac
done
say "input-devices tablet=\$tablet kbd=\$kbd"
( timeout 25 cat \$tablet > /ev-tablet 2>/dev/null ) &
( timeout 25 cat \$kbd > /ev-kbd 2>/dev/null ) &
say "listening"
wait
say "tablet-bytes \$(wc -c < /ev-tablet)"
say "kbd-bytes \$(wc -c < /ev-kbd)"
say "kbd-hex \$(hexdump -v -e '24/1 "%02x" "\\n"' /ev-kbd | cut -c33-44 | tr '\\n' ' ')"
say "done"
sync
poweroff -f
INIT
chmod +x "$work/initrd/init"
mkdir -p "$work/initrd/tmp"
( cd "$work/initrd" && find . | cpio -o -H newc 2>/dev/null | gzip -1 ) > "$work/iso/initrd.img"

cp "$vmlinuz" "$work/iso/kernel"
cat > "$work/iso/isolinux/isolinux.cfg" <<'CFG'
default vesamenu.c32
label livem
	menu label Live CD - ^Run test without installation
	kernel /kernel
	append initrd=/initrd.img root=/dev/ram0 androidboot.selinux=permissive buildvariant=userdebug quiet SRC= DATA=
CFG
xorriso -as mkisofs -quiet -V PORTYTEST -J -r -o "$work/test.iso" "$work/iso" 2>/dev/null

# --- the real pipeline ---------------------------------------------------------
PORTY_DISK_FORMAT="$disk_format" PORTY_SLIM_LIST="$work/slim.list" \
    "$repo/scripts/prepare-image.sh" "$work/test.iso" "$work/image" 1048576 > "$work/prepare.log"
# What the guest must see on the disk, from the manifest: the ext4 image
# inside the qcow2, or the squashfs itself.
read -r disk_sha disk_bytes disk_fs gone < <(python3 -I - "$work/image/manifest.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))["disk"]
if d["format"] == "qcow2":
    print(d["content_sha256"], d["virtual_size"], "ext4", "gone")
else:
    print(d["sha256"], d["size"], "squashfs", "still-there")
PY
)

if [[ "$bus" == ide ]]; then
    # CD-ROM sectors are 2048 bytes; the page pads ramdisk.img the same way.
    truncate -s %2048 "$work/image/ramdisk.img"
fi

# Only the firmware files the site ships (build/pc-bios.list).
mkdir "$work/bios"
while read -r rom; do
    [[ -n "$rom" ]] && cp "$bios/$rom" "$work/bios/"
done < "$repo/build/pc-bios.list"

# --- boot with the page's own argv ---------------------------------------------
query="?mem=512&tb=64&smp=2&res=${REQ_W}x${REQ_H}&cache=4&parallel=3&disk=$bus&append=panic=-1${extra_query}"
# The page appends its boot-diet archive to initrd.img in memory; same code.
node "$repo/tests/apply-boot-diet.mjs" "$work/image/initrd.img" "$work/image/initrd.img" "$query" > "$work/diet.log"
mapfile -t args < <(node "$repo/tests/print-qemu-args.mjs" "$work/image/manifest.json" \
    "$work/image" "$work/bios" "$query")
# Pointer sweep, left click, then the keys A (30) and BACK (158), repeated
# so that at least one burst lands while the guest is listening.
script=""
for t in 20000 30000 40000 50000 60000 75000 90000; do
    script+="$t:1:1000:1000:0;$((t+50)):1:16000:20000:0;$((t+100)):2:0:1:0;$((t+150)):2:0:0:0;"
    script+="$((t+200)):3:30:1:0;$((t+250)):3:30:0:0;$((t+300)):3:158:1:0;$((t+350)):3:158:0:0;$((t+400)):4:1:0:0;"
done
echo "argv: ${args[*]}" > "$work/qemu.log"
set +e
PORTY_FB_DUMP="$work/fb" PORTY_INPUT_SCRIPT="$script" \
    timeout 300 "$qemu" "${args[@]}" -no-reboot < /dev/null >> "$work/qemu.log" 2>&1
rc=$?
set -e

# --- verdict ---------------------------------------------------------------------
fail=0
check() { # <description> <grep pattern>
    if grep -a -q -- "$2" "$work/qemu.log"; then echo "PASS  $1"; else echo "FAIL  $1"; fail=1; fi
}
echo "qemu exit status: $rc"
check "guest booted with the ISO's base command line" "PORTY-TEST: cmdline root=/dev/ram0 androidboot.selinux=permissive buildvariant=userdebug console=ttyS0 androidboot.console=ttyS0 RAMDISK=$rd"
check "framebuffer is ${W}x${H}"                    "PORTY-TEST: fb .* size ${W},${H}"
check "the disk holds a $disk_fs filesystem, mounted read-only" "PORTY-TEST: disk-fs $disk_fs ro"
check "build.prop is where the initrd looks for it"  "PORTY-TEST: build-prop porty-test-system"
check "the path on the slim list is $gone"           "PORTY-TEST: removed-path $gone"
check "whole-device hash matches (parallel readers)" "PORTY-TEST: disk-sha256 $disk_sha"
check "whole-device hash matches (cached re-read)"   "PORTY-TEST: disk-sha256-again $disk_sha"
check "random file on the disk matches"              "PORTY-TEST: blob-md5 $blob_md5"
check "compressible file on the disk matches"        "PORTY-TEST: text-md5 $text_md5"
check "device size is the image size"                "PORTY-TEST: disk-sectors $(( (disk_bytes + 511) / 512 ))"
check "ramdisk.img readable from second drive"       "PORTY-TEST: ramdisk marker.txt"
check "USB tablet received events"                   "PORTY-TEST: tablet-bytes [1-9]"
check "keyboard received events"                     "PORTY-TEST: kbd-bytes [1-9]"
check "KEY_BACK (158 = 0x9e) arrived"                "PORTY-TEST: kbd-hex .*01009e00"
check "kernel unpacked the appended boot-diet archive" "porty: boot diet, 3 properties in default.prop"
check "the module fix leaves a guest without ttm.ko alone" "porty: no ttm.ko, nothing to fix"
check "provisioning leaves a guest without init.rc alone" "porty: no init.rc, device not provisioned"
check "the script rewrote default.prop"              "PORTY-TEST: diet ro.zygote=zygote64_32 ro.debuggable=1 debug.sf.nobootanimation=1 pm.dexopt.first-boot=extract pm.dexopt.boot=extract"
check "guest finished"                               "PORTY-TEST: done"

if [[ -f "$work/fb.ppm" ]]; then
    # Row 50 must be white (painted by the guest), row 400 must not be.
    if python3 -I - "$work/fb.ppm" "$W" "$H" "${SKIP_PAINT:-0}" <<'PY'
import sys
path, want_w, want_h = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
data = open(path, "rb").read()
magic, dims, maxval, pixels = data.split(b"\n", 3)
w, h = map(int, dims.split())
ok = True
def report(good, text):
    global ok
    ok &= good
    print(("PASS  " if good else "FAIL  ") + text)
report((w, h) == (want_w, want_h), f"framebuffer dump is {w}x{h}")
row = lambda y: pixels[y * w * 3:(y + 1) * w * 3]
if len(sys.argv) > 4 and sys.argv[4] == "1":
    print("SKIP  guest drawing check (SKIP_PAINT=1)")
else:
    report(row(50) == b"\xff" * (w * 3), "guest drawing is visible in the dump (row 50 is white)")
    report(row(400) != b"\xff" * (w * 3), "row 400 is not white")
sys.exit(0 if ok else 1)
PY
    then :; else fail=1; fi
else
    echo "FAIL  no framebuffer dump"; fail=1
fi
grep -a "PORTY-TEST" "$work/qemu.log" | sed 's/^/    /'
exit "$fail"
