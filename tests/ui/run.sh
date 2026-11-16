#!/usr/bin/env bash
# Build a miniature site (tests/site-smoke.sh), swap in the fake QEMU module
# and run the browser tests against it: the normal start, then (unless a
# query was given) the same site with a snapshot to resume, whole and with
# a chunk missing.
#
# usage: tests/ui/run.sh <empty-work-dir> [url-query]
#   PUPPETEER_DIR  directory with node_modules/puppeteer-core
#                  (e.g. `npm i --no-save puppeteer-core` somewhere)
#   CHROME         Chrome/Chromium binary (default /usr/bin/google-chrome)
set -euo pipefail

work="${1:?usage: run.sh <empty-work-dir> [url-query]}"
query="${2:-}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
port="${PORT:-8765}"

"$here/../site-smoke.sh" "$work" > "$work.smoke.log"

server=""
stop() {
    if [[ -n "$server" ]]; then
        kill "$server" 2>/dev/null || true
        wait "$server" 2>/dev/null || true
        server=""
    fi
}
trap stop EXIT
serve() { # <site-dir>: with the fake QEMU, on $port
    stop
    cp "$here/fake-qemu.js" "$1/qemu/out.js"
    python3 "$here/serve.py" "$1" "$port" &
    server=$!
    for _ in $(seq 50); do
        curl -fsS -o /dev/null "http://localhost:$port/index.html" 2>/dev/null && return 0
        sleep 0.1
    done
    echo "the test server did not start on port $port" >&2
    return 1
}

serve "$work/dist"
node "$here/ui-test.mjs" "http://localhost:$port/" "$query"
[[ -z "$query" ]] || exit 0

# A site with a snapshot (site-smoke.sh assembled it with --snapshot).
serve "$work/dist-snapshot"
node "$here/ui-resume-test.mjs" "http://localhost:$port/" ok

# The same with one chunk file missing.  The trees share hard links, so
# copy rather than edit in place.
cp -r "$work/dist-snapshot" "$work/dist-broken"
rm "$work/dist-broken/snapshot/000003.zz"
serve "$work/dist-broken"
node "$here/ui-resume-test.mjs" "http://localhost:$port/" broken
