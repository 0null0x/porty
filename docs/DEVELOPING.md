# Developing Porty

How to build, deploy and test Porty. The design, the reasoning behind each
decision, the size budget and the findings so far are in
[PLAN.md](PLAN.md); what each file of the page does is in
[web/README.md](../web/README.md). Using the site, its URL parameters and
the troubleshooting tips for users are in the [README](../README.md).

## Deploying your own copy

The same steps deploy this repository and a fork. A fork's site appears at
`https://<owner>.github.io/<repository>/`, and its boot test follows it
there.

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
     SHA-1 published by Android-x86, extracts the kernel and ramdisks,
     takes the ext4 system image out of `system.sfs`, removes Google's apps
     from it (`build/slim-remove.list`) and publishes it as a compressed
     qcow2 in 2 MiB chunks (the ISO is cached as well; see
     [PLAN.md, section 2.8](PLAN.md#28-system-image-slimmed-ext4-in-a-compressed-qcow2));
   - assembles the site, checks its size against the GitHub Pages limit and
     deploys it.
3. Open the site's address.

A build can also be started by hand from the Actions tab ("Run workflow"),
optionally forcing a QEMU rebuild or skipping the deployment.

Pushes that only change Markdown files, `docs/`, `tests/boot/` or the
boot-test workflow do not rebuild or redeploy the site.

## Testing a deployment, in this order

1. **Desktop Chrome** (then desktop Safari): open the page with
   [`?serial=1`](../README.md#url-parameters). Press *Start Android*. You
   should see, in order: the download bar; SeaBIOS text on the canvas; Linux
   kernel messages in the console panel; `Detecting Android-x86... found at
   /dev/vda`; and eventually the canvas switching from text mode to
   Android's boot animation. Expect minutes. The toolbar shows how many MB
   of the system image have been read; if that number keeps growing, it is
   still booting.
2. **iPhone, Safari 26 or later**: plain address, no parameters. The page
   reloads itself once on the first visit (that is the service worker
   enabling cross-origin isolation). Use Wi-Fi and keep the screen on.

When something goes wrong the page shows the reason, a hint and the last
lines of the serial console, with a *Copy details* button. From the browser
console, `__porty` exposes the running emulator (`__porty.args`,
`__porty.cmdline`, `__porty.diskStats()`).

## The boot test

After every successful deployment, `.github/workflows/boot-test.yml` opens
the live site in headless Chrome on a GitHub runner, presses *Start* and
lets Android boot for up to 100 minutes. Its log has the serial console, the
page status every few seconds, and screenshots of the guest display printed
as base64 JPEG between marker lines. Recover them with
`python3 -I tests/boot/extract-shots.py <log> <out-dir>`.

GitHub shows a job's log only when the run ends, so while it runs the test
posts its progress as a commit status named `porty/boot <parameters>`.

Start it by hand from the Actions tab to try other
[URL parameters](../README.md#url-parameters) (for example `smp=1`), or to
boot QEMU-Wasm's own Alpine x86_64 demo instead as a control experiment.
The job stays green whatever happens to Android, because GitHub e-mails the
repository owner about every failed run; the verdict is in the run's summary
and in a warning annotation.

## Troubleshooting the build

**The workflow fails in "Build the toolchain image".** That step downloads
third-party sources (Docker Hub, GNOME, freedesktop.org, GitHub). Re-run the
job; if one source is gone for good, the URL lives in QEMU-Wasm's
`Dockerfile` and can be changed with another patch in `patches/qemu-wasm/`
(`0003-*.patch` is exactly such a fix).

**The deploy job fails.** If it mentions Pages not being enabled, do step 1
of [Deploying your own copy](#deploying-your-own-copy). If it mentions the
artifact size, see [Size budget](PLAN.md#4-size-budget) in the plan.

## Repository layout

| Path | Purpose |
| --- | --- |
| `patches/qemu-wasm/` | The changes to QEMU-Wasm, as plain patches |
| `build/` | Pinned versions and the script that compiles QEMU inside the toolchain container |
| `scripts/` | ISO download and verification, image preparation, site assembly |
| `web/` | The page (plain ES modules, no bundler) |
| `tests/` | Unit tests, pipeline dry run, native QEMU end-to-end test, headless-browser test, boot test |
| `.github/workflows/` | Build and deploy; boot test |
| `docs/PLAN.md` | Design, decisions, sources, risks, findings |
| `docs/DEVELOPING.md` | This file |

## What has been tested locally

Run locally, without the WebAssembly build:

| Check | Command |
| --- | --- |
| The patches apply to the pinned QEMU-Wasm commit and compile natively with `-Werror` (gcc; clang syntax check including the Emscripten-only branches) | see [PLAN.md, section 5](PLAN.md#5-what-was-validated-without-the-webassembly-build) |
| Display, input and block driver work in a native QEMU built from the patched tree, booting a Linux guest through the real image pipeline with the page's own QEMU arguments | `tests/native-e2e.sh` |
| The published system disk reads back bit for bit through qcow2 over the block driver, in a native `qemu-img` built from the patched tree | `tests/native-disk.sh` (the branch check builds the tool and runs it) |
| Page logic | `node tests/unit.test.mjs`, `node tests/wasm-patch.test.mjs` |
| Image and site pipeline on a miniature ISO | `tests/site-smoke.sh /tmp/smoke` |
| The page in headless Chrome with a fake QEMU module: service-worker isolation, start-up, canvas, input, console | `tests/ui/run.sh /tmp/ui` |
| Workflow and scripts | `actionlint`, `shellcheck -x` |

These local checks do not cover the Emscripten build itself, QEMU-Wasm
running the patched code in a browser, or Android-x86 booting under it; the
CI build and the boot test do. Nothing has been run on iOS yet.

To preview the UI without the real build:

```sh
(cd web && npm ci --ignore-scripts)
tests/site-smoke.sh /tmp/porty-preview
cp tests/ui/fake-qemu.js /tmp/porty-preview/dist/qemu/out.js
python3 tests/ui/serve.py /tmp/porty-preview/dist 8080
```
