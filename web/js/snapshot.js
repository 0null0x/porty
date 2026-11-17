// Resuming a saved Android instead of booting: checks of the snapshot's
// manifest against this build, the QEMU arguments and the chunk index for
// QEMU's "-incoming porty:<index>" (patch 0012, migration/porty-snapshot.c).
// Pure functions (no DOM), shared by the page and by the tests.
// SPDX-License-Identifier: GPL-2.0-or-later

import { PHONE_LEVELS, parseConfig, requiredWasmMemoryMb } from './config.js';

export const SNAPSHOT_DIR = 'snapshot';
export const STAGE_RESUMING = 'Resuming Android';
export const RESUME_FAILED_KEY = 'porty.resumeFailed';

// porty_snapshot_stats()[0]
export const SNAP_IDLE = 0;
export const SNAP_LOADING = 1;
export const SNAP_DONE = 2;
export const SNAP_FAILED = 3;

// URL parameters that shape the machine. A snapshot only fits the machine
// it was saved on, so a visitor who sets one of these gets a normal boot.
const MACHINE_PARAMS = ['mem', 'tb', 'smp', 'usb', 'touch', 'cpu', 'res', 'dpi', 'gfx', 'disk', 'setup',
    'cache', 'parallel', 'append', 'cmdline', 'qemu', 'timescale', 'diet', 'props', 'lowmem', 'ttmfix', 'sffix',
    'anrtraces'];
// Settings of the page and of this device that a resume keeps.
const PAGE_KEYS = ['mobile', 'serial', 'fps', 'prefetch', 'wasmmem', 'wasmmemExplicit', 'jit', 'jitcap', 'jitgc'];

const HEX64 = /^[0-9a-f]{64}$/;
const CHUNK_FILE = /^[0-9A-Za-z_-][0-9A-Za-z._-]*$/;

/** ?resume=1 insists on the snapshot, ?resume=0 on a normal boot. */
export function resumeMode(search) {
    const raw = new URLSearchParams(search).get('resume');
    if (raw === null) {
        return 'auto';
    }
    return raw === '0' || raw === 'false' || raw === 'off' ? 'off' : 'on';
}

/**
 * Why this visit should boot normally although the site may have a
 * snapshot; '' when nothing speaks against resuming.
 *
 * @param {object} o
 * @param {string} o.search    location.search
 * @param {object|null} o.lastRun  crash-guard's interrupted run, if any
 * @param {{message?: string}|null} o.failure  what takeResumeFailure() returned
 */
export function resumeVeto({ search, lastRun = null, failure = null }) {
    const mode = resumeMode(search);
    if (mode === 'off') {
        return 'resume=0 asks for a normal boot';
    }
    if (failure) {
        return `the last attempt failed (${failure.message || 'no details'})`;
    }
    if (mode === 'on') {
        return '';
    }
    if (lastRun && lastRun.stage === STAGE_RESUMING) {
        return 'the browser stopped the last attempt while the saved Android was loading';
    }
    const params = new URLSearchParams(search);
    const set = MACHINE_PARAMS.filter((name) => params.has(name));
    if (set.length) {
        return `the address sets ${set.map((n) => `${n}=`).join(', ')} (add resume=1 to resume anyway)`;
    }
    return '';
}

/** Remember across the reload why resuming failed. False if that is impossible. */
export function storeResumeFailure(storage, message, now = Date.now()) {
    try {
        storage.setItem(RESUME_FAILED_KEY, JSON.stringify({ message: String(message).slice(0, 300), at: now }));
        return storage.getItem(RESUME_FAILED_KEY) !== null;
    } catch (e) {
        return false;
    }
}

/** The failure stored by storeResumeFailure(), once, if it is recent. */
export function takeResumeFailure(storage, now = Date.now()) {
    try {
        const raw = storage.getItem(RESUME_FAILED_KEY);
        if (!raw) {
            return null;
        }
        storage.removeItem(RESUME_FAILED_KEY);
        const failure = JSON.parse(raw);
        return failure && now - failure.at < 10 * 60000 ? failure : null;
    } catch (e) {
        return null;
    }
}

function isCount(v) {
    return Number.isSafeInteger(v) && v > 0;
}

/**
 * Problems that rule out resuming this snapshot on this build (empty: none).
 *
 * @param snap   snapshot/manifest.json
 * @param build  build.json of the site
 */
export function checkSnapshot(snap, build) {
    if (!snap || typeof snap !== 'object') {
        return ['the snapshot manifest is not an object'];
    }
    const problems = [];
    if (snap.format !== 1 || snap.kind !== 'qemu-migration') {
        problems.push(`unknown snapshot format (${snap.format}, ${snap.kind})`);
        return problems;
    }
    if (snap.compression !== 'zlib') {
        problems.push(`unknown compression "${snap.compression}"`);
    }
    const chunkSize = snap.chunk_size;
    if (!isCount(chunkSize) || chunkSize < 4096 || chunkSize > 64 * 1048576) {
        problems.push(`bad chunk size ${chunkSize}`);
    }
    if (!isCount(snap.uncompressed_size)) {
        problems.push(`bad stream size ${snap.uncompressed_size}`);
    }
    const chunks = Array.isArray(snap.chunks) ? snap.chunks : [];
    if (!problems.length && chunks.length !== Math.ceil(snap.uncompressed_size / chunkSize)) {
        problems.push(`${chunks.length} chunks do not cover ${snap.uncompressed_size} bytes`);
    }
    const bad = chunks.findIndex((c) => !c || typeof c.file !== 'string' || !CHUNK_FILE.test(c.file) ||
        c.file.includes('..') || !isCount(c.size) || !HEX64.test(c.sha256 || ''));
    if (bad >= 0) {
        problems.push(`chunk ${bad} is malformed`);
    }
    if (!Array.isArray(snap.argv) || !snap.argv.length || snap.argv.some((a) => typeof a !== 'string')) {
        problems.push('the QEMU arguments are missing');
    } else if (snap.argv.includes('-incoming')) {
        problems.push('the QEMU arguments already contain -incoming');
    }
    if (typeof snap.query !== 'string') {
        problems.push('the configuration (query) is missing');
    }
    // Saved by another QEMU, with other patches or for another image: the
    // device state would not fit this machine.
    for (const [key, what] of [
        ['qemu_wasm_commit', 'QEMU-Wasm commit'],
        ['porty_patches_sha256', 'set of QEMU patches'],
        ['image_manifest_sha256', 'Android image'],
    ]) {
        if (!snap[key] || !build || snap[key] !== build[key]) {
            problems.push(`it was saved with a different ${what}`);
        }
    }
    return problems;
}

function argAfter(argv, flag) {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

/** Split a QEMU option string at single commas (",," is an escaped comma). */
function splitOptions(value) {
    const parts = [];
    let current = '';
    for (let i = 0; i < value.length; i++) {
        if (value[i] === ',' && value[i + 1] === ',') {
            current += ',,';
            i++;
        } else if (value[i] === ',') {
            parts.push(current);
            current = '';
        } else {
            current += value[i];
        }
    }
    parts.push(current);
    return parts;
}

function optionValue(options, name) {
    for (const value of options) {
        const hit = splitOptions(value).find((p) => p.startsWith(`${name}=`));
        if (hit) {
            return hit.slice(name.length + 1);
        }
    }
    return null;
}

/**
 * The configuration a resume runs with: the snapshot's own (its query and,
 * for the memory sizes, its QEMU arguments), whatever this visitor's
 * defaults are; only page-side settings are taken from the visitor.
 *
 * @param snap     a manifest that passed checkSnapshot()
 * @param userCfg  parseConfig() result for this visit
 * @param env      what parseConfig() got for this visit
 * @returns {{cfg: object, problems: string[]}}
 */
export function snapshotConfig(snap, userCfg, env = {}) {
    const cfg = parseConfig(`?${snap.query}`, env);
    for (const key of PAGE_KEYS) {
        if (userCfg[key] !== undefined) {
            cfg[key] = userCfg[key];
        }
    }
    const problems = [];
    const mem = /^(\d+)M?$/.exec(argAfter(snap.argv, '-m') || '');
    if (mem) {
        cfg.mem = Number(mem[1]);
    } else {
        problems.push('its QEMU arguments have no "-m <MiB>M"');
    }
    const drives = snap.argv.filter((a, i) => snap.argv[i - 1] === '-drive');
    const tb = Number(optionValue([argAfter(snap.argv, '-accel') || ''], 'tb-size'));
    const cache = Number(optionValue(drives, 'file.cache-chunks'));
    if (tb > 0) {
        cfg.tb = tb;
    }
    if (cache > 0) {
        cfg.cache = cache;
    }
    // The snapshot decides the memory: no smaller steps, no fallbacks.
    cfg.memExplicit = true;
    cfg.memoryExplicit = true;
    delete cfg.phoneLevel;
    cfg.resume = true;
    if (cfg.mobile) {
        const limit = requiredWasmMemoryMb({ ...cfg, ...PHONE_LEVELS[0] });
        const need = requiredWasmMemoryMb(cfg);
        if (need > limit) {
            problems.push(`it needs ${need} MiB of memory, more than the ${limit} MiB a phone gets`);
        }
    }
    return { cfg, problems };
}

/**
 * The snapshot's QEMU arguments with the paths of this page, plus the
 * incoming stream.  Only where files live changes; the machine does not.
 *
 * @param snap       a manifest that passed checkSnapshot()
 * @param paths      { bios, kernel, initrd, ramdisk, diskUrl } as for buildQemuArgs()
 * @param indexPath  where the page puts snapshotIndex() in QEMU's filesystem
 */
export function snapshotArgs(snap, paths, indexPath) {
    const esc = (s) => String(s).replace(/,/g, ',,');
    const direct = { '-L': paths.bios, '-kernel': paths.kernel, '-initrd': paths.initrd };
    const args = snap.argv.map((arg, i) => {
        const flag = snap.argv[i - 1];
        if (Object.prototype.hasOwnProperty.call(direct, flag)) {
            return direct[flag];
        }
        if (flag !== '-drive') {
            return arg;
        }
        return splitOptions(arg).map((part) => {
            if (part.startsWith('file.url=')) {
                return `file.url=${esc(paths.diskUrl)}`;
            }
            if (part.startsWith('file=')) {
                return `file=${esc(paths.ramdisk)}`;
            }
            return part;
        }).join(',');
    });
    return [...args, '-incoming', `porty:${indexPath}`];
}

/**
 * The chunk index QEMU reads (format: migration/porty-snapshot.c).
 *
 * @param snap  a manifest that passed checkSnapshot()
 * @param url   base URL (or directory) of the chunk files; '' leaves it
 *              out, and QEMU then looks next to the index file
 * @param tag   true adds "?v=<hash>" to every file, so that a cache can
 *              never serve a chunk of another snapshot; 16 hex digits
 *              that name the snapshot add "&s=<them>" as well, which the
 *              disk cache keys its versions by (diskcache-sw.js)
 */
export function snapshotIndex(snap, url = '', tag = false) {
    const lines = ['porty-snapshot 1'];
    if (url) {
        if (/\s/.test(url)) {
            throw new Error('the snapshot URL contains white space');
        }
        lines.push(`url ${url}`);
    }
    lines.push(`chunk-size ${snap.chunk_size}`, `size ${snap.uncompressed_size}`);
    const version = typeof tag === 'string' && /^[0-9a-f]{16}$/.test(tag) ? `&s=${tag}` : '';
    for (const c of snap.chunks) {
        lines.push(`chunk ${c.size} ${c.sha256} ${c.file}${tag ? `?v=${c.sha256.slice(0, 16)}${version}` : ''}`);
    }
    return `${lines.join('\n')}\n`;
}

/** porty_snapshot_stats() as an object, with the share of the stream loaded. */
export function readSnapshotStats(s) {
    const total = s[6] || 1;
    return {
        state: s[0],
        chunksTotal: s[1],
        chunksFetched: s[2],
        fetchedMb: s[3] / 1024,
        compressedMb: s[4] / 1024,
        loadedMb: s[5] / 1024,
        totalMb: s[6] / 1024,
        errors: s[7],
        progress: Math.min(1, s[5] / total),
    };
}

/** One line for the progress display. */
export function describeResume(stats) {
    return `${stats.fetchedMb.toFixed(0)} of ${stats.compressedMb.toFixed(0)} MB downloaded` +
        (stats.errors ? `, ${stats.errors} download retries` : '');
}
