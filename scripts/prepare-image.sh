#!/usr/bin/env bash
# Turn the Android-x86 ISO into what the browser needs:
#
#   <out>/kernel, <out>/initrd.img, <out>/ramdisk.img   (fetched whole)
#   <out>/system-<hash>/000000.bin ...                   (the system disk in
#                                                         chunks, fetched
#                                                         lazily)
#   <out>/manifest.json                                  (sizes, hashes and the
#                                                         ISO's own kernel
#                                                         command line)
#
# The system disk (PORTY_DISK_FORMAT):
#
#   qcow2 (default)  The ISO's system.sfs is a squashfs that holds one file,
#       system.img (ext4).  That image is taken out, the paths in
#       build/slim-remove.list are removed from it (scripts/slim-system.py)
#       and it is published as a compressed qcow2.  QEMU inflates it, at
#       WebAssembly speed, and the guest sees a plain ext4 disk; with the
#       squashfs the emulated CPU inflated every block and the guest cached
#       the same data in two filesystems and a loop device.
#   sfs              system.sfs as it is in the ISO, bit for bit.
#
# Either way the chunks concatenate back to the published file (checked
# below) and manifest.json records its hash.  No root and no loop mounts
# are needed.
#
# usage: scripts/prepare-image.sh <iso> <out-dir> [chunk-bytes]
#   PORTY_DISK_FORMAT    qcow2 (default) or sfs
#   PORTY_QCOW2_CLUSTER  qcow2 cluster size in bytes (default:
#                        QCOW2_CLUSTER_BYTES in build/versions.env)
#   PORTY_SLIM_LIST      paths to remove (default: build/slim-remove.list)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR source=../build/versions.env
source "$here/../build/versions.env"

iso="${1:?usage: prepare-image.sh <iso> <out-dir> [chunk-bytes]}"
out="${2:?usage: prepare-image.sh <iso> <out-dir> [chunk-bytes]}"
chunk="${3:-$DISK_CHUNK_BYTES}"
format="${PORTY_DISK_FORMAT:-qcow2}"
cluster="${PORTY_QCOW2_CLUSTER:-$QCOW2_CLUSTER_BYTES}"
slim_list="${PORTY_SLIM_LIST:-$here/../build/slim-remove.list}"

die() { echo "::error::prepare-image: $*" >&2; exit 1; }

tools=(xorriso split sha256sum sha1sum python3 od)
case "$format" in
    qcow2) tools+=(unsquashfs debugfs dumpe2fs e2fsck qemu-img gzip cpio) ;;
    sfs) ;;
    *) die "PORTY_DISK_FORMAT must be qcow2 or sfs, not '$format'" ;;
esac
# e2fsprogs lives in /usr/sbin, which is not on every user's PATH.
PATH="$PATH:/usr/sbin:/sbin"
for tool in "${tools[@]}"; do
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

extract /kernel "$out/kernel"
extract /initrd.img "$out/initrd.img"
extract /ramdisk.img "$out/ramdisk.img"
extract /system.sfs "$work/system.sfs"
extract /isolinux/isolinux.cfg "$work/isolinux.cfg"

# --- sanity checks on what we extracted -----------------------------------
magic_at() { od -A n -t x1 -j "$2" -N "$3" "$1" | tr -d ' \n'; }
u16_at() { od -A n -t u2 -j "$2" -N 2 "$1" | tr -d ' \n'; }
u32_at() { od -A n -t u4 -j "$2" -N 4 "$1" | tr -d ' \n'; }
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

# --- the system disk ---------------------------------------------------------
sfs_size="$(stat -c %s "$work/system.sfs")"
# squashfs superblock: block size at byte 12, compression id at byte 20,
# version at bytes 28 and 30.
sfs_comp="$(u16_at "$work/system.sfs" 20)"
case "$sfs_comp" in
    1) sfs_comp=gzip ;; 2) sfs_comp=lzma ;; 3) sfs_comp=lzo ;;
    4) sfs_comp=xz ;; 5) sfs_comp=lz4 ;; 6) sfs_comp=zstd ;;
    *) sfs_comp="unknown-$sfs_comp" ;;
esac
echo "system.sfs: $sfs_size bytes, squashfs $(u16_at "$work/system.sfs" 28).$(u16_at "$work/system.sfs" 30)," \
     "compression $sfs_comp, block size $(u32_at "$work/system.sfs" 12)"

slim_report="$work/slim.json"
echo '{}' > "$slim_report"
virtual_size=0
content_sha=""
if [[ "$format" == qcow2 ]]; then
    (( cluster >= 4096 && cluster <= 2097152 && (cluster & (cluster - 1)) == 0 )) \
        || die "qcow2 cluster size $cluster is not a power of two between 4 KiB and 2 MiB"
    [[ -f "$slim_list" ]] || die "no such file: $slim_list"

    # The initrd must take a bare system filesystem on the disk.  Its
    # check_root() mounts each block device read-only on /mnt and accepts,
    # besides system.sfs, system.img and a system/ directory, a filesystem
    # with build.prop at its root ("mount --bind /mnt system"); that is how
    # Android-x86's own qemu-android script boots a system.img on vda.
    gzip -dc "$out/initrd.img" 2>/dev/null \
        | cpio -i --quiet --to-stdout init ./init > "$work/initrd-init" 2>/dev/null || true
    if ! grep -q -E -- '-[es] /mnt/build\.prop' "$work/initrd-init"; then
        echo "initrd.img holds: $(gzip -dc "$out/initrd.img" 2>/dev/null | cpio -t --quiet 2>/dev/null | head -40 | tr '\n' ' ')"
        echo "its init ($(wc -c < "$work/initrd-init") bytes), check_root:"
        sed -n '/^check_root/,/^}/p' "$work/initrd-init" | sed 's/^/    /'
    fi
    grep -q -E -- '-[es] /mnt/build\.prop' "$work/initrd-init" \
        || die "the initrd's init does not accept a filesystem with build.prop at its root (PORTY_DISK_FORMAT=sfs still works)"
    echo "initrd init, where it looks for the system image:"
    grep -n -E 'try_mount ro|system\.sfs|system\.img|-d /mnt/|build\.prop|mount --bind /mnt|RAMDISK' \
        "$work/initrd-init" | sed 's/^/    /'

    echo "system.sfs holds:"
    unsquashfs -ll "$work/system.sfs" | sed 's/^/    /'
    unsquashfs -no-progress -no-xattrs -d "$work/sfs" "$work/system.sfs" system.img >/dev/null \
        || die "cannot extract system.img from system.sfs"
    img="$work/sfs/system.img"
    [[ -f "$img" && ! -L "$img" ]] \
        || die "system.sfs does not hold a system.img (PORTY_DISK_FORMAT=sfs still works)"
    rm -f "$work/system.sfs"
    chmod u+rw "$img"
    [[ "$(magic_at "$img" 1080 2)" == "53ef" ]] || die "system.img is not an ext2/3/4 filesystem"
    echo "system.img: $(stat -c %s "$img") bytes"
    dumpe2fs -h "$img" 2>/dev/null \
        | grep -E '^(Filesystem (features|state|OS type|volume name|revision)|Last mounted on|Block (count|size)|Free blocks|Inode (count|size)|Free inodes|Journal|Default mount options)' \
        | sed 's/^/    /'

    python3 -I "$here/slim-system.py" "$img" "$slim_list" "$slim_report"

    virtual_size="$(stat -c %s "$img")"
    content_sha="$(sha256sum "$img" | cut -d' ' -f1)"
    disk_file="$work/system.qcow2"
    # QEMU inflates a compressed cluster whole for every read that touches it
    # and keeps no cache of inflated clusters, so the cluster size trades
    # download size against work per read (QCOW2_CLUSTER_BYTES).
    qemu-img convert -f raw -O qcow2 -c -o "cluster_size=$cluster" "$img" "$disk_file"
    qemu-img check -q "$disk_file" || die "qemu-img check found errors in the qcow2 image"
    qemu-img compare -q -f raw -F qcow2 "$img" "$disk_file" \
        || die "the qcow2 image does not read back as the system image"
    qemu-img info --output=json "$disk_file" > "$work/qcow2.json"
    python3 -I - "$work/qcow2.json" "$virtual_size" "$cluster" <<'PY' || die "unexpected qcow2 image properties"
import json, sys
with open(sys.argv[1], encoding="utf-8") as f:
    info = json.load(f)
data = info.get("format-specific", {}).get("data", {})
problems = []
if info.get("format") != "qcow2":
    problems.append("format")
if info.get("virtual-size") != int(sys.argv[2]):
    problems.append("virtual size")
if info.get("cluster-size") != int(sys.argv[3]):
    problems.append("cluster size")
# The browser build of QEMU has zlib and no zstd, and it opens the image
# read-only over a driver that cannot write: nothing may need a repair, a
# second file or a key.
if data.get("compression-type", "zlib") != "zlib":
    problems.append("compression type")
if info.get("backing-filename") or info.get("encrypted") or data.get("data-file"):
    problems.append("backing file, data file or encryption")
if info.get("dirty-flag") or data.get("corrupt") or data.get("lazy-refcounts"):
    problems.append("dirty or lazy refcounts")
print("qcow2:", json.dumps({k: info.get(k) for k in ("virtual-size", "actual-size", "cluster-size")}),
      json.dumps(data))
if problems:
    sys.exit("qcow2 image: unexpected " + ", ".join(problems))
PY
    # TEMPORARY (first branch check only): what other cluster sizes would cost.
    for other in ${PORTY_QCOW2_SURVEY:-}; do
        qemu-img convert -f raw -O qcow2 -c -o "cluster_size=$other" "$img" "$work/survey.qcow2"
        echo "survey: cluster size $other -> $(stat -c %s "$work/survey.qcow2") bytes"
        rm -f "$work/survey.qcow2"
    done
    rm -rf "$work/sfs"
    echo "system disk: ext4 of $virtual_size bytes as a compressed qcow2 of $(stat -c %s "$disk_file") bytes" \
         "(cluster size $cluster); system.sfs was $sfs_size bytes"
else
    disk_file="$work/system.sfs"
fi

# --- chunk it ----------------------------------------------------------------
mkdir "$out/system"
split --bytes="$chunk" --numeric-suffixes=0 --suffix-length=6 \
      --additional-suffix=.bin "$disk_file" "$out/system/"
disk_size="$(stat -c %s "$disk_file")"
disk_sha="$(sha256sum "$disk_file" | cut -d' ' -f1)"
chunks="$(find "$out/system" -name '*.bin' | wc -l)"
expected=$(( (disk_size + chunk - 1) / chunk ))
(( chunks == expected )) || die "expected $expected chunks, found $chunks"
joined_sha="$(find "$out/system" -name '*.bin' -print0 | sort -z | xargs -0 cat | sha256sum | cut -d' ' -f1)"
[[ "$joined_sha" == "$disk_sha" ]] || die "chunks do not concatenate back to the system disk"
# The directory name carries the hash, so a chunk URL never names different
# bytes in two deployments, whatever a browser or a CDN has cached.
disk_dir="system-${disk_sha:0:16}"
mv "$out/system" "$out/$disk_dir"

# --- manifest ----------------------------------------------------------------
PORTY_CMDLINE="$cmdline" PORTY_DISK_SHA="$disk_sha" PORTY_ISO_NAME="$(basename "$iso")" \
PORTY_ISO_SHA1="$(sha1sum "$iso" | cut -d' ' -f1)" \
PORTY_DISK_FORMAT="$format" PORTY_DISK_DIR="$disk_dir" PORTY_VIRTUAL_SIZE="$virtual_size" \
PORTY_CONTENT_SHA="$content_sha" PORTY_CLUSTER="$cluster" PORTY_SLIM_REPORT="$slim_report" \
PORTY_SFS_SIZE="$sfs_size" PORTY_SFS_COMP="$sfs_comp" \
python3 -I - "$out" "$chunk" "$disk_size" "$chunks" "$(stat -c %s "$iso")" <<'PY'
import hashlib, json, os, sys

out, chunk, disk_size, chunks, iso_size = sys.argv[1], *map(int, sys.argv[2:6])
env = os.environ

def entry(name):
    path = os.path.join(out, name)
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return {"file": name, "size": os.path.getsize(path), "sha256": digest.hexdigest()}

# "format" 2 added disk.format: what QEMU opens on top of the chunks.
#   raw    the ISO's system.sfs, unmodified (all there was in format 1)
#   qcow2  a compressed qcow2 whose contents are the slimmed ext4 system image
# size and sha256 always describe the published file, the one the chunks
# concatenate to.
disk = {
    "dir": env["PORTY_DISK_DIR"],
    "format": "raw",
    "content": "squashfs",
    "size": disk_size,
    "chunk_size": chunk,
    "chunks": chunks,
    "sha256": env["PORTY_DISK_SHA"],
}
if env["PORTY_DISK_FORMAT"] == "qcow2":
    with open(env["PORTY_SLIM_REPORT"], encoding="utf-8") as f:
        slim = json.load(f)
    disk.update({
        "format": "qcow2",
        "content": "ext4",
        "virtual_size": int(env["PORTY_VIRTUAL_SIZE"]),
        "cluster_size": int(env["PORTY_CLUSTER"]),
        "content_sha256": env["PORTY_CONTENT_SHA"],
        "removed": slim.get("removed", []),
        "removed_bytes": slim.get("removed_bytes", 0),
    })

manifest = {
    "format": 2,
    "source": {
        "iso": env["PORTY_ISO_NAME"],
        "iso_size": iso_size,
        "iso_sha1": env["PORTY_ISO_SHA1"],
        "system_sfs_size": int(env["PORTY_SFS_SIZE"]),
        "system_sfs_compression": env["PORTY_SFS_COMP"],
    },
    "kernel": entry("kernel"),
    "initrd": entry("initrd.img"),
    "ramdisk": entry("ramdisk.img"),
    "disk": disk,
    "cmdline": env["PORTY_CMDLINE"],
}
with open(os.path.join(out, "manifest.json"), "w", encoding="utf-8") as f:
    json.dump(manifest, f, indent=2)
    f.write("\n")
print(json.dumps(manifest, indent=2))
PY

echo "prepared $out: system disk ($format) $disk_size bytes in $chunks chunks of $chunk bytes"
