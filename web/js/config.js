// Porty configuration: URL parameters -> a validated config object.
// Pure functions only (no DOM), so the same code runs under node for tests.
// SPDX-License-Identifier: GPL-2.0-or-later

export const MIB = 1024 * 1024;
export const WASM_PAGE = 65536;

// Memory QEMU itself needs on top of guest RAM and the TCG code buffer:
// VGA memory, the chunk cache, BIOS/option ROMs, glib/QEMU heaps and
// thread stacks.  Deliberately generous.
export const QEMU_OVERHEAD_MB = 288;

const DEFAULTS = {
    // 1536 MiB ran QEMU-Wasm out of its 2300 MiB at the virtio disk probe
    // (boot tests, 2026-11-15); 1024 boots through to Android's init.
    desktop: { mem: 1024, tb: 384 },
    mobile: { mem: 1024, tb: 256 },
};

export const PARAM_HELP = [
    ['mem', 'guest RAM in MiB (512-3072). Default 1024 (1536 runs out of WebAssembly memory).'],
    ['wasmmem', 'size of the WebAssembly memory in MiB. Default: sized to fit.'],
    ['tb', 'TCG translation cache in MiB (64-1024).'],
    ['smp', 'guest CPUs, 1-4 (default 1).'],
    ['usb', '0 leaves out the USB tablet (no touch input; for diagnosis).'],
    ['jit', 'runs of a code block before it is compiled to WebAssembly (default 1500; 2147483647 = interpreter only).'],
    ['cpu', 'QEMU CPU model (default Nehalem: SSE4.2 + POPCNT, no AVX).'],
    ['res', 'guest resolution WxH (default 480x800).'],
    ['dpi', 'Android screen density (default derived from res).'],
    ['gfx', '"auto" (default) or "vesa" (adds nomodeset).'],
    ['disk', '"virtio" (default) or "ide".'],
    ['setup', '1 keeps the Android setup wizard (default: skipped).'],
    ['serial', '1 opens the serial console panel at start.'],
    ['cache', 'disk chunks kept in RAM (default 16).'],
    ['parallel', 'concurrent chunk downloads (default 4).'],
    ['prefetch', '1 warms the browser cache with the first chunks in the background.'],
    ['append', 'extra kernel command line arguments.'],
    ['cmdline', 'replace the whole kernel command line.'],
    ['qemu', 'extra QEMU arguments (space separated).'],
    ['fps', 'canvas refresh cap (default 30).'],
];

function intParam(params, name, fallback, min, max) {
    const raw = params.get(name);
    if (raw === null || raw === '') {
        return fallback;
    }
    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, value));
}

function boolParam(params, name, fallback) {
    const raw = params.get(name);
    if (raw === null) {
        return fallback;
    }
    return raw === '' || raw === '1' || raw === 'true' || raw === 'on';
}

// Kernel command line and QEMU argument fragments come from the URL, so
// restrict them to the characters such arguments legitimately need.
function safeWords(raw) {
    if (!raw) {
        return [];
    }
    return raw.split(/\s+/).filter((w) => /^[A-Za-z0-9_=\/.,:@+%-]+$/.test(w));
}

export function isMobile(env) {
    const ua = env.userAgent || '';
    if (/iPhone|iPad|iPod|Android/i.test(ua)) {
        return true;
    }
    // iPadOS reports itself as a Mac; the touch point count gives it away.
    return /Macintosh/.test(ua) && (env.maxTouchPoints || 0) > 1;
}

/**
 * @param {string} search  location.search
 * @param {{userAgent?: string, maxTouchPoints?: number}} env
 */
export function parseConfig(search, env = {}) {
    const params = new URLSearchParams(search);
    const mobile = isMobile(env);
    const base = mobile ? DEFAULTS.mobile : DEFAULTS.desktop;

    let width = 480;
    let height = 800;
    const res = /^(\d{3,4})x(\d{3,4})$/.exec(params.get('res') || '');
    if (res) {
        width = Math.min(1920, Math.max(320, Number(res[1])));
        height = Math.min(1920, Math.max(240, Number(res[2])));
    }
    const autoDpi = Math.round((Math.min(width, height) / 480) * 160 / 20) * 20;

    const cpu = params.get('cpu') || 'Nehalem';
    const cfg = {
        mobile,
        mem: intParam(params, 'mem', base.mem, 512, 3072),
        tb: intParam(params, 'tb', base.tb, 64, 1024),
        wasmmem: intParam(params, 'wasmmem', 0, 512, 4032),
        wasmmemExplicit: params.has('wasmmem'),
        memExplicit: params.has('mem'),
        // One CPU by default: with -smp 2, QEMU-Wasm dies within seconds
        // (first boot test, 2026-11-15).
        smp: intParam(params, 'smp', 1, 1, 4),
        usb: boolParam(params, 'usb', true),
        // -1: keep the build's JIT threshold (tcg/wasm32.h, 1500).
        jit: intParam(params, 'jit', -1, -1, 2147483647),
        cpu: /^[A-Za-z0-9_,+=.-]+$/.test(cpu) ? cpu : 'Nehalem',
        width,
        height,
        dpi: intParam(params, 'dpi', Math.min(480, Math.max(120, autoDpi)), 80, 640),
        gfx: params.get('gfx') === 'vesa' ? 'vesa' : 'auto',
        disk: params.get('disk') === 'ide' ? 'ide' : 'virtio',
        setup: boolParam(params, 'setup', false),
        serial: boolParam(params, 'serial', false),
        cache: intParam(params, 'cache', 16, 4, 256),
        parallel: intParam(params, 'parallel', 4, 1, 8),
        prefetch: boolParam(params, 'prefetch', false),
        fps: intParam(params, 'fps', 30, 1, 60),
        append: safeWords(params.get('append')),
        cmdline: safeWords(params.get('cmdline')),
        qemu: safeWords(params.get('qemu')),
    };
    return cfg;
}

/** WebAssembly memory (MiB, multiple of 64) needed for a config. */
export function requiredWasmMemoryMb(cfg, chunkBytes = 2 * MIB) {
    const cacheMb = Math.ceil((cfg.cache * chunkBytes) / MIB);
    const need = cfg.mem + cfg.tb + QEMU_OVERHEAD_MB + cacheMb;
    return Math.ceil(need / 64) * 64;
}

/**
 * Decide how big the WebAssembly memory should be.
 *
 * Desktop keeps the size the module was linked with whenever the config
 * fits (that is the exact configuration QEMU-Wasm itself is tested with and
 * needs no binary patching).  Phones get the smallest memory that fits,
 * because iOS Safari is far less willing to reserve address space.
 */
export function chooseWasmMemoryMb(cfg, builtMb, chunkBytes = 2 * MIB) {
    if (cfg.wasmmemExplicit && cfg.wasmmem) {
        return Math.ceil(cfg.wasmmem / 64) * 64;
    }
    const need = requiredWasmMemoryMb(cfg, chunkBytes);
    if (cfg.mobile) {
        return need;
    }
    return Math.max(need, builtMb);
}

/**
 * Smaller configurations to fall back to when the browser refuses to
 * allocate the WebAssembly memory.  Returns a list of {mem, tb} pairs, each
 * strictly smaller than the previous one.
 */
export function fallbackLadder(cfg) {
    const steps = [];
    for (const mem of [1536, 1280, 1024, 896, 768]) {
        if (mem < cfg.mem) {
            steps.push({ mem, tb: Math.min(cfg.tb, mem >= 1024 ? 256 : 192) });
        }
    }
    return steps;
}
