#!/usr/bin/env bash
# Build a NATIVE qemu-system-x86_64 from the patched QEMU-Wasm tree, for the
# snapshot producer (.github/workflows/snapshot.yml): it boots Android with
# TCG on a build machine and saves the running guest with QEMU's migration,
# and the browser build resumes that stream (QEMU-Wasm documents the flow in
# examples/migration/README.md).
#
# The configure line is the one the WebAssembly build uses
# (build/build-qemu.sh) minus the Emscripten parts, so both binaries are the
# same QEMU with the same device models:
#   * --without-default-features --enable-system, one target;
#   * ucontext coroutines instead of Emscripten fibers;
#   * no pixman, exactly like the WebAssembly build (QEMU then uses its
#     built-in minimal replacement; there is no "screendump" command, the
#     snapshot producer uses ui/wasmfb.c's PORTY_FB_DUMP instead);
#   * -DPORTY_NS_HOST_TICKS (patch 0014): the guest's TSC counts nanoseconds,
#     as it does in the browser, instead of the build machine's RDTSC.
#
# usage: build/build-native-qemu.sh <patched-source-dir> <build-dir> <out-dir>
#   <out-dir> receives qemu-system-x86_64, pc-bios/ (the files in
#   build/pc-bios.list) and build-info.txt.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src="$(realpath "${1:?usage: build-native-qemu.sh <source-dir> <build-dir> <out-dir>}")"
build="${2:?usage: build-native-qemu.sh <source-dir> <build-dir> <out-dir>}"
out="${3:?usage: build-native-qemu.sh <source-dir> <build-dir> <out-dir>}"
jobs="${BUILD_JOBS:-$(nproc)}"

[[ -x "$src/configure" ]] || { echo "::error::$src is not a QEMU source tree" >&2; exit 1; }
mkdir -p "$build" "$out/pc-bios"
out="$(realpath "$out")"

configure_args=(
    --target-list=x86_64-softmmu
    --without-default-features
    --enable-system
    --enable-tcg
    --enable-fdt=system
    --with-coroutine=ucontext
    --disable-werror
    --extra-cflags=-DPORTY_NS_HOST_TICKS
)

(
    cd "$build"
    "$src/configure" "${configure_args[@]}"
    make -j"$jobs" qemu-system-x86_64
)
[[ -x "$build/qemu-system-x86_64" ]] || { echo "::error::build did not produce qemu-system-x86_64" >&2; exit 1; }

cp "$build/qemu-system-x86_64" "$out/"
while read -r rom; do
    [[ -n "$rom" ]] || continue
    cp "$src/pc-bios/$rom" "$out/pc-bios/"
done < "$here/pc-bios.list"

{
    echo "configure: ${configure_args[*]}"
    echo "source: $(git -C "$src" rev-parse HEAD 2>/dev/null || echo unknown)"
    "$out/qemu-system-x86_64" --version | head -1
    echo "accelerators:"
    "$out/qemu-system-x86_64" -accel help | sed 's/^/  /'
    echo "pixman and friends (config-host.h):"
    grep -E '^#(define|undef) CONFIG_(PIXMAN|KVM|TCG|FDT|PNG|VNC|SLIRP|LINUX_AIO|LINUX_IO_URING|VIRTFS)\b' \
        "$build/config-host.h" | sed 's/^/  /' || true
    echo "firmware:"
    (cd "$out/pc-bios" && sha256sum -- * | sed 's/^/  /')
} > "$out/build-info.txt"
cat "$out/build-info.txt"
