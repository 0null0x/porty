#!/usr/bin/env bash
# Turn the Android-x86 ISO into what the browser needs:
#
#   <out>/kernel, <out>/initrd.img, <out>/ramdisk.img   (fetched whole)
#   <out>/system/000000.bin ...                          (system.sfs in chunks,
#                                                         fetched lazily)
#   <out>/manifest.json                                  (sizes, hashes and the
#                                                         ISO's own kernel
#                                                         command line)
#
# Nothing is modified: the chunks concatenate back to the ISO's system.sfs
# bit for bit (checked below).  No root and no loop mounts are needed.
#
# usage: scripts/prepare-image.sh <iso> <out-dir> [chunk-bytes]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR source=../build/versions.env
source "$here/../build/versions.env"

iso="${1:?usage: prepare-image.sh <iso> <out-dir> [chunk-bytes]}"
out="${2:?usage: prepare-image.sh <iso> <out-dir> [chunk-bytes]}"
chunk="${3:-$DISK_CHUNK_BYTES}"

die() { echo "::error::prepare-image: $*" >&2; exit 1; }

for tool in xorriso split sha256sum sha1sum python3 od; do
    command -v "$tool" >/dev/null || die "missing tool: $tool"
done
[[ -f "$iso" ]] || die "no such file: $iso"
(( chunk >= 65536 && (chunk & (chunk - 1)) == 0 )) \
    || die "chunk size $chunk is not a power of two >= 64 KiB"

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

extract() { # <path in iso> <destination>
    xorriso -osirrox on -indev "$iso" -extract "$1" "$2" >/dev/null 2>"$work/xorriso.log" \
        || { cat "$work/xorriso.log" >&2; die "cannot extract $1 from $iso"; }
    chmod u+rw "$2"
    [[ -s "$2" ]] || die "$1 is empty in $iso"
}

mkdir -p "$out"
[[ -z "$(ls -A "$out")" ]] || die "output directory $out is not empty"
mkdir "$out/system"

extract /kernel "$out/kernel"
extract /initrd.img "$out/initrd.img"
extract /ramdisk.img "$out/ramdisk.img"
extract /system.sfs "$work/system.sfs"
extract /isolinux/isolinux.cfg "$work/isolinux.cfg"

# --- sanity checks on what we extracted -----------------------------------
magic_at() { od -A n -t x1 -j "$2" -N "$3" "$1" | tr -d ' \n'; }
[[ "$(magic_at "$out/kernel" 514 4)" == "48647253" ]] \
    || die "kernel is not a Linux bzImage (no HdrS signature)"
[[ "$(magic_at "$work/system.sfs" 0 4)" == "68737173" ]] \
    || die "system.sfs is not a squashfs image"
[[ "$(magic_at "$out/initrd.img" 0 2)" == "1f8b" ]] \
    || die "initrd.img is not gzip compressed"
[[ "$(magic_at "$out/ramdisk.img" 0 2)" == "1f8b" ]] \
    || die "ramdisk.img is not gzip compressed"

# --- the ISO's own kernel command line -------------------------------------
# isolinux.cfg, first "append" line (the "Live CD" entry):
#   append initrd=/initrd.img root=/dev/ram0 ... quiet SRC= DATA=
# Keep only the distribution's base arguments; Porty adds its own.
cmdline="$(python3 -I - "$work/isolinux.cfg" <<'PY'
import sys
drop = ("initrd=", "SRC=", "DATA=")
for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
    words = line.split()
    if words and words[0].lower() == "append":
        keep = [w for w in words[1:] if not w.startswith(drop) and w != "quiet"]
        print(" ".join(keep))
        break
PY
)"
[[ "$cmdline" == *root=/dev/ram0* ]] \
    || die "unexpected live command line in isolinux.cfg: '$cmdline'"
case "$cmdline" in
    *[!A-Za-z0-9_=/.,:\ -]*) die "command line has unexpected characters: '$cmdline'" ;;
esac

# --- chunk system.sfs -------------------------------------------------------
split --bytes="$chunk" --numeric-suffixes=0 --suffix-length=6 \
      --additional-suffix=.bin "$work/system.sfs" "$out/system/"
disk_size="$(stat -c %s "$work/system.sfs")"
disk_sha="$(sha256sum "$work/system.sfs" | cut -d' ' -f1)"
chunks="$(find "$out/system" -name '*.bin' | wc -l)"
expected=$(( (disk_size + chunk - 1) / chunk ))
(( chunks == expected )) || die "expected $expected chunks, found $chunks"
joined_sha="$(find "$out/system" -name '*.bin' -print0 | sort -z | xargs -0 cat | sha256sum | cut -d' ' -f1)"
[[ "$joined_sha" == "$disk_sha" ]] || die "chunks do not concatenate back to system.sfs"

# --- manifest ----------------------------------------------------------------
PORTY_CMDLINE="$cmdline" PORTY_DISK_SHA="$disk_sha" PORTY_ISO_NAME="$(basename "$iso")" \
PORTY_ISO_SHA1="$(sha1sum "$iso" | cut -d' ' -f1)" \
python3 -I - "$out" "$chunk" "$disk_size" "$chunks" "$(stat -c %s "$iso")" <<'PY'
import hashlib, json, os, sys

out, chunk, disk_size, chunks, iso_size = sys.argv[1], *map(int, sys.argv[2:6])

def entry(name):
    path = os.path.join(out, name)
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return {"file": name, "size": os.path.getsize(path), "sha256": digest.hexdigest()}

manifest = {
    "format": 1,
    "source": {
        "iso": os.environ["PORTY_ISO_NAME"],
        "iso_size": iso_size,
        "iso_sha1": os.environ["PORTY_ISO_SHA1"],
    },
    "kernel": entry("kernel"),
    "initrd": entry("initrd.img"),
    "ramdisk": entry("ramdisk.img"),
    "disk": {
        "dir": "system",
        "size": disk_size,
        "chunk_size": chunk,
        "chunks": chunks,
        "sha256": os.environ["PORTY_DISK_SHA"],
    },
    "cmdline": os.environ["PORTY_CMDLINE"],
}
with open(os.path.join(out, "manifest.json"), "w", encoding="utf-8") as f:
    json.dump(manifest, f, indent=2)
    f.write("\n")
print(json.dumps(manifest, indent=2))
PY

echo "prepared $out: system.sfs $disk_size bytes in $chunks chunks of $chunk bytes"
