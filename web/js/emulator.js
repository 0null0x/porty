// Loads QEMU-Wasm and boots Android-x86 in it.
// SPDX-License-Identifier: GPL-2.0-or-later

import { MIB, chooseWasmMemoryMb, fallbackLadder, requiredWasmMemoryMb } from './config.js';
import { buildKernelCmdline, buildQemuArgs } from './qemu-args.js';
import { WASM_PAGE, findMemoryImport, setMemoryImportPages } from './wasm-patch.js';
import { Display } from './display.js';

const BIOS_DIR = '/pc-bios';
const IMAGE_DIR = '/img';

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
     */
    constructor({ cfg, canvas, serial, baseUrl, onStatus, onFatal }) {
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
    }

    status(stage, detail = '', progress = undefined) {
        this.onStatus({ stage, detail, progress });
    }

    async start() {
        const problems = checkEnvironment();
        if (problems.length) {
            throw new StartError(problems.join(' '),
                'Reload the page once (the service worker that enables isolation ' +
                'only takes effect on the second load). Private browsing modes and ' +
                'in-app browsers often block service workers.');
        }

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
        for (const attempt of attempts) {
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

        // --- QEMU ---------------------------------------------------------------
        const ramdiskPath = `${IMAGE_DIR}/${manifest.ramdisk.file}`;
        const args = buildQemuArgs(this.cfg, manifest, {
            bios: BIOS_DIR,
            kernel: `${IMAGE_DIR}/${manifest.kernel.file}`,
            initrd: `${IMAGE_DIR}/${manifest.initrd.file}`,
            ramdisk: ramdiskPath,
            diskUrl: `${base}image/${manifest.disk.dir}`,
        });
        this.args = args;
        this.cmdline = buildKernelCmdline(this.cfg, manifest);

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
        this.status('Booting Android');
        return this;
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
        this.onFatal(error);
    }
}
