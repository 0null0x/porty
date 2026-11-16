# Porty: design and plan

Status as of 2026-11-15: code complete for a first attempt, **not yet run end
to end**. The first GitHub Actions run is the first time the WebAssembly
build exists.

Statements below are marked where they rest on something other than a test
in this repository:

- *(source)* read in upstream source code or documentation, cited;
- *(recalled)* believed from general knowledge, not re-checked;
- *(unknown)* will only be known after CI or a device test.

## 1. Architecture

```
browser main thread                      Web Workers (pthreads)
-------------------                      ----------------------
index.html, js/*.js                      QEMU main loop (PROXY_TO_PTHREAD)
  canvas  <-- reads pixels --+             ui/wasmfb.c   publishes surface
  touch/keys -- ring buffer -+- shared     ui/wasmfb.c   drains input ring
  Emscripten FS (kernel,     |  memory     vCPU threads  TCG -> wasm modules
   initrd, ramdisk, BIOS)    |  (SAB)      thread pool   block/porty.c:
  serial console (PTY)       +             synchronous XHR per 2 MiB chunk
                                                |
service worker (coi-serviceworker) adds COOP/COEP to every response
                                                |
GitHub Pages: qemu/*.wasm, image/kernel, image/system/000000.bin ...
```

One WebAssembly memory is shared by every thread. The page creates it
itself and hands it to Emscripten (`Module.wasmMemory`), so the display and
input code can use it without going through Emscripten's runtime.

## 2. Decisions

### 2.1 Display: zero-copy shared-memory framebuffer, 2D canvas

`patches/qemu-wasm/0001` adds `-display wasmfb` (`ui/wasmfb.c`), a
`DisplayChangeListener` that records where the current `DisplaySurface`
lives (address, size, stride, format), a generation counter and the dirty
rectangle. `porty_fb_poll()` returns a snapshot of that record. JavaScript
calls it once per animation frame from the main thread and copies the dirty
rows from the shared memory into an `ImageData`, converting BGRX to RGBA in
the same pass, then `putImageData`.

- QEMU never copies a pixel: for 32 bpp modes the surface *is* the guest's
  video memory. One copy is unavoidable because `ImageData` cannot wrap a
  `SharedArrayBuffer`; WebGPU would not remove it either, so it was left
  out. A 480x800 frame is 1.5 MB.
- The exported functions only touch atomics and a spinlock held for a few
  instructions, so calling them from the main thread while QEMU runs in a
  worker is safe. Reading pixels while the guest draws can tear; a full
  repaint once a second bounds how long a torn frame can stay visible.
- `dpy_gfx_check_format` accepts only x8r8g8b8/a8r8g8b8, so the VGA device
  converts 15/16/24 bpp guest modes itself.

### 2.2 Input: lock-free ring, drained in QEMU's main loop

`porty_input_event(type, a, b, c)` appends to a single-producer /
single-consumer ring (512 entries). An 8 ms `QEMU_CLOCK_REALTIME` timer and
the display refresh drain it with the BQL held and call
`qemu_input_queue_abs` / `qemu_input_queue_btn` /
`qemu_input_event_send_key_qcode`. Keys cross the boundary as Linux evdev
codes and are translated with `qemu_input_linux_to_qcode()`, so no
QEMU-version-specific enum values live in JavaScript. The same ring carries
pause, resume and reset.

Guest devices: `-usb -device usb-tablet` and the PS/2 keyboard. This is what
Android-x86's own `qemu-android` launcher uses (`-usbdevice tablet`)
*(source: `bootable/newinstaller/rpm/qemu-android`, pie-x86 branch)*.
Back = `KEY_BACK`, Home = `KEY_HOMEPAGE`, Recents = Alt+Tab.

### 2.3 Disk: a block driver that fetches chunk files

`patches/qemu-wasm/0002` adds the read-only protocol driver `porty`
(`block/porty.c`). The image is published as `000000.bin`, `000001.bin`, ...
of 2 MiB each. A read that misses the small LRU cache (16 chunks) fetches
the chunk with a **synchronous XMLHttpRequest issued from a QEMU thread-pool
thread**.

Why not an Emscripten lazy file (`FS.createLazyFile`) as first planned: in a
pthread build Emscripten's filesystem lives on the browser main thread and
every file syscall is proxied there *(source: emscripten 3.1.50
`src/library_syscall.js`, `wrapSyscallFunction`)*. The main thread may not
do synchronous binary XHR, and blocking it would freeze the page. A block
driver runs where QEMU's I/O already runs, in a worker, where synchronous
XHR is allowed. Using the thread pool (as `file-posix` does) keeps QEMU's
main loop, and therefore timers, input and display, responsive during
downloads and allows four chunks in flight.

Why chunk files rather than HTTP range requests on one file: plain GETs of
immutable small files are the most boring thing a CDN and a service worker
can be asked to do, they cache individually, and no file comes near GitHub's
100 MB per-file limit.

The other small files (kernel, initrd, ramdisk, firmware) are fetched by the
page and written into Emscripten's in-memory filesystem before QEMU starts.

### 2.4 Boot: direct kernel boot, system.sfs as a virtio disk

The build extracts `kernel`, `initrd.img`, `ramdisk.img` and `system.sfs`
from the ISO and boots with `-kernel/-initrd/-append`. No boot menu, and the
kernel command line is under our control. This is the layout of
Android-x86's `qemu-android` script: system image on the first virtio disk,
`ramdisk.img` on the second, `RAMDISK=vdb` *(source: same file)*. The
initrd's `init` scans `/dev/[hmnsv][dmrv][0-9a-z]*`, mounts each candidate
and accepts one that contains `system.sfs`, `system.img` or a `system`
directory; `system.sfs` is a squashfs holding `system.img`, so the squashfs
attached as `/dev/vda` matches the `system.img` case *(source:
`bootable/newinstaller/initrd/init`, pie-x86 branch)*.

Publishing only `system.sfs` instead of the whole ISO also saves the few MB
that matter for the size budget.

Kernel command line (see `web/js/qemu-args.js`):

| Argument | Why | Source |
| --- | --- | --- |
| base arguments | copied at build time from the ISO's own `isolinux.cfg` live entry (`root=/dev/ram0 androidboot.selinux=permissive ...`) | `scripts/prepare-image.sh` |
| `console=ttyS0` | boot log and root shell on the serial console | `qemu-android` |
| `RAMDISK=vdb` | ramdisk from the second disk | `initrd/init` |
| `SRC= DATA=` | live session; `/data` on tmpfs | `isolinux.cfg`, `initrd/scripts/2-mount` |
| `SETUPWIZARD=0` | skip the first-run wizard | `initrd/init` |
| `DPI=160` | `ro.sf.lcd_density` | `initrd/scripts/4-dpi` |
| `video=480x800` | mode for the KMS framebuffer | kernel DRM |
| `UVESA_MODE=800x600` | mode `init.sh` gives `uvesafb` if no framebuffer exists | `device/generic/common/init.sh` (`init_uvesafb`) |
| `nomodeset vga=0x343` (`gfx=vesa` only) | the ISO's "VESA mode - No GPU hardware acceleration" entry is `nomodeset vga=ask` | `isolinux.cfg` |

Graphics path. With `-vga std` and no `nomodeset`, either the kernel's
`bochs-drm` driver provides the framebuffer (any resolution through
`video=`), or, if that module is absent, `init.sh` loads `uvesafb` with
`UVESA_MODE`. VESA drivers can only use the modes in the VGA BIOS; the one
QEMU ships (SeaBIOS rel-1.16.3) has no portrait modes *(source: SeaBIOS
`vgasrc/svgamodes.c` at that tag)*, hence a separate, standard `UVESA_MODE`.
`init.sh` only selects the DRM gralloc/hwcomposer for virtio, Intel, AMD,
nouveau and VMware framebuffers; for anything else Android renders in
software. *(recalled: Android-x86 9.0 uses SwiftShader for that; the
9.0-rc1 release note says so.)* Whether Android-x86's 4.19 kernel honours
`video=480x800` on `bochs-drm` is *(unknown)*; if not, the guest comes up in
its default mode and the canvas simply follows.

CPU model `Nehalem`: Android's x86_64 ABI requires SSE4.2 and POPCNT
*(recalled)*, which QEMU's default `qemu64` lacks; `Nehalem` has them
without AVX.

### 2.5 Memory

Three numbers matter: guest RAM (`-m`), the TCG translation cache
(`tb-size`) and the WebAssembly memory that has to hold both plus QEMU
itself.

| | guest RAM | TCG cache | WebAssembly memory |
| --- | --- | --- | --- |
| desktop | 1024 MiB | 384 MiB | 2300 MiB (as linked) |
| phone | 768 MiB | 128 MiB | 1280 MiB |

(Planned as 1536/1024 MiB of guest RAM; see "Findings" for why it is less.)

The trade-off: Android 9 is uncomfortable below about 1 GB, and its `/data`
is a tmpfs that eats into the same RAM; but Emscripten zero-fills anonymous
mappings, so the whole guest RAM becomes resident memory of the tab at
start-up, and iOS kills tabs that use too much.

Emscripten fixes the memory size at link time: the module *imports* a shared
memory whose minimum and maximum both equal `TOTAL_MEMORY`, and a browser
only instantiates it with a memory of exactly that size. Instead of building
several variants, `web/js/wasm-patch.js` rewrites those two numbers in the
downloaded binary before compiling it. Nothing else depends on them:
Emscripten's glue takes the heap size from the `WebAssembly.Memory` it is
given and `sbrk` asks at run time *(source: emscripten 3.1.50
`src/runtime_init_memory.js`)*. On desktop the linked size is kept, so the
default desktop path is exactly QEMU-Wasm's tested configuration and does
not depend on the patcher. If the browser refuses the allocation the page
steps down (desktops: 896, 768 MiB of guest RAM; phones: 640, 512 MiB).
iOS does not refuse, it kills the tab later; so the page also records each
start's progress in localStorage, and a phone whose last start never ended
takes the next step down on its own (`web/js/crash-guard.js`).

`build/versions.env` keeps the linked size at QEMU-Wasm's own 2300 MiB.

### 2.6 Cross-origin isolation

Threads need `SharedArrayBuffer`, which browsers expose only to
cross-origin-isolated pages (COOP `same-origin` + COEP). GitHub Pages cannot
set response headers, so the page loads
[coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) 0.1.7
(MIT, vendored unmodified): a service worker that re-serves every response
with those headers and reloads the page once. QEMU-Wasm's own demo site
uses the same file on GitHub Pages.

`window.coi.coepCredentialless` is forced to `false`: version 0.1.7 would
otherwise choose `credentialless` for every browser that is neither Chrome
nor Firefox, and Safari does not implement that value *(source: the
package's `coi-serviceworker.js`; recalled for Safari)*.

Verified here: in headless Chrome, served without any headers, the page
becomes `crossOriginIsolated` and a synchronous XHR from a worker goes
through the service worker (`tests/ui`).

**Not verified: iOS Safari 26.** No primary source was found that states
that Safari honours COOP/COEP supplied by a service worker; the coi-
serviceworker README does not list browser support at all. Safari has
supported cross-origin isolation with real headers since 15.2 *(recalled)*.
If M5 fails at "not cross-origin isolated", the site also ships a `_headers`
file with the real headers, which Netlify and Cloudflare Pages honour, so
the same `dist/` can be hosted there unchanged (Cloudflare Pages limits
files to 25 MiB, which the `.wasm` may exceed; Netlify does not).

### 2.7 Serial console

QEMU-Wasm links xterm-pty's Emscripten library, which replaces Emscripten's
TTY with a PTY. The guest's serial port (`-serial mon:stdio`) and QEMU's own
messages arrive there. `web/js/serial.js` takes the place of the terminal:
it always keeps the text (boot progress line, error reports) and only
creates an xterm.js terminal when the console panel is opened.

## 3. Build

`.github/workflows/build-and-deploy.yml`:

1. `checks`: shellcheck, `node --check`, unit tests, miniature pipeline run.
2. `build`:
   - QEMU-Wasm at `0ef7b4e2814b231705d8371dd7997f5b72e70baf` + patches;
   - toolchain image from QEMU-Wasm's own `Dockerfile` (Emscripten 3.1.50,
     zlib, libffi, glib, pixman), layers cached in the Actions cache;
   - `build/build-qemu.sh` inside the container: QEMU-Wasm's documented
     configure/make line, with `-g2` instead of `-g` (function names and
     unminified glue, no DWARF);
   - the result (`out/qemu`) is cached under a key made of the commit, the
     memory size and the hashes of the patches and build script, so later
     pushes that only touch the page deploy in minutes;
   - ISO download with SHA-1 verification (cached), `prepare-image.sh`,
     `assemble-site.sh`, Pages artifact.
3. `deploy`: `actions/deploy-pages`.
4. `ui-test`: headless Chrome against a fake QEMU; informative only.

Actions are pinned to commit SHAs. Patch `0003` changes the zlib download
URL in the Dockerfile: `https://zlib.net/zlib-1.3.1.tar.xz` only exists
while 1.3.1 is the newest release, and newer tags exist upstream.

## 4. Size budget

GitHub documents a 1 GB limit for a published Pages site.

| Part | Size | Basis |
| --- | --- | --- |
| `android-x86_64-9.0-r2.iso` | 965.7 MB (about 921 MiB) | SourceForge file listing |
| `system.sfs` (published, 2 MiB chunks) | ISO minus roughly 15 to 20 MB | *(unknown until CI)* |
| kernel + initrd + ramdisk | roughly 11 MB | *(recalled)* |
| `qemu-system-x86_64.wasm` | 25 to 45 MB expected with `-g2` | *(unknown until CI)* |
| page, glue, firmware, xterm | about 1 MB | measured |
| **total** | **about 0.98 to 1.01 GB** | |

That is on the line. `assemble-site.sh` prints the exact numbers, warns
above 1,000,000,000 bytes and fails above 1,500,000,000 bytes; it also fails
if any single file reaches 100 MB. GitHub's deploy step only annotates
uploads over 1 GB ("Deployment might fail") rather than refusing them, so a
site slightly over the line is worth trying before shrinking anything.

If GitHub rejects the deployment for size, in order of preference:

1. Build with `-g0` instead of `-g2` (smaller `.wasm`; minified glue is the
   untested part).
2. Recompress `system.img` into a squashfs with xz in `prepare-image.sh`
   (roughly 20% smaller), after checking on the serial console that the
   kernel has `CONFIG_SQUASHFS_XZ` (`zcat /proc/config.gz | grep SQUASHFS`).
3. Host `dist/` elsewhere (Netlify works as is, thanks to `_headers`).

Bandwidth: a cold boot reads several hundred MB; GitHub's soft limit is
100 GB per month.

## 5. What was validated without the WebAssembly build

| What | How | Result |
| --- | --- | --- |
| Patches apply to the pinned commit | `git apply` on a pristine worktree | clean |
| Patched tree compiles natively, `-Werror` | `configure --target-list=x86_64-softmmu --without-default-features --enable-system --enable-tcg --enable-fdt=system --with-coroutine=ucontext` + `ninja qemu-system-x86_64` (gcc 13) | builds |
| The two new files under clang, including the `__EMSCRIPTEN__` branches | `clang -fsyntax-only` with the tree's flags and Emscripten 3.1.50's `emscripten.h`/`em_js.h` | no diagnostics |
| Block driver returns bit-exact data, with parallel readers | `tests/native-e2e.sh`: whole-device and file hashes | pass (virtio and IDE CD-ROM) |
| Framebuffer export follows mode switches and guest drawing | same test, PPM dump: 480x800 via EDID/KMS, 800x600 via `vga=0x343` | pass |
| Input ring reaches the guest as USB tablet and keyboard events, incl. `KEY_BACK` | same test | pass |
| The four firmware files are sufficient | same test runs with only those | pass |
| Image pipeline, incl. deriving the command line from `isolinux.cfg` | `tests/site-smoke.sh`, and the native test boots through it | pass |
| Page logic | `tests/unit.test.mjs`, `tests/wasm-patch.test.mjs` (the patched module is instantiated by a real engine) | pass |
| Page in a real browser | `tests/ui/run.sh` (headless Chrome, fake QEMU): isolation through the service worker, start-up, canvas colours, pointer mapping, keys, pause, console, worker XHR | 15 checks pass, also with a patched 1024 MiB memory |
| Workflow | YAML parse, `actionlint` 1.7.12 (with shellcheck) | clean |

The native test's guest is a stock Ubuntu 6.8 kernel with a busybox initrd,
not Android: it proves the QEMU-side code, not Android's behaviour on it.

Could not be validated here: the Emscripten compile and link (no Docker Hub,
no emsdk); the EM_JS chunk fetcher executing (syntax-checked only); thread
creation and asyncify behaviour of the new code under Emscripten; QEMU-Wasm's
TCG backend running Android; anything in Safari or on iOS; the real ISO
(layout, `isolinux.cfg` wording, sizes); the Pages deployment.

## 6. Milestones

**M1: CI green.** Watch, in order: toolchain image build (network
downloads); `emconfigure` (meson fetching its subprojects); the final link
(slow, memory-hungry); the export check at the end of `build-qemu.sh`
(`_porty_fb_poll` and friends present in the glue); `wasm-info.py` (memory
import is shared, 2300 MiB, and the section sizes); ISO download and SHA-1;
`prepare-image.sh` (kernel/squashfs signatures, the extracted command
line); the size report from `assemble-site.sh`.

**M2: serial boot log on desktop.** `?serial=1`. If QEMU exits immediately,
the console shows why (most likely an option the build does not have). If
nothing appears at all, try `?smp=1` (single-threaded TCG).

**M3: Android UI on desktop.** The largest unknown is whether Android 9
gets through its boot at this emulation speed. Levers: `smp=1..4`, a smaller
screen (`res=320x480&dpi=120`), `gfx=vesa`, `append=DEBUG=1` for a shell
before Android starts, and from that shell `logcat` to see what Android is
waiting for. If the display stays in text mode while the log shows
SurfaceFlinger running, it is the graphics path (section 2.4).

**M4: touch.** Already exercised against a Linux guest; with Android, check
that taps land where the finger is (the tablet is absolute, 0..32767 on both
axes of the visible canvas).

**M5: iPhone Safari.** Three independent hurdles: isolation through the
service worker (2.6), the memory allocation (2.5; try `?mem=768`), and
speed. If the tab dies without an error, it is memory.

**M6: performance.** Ideas, none implemented: record which chunks a boot
reads and prefetch them in that order; keep chunks in Cache Storage across
visits; a snapshot of a booted guest loaded with `-incoming` (QEMU-Wasm has
a migration example); `virtio-gpu` instead of software GL is not available
without a GL backend in the browser build.

## 7. Findings from the first runs (2026-11-15)

**M1 passed on the first run.** QEMU-Wasm compiled with the Porty patches in
about four minutes on a GitHub runner (12 MB `.wasm`, shared 2300 MiB
memory); the ISO matched the published SHA-1 (965,738,496 bytes); the site
came to 966,554,587 bytes, under the 1 GB line. Whole workflow: about 21
minutes, then about 3 minutes with the caches warm.

**Boot test (headless Chrome 157 on a 4-vCPU runner, against the live
site):**

| Parameters | Result |
| --- | --- |
| defaults then (`smp=2`, multi-threaded TCG) | QEMU dies within 2 s, before the kernel prints anything: "memory access out of bounds", then "Cannot convert undefined to a BigInt", in worker threads |
| `smp=1` | SeaBIOS runs, the kernel boots to about 0.8 s of guest time, then `WARN_ON(num_online_cpus() != 1)` in `rcu_scheduler_starting` fires (with one CPU; on `Nehalem` that count is a POPCNT instruction), is not recognised as a warning and becomes an oops: "Attempted to kill the idle task", panic |
| `smp=1` with `cpu=qemu64`, `cpu=max`, `cpu=Nehalem,-popcnt` or `append=nokaslr` | Dies at a different point each time, from 0.2 s to 2.1 s of guest time: panics, or the machine simply powers off |
| `smp=1`, all memory below 2 GiB (`mem=1024&tb=256&wasmmem=1664`) | Same panic as `smp=1`, so addresses above 2 GiB are not the cause |
| `smp=1&mem=512&tb=500&cpu=qemu64` (QEMU-Wasm's own x86_64 demo settings) | Machine powers off at 0.2 s |

What that says: the Porty display and disk code is unlikely to be involved
(one disk chunk has been read when the kernel dies, and the display is still
in text mode), and changing the CPU model or the memory layout does not fix
it. There are probably two guest mis-execution bugs in QEMU-Wasm: a wrong
POPCNT result (the `rcu_scheduler_starting` warning goes away without
POPCNT, with `cpu=qemu64` or `cpu=Nehalem,-popcnt`, which then run longest),
and something that stops the machine at a point that moves from run to run,
which smells of interrupts arriving in the middle of code compiled to
WebAssembly (blocks that ran 1500 times are compiled; everything else is
interpreted). Android's x86_64 ABI requires POPCNT, so turning it off is not
a fix. QEMU-Wasm's own x86_64 demo boots a small Alpine kernel that may
simply not hit either path.

**Second round (same day).** Patch 0004 made the compile threshold a run-time
setting (`?jit=`), and the boot test learned to print QEMU's own log
(`qemu=-d cpu_reset,guest_errors -D /tmp/q.log`, `dump=/tmp/q.log`) and
trace points (`-trace qemu_system_shutdown_request -trace runstate_set`).

| Parameters | Result |
| --- | --- |
| defaults (`smp=1`) | kernel panics in `check_timer()`: "IO-APIC + timer doesn't work!" (timer interrupts did not arrive while the kernel waited for them), or dies as before |
| `jit=2147483647` (interpreter only) | the page reports an exit within seconds, before the kernel prints anything |
| `jit=0` (compile every block) | kernel reaches 0.2 s, then the same kind of exit |
| any of the above with the trace points | QEMU logs only the two start-up CPU resets and `prelaunch -> running`: it never requests a shutdown, a reset or a power-down, yet the program exits with status 0 |

So the guest is not switching itself off and QEMU is not deciding to quit: the
WebAssembly program ends underneath QEMU (the page's `quit`/`onExit` hooks
fire with status 0). Together with the earlier "memory access out of bounds",
"Cannot convert undefined to a BigInt" and libffi's "Unexpected rtype"
errors from worker threads, this points at QEMU-Wasm's runtime (Emscripten
pthreads, Asyncify-based coroutines and its per-block Wasm modules) rather
than at Porty's display and disk code. Also learned: QEMU-Wasm calls
`init_wasm32()` only from the multi-threaded TCG vCPU thread, so
`thread=single` must never be used.

**Third round: most of the "crashes" were the page giving up.** A JavaScript
stack trace of the exit showed `callMain -> exitJS -> _proc_exit -> quit`.
With `PROXY_TO_PTHREAD`, Emscripten's `callMain()` hands `main()` to a
pthread and then calls `exitJS(0, implicit)`, which always calls the page's
`quit` hook, while QEMU goes on running. `emulator.js` took that call for
"the virtual machine powered off", so the page stopped drawing and the boot
test closed the browser within seconds of every start. The kernel panics
seen in that window (the `rcu_scheduler_starting` warning, "IO-APIC + timer
doesn't work!") still need watching, but no run so far gave QEMU more than
about ten seconds. Fixed: `quit` before `createQemu()` resolves is ignored.

Also tried in this round: building without `-sMALLOC=mimalloc` (QEMU-Wasm's
author removed it "to prevent runtime error" on the `fixmalloc` branch, never
merged into master); kept. A build with 2 MiB stacks, `STACK_OVERFLOW_CHECK=2`
and `ASSERTIONS=1` found no stack overflow, but QEMU's vCPU thread then
failed in its interpreter within a second, in both JIT and interpreter-only
modes: libffi's "Unexpected rtype 28005" (the bytes "em", as in "memory")
from a helper-call record read by `tcg_qemu_tb_exec_tci`, which suggests a
stale or misread block. Reverted to the plain build to measure the boot
without the page bug first.

**Fourth round: two real bugs fixed, Android's init reached.**

- QEMU-Wasm's wasm32 backend passed `args[1], args[2]` to
  `tcg_out_ctpop_i32/i64` instead of `args[0], args[1]`, so every POPCNT
  wrote its result into its input register (patch 0005). That was the
  `WARN_ON(num_online_cpus() != 1)` panic at 0.8 s with any POPCNT-capable
  CPU model. With the fix the default `Nehalem` model boots past it.
- QEMU-Wasm's own x86_64 Alpine demo reaches its login prompt in 77 s in the
  same headless Chrome (`control` input of the Boot test), so the browser
  and runner are fine.
- `mem=1536` runs out of the 2300 MiB WebAssembly memory ("Aborted(OOM)")
  when the kernel probes the virtio disk, or fails earlier with libffi's
  "Unexpected rtype"; `mem=1024` does not. Default is now 1024.
- With `cpu=Nehalem,-popcnt&mem=1024` (before the POPCNT fix) the kernel
  booted completely in about seven minutes of real time ("Run /init as init
  process" at 35 s of guest time), the Android-x86 initrd found the system
  image on Porty's streamed disk ("Detecting Android-x86... found at
  /dev/vda") and the display switched to 480x800, but after 30 minutes the
  screen was still black: Android's own boot had not drawn anything yet.
  The emulation is slow (the BIOS screen was still up after two minutes).
- `androidboot.console=ttyS0` is now on the command line so Android's root
  shell appears on the serial console and the boot test can ask for
  `sys.boot_completed`; the automatic boot test runs for up to 100 minutes.

**Fifth round: the boot animation.**

- With 0005, Android's init died on every boot at the same two places in
  SELinux (`ebitmap_read`, `context_struct_compute_av`). The interpreter
  multiplies 32-bit casts for `mulu2_i32`/`muls2_i32`, but the generated Wasm
  multiplied whole 64-bit registers whose upper halves are undefined for i32
  values; compilers turn `x % 384` into exactly such a multiply. Patch 0006
  extends the operands first. After it: no more crashes.
- `-trace`-free diagnosis that worked: `append=ignore_loglevel printk.devkmsg=on`
  shows Android init's own messages on the serial console.
- Timeline of a boot (verbose run, 64-chunk cache): kernel to init about 40 s,
  zygote at about 3 min, SurfaceFlinger at 11 min, the root console at 13 min,
  and SurfaceFlinger starts `bootanim` at 23 min. In `gfx=vesa` mode the
  animation is on screen at 30 and 40 minutes
  ([screenshot](img/boot-animation-vesa-30min.jpg)), and by 43 minutes
  system_server's package setup (`idmap`) is running. Each init step takes
  about a second: roughly 10 to 50 times slower than real hardware.
- A 16-chunk disk cache made the guest re-download 1.25 GB of a 943 MB image;
  64 chunks fetch far less and reach each stage sooner. Default now 64 (32 on
  phones).
- The boot test posts live progress as a commit status (`porty/boot ...`,
  including the share of lit pixels on the guest screen), because GitHub
  shows job logs and annotations only when a run ends.

**Sixth round: memory, and the first iPhone try (2026-11-16).**

- The earlier attempt to build without mimalloc never took effect: QEMU-Wasm's
  toolchain image sets `-sMALLOC=mimalloc` in its `CFLAGS`, and the last
  `-sMALLOC` on the link line wins. `build/build-qemu.sh` now ends with
  `-sMALLOC=dlmalloc`. With mimalloc, 1280 to 1536 MiB WebAssembly memories
  ran out at the first disk reads; with dlmalloc they boot.
- `porty_heap_stats()` (patch 0007): with dlmalloc, QEMU needs about 290 MiB
  beyond guest RAM, TCG cache and disk cache. About 115 MiB is there at
  start; the other 170 MiB arrives in the first two minutes and stays. That
  fits the coroutines: each had a 1 MiB C stack and a 1 MiB Asyncify buffer,
  both committed when allocated and kept by the coroutine pool. Patch 0008
  makes both 256 KiB and reports the coroutine count.
- The first try in iPhone Safari ended in a forced restart while loading.
  WebContent processes on iPhone have a soft memory limit of around 1.5 GB
  (an Apple engineer in WebKit bug 277848), and the browser's own memory
  comes on top of the WebAssembly memory: among other things every compiled
  TB is a module and instance of its own, up to 15000 of them. Patch 0009
  makes that cap adjustable (`?jitcap=`); phones keep 4000.
- Phone defaults are now 768/128/16 (guest RAM, TCG cache, disk chunks), 1280
  MiB of WebAssembly memory; after a killed start, 640/96/12, then 512/64/8.
- Speed: `mem=768&tb=128&cache=16` reached Android's root shell in 8
  minutes, against about 12 for the desktop defaults and more than 18 for
  `mem=1024&tb=256&cache=32&wasmmem=1664`, whose heap had only 2 MiB of room
  left (cause not known yet).

**Next steps, in order of cost:**

1. A debug build of QEMU-Wasm with `-sASSERTIONS=1` (and possibly
   `-sSAFE_HEAP=1`), deployed beside the normal one and selected with a page
   parameter, so the runtime reports what goes wrong instead of exiting.
2. Try ktock's newer branches (`sync-upstream`, `dev-wasm-j`) or the
   upstream QEMU series for 64-bit guests, which may already fix this.
3. Reproduce with QEMU-Wasm's own Alpine x86_64 image and settings to tell
   "QEMU-Wasm is unstable with any x86_64 guest under load" from "this
   kernel hits a specific bug".

## 8. Open questions for the first real run

- Exact size of `system.sfs` and of the `.wasm` (section 4).
- Does Android-x86's kernel have `bochs-drm`, and does it accept
  `video=480x800`?
- Does QEMU-Wasm's thread pool cope with four concurrent chunk fetches at
  boot (each pool thread is a Web Worker)? `?parallel=1` serialises them.
- Is 2300 MiB of shared memory acceptable to desktop Safari?
