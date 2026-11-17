// Loads QEMU-Wasm and boots Android-x86 in it.
// SPDX-License-Identifier: GPL-2.0-or-later

import { MIB, chooseWasmMemoryMb, fallbackLadder, requiredWasmMemoryMb } from './config.js';
import { buildKernelCmdline, buildQemuArgs, inputDevice } from './qemu-args.js';
import { WASM_PAGE, findMemoryImport, setMemoryImportPages } from './wasm-patch.js';
import { Display } from './display.js';
import { snapshotVersion } from './diskcache.js';
import { applyBootDiet, dietFixes, dietProps } from './boot-diet.js';
import {
    SNAPSHOT_DIR, SNAP_DONE, SNAP_FAILED, STAGE_RESUMING, checkSnapshot, describeResume, readSnapshotStats,
    snapshotArgs, snapshotConfig, snapshotIndex,
} from './snapshot.js';

const BIOS_DIR = '/pc-bios';
const IMAGE_DIR = '/img';
const SNAPSHOT_INDEX = `${IMAGE_DIR}/snapshot.idx`;

export class StartError extends Error {
    constructor(message, hint = '') {
        super(message);
        this.hint = hint;
    }
}

/** What this browser is missing, as a list of human readable problems. */
export function checkEnvironment(env = globalThis) {
    const problems = [];
    if (typeof env.WebAssembly !== 'object') {
        problems.push('WebAssembly is not available.');
    }
    if (typeof env.SharedArrayBuffer !== 'function' || env.crossOriginIsolated !== true) {
        problems.push(
            'This page is not cross-origin isolated, so SharedArrayBuffer ' +
            '(needed for threads) is unavailable.');
    }
    if (typeof env.Atomics !== 'object') {
        problems.push('Atomics is not available.');
    }
    return problems;
}

async function fetchJson(url) {
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) {
        throw new StartError(`Cannot load ${url} (HTTP ${response.status}).`,
            'The site may still be deploying, or the build did not publish this file.');
    }
    return response.json();
}

/** Download a file, reporting received bytes as they arrive. */
async function fetchBytes(url, onBytes) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new StartError(`Cannot download ${url} (HTTP ${response.status}).`);
    }
    if (!response.body || !response.body.getReader) {
        const whole = new Uint8Array(await response.arrayBuffer());
        onBytes(whole.length);
        return whole;
    }
    const reader = response.body.getReader();
    const parts = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        parts.push(value);
        total += value.length;
        onBytes(value.length);
    }
    const out = new Uint8Array(total);
    let pos = 0;
    for (const part of parts) {
        out.set(part, pos);
        pos += part.length;
    }
    return out;
}

function allocateMemory(pages) {
    return new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
}

export class Emulator {
    /**
     * @param {object} options
     * @param {object} options.cfg       parseConfig() result
     * @param {HTMLCanvasElement} options.canvas
     * @param {object} options.serial    SerialConsole
     * @param {string} options.baseUrl   site root, with trailing slash
     * @param {(s: {stage: string, detail?: string, progress?: number}) => void} options.onStatus
     * @param {(e: Error) => void} options.onFatal
     * @param {{mode?: string, veto?: string, env?: object}} [options.resume]
     *        whether a snapshot on the site may be resumed (snapshot.js)
     * @param {(e: Error) => void} [options.onResumeFailed]
     *        QEMU stopped while loading the snapshot; without it, onFatal
     * @param {object} [options.diskCache]
     *        a DiskCache (diskcache.js): chunks are kept on the device
     */
    constructor({
        cfg, canvas, serial, baseUrl, onStatus, onFatal, resume = {}, onResumeFailed = null, diskCache = null,
    }) {
        this.cfg = { ...cfg };
        this.canvas = canvas;
        this.serial = serial;
        this.baseUrl = baseUrl;
        this.onStatus = onStatus;
        this.onFatal = onFatal;
        this.module = null;
        this.memory = null;
        this.display = null;
        this.exited = false;
        this.notes = [];
        this.resume = { mode: 'auto', veto: '', env: {}, ...resume };
        this.onResumeFailed = onResumeFailed;
        this.diskCache = diskCache;
        // Milliseconds from start() to each step, for tests and measurements.
        this.timings = {};
        // Why this start boots although a snapshot was asked for or on offer.
        this.resumeNote = '';
        this.resuming = false;
        this.resumed = false;
    }

    status(stage, detail = '', progress = undefined) {
        this.onStatus({ stage, detail, progress });
    }

    /** Not resuming: say why, once, where the page and the logs show it. */
    noResume(reason) {
        this.resumeNote = `Not resuming the saved Android: ${reason}. Booting normally instead.`;
        this.notes.push(this.resumeNote);
    }

    /**
     * Decide whether this start resumes the site's snapshot.
     * @returns {Promise<{snap: object, cfg: object}|null>}
     */
    async planResume(build) {
        const { mode, veto, env } = this.resume;
        if (mode === 'off') {
            return null;
        }
        if (!build.snapshot && mode !== 'on') {
            return null;
        }
        if (veto) {
            this.noResume(veto);
            return null;
        }
        let snap;
        try {
            snap = await fetchJson(`${this.baseUrl}${SNAPSHOT_DIR}/manifest.json`);
        } catch (e) {
            this.noResume('this site has no snapshot');
            return null;
        }
        const problems = checkSnapshot(snap, build);
        if (problems.length) {
            this.noResume(problems.join('; '));
            return null;
        }
        const plan = snapshotConfig(snap, this.cfg, env);
        if (plan.problems.length) {
            this.noResume(plan.problems.join('; '));
            return null;
        }
        return { snap, cfg: plan.cfg };
    }

    async start() {
        const problems = checkEnvironment();
        if (problems.length) {
            throw new StartError(problems.join(' '),
                'Reload the page once (the service worker that enables isolation ' +
                'only takes effect on the second load). Private browsing modes and ' +
                'in-app browsers often block service workers.');
        }

        const startedAt = performance.now();
        const mark = (step) => {
            this.timings[step] = Math.round(performance.now() - startedAt);
        };
        this.mark = mark;
        this.status('Reading build information');
        const base = this.baseUrl;
        const [build, manifest, qemuInfo] = await Promise.all([
            fetchJson(`${base}build.json`),
            fetchJson(`${base}image/manifest.json`),
            fetchJson(`${base}qemu/build-info.json`),
        ]);
        const v = `?v=${encodeURIComponent(build.id)}`;
        this.manifest = manifest;
        this.build = build;
        let plan = await this.planResume(build);
        if (this.diskCache) {
            // Before QEMU's threads exist: they inherit the service worker
            // that answers their chunk requests from the device.
            // Never in the way of a start: a browser that leaves a storage
            // call unanswered boots without the cache's say.
            const note = await Promise.race([
                this.diskCache.prepare(manifest.disk).catch((e) => `No disk cache (${e}).`),
                new Promise((resolve) => setTimeout(() => resolve(
                    `The disk cache did not get ready in 12 s (at "${this.diskCache.step}"); starting without waiting for it.`), 12000)),
            ]);
            if (note) {
                this.notes.push(note);
            }
        }

        // --- downloads -------------------------------------------------------
        const files = [
            { key: 'wasm', url: `${base}qemu/qemu-system-x86_64.wasm${v}`, size: qemuInfo.size },
            { key: 'kernel', url: `${base}image/${manifest.kernel.file}`, size: manifest.kernel.size },
            { key: 'initrd', url: `${base}image/${manifest.initrd.file}`, size: manifest.initrd.size },
            { key: 'ramdisk', url: `${base}image/${manifest.ramdisk.file}`, size: manifest.ramdisk.size },
            ...build.pc_bios.map((name) => ({ key: `bios:${name}`, url: `${base}qemu/pc-bios/${name}${v}`, size: 0 })),
        ];
        const totalBytes = files.reduce((sum, f) => sum + f.size, 0) || 1;
        let received = 0;
        const report = (n) => {
            received += n;
            this.status('Downloading the emulator',
                `${(received / MIB).toFixed(1)} of ${(totalBytes / MIB).toFixed(0)} MB`,
                Math.min(1, received / totalBytes));
        };
        report(0);
        const blobs = {};
        await Promise.all(files.map(async (f) => {
            blobs[f.key] = await fetchBytes(f.url, report);
        }));
        mark('downloaded');
        for (const part of ['kernel', 'initrd', 'ramdisk']) {
            if (blobs[part].length !== manifest[part].size) {
                throw new StartError(`${manifest[part].file} has the wrong size ` +
                    `(${blobs[part].length}, expected ${manifest[part].size}).`,
                    'A stale cache or an interrupted download. Reload the page.');
            }
        }

        // --- WebAssembly memory --------------------------------------------------
        this.status('Reserving memory');
        const imported = findMemoryImport(blobs.wasm);
        if (!imported || !imported.shared || imported.max === null) {
            throw new StartError('The QEMU module does not import a shared memory.',
                'This build of QEMU-Wasm is not the one Porty expects.');
        }
        const builtMb = (imported.min * WASM_PAGE) / MIB;
        const chunk = manifest.disk.chunk_size;
        const attempts = [{ mem: this.cfg.mem, tb: this.cfg.tb }, ...fallbackLadder(this.cfg)];
        let memory = null;
        let lastError = null;
        if (plan) {
            // The snapshot fits one machine only: its memory or a normal boot.
            const mb = chooseWasmMemoryMb(plan.cfg, builtMb, chunk);
            try {
                memory = allocateMemory((mb * MIB) / WASM_PAGE);
                this.cfg = plan.cfg;
                this.wasmMemoryMb = mb;
            } catch (e) {
                this.noResume(`the browser refused the ${mb} MiB of memory it needs`);
                plan = null;
            }
        }
        for (const attempt of memory ? [] : attempts) {
            const candidate = { ...this.cfg, ...attempt };
            const first = attempt === attempts[0];
            // An explicit wasmmem only applies to the configuration the user asked for.
            const mb = first ? chooseWasmMemoryMb(candidate, builtMb, chunk)
                : requiredWasmMemoryMb(candidate, chunk);
            if (mb < requiredWasmMemoryMb(candidate, chunk)) {
                this.notes.push(`wasmmem=${mb} is below the estimated need of ` +
                    `${requiredWasmMemoryMb(candidate, chunk)} MiB for mem=${candidate.mem}.`);
            }
            try {
                memory = allocateMemory((mb * MIB) / WASM_PAGE);
                if (!first) {
                    this.notes.push(`The browser refused the requested memory; ` +
                        `falling back to ${attempt.mem} MiB guest RAM (${mb} MiB total).`);
                }
                this.cfg = candidate;
                this.wasmMemoryMb = mb;
                break;
            } catch (e) {
                lastError = e;
            }
        }
        if (!memory) {
            throw new StartError(`The browser could not reserve WebAssembly memory (${lastError}).`,
                'Close other tabs and apps and try again, or pass a smaller ?mem= value.');
        }
        this.memory = memory;
        const wasmBytes = setMemoryImportPages(blobs.wasm, (this.wasmMemoryMb * MIB) / WASM_PAGE);
        this.patched = wasmBytes !== blobs.wasm;
        blobs.wasm = null;

        // Boot diet: one more script for Android-x86's initrd (boot-diet.js).
        // (After the memory is settled: a resume uses the snapshot's settings,
        // so that the initrd is the one the saved machine was started with.)
        const props = dietProps(this.cfg);
        const fixes = dietFixes(this.cfg);
        blobs.initrd = applyBootDiet(blobs.initrd, props, fixes);
        this.notes.push(props.length
            ? `Android properties set at boot: ${props.map((p) => p.join('=')).join(', ')}.`
            : 'No Android properties set at boot (diet=0).');
        if (this.cfg.propsRejected) {
            this.notes.push(`${this.cfg.propsRejected} entries of ?props= were ignored (not key=value of letters, digits, . _ -).`);
        }
        if (fixes.ttm) {
            this.notes.push('The kernel module ttm.ko is replaced at boot by a copy without the WARN_ON in ' +
                'ttm_bo_vm_open (this kernel panics on it when Android collects stack traces); ttmfix=0 leaves it.');
        } else if (this.cfg.gfx !== 'vesa') {
            this.notes.push('ttmfix=0: ttm.ko is left as shipped; the guest panics when surfaceflinger forks.');
        }
        this.notes.push(fixes.sf
            ? 'surfaceflinger\'s library is replaced at boot by a copy that applies a layer change waiting for another ' +
                'layer\'s frame at once, instead of composing the screen again on every vsync until then; sffix=0 leaves it.'
            : 'sffix=0: surfaceflinger is left as shipped; it composes the screen again on every vsync while a layer ' +
                'change waits for another layer\'s frame.');
        this.notes.push(fixes.anr
            ? '"Not responding" reports come without the stack dumps of every process of interest (only the culprit\'s ' +
                'own); anrtraces=1 keeps Android\'s dumps in /data/anr.'
            : 'anrtraces=1: "not responding" reports come with Android\'s stack dumps in /data/anr.');
        this.notes.push(fixes.provision
            ? 'Android is marked as set up once it has booted, and its setup wizard, analytics service and ' +
                'second launcher (Taskbar) are hidden, so the boot ends on the home screen; setup=1 leaves all that alone.'
            : 'setup=1: the setup wizard is left to run (it stops without Google\'s services).');

        // --- QEMU ---------------------------------------------------------------
        const ramdiskPath = `${IMAGE_DIR}/${manifest.ramdisk.file}`;
        const paths = {
            bios: BIOS_DIR,
            kernel: `${IMAGE_DIR}/${manifest.kernel.file}`,
            initrd: `${IMAGE_DIR}/${manifest.initrd.file}`,
            ramdisk: ramdiskPath,
            diskUrl: `${base}image/${manifest.disk.dir}`,
        };
        // A resume runs the snapshot's own machine: its arguments, with
        // this page's paths, plus the stream to load (QEMU patch 0012).
        const args = plan ? snapshotArgs(plan.snap, paths, SNAPSHOT_INDEX, plan.cfg.tbExplicit ? plan.cfg.tb : 0)
            : buildQemuArgs(this.cfg, manifest, paths);
        if (plan) {
            // Its query should describe the same machine: page-side settings
            // (boot diet, time dilation) are taken from it.
            const own = buildQemuArgs(this.cfg, manifest, paths);
            if (JSON.stringify(own) !== JSON.stringify(args.slice(0, -2))) {
                this.notes.push('The snapshot\'s QEMU arguments differ from what its settings ' +
                    `(${plan.snap.query}) give on this page; the snapshot's arguments are used.`);
            }
        }
        const snapshotIndexText = plan ? snapshotIndex(plan.snap, `${base}${SNAPSHOT_DIR}`, snapshotVersion(plan.snap) || true) : null;
        this.args = args;
        // What the machine (a resumed one brings its own) has for a pointing
        // device decides what the page sends: touches, tablet moves or nothing.
        this.inputMode = inputDevice(args);
        this.cmdline = plan ? (args[args.indexOf('-append') + 1] || '') : buildKernelCmdline(this.cfg, manifest);

        let ramdisk = blobs.ramdisk;
        if (this.cfg.disk === 'ide' && ramdisk.length % 2048) {
            // CD-ROM sectors are 2048 bytes; pad so the tail is not cut off.
            const padded = new Uint8Array(Math.ceil(ramdisk.length / 2048) * 2048);
            padded.set(ramdisk);
            ramdisk = padded;
        }

        const qemuBase = `${base}qemu/`;
        let pending = wasmBytes;
        const Module = {
            arguments: args,
            wasmMemory: memory,
            pty: this.serial.slave,
            locateFile: (path) => `${qemuBase}${path}${v}`,
            mainScriptUrlOrBlob: `${qemuBase}out.js${v}`,
            // Compile from the (possibly patched) bytes we already hold.
            instantiateWasm: (imports, receiveInstance) => {
                WebAssembly.instantiate(pending, imports).then(({ instance, module }) => {
                    pending = null;
                    receiveInstance(instance, module);
                }).catch((e) => this.fatal(new StartError(`QEMU failed to compile: ${e}`,
                    'The browser may be out of memory.')));
                return {};
            },
            preRun: [(mod) => {
                mod.FS.mkdir(BIOS_DIR);
                mod.FS.mkdir(IMAGE_DIR);
                for (const name of build.pc_bios) {
                    mod.FS.writeFile(`${BIOS_DIR}/${name}`, blobs[`bios:${name}`]);
                }
                mod.FS.writeFile(`${IMAGE_DIR}/${manifest.kernel.file}`, blobs.kernel);
                mod.FS.writeFile(`${IMAGE_DIR}/${manifest.initrd.file}`, blobs.initrd);
                mod.FS.writeFile(ramdiskPath, ramdisk);
                if (snapshotIndexText) {
                    mod.FS.writeFile(SNAPSHOT_INDEX, snapshotIndexText);
                }
                Object.keys(blobs).forEach((k) => { blobs[k] = null; });
                ramdisk = null;
            }],
            print: (text) => this.serial.write(`${text}\r\n`),
            printErr: (text) => {
                console.warn(text);
                this.serial.write(`${text}\r\n`);
            },
            // Runs on the page's thread after the module is instantiated and
            // before main() starts QEMU, so no code block has been compiled yet.
            onRuntimeInitialized: () => {
                if (this.cfg.jitcap > 0) {
                    if (typeof Module._porty_set_jit_max_instances === 'function') {
                        const n = Module._porty_set_jit_max_instances(this.cfg.jitcap);
                        this.notes.push(`At most ${n} compiled code blocks at once.`);
                    } else {
                        this.notes.push('This QEMU build has no adjustable JIT cap; ?jitcap= ignored.');
                    }
                }
                if (this.cfg.jitgc === false) {
                    if (typeof Module._porty_set_jit_wait_gc === 'function') {
                        Module._porty_set_jit_wait_gc(0);
                        this.notes.push('Dropped compiled blocks stop counting at once (jitgc=0).');
                    } else {
                        this.notes.push('This QEMU build cannot skip the garbage-collector wait; ?jitgc= ignored.');
                    }
                }
                if (this.cfg.jitgcwait > 0) {
                    if (typeof Module._porty_set_jit_gc_wait_ms === 'function') {
                        const n = Module._porty_set_jit_gc_wait_ms(this.cfg.jitgcwait);
                        this.notes.push(`The cap waits at most ${n} ms for the garbage collector (jitgcwait).`);
                    } else {
                        this.notes.push('This QEMU build has no limit on the garbage-collector wait; ?jitgcwait= ignored.');
                    }
                }
                // QEMU patches 0022-0024: the JIT cache's policies and module
                // ring (on by default on iPhones and iPads, config.js; a build
                // without them stays as it is, so only a value that asks for
                // something is worth a note).
                if (this.cfg.jitpolicy >= 0) {
                    if (typeof Module._porty_set_jit_policy === 'function') {
                        const n = Module._porty_set_jit_policy(this.cfg.jitpolicy);
                        if (n) {
                            this.notes.push(`JIT cache policies: ${n} (jitpolicy).`);
                        }
                    } else if (this.cfg.jitpolicy > 0) {
                        this.notes.push('This QEMU build has no JIT cache policies; jitpolicy ignored.');
                    }
                }
                if (this.cfg.jitring >= 0) {
                    if (typeof Module._porty_set_jit_ring_kb === 'function') {
                        const n = Module._porty_set_jit_ring_kb(this.cfg.jitring);
                        if (n) {
                            this.notes.push(`Compiled forms of code blocks in a ${n} KiB ring (jitring).`);
                        }
                    } else if (this.cfg.jitring > 0) {
                        this.notes.push('This QEMU build has no module ring; jitring ignored.');
                    }
                }
                if (this.cfg.timescale > 1) {
                    if (typeof Module._porty_set_time_scale === 'function') {
                        const n = Module._porty_set_time_scale(this.cfg.timescale);
                        this.notes.push(`Guest time runs ${n} times slower than real time (timescale=${n}).`);
                    } else {
                        this.notes.push('This QEMU build has no time dilation; ?timescale= ignored.');
                    }
                }
                if (this.cfg.jit < 0) {
                    return;
                }
                if (typeof Module._porty_set_jit_threshold === 'function') {
                    const n = Module._porty_set_jit_threshold(this.cfg.jit);
                    this.notes.push(`JIT threshold: ${n} runs per code block.`);
                } else {
                    this.notes.push('This QEMU build has no adjustable JIT threshold; ?jit= ignored.');
                }
            },
            onAbort: (what) => this.fatal(new StartError(`QEMU aborted: ${what}`,
                'Usually the WebAssembly memory ran out. Try a smaller ?mem= value.')),
            // Without EXIT_RUNTIME Emscripten skips onExit, but always calls quit.
            onExit: (code) => this.exitedWith(code),
            quit: (code, toThrow) => {
                // With PROXY_TO_PTHREAD, callMain() hands main() to a pthread
                // and then calls exitJS(0, implicit) -> quit_(0) at once, while
                // QEMU goes on running. Only a quit after start-up is QEMU
                // really exiting (an exit in QEMU's thread reaches this thread
                // as a message, after createQemu() has resolved).
                if (this.qemuStarted) {
                    this.exitedWith(code);
                }
                throw toThrow;
            },
        };

        this.status('Starting QEMU', `${this.cfg.mem} MiB guest RAM, ${this.wasmMemoryMb} MiB WebAssembly memory`);
        const { default: createQemu } = await import(`${qemuBase}out.js${v}`);
        const instance = await createQemu(Module);
        this.qemuStarted = true;
        this.module = instance;
        mark('qemu');

        // Same workaround as QEMU-Wasm's own example page: never report the
        // PTY as readable when it is not, or QEMU spins on stdin.
        const tty = instance.TTY || Module.TTY;
        if (tty && tty.stream_ops && tty.stream_ops.poll) {
            const oldPoll = tty.stream_ops.poll;
            const pty = this.serial.slave;
            tty.stream_ops.poll = function poll(stream, timeout) {
                if (!pty.readable) {
                    return (pty.readable ? 1 : 0) | (pty.writable ? 4 : 0);
                }
                return oldPoll.call(stream, timeout);
            };
        }

        for (const name of ['_porty_fb_poll', '_porty_input_event', '_porty_disk_stats']) {
            if (typeof instance[name] !== 'function') {
                throw new StartError(`The QEMU build has no ${name} export.`,
                    'The Porty patches were not applied to this build.');
            }
        }
        this.display = new Display(this.canvas, memory, () => instance._porty_fb_poll());
        this.sendInput = (type, a, b, c) => instance._porty_input_event(type, a, b, c);
        const abi = typeof instance._porty_abi_version === 'function' ? instance._porty_abi_version() : 0;
        if (this.inputMode === 'touch' && abi < 2) {
            this.notes.push(`This QEMU build (input ABI ${abi}) cannot pass touches on, but Android has a touchscreen ` +
                'and nothing else to point with: add ?touch=0 for the USB tablet.');
        } else {
            this.notes.push({
                touch: 'Android has a touchscreen (virtio multitouch, touch=1): fingers are fingers, the mouse is one finger, ' +
                    'its wheel drags and its right button is Back. Apps draw their first frame more slowly with it; ' +
                    'touch=0 (the default) gives Android a USB tablet (a mouse) instead.',
                tablet: 'Android has a USB tablet (touch=0, the default): it is a mouse there, with an arrow, and a tap ' +
                    'is a click. touch=1 gives it a touchscreen.',
                none: 'Android has no pointing device (usb=0).',
            }[this.inputMode]);
        }
        if (plan) {
            this.resuming = true;
            this.snapshot = plan.snap;
            this.status(STAGE_RESUMING, 'Loading the saved Android', 0);
        } else {
            this.status('Booting Android');
        }
        return this;
    }

    /** Progress counters of migration/porty-snapshot.c; null without them. */
    snapshotStats() {
        const m = this.module;
        if (!m || typeof m._porty_snapshot_stats !== 'function') {
            return null;
        }
        return readSnapshotStats(new Uint32Array(this.memory.buffer, m._porty_snapshot_stats() >>> 0, 8));
    }

    /**
     * Report the progress of a resume; the page calls this while it draws.
     * @returns {boolean} true while the snapshot is still loading
     */
    resumeTick() {
        if (!this.resuming || this.failed) {
            return false;
        }
        const stats = this.snapshotStats();
        if (!stats) {
            // QEMU rejects "-incoming porty:" itself and exits; see fatal().
            return true;
        }
        if (stats.state === SNAP_FAILED) {
            this.fatal(new StartError('The saved Android could not be loaded.',
                'A chunk of the snapshot failed to download or did not match.'));
            return false;
        }
        if (stats.state === SNAP_DONE) {
            this.resuming = false;
            this.resumed = true;
            this.mark('resumed');
            this.status('Android resumed');
            return false;
        }
        const detail = describeResume(stats);
        const shown = `${detail}|${Math.round(stats.progress * 200)}`;
        if (shown !== this.resumeShown) {
            this.resumeShown = shown;
            this.status(STAGE_RESUMING, detail, stats.progress);
        }
        return true;
    }

    /** Disk download counters maintained by block/porty.c. */
    diskStats() {
        if (!this.module) {
            return null;
        }
        const s = new Uint32Array(this.memory.buffer, this.module._porty_disk_stats() >>> 0, 8);
        return {
            chunksTotal: s[0],
            chunksFetched: s[1],
            megabytes: s[2] / 1024,
            inFlight: s[3],
            errors: s[4],
            cacheHits: s[5],
        };
    }

    /**
     * QEMU's heap in MiB (break, arena, used, free), with the number of
     * coroutines and of compiled code blocks where the build reports them;
     * null on builds without heap statistics.
     */
    heapStats() {
        const m = this.module;
        if (!m || typeof m._porty_heap_stats !== 'function') {
            return null;
        }
        const s = new Uint32Array(this.memory.buffer, m._porty_heap_stats() >>> 0, 4);
        const mb = (v) => Math.round(v / 1048576);
        const out = { brk: mb(s[0]), arena: mb(s[1]), used: mb(s[2]), free: mb(s[3]) };
        if (typeof m._porty_coroutine_count === 'function') {
            out.coroutines = m._porty_coroutine_count();
        }
        if (typeof m._porty_jit_stats === 'function') {
            const j = new Uint32Array(this.memory.buffer, m._porty_jit_stats() >>> 0, 4);
            out.jitAlive = j[0];
            out.jitCap = j[1];
            out.jitCompiled = j[3];
        }
        return out;
    }

    exitedWith(code) {
        this.exited = true;
        this.fatal(code === 0
            ? new StartError('The virtual machine powered off.', 'Reload the page to start again.')
            : new StartError(`QEMU exited with status ${code}.`,
                'The last lines of the serial console below usually say why.'));
    }

    fatal(error) {
        if (this.failed) {
            return;
        }
        this.failed = true;
        const stats = this.resuming ? this.snapshotStats() : null;
        if (stats && stats.state === SNAP_DONE) {
            // Loaded, but the page had not drawn since: not a failed resume.
            this.resuming = false;
            this.resumed = true;
        }
        if (this.resuming && this.onResumeFailed) {
            // The page starts over with a normal boot instead of giving up.
            this.onResumeFailed(error);
            return;
        }
        this.onFatal(error);
    }
}
