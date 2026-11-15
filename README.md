# Porty

Porty is a static web page that boots a real 64-bit Android,
**Android-x86 9.0-r2 (x86_64)**, inside the browser. A PC is emulated by
**QEMU compiled to WebAssembly** ([QEMU-Wasm](https://github.com/ktock/qemu-wasm)),
the screen is drawn on a canvas and touches are delivered as a USB tablet.
There is no server-side component, no app to install and no JIT helper: the
only code generator involved is the browser's own WebAssembly engine, which
is why it can run in Safari on an iPhone.

Expected address once deployed: **https://0null0x.github.io/porty/**

## Status: builds and deploys; booting unverified

The first workflow run (2026-11-15) compiled QEMU to WebAssembly (a 12 MB
module), downloaded and verified the ISO, and deployed a 966 MB site. Nobody
has seen Android boot in a browser yet. What was checked before that is
listed under [What has been tested](#what-has-been-tested). Treat every
statement about booting Android as a plan until the milestones below are
ticked off.

- [x] **M1** CI build is green and the site deploys
- [ ] **M2** desktop browser: kernel boot log appears on the serial console
- [ ] **M3** desktop browser: Android UI is visible on the canvas
- [ ] **M4** touch, navigation buttons and keyboard work
- [ ] **M5** boots in Safari on an iPhone (iOS 26 or later)
- [ ] **M6** performance tuning

[docs/PLAN.md](docs/PLAN.md) has the design, the reasoning behind each
decision, the size budget and what to try when a milestone fails.

## First deployment

1. On GitHub open **Settings > Pages** and set **Build and deployment >
   Source** to **GitHub Actions**. Do this before the first push; the deploy
   job fails otherwise.
2. Push `main`. The workflow `.github/workflows/build-and-deploy.yml` then:
   - lints the scripts and runs the unit tests and a miniature dry run of the
     image pipeline (a few seconds);
   - checks out QEMU-Wasm at the pinned commit, applies `patches/qemu-wasm/`,
     builds QEMU-Wasm's own Docker toolchain image and compiles
     `qemu-system-x86_64` to WebAssembly (about 20 minutes for the whole
     first run; the result is cached and reused until the patches or the
     build script change);
   - downloads `android-x86_64-9.0-r2.iso` from SourceForge, verifies the
     SHA-1 published by Android-x86, extracts the kernel and ramdisks and
     splits `system.sfs` into 2 MiB chunks (the ISO is cached as well);
   - assembles the site, checks its size against the GitHub Pages limit and
     deploys it.
3. Open the address above.

A build can also be started by hand from the Actions tab ("Run workflow"),
optionally forcing a QEMU rebuild or skipping the deployment.

## Testing, in this order

1. **Desktop Chrome** (then desktop Safari): open the page with
   [`?serial=1`](#url-parameters). Press *Start Android*. You should see, in
   order: the download bar; SeaBIOS text on the canvas; Linux kernel messages
   in the console panel; `Detecting Android-x86... found at /dev/vda`; and
   eventually the canvas switching from text mode to Android's boot
   animation. Expect minutes. The toolbar shows how many MB of the system
   image have been read; if that number keeps growing, it is still booting.
2. **iPhone, Safari 26 or later**: plain address, no parameters. The page
   reloads itself once on the first visit (that is the service worker
   enabling cross-origin isolation). Use Wi-Fi and keep the screen on.

After every successful deployment, `.github/workflows/boot-test.yml` opens
the live site in headless Chrome on a GitHub runner, presses *Start* and lets
Android boot for 40 minutes. Its log has the serial console, the page status
every few seconds, and screenshots of the guest display printed as base64
JPEG between marker lines. Recover them with
`python3 -I tests/boot/extract-shots.py <log> <out-dir>`. Start it by hand
from the Actions tab to try other [URL parameters](#url-parameters) (for
example `smp=1`). The job stays green whatever happens to Android, because
GitHub e-mails the repository owner about every failed run; the verdict is
in the run's summary and in a warning annotation.

When something goes wrong the page shows the reason, a hint and the last
lines of the serial console, with a *Copy details* button. From the browser
console, `__porty` exposes the running emulator (`__porty.args`,
`__porty.cmdline`, `__porty.diskStats()`).

## URL parameters

| Parameter | Default | Meaning |
| --- | --- | --- |
| `mem` | 1536 (phones: 1024) | Guest RAM in MiB (512 to 3072) |
| `wasmmem` | sized to fit | Size of the WebAssembly memory in MiB |
| `tb` | 384 (phones: 256) | TCG translation cache in MiB |
| `smp` | 1 | Guest CPUs, 1 to 4 (extra CPUs share one thread unless `mttcg=1`) |
| `mttcg` | off | `1` gives each guest CPU its own thread (multi-threaded TCG; crashes QEMU-Wasm with this guest today) |
| `jit` | 1500 | Runs of a code block in the interpreter before it is compiled to WebAssembly; `0` compiles at once, `2147483647` means interpreter only |
| `cpu` | `Nehalem` | QEMU CPU model (SSE4.2 and POPCNT, which Android's x86_64 ABI requires; no AVX) |
| `res` | `480x800` | Guest resolution |
| `dpi` | from `res` | Android screen density |
| `gfx` | `auto` | `vesa` adds `nomodeset vga=...` (no kernel mode setting; standard VESA modes only, so portrait sizes become 800x600 or 1024x768) |
| `disk` | `virtio` | `ide` presents the images as IDE CD-ROMs instead |
| `setup` | off | `1` keeps Android's first-run setup wizard |
| `serial` | off | `1` opens the serial console at start |
| `cache`, `parallel` | 16, 4 | Disk chunks kept in RAM, concurrent chunk downloads |
| `fps` | 30 | Canvas refresh cap |
| `append` | | Extra kernel arguments, for example `append=DEBUG=1` |
| `cmdline` | | Replace the whole kernel command line |
| `qemu` | | Extra QEMU arguments |
| `nocoi` | | `1` unregisters the service worker (debugging) |

Example: `https://0null0x.github.io/porty/?serial=1&mem=1024&smp=1&res=1024x768`

## Known limits and risks

- **Speed.** This is full-system emulation without hardware virtualisation,
  and Android 9 renders through a software OpenGL implementation on top of
  it. A boot that takes a native PC seconds will take many minutes here, and
  may not complete at all on a phone. This is the largest risk to M3 and M5.
- **Memory.** The guest's RAM is real memory in the browser tab. iOS Safari
  limits tabs more tightly than desktop browsers; the page falls back to
  smaller guests when the browser refuses the allocation, but a tab that is
  killed later for using too much memory cannot be caught.
- **Download size.** Tens of MB up front, then the parts of the roughly
  950 MB system image that Android touches while booting.
- **Live session only.** `/data` is a RAM disk inside the guest. Reloading
  the page, or the browser discarding the tab, loses everything.
- **No network** in the guest, so also no app installs from the internet.
  No Google Play or Google apps, no cellular, SMS, calls, camera, sound,
  sensors or GPS.
- **One pointer.** Touches are delivered through a USB tablet: Android shows
  a mouse pointer and there are no multi-touch gestures.
- **Text input** from the on-screen keyboard is limited to US-ASCII.
- **Hosting.** GitHub Pages has a 1 GB site limit and a 100 GB/month soft
  bandwidth limit; the site is close to the first. See the size budget in
  the plan.

## Troubleshooting

**The workflow fails in "Build the toolchain image".** That step downloads
third-party sources (Docker Hub, GNOME, freedesktop.org, GitHub). Re-run the
job; if one source is gone for good, the URL lives in QEMU-Wasm's
`Dockerfile` and can be changed with another patch in `patches/qemu-wasm/`
(`0003-*.patch` is exactly such a fix).

**The deploy job fails.** If it mentions Pages not being enabled, do step 1
of *First deployment*. If it mentions the artifact size, see "Size budget"
in the plan.

**"This page is not cross-origin isolated".** Reload once. If it stays:
private browsing and in-app browsers (inside chat or social apps) block
service workers, so open the address in Safari or Chrome itself. To start
over, open the page with `?nocoi=1`, then without it.

**"The browser could not reserve WebAssembly memory", or the tab reloads by
itself.** Close other tabs and apps, then try `?mem=768` (and, if needed,
`?mem=768&tb=128`).

**"QEMU exited with status 1".** The last serial lines name the option QEMU
did not like. Remove custom `qemu=`/`cpu=` parameters first.

**The console stops at `Detecting Android-x86....` with more dots
appearing.** The guest cannot see its disk. Try `?disk=ide`.

**The console shows Android starting, but the canvas stays in text mode or
black.** Try `?gfx=vesa`, then `?res=1024x768`, then both.

**It works but crawls.** Try a smaller screen such as `?res=320x480&dpi=120`.
Extra CPUs (`?smp=2`) share one host thread unless `mttcg=1`, so they add
no speed today.

**The kernel crashes or the machine powers off early in boot.** See
"Findings" in [docs/PLAN.md](docs/PLAN.md). `?jit=2147483647` runs the
guest in QEMU's interpreter only, which tells a WebAssembly code-generator
bug apart from everything else.

**After a new deployment the page behaves strangely.** GitHub Pages caches
files for ten minutes; reload after that.

## Repository layout

| Path | Purpose |
| --- | --- |
| `patches/qemu-wasm/` | The changes to QEMU-Wasm, as plain patches |
| `build/` | Pinned versions and the script that compiles QEMU inside the toolchain container |
| `scripts/` | ISO download and verification, image preparation, site assembly |
| `web/` | The page (plain ES modules, no bundler) |
| `tests/` | Unit tests, pipeline dry run, native QEMU end-to-end test, headless-browser test |
| `.github/workflows/` | Build and deploy |
| `docs/PLAN.md` | Design, decisions, sources, risks |

## What has been tested

Run locally, without the WebAssembly build:

| Check | Command |
| --- | --- |
| The patches apply to the pinned QEMU-Wasm commit and compile natively with `-Werror` (gcc; clang syntax check including the Emscripten-only branches) | see `docs/PLAN.md` |
| Display, input and block driver work in a native QEMU built from the patched tree, booting a Linux guest through the real image pipeline with the page's own QEMU arguments | `tests/native-e2e.sh` |
| Page logic | `node tests/unit.test.mjs`, `node tests/wasm-patch.test.mjs` |
| Image and site pipeline on a miniature ISO | `tests/site-smoke.sh /tmp/smoke` |
| The page in headless Chrome with a fake QEMU module: service-worker isolation, start-up, canvas, input, console | `tests/ui/run.sh /tmp/ui` |
| Workflow and scripts | `actionlint`, `shellcheck -x` |

Not tested: the Emscripten build itself, QEMU-Wasm running the patched code
in a browser, Android-x86 booting under it, anything on iOS.

To preview the UI without the real build:

```sh
(cd web && npm ci --ignore-scripts)
tests/site-smoke.sh /tmp/porty-preview
cp tests/ui/fake-qemu.js /tmp/porty-preview/dist/qemu/out.js
python3 tests/ui/serve.py /tmp/porty-preview/dist 8080
```

## License

Porty's own files are licensed under the GNU General Public License,
version 2 or (at your option) any later version; see [LICENSE](LICENSE).
QEMU is GPL-2.0, and the published site contains a build of it: the complete
corresponding source is the pinned QEMU-Wasm commit in `build/versions.env`
plus `patches/qemu-wasm/`, built by `build/build-qemu.sh`.

The Android-x86 image is not part of this repository; the workflow downloads
it from the Android-x86 project and publishes it unmodified.
[NOTICE](NOTICE) lists every third-party component, its license and where
its source code is.
