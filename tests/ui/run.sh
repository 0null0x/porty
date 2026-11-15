#!/usr/bin/env bash
# Build a miniature site (tests/site-smoke.sh), swap in the fake QEMU module
# and run the browser test against it.
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
cp "$here/fake-qemu.js" "$work/dist/qemu/out.js"

python3 "$here/serve.py" "$work/dist" "$port" &
server=$!
trap 'kill "$server" 2>/dev/null || true' EXIT
for _ in $(seq 50); do
    curl -fsS -o /dev/null "http://localhost:$port/index.html" 2>/dev/null && break
    sleep 0.1
done

node "$here/ui-test.mjs" "http://localhost:$port/" "$query"
