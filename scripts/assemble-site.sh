#!/usr/bin/env bash
# Assemble the static site that GitHub Pages serves.
#
# usage: scripts/assemble-site.sh --qemu <dir> --image <dir> --out <dir> [--id <build-id>]
#                                 [--snapshot <dir>]
#   --qemu   output of build/build-qemu.sh (out.js, *.wasm, *.worker.js,
#            pc-bios/, build-info.json)
#   --image  output of scripts/prepare-image.sh
#   --out    destination (must not exist or be empty)
#   --snapshot  a saved, booted Android for the page to resume instead of
#            booting: manifest.json plus the zlib chunk files it lists (see
#            web/js/snapshot.js).  Every chunk is checked against the
#            manifest (size, SHA-256, inflated size); a damaged snapshot
#            fails the build.  A sound snapshot that was saved with another
#            QEMU-Wasm commit, other patches or another image is left out
#            with a warning, because the page would refuse it anyway.
#
# web/node_modules must exist (npm ci --ignore-scripts in web/).
# Fails if the site exceeds the GitHub Pages size limits in build/versions.env.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
# shellcheck source-path=SCRIPTDIR source=../build/versions.env
source "$repo/build/versions.env"

qemu="" image="" out="" id="" snapshot=""
while (( $# )); do
    case "$1" in
        --qemu)  qemu="$2"; shift 2 ;;
        --image) image="$2"; shift 2 ;;
        --out)   out="$2"; shift 2 ;;
        --id)    id="$2"; shift 2 ;;
        --snapshot) snapshot="$2"; shift 2 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done
die() { echo "::error::assemble-site: $*" >&2; exit 1; }
[[ -n "$qemu" && -n "$image" && -n "$out" ]] || die "--qemu, --image and --out are required"
id="${id:-$(git -C "$repo" rev-parse HEAD 2>/dev/null || date -u +%Y%m%d%H%M%S)}"
[[ "$id" =~ ^[A-Za-z0-9._-]+$ ]] || die "build id '$id' has unexpected characters"

for f in out.js qemu-system-x86_64.wasm qemu-system-x86_64.worker.js build-info.json; do
    [[ -s "$qemu/$f" ]] || die "missing $qemu/$f"
done
[[ -s "$image/manifest.json" ]] || die "missing $image/manifest.json"
# A qcow2 system disk needs QEMU's qcow2 driver in the WebAssembly build
# (block/qcow2.c is always built; the string is one of its error messages).
if grep -q '"format": "qcow2"' "$image/manifest.json" \
   && ! grep -a -q -F "Image is not in qcow2 format" "$qemu/qemu-system-x86_64.wasm"; then
    die "the system disk is a qcow2 image, but this QEMU build has no qcow2 driver"
fi
nm="$repo/web/node_modules"
for f in xterm/lib/xterm.js xterm/css/xterm.css xterm-pty/index.js; do
    [[ -s "$nm/$f" ]] || die "missing web/node_modules/$f (run: npm ci --ignore-scripts in web/)"
done

mkdir -p "$out"
[[ -z "$(ls -A "$out")" ]] || die "$out is not empty"

# --- page ------------------------------------------------------------------
cp "$repo/web/index.html" "$repo/web/coi-serviceworker.js" "$out/"
cp -r "$repo/web/css" "$repo/web/js" "$out/"
mkdir -p "$out/vendor/licenses"
cp "$nm/xterm/lib/xterm.js" "$out/vendor/xterm.js"
cp "$nm/xterm/css/xterm.css" "$out/vendor/xterm.css"
cp "$nm/xterm-pty/index.js" "$out/vendor/xterm-pty.js"
cp "$nm/xterm/LICENSE" "$out/vendor/licenses/xterm.txt"
cp "$nm/xterm-pty/LICENSE.txt" "$out/vendor/licenses/xterm-pty.txt"
cp "$repo/web/vendor/coi-serviceworker/LICENSE" "$out/vendor/licenses/coi-serviceworker.txt"
cp "$repo/LICENSE" "$out/LICENSE.txt"
cp "$repo/NOTICE" "$out/NOTICE.txt"

# --- emulator and image (hard links when possible: the image is ~1 GB) -------
link_tree() { cp -al "$1" "$2" 2>/dev/null || cp -r "$1" "$2"; }
link_tree "$qemu" "$out/qemu"
link_tree "$image" "$out/image"

# --- what a snapshot must have been saved with -------------------------------------
# The patches in name order, concatenated: the same definition the snapshot
# producer uses for "porty_patches_sha256".
patches_sha="$(cat "$repo"/patches/qemu-wasm/*.patch | sha256sum | cut -d' ' -f1)"
image_sha="$(sha256sum "$image/manifest.json" | cut -d' ' -f1)"

# --- snapshot (optional) --------------------------------------------------------------
has_snapshot=false
if [[ -n "$snapshot" ]]; then
    [[ -s "$snapshot/manifest.json" ]] || die "missing $snapshot/manifest.json"
    rc=0
    PORTY_QEMU_COMMIT="$QEMU_WASM_COMMIT" PORTY_PATCHES_SHA="$patches_sha" PORTY_IMAGE_SHA="$image_sha" \
    python3 -I - "$snapshot" "$out/snapshot" <<'PY' || rc=$?
import hashlib, json, os, re, shutil, sys, zlib

src, dst = sys.argv[1], sys.argv[2]

def broken(text):
    print(f"::error::assemble-site: snapshot: {text}", file=sys.stderr)
    sys.exit(1)

try:
    with open(os.path.join(src, "manifest.json"), encoding="utf-8") as f:
        m = json.load(f)
except (OSError, ValueError) as e:
    broken(f"cannot read manifest.json: {e}")
if not isinstance(m, dict) or m.get("format") != 1 or m.get("kind") != "qemu-migration":
    broken("manifest.json is not a format 1 qemu-migration snapshot")
if m.get("compression") != "zlib":
    broken(f"unknown compression {m.get('compression')!r}")
chunk_size, total, chunks = m.get("chunk_size"), m.get("uncompressed_size"), m.get("chunks")
if not (isinstance(chunk_size, int) and 4096 <= chunk_size <= 64 << 20):
    broken(f"bad chunk_size {chunk_size!r}")
if not (isinstance(total, int) and total > 0 and isinstance(chunks, list)):
    broken("bad uncompressed_size or chunks")
if len(chunks) != -(-total // chunk_size):
    broken(f"{len(chunks)} chunks cannot hold {total} bytes in chunks of {chunk_size}")
argv = m.get("argv")
if not (isinstance(argv, list) and argv and all(isinstance(a, str) for a in argv)) or "-incoming" in argv:
    broken("argv must be a list of QEMU arguments without -incoming")
if not isinstance(m.get("query"), str):
    broken("query is missing")

left = total
for i, c in enumerate(chunks):
    name = c.get("file") if isinstance(c, dict) else None
    if not isinstance(name, str) or not re.fullmatch(r"[0-9A-Za-z_-][0-9A-Za-z._-]*", name) or ".." in name:
        broken(f"chunk {i} has a bad file name")
    try:
        with open(os.path.join(src, name), "rb") as f:
            data = f.read()
    except OSError as e:
        broken(f"chunk {i}: {e}")
    if len(data) != c.get("size"):
        broken(f"chunk {i} ({name}) is {len(data)} bytes, the manifest says {c.get('size')}")
    if hashlib.sha256(data).hexdigest() != c.get("sha256"):
        broken(f"chunk {i} ({name}) does not match its SHA-256")
    try:
        plain = zlib.decompress(data)
    except zlib.error as e:
        broken(f"chunk {i} ({name}) is not valid zlib data: {e}")
    if len(plain) != min(chunk_size, left):
        broken(f"chunk {i} ({name}) inflates to {len(plain)} bytes, expected {min(chunk_size, left)}")
    left -= len(plain)

stale = [what for key, env, what in (
    ("qemu_wasm_commit", "PORTY_QEMU_COMMIT", "QEMU-Wasm commit"),
    ("porty_patches_sha256", "PORTY_PATCHES_SHA", "QEMU patches"),
    ("image_manifest_sha256", "PORTY_IMAGE_SHA", "image manifest"),
) if m.get(key) != os.environ[env]]
if stale:
    print("::warning::assemble-site: the snapshot was saved with a different "
          + ", ".join(stale) + "; it is left out of the site.", file=sys.stderr)
    sys.exit(3)

os.makedirs(dst)
for name in ["manifest.json"] + [c["file"] for c in chunks]:
    try:
        os.link(os.path.join(src, name), os.path.join(dst, name))
    except OSError:
        shutil.copyfile(os.path.join(src, name), os.path.join(dst, name))
print(f"snapshot: {len(chunks)} chunks, {sum(c['size'] for c in chunks)} bytes "
      f"for {total} bytes of machine state")
PY
    case "$rc" in
        0) has_snapshot=true ;;
        3) ;;
        *) die "the snapshot in $snapshot is damaged (see above)" ;;
    esac
fi

# --- build.json -----------------------------------------------------------------
mapfile -t roms < <(grep -v '^[[:space:]]*$' "$repo/build/pc-bios.list")
for rom in "${roms[@]}"; do
    [[ -s "$out/qemu/pc-bios/$rom" ]] || die "missing BIOS file $rom"
done
PORTY_ID="$id" PORTY_QEMU_COMMIT="$QEMU_WASM_COMMIT" PORTY_ROMS="${roms[*]}" \
PORTY_PATCHES_SHA="$patches_sha" PORTY_IMAGE_SHA="$image_sha" PORTY_SNAPSHOT="$has_snapshot" \
python3 -I - "$out/build.json" <<'PY'
import json, os, sys, time
info = {
    "id": os.environ["PORTY_ID"],
    "built_at": time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime()),
    "qemu_wasm_commit": os.environ["PORTY_QEMU_COMMIT"],
    # What a snapshot must have been saved with for the page to resume it.
    "porty_patches_sha256": os.environ["PORTY_PATCHES_SHA"],
    "image_manifest_sha256": os.environ["PORTY_IMAGE_SHA"],
    "snapshot": os.environ["PORTY_SNAPSHOT"] == "true",
    "pc_bios": os.environ["PORTY_ROMS"].split(),
}
with open(sys.argv[1], "w", encoding="utf-8") as f:
    json.dump(info, f, indent=2)
    f.write("\n")
PY

# Real COOP/COEP headers for hosts that support a _headers file (Netlify,
# Cloudflare Pages).  GitHub Pages ignores it and relies on the service worker.
cat > "$out/_headers" <<'HDR'
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Cross-Origin-Resource-Policy: same-origin
HDR

# --- size report and limits --------------------------------------------------------
total="$(find "$out" -type f -printf '%s\n' | awk '{ s += $1 } END { printf "%d", s }')"
files="$(find "$out" -type f | wc -l)"
biggest="$(find "$out" -type f -printf '%s %p\n' | sort -n | tail -1)"
echo "site: $files files, $total bytes ($(( total / 1000000 )) MB, $(( total / 1048576 )) MiB)"
parts=(qemu image)
[[ "$has_snapshot" == true ]] && parts+=(snapshot)
for part in "${parts[@]}"; do
    size="$(find "$out/$part" -type f -printf '%s\n' | awk '{ s += $1 } END { printf "%d", s }')"
    echo "  $part: $size bytes"
done
echo "  largest file: $biggest"
if (( ${biggest%% *} >= 100000000 )); then
    die "a file is 100 MB or larger: $biggest"
fi
if (( total > SITE_HARD_LIMIT_BYTES )); then
    die "site is $total bytes, above the hard limit of $SITE_HARD_LIMIT_BYTES"
fi
if (( total > SITE_SOFT_LIMIT_BYTES )); then
    echo "::warning::site is $total bytes, above GitHub Pages' documented 1 GB (decimal) limit of $SITE_SOFT_LIMIT_BYTES; the deployment may be rejected. See docs/PLAN.md, 'Size budget'."
fi
