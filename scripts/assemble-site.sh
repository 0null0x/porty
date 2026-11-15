#!/usr/bin/env bash
# Assemble the static site that GitHub Pages serves.
#
# usage: scripts/assemble-site.sh --qemu <dir> --image <dir> --out <dir> [--id <build-id>]
#   --qemu   output of build/build-qemu.sh (out.js, *.wasm, *.worker.js,
#            pc-bios/, build-info.json)
#   --image  output of scripts/prepare-image.sh
#   --out    destination (must not exist or be empty)
#
# web/node_modules must exist (npm ci --ignore-scripts in web/).
# Fails if the site exceeds the GitHub Pages size limits in build/versions.env.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
# shellcheck source-path=SCRIPTDIR source=../build/versions.env
source "$repo/build/versions.env"

qemu="" image="" out="" id=""
while (( $# )); do
    case "$1" in
        --qemu)  qemu="$2"; shift 2 ;;
        --image) image="$2"; shift 2 ;;
        --out)   out="$2"; shift 2 ;;
        --id)    id="$2"; shift 2 ;;
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

# --- build.json -----------------------------------------------------------------
mapfile -t roms < <(grep -v '^[[:space:]]*$' "$repo/build/pc-bios.list")
for rom in "${roms[@]}"; do
    [[ -s "$out/qemu/pc-bios/$rom" ]] || die "missing BIOS file $rom"
done
PORTY_ID="$id" PORTY_QEMU_COMMIT="$QEMU_WASM_COMMIT" PORTY_ROMS="${roms[*]}" \
python3 -I - "$out/build.json" <<'PY'
import json, os, sys, time
info = {
    "id": os.environ["PORTY_ID"],
    "built_at": time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime()),
    "qemu_wasm_commit": os.environ["PORTY_QEMU_COMMIT"],
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
for part in qemu image; do
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
