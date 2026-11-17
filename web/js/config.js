// Porty configuration: URL parameters -> a validated config object.
// Pure functions only (no DOM), so the same code runs under node for tests.
// SPDX-License-Identifier: GPL-2.0-or-later

import { parseProps } from './boot-diet.js';

export const MIB = 1024 * 1024;
export const WASM_PAGE = 65536;

// Memory QEMU itself needs on top of guest RAM, the TCG code buffer and the
// disk chunk cache: VGA memory, BIOS/option ROMs, glib/QEMU heaps, thread
// and coroutine stacks, softmmu TLBs. Measured with porty_heap_stats() and
// dlmalloc: about 290 MiB through Android's boot, about 110 MiB since patch
// 0008 shrank the coroutines (2026-11-16). The rest is headroom on purpose:
// QEMU quietly keeps smaller TLBs when the heap is full, and a boot with
// 2 MiB to spare ran several times slower.
export const QEMU_OVERHEAD_MB = 352;

// Phones, from the default down: what a start uses after Safari killed the
// previous one (see crash-guard.js), and the fallbacks when the browser
// refuses the WebAssembly memory.  iOS reloads a tab whose memory goes much
// past 1.5 GB (WebKit bug 277848), and the browser's own share (compiled
// code, the page) comes on top of the WebAssembly memory, so phones keep
// the guest small.  In the boot tests 768/128/16 was not slower than the
// desktop settings: Android's shell after 8 minutes, the boot animation
// after about 30.
export const PHONE_LEVELS = [
    { mem: 768, tb: 128, cache: 16 },
    { mem: 640, tb: 96, cache: 12 },
    { mem: 512, tb: 64, cache: 8 },
];

const DEFAULTS = {
    // 1536 MiB ran QEMU-Wasm out of its 2300 MiB at the virtio disk probe
    // (boot tests, 2026-11-15); 1024 boots through to Android's init.
    // cache: 2 MiB disk chunks kept in RAM. With 16, a boot re-downloaded
    // 1.25 GB for a 943 MB image and reached each stage later than with 64.
    // jitcap: compiled code blocks alive at once (0: the build's 15000).
    // Each is a module in the browser's own heap, so phones keep fewer.
    // jitring, jitpolicy: QEMU patches 0022-0024 (the module ring and the
    // JIT cache policies), 0: off, QEMU-Wasm as before.
    desktop: { mem: 1024, tb: 384, cache: 64, jitcap: 0, jitring: 0, jitpolicy: 0 },
    mobile: { ...PHONE_LEVELS[0], jitcap: 4000, jitring: 0, jitpolicy: 0 },
    // iPhones and iPads, where every browser is WebKit.  There the time of
    // an app launch went to translating blocks again after the translation
    // cache was flushed (every 6-10 s, as compiled forms took 80% of it) and
    // to waiting at the cap for the collector to take dropped blocks.  The
    // module ring keeps compiled forms out of the cache (one flush per
    // launch instead of 13), and 8000 blocks hold the launch's working set:
    // Gallery in 75 s instead of 112 s, with no higher peak memory (WebKit
    // on Linux, A/B run 44098484966).  Chrome and desktops were not faster.
    ios: { ...PHONE_LEVELS[0], jitcap: 8000, jitring: 24576, jitpolicy: 6 },
};

export const PARAM_HELP = [
    ['mem', 'guest RAM in MiB (512-3072). Default 1024, phones 768 (1536 runs out of WebAssembly memory).'],
    ['wasmmem', 'size of the WebAssembly memory in MiB. Default: sized to fit.'],
    ['tb', 'TCG translation cache in MiB (64-1024). Default 384, phones 128.'],
    ['smp', 'guest CPUs, 1-4 (default 1).'],
    ['touch', '1 gives Android a touchscreen (virtio multitouch: taps, swipes and two-finger gestures as on a phone; a mouse acts as one finger, its wheel drags, its right button is Back) instead of the USB tablet (default 0: a mouse, an arrow follows the finger and a tap is a click). Off by default for now: with a touchscreen, apps take about twice as long to draw their first frame.'],
    ['usb', '0 leaves out the pointing device, touchscreen or USB tablet (no touch input; for diagnosis).'],
    ['jit', 'runs of a code block before it is compiled to WebAssembly (default 1500; 2147483647 = interpreter only).'],
    ['jitcap', 'compiled code blocks kept at once (256-15000; default 15000, phones 4000, iPhones and iPads 8000).'],
    ['jitgc', '0: dropped compiled blocks stop counting at once instead of after garbage collection (experiment).'],
    ['jitpolicy', 'JIT cache policies, bits (default 0, iPhones and iPads 6): 1 compile at once after a flush what was hot before it, 2 at the cap give the blocks that ran since the last drop a second chance, 4 translate again a hot block whose module was overwritten in the module ring. 0 = as before.'],
    ['jitring', 'KiB of the ring that keeps the compiled forms of code blocks out of the translation cache (default 0 = in the cache, as before; iPhones and iPads 24576).'],
    ['timescale', 'guest time runs this many times slower than real time (1-16, default 8; 1 = real time), so Android\'s timeouts allow for a slow emulator. The guest\'s clock then falls behind.'],
    ['cpu', 'QEMU CPU model (default Nehalem: SSE4.2 + POPCNT, no AVX).'],
    ['res', 'guest resolution WxH (default 480x800).'],
    ['dpi', 'Android screen density (default derived from res).'],
    ['gfx', '"auto" (default) or "vesa" (adds nomodeset).'],
    ['disk', '"virtio" (default) or "ide".'],
    ['setup', '1 keeps the Android setup wizard, which stops without Google\'s services (default: the page hides it and marks Android as set up, see boot-diet.js).'],
    ['serial', '1 opens the serial console panel at start.'],
    ['cache', '2 MiB disk chunks kept in RAM (default 64, phones 16).'],
    ['parallel', 'concurrent chunk downloads (default 4).'],
    ['prefetch', '1 warms the browser cache with the first chunks in the background.'],
    ['append', 'extra kernel command line arguments.'],
    ['cmdline', 'replace the whole kernel command line.'],
    ['qemu', 'extra QEMU arguments (space separated).'],
    ['fps', 'canvas refresh cap (default 30).'],
    ['diet', 'Android properties that shorten the boot: 1 (default) no boot animation and no first-boot app verification, 0 none, 2 also a 64-bit-only Android (experiment).'],
    ['props', 'more Android properties, key=value,key=value (letters, digits, . _ -); they override diet.'],
    ['lowmem', '0 leaves Android\'s low memory killer as shipped: it then ends every app that is left for another within seconds (default 1: background apps stay until memory is critically short, see boot-diet.js).'],
    ['ttmfix', '0 leaves the kernel module ttm.ko as shipped: the guest then panics when Android collects stack traces (for diagnosis).'],
    ['sffix', '0 leaves surfaceflinger as shipped: it then composes the same picture on every vsync while a deferred transaction waits, for up to minutes after an app starts (see boot-diet.js).'],
    ['anrtraces', '1 keeps Android\'s stack dumps for "not responding" reports (in /data/anr) (default 0: the report and its dialog, and the culprit\'s own stacks only; see boot-diet.js).'],
    ['resume', '1 resumes the saved Android even with other settings in the address; 0 always boots.'],
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
    if (/Android/i.test(ua)) {
        return true;
    }
    return isAppleMobile(env);
}

/** iPhone, iPad or iPod: every browser there is WebKit. */
export function isAppleMobile(env) {
    const ua = env.userAgent || '';
    if (/iPhone|iPad|iPod/i.test(ua)) {
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
    const base = isAppleMobile(env) ? DEFAULTS.ios : (mobile ? DEFAULTS.mobile : DEFAULTS.desktop);

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
        // Any memory parameter in the URL: then phones never step down.
        memoryExplicit: ['mem', 'tb', 'cache', 'wasmmem'].some((n) => params.has(n)),
        // tb= also applies to a resume (snapshot.js): the translation cache
        // is not part of the saved machine.
        tbExplicit: params.has('tb'),
        // One CPU by default: with -smp 2, QEMU-Wasm dies within seconds
        // (first boot test, 2026-11-15).
        smp: intParam(params, 'smp', 1, 1, 4),
        // false: no pointing device at all (diagnosis).
        usb: boolParam(params, 'usb', true),
        // Android's pointing device: with touch=1 a touchscreen
        // (virtio-multitouch-pci, QEMU patch 0020 feeds it), by default the
        // USB tablet, which Android-x86 drives as a mouse.  Off by default
        // since 2026-11-17: with the touchscreen in the machine, Gallery's
        // first frame took 2.3-2.5x as long natively (guest-cpu runs
        // 44137863037, 44142443850, 44142458128; with am start too, so not
        // the events) and about 5x in the browser.  Not the USB controller,
        // touch mode or anrtraces; still being looked into.
        touch: boolParam(params, 'touch', false),
        // -1: keep the build's JIT threshold (tcg/wasm32.h, 1500).
        jit: intParam(params, 'jit', -1, -1, 2147483647),
        jitcap: intParam(params, 'jitcap', base.jitcap, 0, 15000),
        jitcapExplicit: params.has('jitcap'),
        // false: patch 0010's "do not wait for the garbage collector".
        jitgc: boolParam(params, 'jitgc', true),
        // QEMU patches 0022-0024 (see PARAM_HELP); -1: the build's defaults (off).
        jitpolicy: intParam(params, 'jitpolicy', base.jitpolicy, -1, 7),
        jitring: intParam(params, 'jitring', base.jitring, -1, 262144),
        // Patch 0011's time dilation: the guest's clocks (and with them
        // Android's 60 s Watchdog) run this many times slower. 1: off.
        // Default 8: the first boots to sys.boot_completed in a browser
        // (2026-11-16, docs/PLAN.md, eighth round) all had it; without it
        // the Watchdog and the stack dumps after every ANR never let the
        // boot finish.
        timescale: intParam(params, 'timescale', 8, 1, 16),
        cpu: /^[A-Za-z0-9_,+=.-]+$/.test(cpu) ? cpu : 'Nehalem',
        width,
        height,
        dpi: intParam(params, 'dpi', Math.min(480, Math.max(120, autoDpi)), 80, 640),
        gfx: params.get('gfx') === 'vesa' ? 'vesa' : 'auto',
        disk: params.get('disk') === 'ide' ? 'ide' : 'virtio',
        setup: boolParam(params, 'setup', false),
        serial: boolParam(params, 'serial', false),
        cache: intParam(params, 'cache', base.cache, 4, 256),
        parallel: intParam(params, 'parallel', 4, 1, 8),
        prefetch: boolParam(params, 'prefetch', false),
        fps: intParam(params, 'fps', 30, 1, 60),
        append: safeWords(params.get('append')),
        cmdline: safeWords(params.get('cmdline')),
        qemu: safeWords(params.get('qemu')),
        // Boot diet (boot-diet.js): property set 0-2, plus ?props=k=v,k=v.
        diet: intParam(params, 'diet', 1, 0, 2),
        props: parseProps(params.get('props')).props,
        propsRejected: parseProps(params.get('props')).rejected,
        // false: lmkd's own levels (boot-diet.js, LOWMEM_PROPS).
        lowmem: boolParam(params, 'lowmem', true),
        // false: no patched ttm.ko (boot-diet.js, TTM_FIX).
        ttmfix: boolParam(params, 'ttmfix', true),
        // false: surfaceflinger as shipped (boot-diet.js, SF_FIX).
        sffix: boolParam(params, 'sffix', true),
        // true: Android's own ANR dumps (boot-diet.js, ANR_TRACES).
        anrtraces: boolParam(params, 'anrtraces', false),
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
 * A phone config with the memory of PHONE_LEVELS[level] (clamped to the
 * list).  Desktops and URLs that set any memory parameter keep theirs.
 */
export function applyPhoneLevel(cfg, level) {
    if (!cfg.mobile || cfg.memoryExplicit || !(level > 0)) {
        return cfg;
    }
    const step = PHONE_LEVELS[Math.min(PHONE_LEVELS.length - 1, Math.floor(level))];
    // After a start the browser killed, iPhones also go back to other
    // phones' cap on compiled blocks.
    const cap = !cfg.jitcapExplicit && cfg.jitcap > DEFAULTS.mobile.jitcap ? { jitcap: DEFAULTS.mobile.jitcap } : {};
    return { ...cfg, ...step, ...cap, phoneLevel: PHONE_LEVELS.indexOf(step) };
}

/**
 * Smaller configurations to fall back to when the browser refuses to
 * allocate the WebAssembly memory.  Returns a list of {mem, tb} pairs (on
 * phones {mem, tb, cache}), each strictly smaller than the previous one.
 */
export function fallbackLadder(cfg) {
    if (cfg.mobile) {
        return PHONE_LEVELS.filter((step) => step.mem < cfg.mem).map((step) => ({ ...step }));
    }
    const steps = [];
    for (const mem of [1536, 1280, 1024, 896, 768]) {
        if (mem < cfg.mem) {
            steps.push({ mem, tb: Math.min(cfg.tb, mem >= 1024 ? 256 : 192) });
        }
    }
    return steps;
}
