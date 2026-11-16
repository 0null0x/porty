#!/usr/bin/env bash
# Runs INSIDE the QEMU-Wasm build container (the image built from the
# Dockerfile of the pinned ktock/qemu-wasm checkout: Emscripten 3.1.50 plus
# zlib, libffi, glib and pixman compiled for wasm32).
#
#   /qemu   the patched QEMU-Wasm source tree (read-write: meson downloads
#           its wrap subprojects into it)
#   /porty  this repository (read-only)
#   /out    receives out.js, qemu-system-x86_64.wasm,
#           qemu-system-x86_64.worker.js, pc-bios/ and build-info.json
#
# The configure/make invocation is the one from QEMU-Wasm's README
# ("For building qemu-system-x86_64"), with three deliberate changes:
#   * -g2 instead of -g: keep function names and unminified JS glue, but no
#     DWARF, which would blow the GitHub Pages size budget;
#   * the linear memory size comes from build/versions.env;
#   * -sMALLOC=dlmalloc at the end: QEMU-Wasm's toolchain image puts
#     -sMALLOC=mimalloc into its CFLAGS environment (Dockerfile ENV), which
#     QEMU's configure passes to the link, and the last -sMALLOC wins. Its
#     author dropped mimalloc "to prevent runtime error" on the fixmalloc
#     branch (3948df46, 2025-05-01); dlmalloc also provides mallinfo() for
#     porty_heap_stats(). (Removing the flag from the README's command line
#     alone, as an earlier version of this script did, changed nothing.)
# (A build with 2 MiB stacks, STACK_OVERFLOW_CHECK=2 and ASSERTIONS=1 found no
# stack overflow; see docs/DEVELOPING.md and docs/PLAN.md, "Findings".)
set -euo pipefail

: "${WASM_MEMORY_MB:?WASM_MEMORY_MB is not set}"
jobs="${BUILD_JOBS:-$(nproc)}"

git config --global --add safe.directory '*'
emcc --version

cd /build

EXTRA_CFLAGS="-O3 -g2 -Wno-error=unused-command-line-argument -matomics -mbulk-memory -DNDEBUG -DG_DISABLE_ASSERT -D_GNU_SOURCE -sASYNCIFY=1 -pthread -sPROXY_TO_PTHREAD=1 -sFORCE_FILESYSTEM -sALLOW_TABLE_GROWTH -sTOTAL_MEMORY=${WASM_MEMORY_MB}MB -sWASM_BIGINT --js-library=/build/node_modules/xterm-pty/emscripten-pty.js -sEXPORT_ES6=1 -sASYNCIFY_IMPORTS=ffi_call_js -sMALLOC=dlmalloc"

emconfigure /qemu/configure --static --target-list=x86_64-softmmu --cpu=wasm32 --cross-prefix= \
    --without-default-features --enable-system --with-coroutine=fiber --enable-virtfs \
    --extra-cflags="$EXTRA_CFLAGS" --extra-cxxflags="$EXTRA_CFLAGS" \
    --extra-ldflags="-sEXPORTED_RUNTIME_METHODS=getTempRet0,setTempRet0,addFunction,removeFunction,TTY,FS"

emmake make -j"$jobs" qemu-system-x86_64

for f in qemu-system-x86_64 qemu-system-x86_64.wasm qemu-system-x86_64.worker.js; do
    [[ -s "/build/$f" ]] || { echo "::error::build did not produce $f" >&2; exit 1; }
done

# The Porty entry points must have survived linking *and* be reachable from
# the page: Emscripten attaches EMSCRIPTEN_KEEPALIVE exports as Module['_x'].
for sym in porty_fb_poll porty_input_event porty_abi_version porty_disk_stats porty_set_jit_threshold \
           porty_heap_stats porty_coroutine_count porty_set_jit_max_instances porty_jit_stats \
           porty_set_jit_wait_gc porty_set_time_scale \
           porty_snapshot_stats; do
    grep -q -F -e "Module['_${sym}']" -e "Module[\"_${sym}\"]" /build/qemu-system-x86_64 \
        || { echo "::error::Module._${sym} is missing from the JS glue" >&2; exit 1; }
done

mkdir -p /out/pc-bios
cp /build/qemu-system-x86_64 /out/out.js
cp /build/qemu-system-x86_64.wasm /build/qemu-system-x86_64.worker.js /out/
while read -r rom; do
    [[ -n "$rom" ]] || continue
    cp "/qemu/pc-bios/$rom" /out/pc-bios/
done < /porty/build/pc-bios.list

python3 /porty/scripts/wasm-info.py /out/qemu-system-x86_64.wasm --json /out/build-info.json \
    --expect-memory-mb "$WASM_MEMORY_MB"
ls -l /out /out/pc-bios
