// Runs the deployed Porty site in Playwright's WebKit build (the engine of
// iPhone Safari, here on Linux) or, with the same script, in Chrome, and
// measures what the phone budget gets there:
//
//   1. what the browser supports (cross-origin isolation through the page's
//      service worker, SharedArrayBuffer, Atomics.wait and synchronous XHR
//      in workers, large shared WebAssembly memories),
//   2. a model of QEMU-Wasm's JIT in a worker: thousands of small
//      WebAssembly modules instantiated synchronously, called through a
//      table, dropped and collected (time per module, how call speed
//      changes as the engine tiers up, memory per module, whether a
//      FinalizationRegistry reports dropped instances),
//   3. the resume itself: time to resume and to the first frame, a shell
//      loop timed from outside, then a finger tap on the Gallery icon and
//      the time until Gallery has the focus, with QEMU's JIT statistics and
//      the resident memory of the browser's processes along the way.
//
// usage: node tests/boot/webkit-test.mjs
//   SITE_URL        deployed site, with trailing slash (required)
//   QUERY           page parameters, e.g. "wasmmem=1280&jitcap=4000"
//   BROWSER         webkit (default) or chrome
//   DEVICE          iphone (default: an iPhone's user agent, so the page
//                   takes its phone defaults) or desktop
//   MINUTES         deadline for the whole run (default 30)
//   PROBE_SECONDS   how long to wait for Gallery after the tap (default 480)
//   BENCH           0 skips part 2; "only" stops after it
//   BENCH_MODULES   modules in part 2 (default 8000)
//   COI             sw (the page's service worker), route (the test adds
//                   COOP/COEP to the responses itself) or auto (default:
//                   sw, then route if the page does not become isolated)
//   PLAYWRIGHT_DIR  directory that has node_modules/playwright-core
//   CHROME          Chrome binary for BROWSER=chrome (default: Playwright's
//                   "chrome" channel, the installed Google Chrome)
//   STATUS_CONTEXT  commit status context (default porty/webkit, for
//                   Chrome porty/webkit-chrome); the query is appended
//
// Always exits 0 (2 on bad usage): the verdict is in the log, in a "RESULT"
// line of JSON, the job summary and a commit status.
// SPDX-License-Identifier: GPL-2.0-or-later
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(path.join(process.env.PLAYWRIGHT_DIR || process.cwd(), 'noop.js'));
const playwright = require('playwright-core');

const siteUrl = process.env.SITE_URL || '';
if (!/^https?:\/\/.+\/$/.test(siteUrl)) {
    console.error('SITE_URL must be the site root with a trailing slash');
    process.exit(2);
}
const browserName = (process.env.BROWSER || 'webkit').toLowerCase();
if (!['webkit', 'chrome'].includes(browserName)) {
    console.error('BROWSER must be webkit or chrome');
    process.exit(2);
}
const device = (process.env.DEVICE || 'iphone').toLowerCase();
const minutes = Math.max(3, Math.min(240, Number(process.env.MINUTES) || 30));
const probeSeconds = Math.max(30, Math.min(3600, Number(process.env.PROBE_SECONDS) || 480));
const benchMode = (process.env.BENCH || '1').toLowerCase();
const benchModules = Math.max(500, Math.min(15000, Number(process.env.BENCH_MODULES) || 8000));
const coiMode = (process.env.COI || 'auto').toLowerCase();
const queryText = (process.env.QUERY || '').trim().replace(/^\?/, '');
const params = new URLSearchParams(queryText);
params.set('serial', '1');
const url = `${siteUrl}?${params}`;
const statusContext = `${process.env.STATUS_CONTEXT ||
    (browserName === 'webkit' ? 'porty/webkit' : 'porty/webkit-chrome')} ${queryText || 'defaults'}`.slice(0, 100);

const t0 = Date.now();
const elapsed = () => {
    const s = Math.floor((Date.now() - t0) / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const log = (msg) => console.log(`[${elapsed()}] ${msg}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// eslint-disable-next-line no-control-regex
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b[()][A-Z0-9]/g, '');
const secs = (ms) => Math.round(ms / 100) / 10;

// Everything worth comparing between runs ends up here ("RESULT" line).
const result = {
    browser: browserName, device, query: queryText, version: '', coi: '', features: null, bench: null,
    boot: {}, probe: {}, jit: [], memory: [], crashed: false, errors: [],
};
const note = (msg) => {
    result.errors.push(msg.slice(0, 300));
    log(msg);
};

// ------------------------------------------------------------ processes ---
// Resident memory of the browser's processes, from /proc: the browser is a
// child of this script, the web content (renderer) processes its children.
function readProc(pid) {
    try {
        const status = readFileSync(`/proc/${pid}/status`, 'utf8');
        const kb = (name) => Number((new RegExp(`^${name}:\\s+(\\d+) kB`, 'm').exec(status) || [0, 0])[1]);
        const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
        return {
            pid,
            ppid: Number((/^PPid:\s+(\d+)/m.exec(status) || [0, 0])[1]),
            name: (/^Name:\s+(.*)$/m.exec(status) || ['', '?'])[1],
            cmd,
            rss: kb('VmRSS'), anon: kb('RssAnon'), file: kb('RssFile'), shmem: kb('RssShmem'),
            swap: kb('VmSwap'), threads: Number((/^Threads:\s+(\d+)/m.exec(status) || [0, 0])[1]),
        };
    } catch (e) {
        return null;
    }
}

function browserProcesses() {
    const all = new Map();
    for (const entry of readdirSync('/proc')) {
        if (/^\d+$/.test(entry)) {
            const p = readProc(Number(entry));
            if (p) {
                all.set(p.pid, p);
            }
        }
    }
    const mine = [];
    for (const p of all.values()) {
        let q = p;
        for (let depth = 0; q && depth < 12; depth++) {
            if (q.ppid === process.pid) {
                mine.push(p);
                break;
            }
            q = all.get(q.ppid);
        }
    }
    return mine;
}

/** Is this the process that runs the page (WebKit: web process, Chrome: renderer)? */
function isContentProcess(p) {
    return /WebProcess/.test(p.name) || p.cmd.some((a) => /WebProcess$/.test(a)) || p.cmd.includes('--type=renderer');
}

/** Resident kB inside mappings of 1 GiB or more: the WebAssembly memory. */
function bigMappings(pid) {
    try {
        let size = 0;
        let big = { n: 0, sizeKb: 0, rssKb: 0 };
        for (const line of readFileSync(`/proc/${pid}/smaps`, 'utf8').split('\n')) {
            const m = /^(Size|Rss):\s+(\d+) kB/.exec(line);
            if (!m) {
                continue;
            }
            if (m[1] === 'Size') {
                size = Number(m[2]);
                if (size >= 1048576) {
                    big = { ...big, n: big.n + 1, sizeKb: big.sizeKb + size };
                }
            } else if (size >= 1048576) {
                big.rssKb += Number(m[2]);
            }
        }
        return big;
    } catch (e) {
        return null;
    }
}

const mb = (kb) => Math.round(kb / 1024);

/** {pid, name, rss, anon, file, shmem (MiB), total, count} of the biggest content process. */
function memorySample(withMaps = false) {
    const procs = browserProcesses();
    const content = procs.filter(isContentProcess).sort((a, b) => b.rss - a.rss);
    const top = content[0] || procs.slice().sort((a, b) => b.rss - a.rss)[0];
    if (!top) {
        return null;
    }
    const out = {
        pid: top.pid, name: top.name, rss: mb(top.rss), anon: mb(top.anon), file: mb(top.file),
        shmem: mb(top.shmem), swap: mb(top.swap), threads: top.threads,
        total: mb(procs.reduce((sum, p) => sum + p.rss, 0)), count: procs.length,
        // All content processes together: the JIT model compares this.
        content: mb(content.reduce((sum, p) => sum + p.rss, 0)),
    };
    if (withMaps) {
        const big = bigMappings(top.pid);
        if (big) {
            out.bigMaps = big.n;
            out.bigRss = mb(big.rssKb);
            out.rest = out.rss - out.bigRss;
        }
    }
    return out;
}

const describeMemory = (m) => (m ? `${m.name}[${m.pid}] rss=${m.rss} anon=${m.anon} file=${m.file} shmem=${m.shmem}` +
    (m.bigRss !== undefined ? ` wasm-mapped=${m.bigRss} rest=${m.rest}` : '') +
    ` threads=${m.threads}; content processes ${m.content} MiB, all ${m.count} processes ${m.total} MiB` : 'no browser process found');

// -------------------------------------------------------------- browser ---
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 ' +
    '(KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
let browser;
let page;
let closing = false;
try {
    if (browserName === 'webkit') {
        browser = await playwright.webkit.launch({ headless: true });
    } else {
        browser = await playwright.chromium.launch({
            headless: true,
            ...(process.env.CHROME ? { executablePath: process.env.CHROME } : { channel: 'chrome' }),
            args: ['--no-sandbox', '--disable-gpu', '--disable-background-timer-throttling',
                '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
        });
    }
    result.version = `${browserName} ${browser.version()}`;
    const context = await browser.newContext({
        viewport: { width: 480, height: 900 },
        hasTouch: true,
        ...(device === 'iphone' ? { userAgent: IPHONE_UA } : {}),
    });
    page = await context.newPage();
} catch (e) {
    console.log(`::warning title=Porty WebKit test::the browser did not start: ${String(e.message || e).split('\n')[0]}`);
    console.log(e.stack || e);
    await postStatus('error', `the browser did not start: ${String(e.message || e).split('\n')[0]}`);
    process.exit(0);
}
log(`browser: ${result.version}, device=${device}, playwright ${require('playwright-core/package.json').version}`);
page.setDefaultTimeout(120000);
page.on('pageerror', (e) => note(`pageerror: ${(e && e.stack) || e}`));
page.on('crash', () => {
    result.crashed = true;
    note('PAGE CRASHED (the web content process died)');
});
browser.on('disconnected', () => {
    if (!closing) {
        result.crashed = true;
        note('BROWSER DISCONNECTED');
    }
});
let consoleLines = 0;
page.on('console', (m) => {
    const type = m.type();
    if (type === 'error' || ((type === 'warning' || type === 'warn') && consoleLines < 300)) {
        consoleLines++;
        log(`console.${type}: ${m.text().slice(0, 600)}`);
    }
});
page.on('worker', (w) => log(`worker started: ${w.url().split('/').pop().split('?')[0].slice(0, 60)}`));

async function postStatus(state, description) {
    const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo, GITHUB_SHA: sha } = process.env;
    if (!token || !repo || !sha) {
        return;
    }
    const server = process.env.GITHUB_SERVER_URL || 'https://github.com';
    const api = process.env.GITHUB_API_URL || 'https://api.github.com';
    try {
        const res = await fetch(`${api}/repos/${repo}/statuses/${sha}`, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${token}`,
                accept: 'application/vnd.github+json',
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                state,
                context: statusContext,
                description: description.replace(/\s+/g, ' ').slice(0, 139),
                target_url: `${server}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID || ''}`,
            }),
        });
        if (!res.ok) {
            log(`status update failed: HTTP ${res.status}`);
        }
    } catch (e) {
        log(`status update failed: ${e.message}`);
    }
}

function emit(name, info, b64) {
    log(`screenshot ${name}: ${info}, ${b64.length} base64 chars`);
    console.log(`-----BEGIN PORTY SCREENSHOT ${name.replace(/\s+/g, '_')} ${info}-----`);
    for (let i = 0; i < b64.length; i += 1000) {
        console.log(b64.slice(i, i + 1000));
    }
    console.log('-----END PORTY SCREENSHOT-----');
}

/** Print a screenshot of the page (same markers as boot-test.mjs). */
async function shot(label) {
    try {
        const buf = await page.screenshot({ type: 'jpeg', quality: 55, timeout: 20000 });
        emit(`page ${label}`, '480x900', buf.toString('base64'));
    } catch (e) {
        log(`screenshot ${label} failed: ${String(e.message).split('\n')[0]}`);
    }
}

// ----------------------------------------------------- part 1: features ---
/** Runs in the page. */
async function featureProbe() {
    const out = {
        userAgent: navigator.userAgent,
        cores: navigator.hardwareConcurrency,
        crossOriginIsolated: globalThis.crossOriginIsolated,
        secureContext: globalThis.isSecureContext,
        serviceWorker: 'serviceWorker' in navigator,
        swControls: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
        sharedArrayBuffer: typeof SharedArrayBuffer,
        atomics: typeof Atomics,
        waitAsync: typeof Atomics === 'object' && typeof Atomics.waitAsync,
        finalizationRegistry: typeof FinalizationRegistry,
        weakRef: typeof WeakRef,
        wasm: typeof WebAssembly,
        wakeLock: 'wakeLock' in navigator,
        memory: {},
    };
    // The clock QEMU sees: its resolution.
    {
        let min = Infinity;
        let last = performance.now();
        for (let i = 0; i < 200000; i++) {
            const now = performance.now();
            if (now > last) {
                min = Math.min(min, now - last);
                last = now;
            }
        }
        out.clockStepMs = min;
    }
    // Shared WebAssembly memories of the sizes Porty asks for (phone, desktop).
    for (const mib of [1280, 2304]) {
        const t = performance.now();
        try {
            const m = new WebAssembly.Memory({ initial: mib * 16, maximum: mib * 16, shared: true });
            const bytes = new Uint8Array(m.buffer);
            bytes[bytes.length - 1] = 1;
            out.memory[mib] = `ok (${m.buffer.constructor.name}, ${Math.round(performance.now() - t)} ms)`;
        } catch (e) {
            out.memory[mib] = `refused: ${e}`;
        }
    }
    // In a worker: Atomics.wait, synchronous XHR (how QEMU's disk and
    // snapshot threads fetch), a shared memory posted from the page.
    const source = `
        self.onmessage = (ev) => {
            const r = { crossOriginIsolated: self.crossOriginIsolated, sharedArrayBuffer: typeof SharedArrayBuffer };
            try {
                const ia = new Int32Array(ev.data.sab || new SharedArrayBuffer(8));
                const t = performance.now();
                r.atomicsWait = Atomics.wait(ia, 0, 0, 20) + ' after ' + Math.round(performance.now() - t) + ' ms';
                r.sharedSeen = ev.data.sab ? ia[1] : 'not posted';
            } catch (e) {
                r.atomicsWait = 'threw: ' + e;
            }
            try {
                const times = [];
                let bytes = 0;
                for (let i = 0; i < 12; i++) {
                    const t = performance.now();
                    const xhr = new XMLHttpRequest();
                    xhr.open('GET', ev.data.url + '?probe=' + i, false);
                    xhr.responseType = 'arraybuffer';
                    xhr.send(null);
                    if (xhr.status !== 200) {
                        throw new Error('HTTP ' + xhr.status);
                    }
                    bytes = xhr.response.byteLength;
                    times.push(performance.now() - t);
                }
                times.sort((a, b) => a - b);
                r.syncXhr = 'ok, ' + bytes + ' bytes, median ' + times[6].toFixed(1) + ' ms, min ' +
                    times[0].toFixed(1) + ', max ' + times[11].toFixed(1);
            } catch (e) {
                r.syncXhr = 'failed: ' + e;
            }
            self.postMessage(r);
        };`;
    const run = (data) => new Promise((resolve) => {
        let worker;
        const done = (v) => {
            clearTimeout(timer);
            if (worker) {
                worker.terminate();
            }
            resolve(v);
        };
        const timer = setTimeout(() => done({ error: 'no answer within 60 s' }), 60000);
        try {
            worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
            worker.onmessage = (ev) => done(ev.data);
            worker.onerror = (ev) => done({ error: `worker error: ${ev.message}` });
            worker.postMessage(data);
        } catch (e) {
            done({ error: `cannot start a worker: ${e}` });
        }
    });
    const probeUrl = new URL('build.json', location.href).href;
    let sab = null;
    try {
        sab = new SharedArrayBuffer(8);
        new Int32Array(sab)[1] = 42;
    } catch (e) {
        out.sabError = String(e);
    }
    try {
        out.worker = await run({ url: probeUrl, sab });
    } catch (e) {
        // A SharedArrayBuffer that cannot be posted throws here.
        out.postError = String(e);
        out.worker = await run({ url: probeUrl, sab: null });
    }
    return out;
}

// --------------------------------------------------- part 2: JIT model ---
/**
 * Runs in the page: starts a worker that models QEMU-Wasm's JIT and returns
 * nothing; the worker is then driven with jitModel(command).
 *
 * QEMU-Wasm compiles every hot translation block to a WebAssembly module of
 * its own with "new WebAssembly.Module" and "new WebAssembly.Instance" in
 * the vCPU's worker, puts its one export into the main module's table and
 * calls it from there with call_indirect.  Dropped blocks are taken out of
 * the table, and a FinalizationRegistry counts the ones the collector freed.
 */
function startJitModel() {
    const source = `
    const leb = (v) => { const o = []; do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; o.push(b); } while (v); return o; };
    const sleb = (v) => { const o = []; for (;;) { const b = v & 0x7f; v >>= 7;
        if ((v === 0 && !(b & 0x40)) || (v === -1 && (b & 0x40))) { o.push(b); return o; } o.push(b | 0x80); } };
    const str = (s) => [...leb(s.length), ...[...s].map((c) => c.charCodeAt(0))];
    const section = (id, body) => [id, ...leb(body.length), ...body];
    const HEAD = [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0];
    let pages = 256, shared = true, memory, table, run, registry, collected = 0, made = 0;
    // One "translation block": loads, a few dozen ALU operations, a store,
    // a helper call that is never taken.  k makes every module different.
    function block(k) {
        const body = [1, 1, 0x7f, 0x20, 0, 0x28, 2, 0, 0x21, 1];
        for (let j = 0; j < 24; j++) {
            body.push(0x20, 1, 0x41, ...sleb((k * 31 + j) | 0), 0x6a, 0x20, 1, 0x41, 3, 0x74, 0x73, 0x21, 1);
        }
        body.push(0x20, 0, 0x20, 1, 0x36, 2, 4);
        body.push(0x20, 1, 0x41, ...sleb(0x12345), 0x46, 0x04, 0x40, 0x20, 0, 0x10, 0, 0x1a, 0x0b);
        body.push(0x20, 1, 0x0b);
        return new Uint8Array([...HEAD,
            ...section(1, [1, 0x60, 1, 0x7f, 1, 0x7f]),
            ...section(2, [2, ...str('env'), ...str('buffer'), 2, shared ? 3 : 1, ...leb(pages), ...leb(pages),
                ...str('helper'), ...str('0'), 0, 0]),
            ...section(3, [1, 0]),
            ...section(7, [1, ...str('start'), 0, 1]),
            ...section(10, [1, ...leb(body.length), ...body])]);
    }
    // The "main module": run(lo, hi, rounds, ctx) calls table[lo..hi) in turn.
    function dispatcher() {
        const body = [1, 3, 0x7f,
            0x02, 0x40, 0x03, 0x40,
            0x20, 5, 0x20, 2, 0x4f, 0x0d, 1,
            0x20, 0, 0x21, 4,
            0x02, 0x40, 0x03, 0x40,
            0x20, 4, 0x20, 1, 0x4f, 0x0d, 1,
            0x20, 3, 0x20, 4, 0x11, 0, 0,
            0x20, 6, 0x6a, 0x21, 6,
            0x20, 4, 0x41, 1, 0x6a, 0x21, 4,
            0x0c, 0, 0x0b, 0x0b,
            0x20, 5, 0x41, 1, 0x6a, 0x21, 5,
            0x0c, 0, 0x0b, 0x0b,
            0x20, 6, 0x0b];
        return new Uint8Array([...HEAD,
            ...section(1, [2, 0x60, 1, 0x7f, 1, 0x7f, 0x60, 4, 0x7f, 0x7f, 0x7f, 0x7f, 1, 0x7f]),
            ...section(2, [1, ...str('env'), ...str('table'), 1, 0x70, 0, 0]),
            ...section(3, [1, 1]),
            ...section(7, [1, ...str('run'), 0, 0]),
            ...section(10, [1, ...leb(body.length), ...body])]);
    }
    const helper = { 0: (x) => x };
    const commands = {
        init(a) {
            try {
                memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
            } catch (e) {
                shared = false;
                memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
            }
            table = new WebAssembly.Table({ element: 'anyfunc', initial: a.size });
            run = new WebAssembly.Instance(new WebAssembly.Module(dispatcher()), { env: { table } }).exports.run;
            registry = new FinalizationRegistry(() => { collected++; });
            new Int32Array(memory.buffer)[16] = 7;
            return { shared, crossOriginIsolated: self.crossOriginIsolated };
        },
        // Compile and instantiate table[lo..hi), as instantiate_wasm() does.
        make(a) {
            const t = performance.now();
            let bytes = 0;
            for (let i = a.lo; i < a.hi; i++) {
                const wasm = block(made++);
                bytes = wasm.length;
                const inst = new WebAssembly.Instance(new WebAssembly.Module(wasm), { env: { buffer: memory }, helper });
                registry.register(inst, 'instance');
                table.set(i, inst.exports.start);
            }
            return { ms: performance.now() - t, bytes };
        },
        // Only the part of make() that is not the engine's: building the bytes.
        generate(a) {
            const t = performance.now();
            let n = 0;
            for (let i = 0; i < a.n; i++) {
                n += block(1000000 + i).length;
            }
            return { ms: performance.now() - t, n };
        },
        run(a) {
            const t = performance.now();
            const acc = run(a.lo, a.hi, a.rounds, 64);
            return { ms: performance.now() - t, acc };
        },
        drop(a) {
            for (let i = a.lo; i < a.hi; i++) {
                table.set(i, null);
            }
            return {};
        },
        collected() {
            return { collected, made };
        },
    };
    self.onmessage = (ev) => {
        let answer;
        try {
            answer = commands[ev.data.cmd](ev.data);
        } catch (e) {
            answer = { error: String(e) };
        }
        self.postMessage({ id: ev.data.id, ...answer });
    };`;
    const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
    const waiting = new Map();
    let next = 1;
    worker.onmessage = (ev) => {
        const resolve = waiting.get(ev.data.id);
        waiting.delete(ev.data.id);
        if (resolve) {
            resolve(ev.data);
        }
    };
    worker.onerror = (ev) => {
        for (const resolve of waiting.values()) {
            resolve({ error: `worker error: ${ev.message}` });
        }
        waiting.clear();
    };
    globalThis.__jitModel = (command) => new Promise((resolve) => {
        const id = next++;
        waiting.set(id, resolve);
        worker.postMessage({ ...command, id });
    });
    globalThis.__jitModelStop = () => worker.terminate();
}

async function jitBench() {
    const call = async (command) => {
        const r = await page.evaluate((c) => globalThis.__jitModel(c), command);
        if (r.error) {
            throw new Error(`${command.cmd}: ${r.error}`);
        }
        return r;
    };
    const bench = { modules: benchModules, make: [], calls: [], collect: [], memory: [] };
    result.bench = bench;
    await page.evaluate(startJitModel);
    const init = await call({ cmd: 'init', size: benchModules + 16 });
    bench.sharedMemory = init.shared;
    await sleep(1000);
    const before = memorySample();
    bench.memory.push({ modules: 0, ...before });
    log(`JIT MODEL: ${benchModules} modules, shared memory ${init.shared}, worker isolated ${init.crossOriginIsolated}`);
    log(`JIT MODEL: memory before: ${describeMemory(before)}`);
    const gen = await call({ cmd: 'generate', n: 1000 });
    bench.generateMsPerModule = gen.ms / 1000;

    // Instantiate in steps of 1000: time per module, memory per module.
    for (let lo = 0; lo < benchModules; lo += 1000) {
        const hi = Math.min(benchModules, lo + 1000);
        const r = await call({ cmd: 'make', lo, hi });
        const perModule = r.ms / (hi - lo) - bench.generateMsPerModule;
        bench.moduleBytes = r.bytes;
        bench.make.push(Math.round(perModule * 1000) / 1000);
        await sleep(300);
        const m = memorySample();
        bench.memory.push({ modules: hi, ...m });
        log(`JIT MODEL: modules ${lo}..${hi}: ${perModule.toFixed(3)} ms each (${r.bytes} bytes); ` +
            `content processes ${m ? m.content : '?'} MiB`);
    }
    const made = bench.memory[bench.memory.length - 1];
    if (before && made) {
        bench.kbPerModuleFresh = Math.round(((made.content - before.content) * 1024 / benchModules) * 10) / 10;
    }

    // Call every module in turn, round after round: nanoseconds per call
    // while the engine moves the functions through its tiers.
    let rounds = 0;
    for (const more of [1, 9, 40, 150, 300, 1000, 1500, 3000]) {
        const r = await call({ cmd: 'run', lo: 0, hi: benchModules, rounds: more });
        const ns = (r.ms * 1e6) / (more * benchModules);
        bench.calls.push({ from: rounds + 1, to: rounds + more, ns: Math.round(ns * 10) / 10 });
        log(`JIT MODEL: calls ${rounds + 1}..${rounds + more} of each module: ${ns.toFixed(1)} ns per call`);
        rounds += more;
        if (r.ms > 90000) {
            log('JIT MODEL: slow, skipping the remaining rounds');
            break;
        }
    }
    // The same for a hot few (64 modules, as in a guest loop).
    {
        const r = await call({ cmd: 'run', lo: 0, hi: 64, rounds: 100000 });
        bench.hotNs = Math.round(((r.ms * 1e6) / (100000 * 64)) * 10) / 10;
        log(`JIT MODEL: 64 hot modules: ${bench.hotNs} ns per call`);
    }
    await sleep(2000);
    const warm = memorySample();
    bench.memory.push({ modules: benchModules, warm: true, ...warm });
    if (before && warm) {
        bench.kbPerModuleWarm = Math.round(((warm.content - before.content) * 1024 / benchModules) * 10) / 10;
    }
    log(`JIT MODEL: memory after the calls: ${describeMemory(warm)}`);

    // Drop half, as QEMU-Wasm does at its cap, and see whether the
    // FinalizationRegistry reports them: idle first (what jitgc=1 waits for
    // while the vCPU interprets), then while compiling replacements (jitgc=0).
    const half = Math.floor(benchModules / 2);
    await call({ cmd: 'drop', lo: 0, hi: half });
    const tDrop = Date.now();
    for (const at of [1, 5, 15, 30]) {
        await sleep(Math.max(0, tDrop + at * 1000 - Date.now()));
        const c = await call({ cmd: 'collected' });
        const m = memorySample();
        bench.collect.push({ phase: 'idle', seconds: at, collected: c.collected, of: half, rss: m ? m.content : 0 });
        log(`JIT MODEL: ${at} s after dropping ${half}: ${c.collected} reported collected; content processes ${m ? m.content : '?'} MiB`);
    }
    for (let i = 0; i < 4; i++) {
        const lo = Math.floor((half * i) / 4);
        const hi = Math.floor((half * (i + 1)) / 4);
        const r = await call({ cmd: 'make', lo, hi });
        await call({ cmd: 'run', lo: 0, hi, rounds: 20 });
        await call({ cmd: 'run', lo: half, hi: benchModules, rounds: 20 });
        await sleep(500);
        const c = await call({ cmd: 'collected' });
        const m = memorySample();
        bench.collect.push({
            phase: 'compiling', made: c.made, collected: c.collected, rss: m ? m.content : 0,
            msPerModule: Math.round((r.ms / Math.max(1, hi - lo) - bench.generateMsPerModule) * 1000) / 1000,
        });
        log(`JIT MODEL: ${c.made} made in all, ${c.collected} reported collected; content processes ${m ? m.content : '?'} MiB`);
    }
    await page.evaluate(() => globalThis.__jitModelStop());
    await sleep(3000);
    const after = memorySample();
    bench.memory.push({ modules: 0, stopped: true, ...after });
    log(`JIT MODEL: memory after stopping the worker: ${describeMemory(after)}`);
}

// ------------------------------------------------------- part 3: Android ---
const serialTail = [];
let serialCarry = '';
let serialAll = '';
/** Move the page's captured serial output into the log; returns the new text. */
async function drainSerial() {
    let text = '';
    try {
        text = await page.evaluate(() => (globalThis.__cap ? globalThis.__cap.splice(0).join('') : ''));
    } catch (e) {
        return '';
    }
    if (!text) {
        return '';
    }
    const clean = stripAnsi(text).replace(/\r/g, '');
    serialAll = (serialAll + clean).slice(-60000);
    const lines = (serialCarry + clean).split('\n');
    serialCarry = lines.pop();
    for (const line of lines) {
        if (line.trim()) {
            console.log(`serial| ${line}`);
            serialTail.push(line);
            if (serialTail.length > 40) {
                serialTail.shift();
            }
        }
    }
    return clean;
}
const send = (cmd) => page.evaluate((c) => globalThis.__porty.serial.send(c), cmd);

async function pageState() {
    return page.evaluate(() => {
        const $ = (id) => document.getElementById(id);
        const text = (id) => ($(id) ? $(id).textContent.replace(/\s+/g, ' ').trim() : '');
        const e = globalThis.__porty;
        let lit = -1;
        const c = $('screen');
        try {
            if (c && c.width) {
                const t = document.createElement('canvas');
                t.width = 48;
                t.height = 80;
                const g = t.getContext('2d');
                g.drawImage(c, 0, 0, 48, 80);
                const px = g.getImageData(0, 0, 48, 80).data;
                let on = 0;
                for (let i = 0; i < px.length; i += 4) {
                    on += px[i] + px[i + 1] + px[i + 2] > 30 ? 1 : 0;
                }
                lit = Math.round((100 * on) / (48 * 80));
            }
        } catch (err) {
            lit = -1;
        }
        let heap = null;
        let disk = null;
        try {
            heap = e && e.module && e.heapStats ? e.heapStats() : null;
            disk = e && e.module && e.diskStats ? e.diskStats() : null;
        } catch (err) {
            heap = null;
        }
        return {
            state: $('app').dataset.state || '',
            stage: text('stage-text'),
            detail: text('stage-detail'),
            stats: text('stats'),
            pill: text('pill'),
            failure: $('app').dataset.state === 'failed' ? `${text('fail-message')} ${text('fail-hint')}` : '',
            failLog: $('app').dataset.state === 'failed' ? $('fail-log').textContent : '',
            overlayHidden: $('overlay') ? $('overlay').hidden : false,
            lit,
            screen: c ? `${c.width}x${c.height}` : '',
            heap,
            disk,
            resumed: e ? !!e.resumed : false,
            resuming: e ? !!e.resuming : false,
            resumeNote: e ? e.resumeNote || '' : '',
            exited: e ? !!e.exited : false,
            wasmMb: e ? e.wasmMemoryMb : 0,
            cfg: e && e.cfg ? `mem=${e.cfg.mem} tb=${e.cfg.tb} cache=${e.cfg.cache} jitcap=${e.cfg.jitcap} ` +
                `jit=${e.cfg.jit} jitgc=${e.cfg.jitgc} timescale=${e.cfg.timescale} mobile=${e.cfg.mobile}` : '',
            notes: e && e.notes ? e.notes.join(' | ') : '',
        };
    });
}

let lastSample = 0;
let lastMaps = 0;
/** One line of JIT statistics and memory, at most every `every` ms. */
async function sample(label, every = 10000) {
    if (Date.now() - lastSample < every) {
        return null;
    }
    lastSample = Date.now();
    let s;
    try {
        s = await pageState();
    } catch (e) {
        log(`page did not answer: ${String(e.message).split('\n')[0]}`);
        return null;
    }
    const withMaps = Date.now() - lastMaps > 30000;
    if (withMaps) {
        lastMaps = Date.now();
    }
    const m = memorySample(withMaps);
    const h = s.heap || {};
    const row = {
        t: Math.round((Date.now() - t0) / 1000), label,
        alive: h.jitAlive, compiled: h.jitCompiled, heapUsed: h.used, brk: h.brk,
        diskMb: s.disk ? Math.round(s.disk.megabytes) : undefined,
        rss: m ? m.rss : undefined, anon: m ? m.anon : undefined, shmem: m ? m.shmem : undefined,
        total: m ? m.total : undefined,
        ...(m && m.bigRss !== undefined ? { wasmRss: m.bigRss, rest: m.rest } : {}),
    };
    result.jit.push(row);
    log(`SAMPLE ${label}: state=${s.state} pill="${s.pill}" lit=${s.lit}% jit=${h.jitAlive}/${h.jitCompiled} ` +
        `heap=${h.used}/${h.brk}MB disk=${row.diskMb}MB stats="${s.stats}" | ${describeMemory(m)}`);
    return s;
}

async function boot() {
    const b = result.boot;
    const tClick = Date.now();
    await page.click('#start');
    await page.evaluate(() => {
        globalThis.__cap = [];
        const serial = globalThis.__porty && globalThis.__porty.serial;
        if (serial) {
            const forward = serial.onText;
            serial.onText = (text) => {
                globalThis.__cap.push(text);
                forward(text);
            };
        }
    });
    log('started');
    const deadline = t0 + minutes * 60000;
    let printed = false;
    let lastStage = '';
    let nextStatus = 0;
    // --- until Android is on screen ----------------------------------------
    while (Date.now() < deadline && !result.crashed) {
        await sleep(2000);
        let s;
        try {
            s = await pageState();
        } catch (e) {
            log(`page did not answer: ${String(e.message).split('\n')[0]}`);
            continue;
        }
        await drainSerial();
        if (!printed && s.cfg && s.wasmMb) {
            printed = true;
            b.config = `${s.cfg} wasm=${s.wasmMb}`;
            log(`config: ${b.config}`);
            b.startedQemu = secs(Date.now() - tClick);
        }
        if (`${s.stage}|${s.detail}` !== lastStage) {
            lastStage = `${s.stage}|${s.detail}`;
            log(`stage: ${s.stage} ${s.detail} (state=${s.state}, lit=${s.lit}%)`);
        }
        if (s.resuming && b.resumeStarted === undefined) {
            b.resumeStarted = secs(Date.now() - tClick);
        }
        if (s.resumed && b.resumed === undefined) {
            b.resumed = secs(Date.now() - tClick);
            log(`RESUMED after ${b.resumed} s (from the click on Start)`);
        }
        if (s.resumeNote && !b.resumeNote) {
            b.resumeNote = s.resumeNote;
            log(`NOT RESUMING: ${s.resumeNote}`);
        }
        if (s.state === 'failed') {
            b.failed = s.failure;
            note(`PAGE FAILED: ${s.failure}`);
            console.log(s.failLog.split('\n').map((l) => `fail| ${l}`).join('\n'));
            return false;
        }
        if (s.exited) {
            b.failed = 'QEMU exited';
            note('QEMU EXITED');
            return false;
        }
        if (s.state === 'running' && !s.resuming && s.lit >= 20 && b.firstFrame === undefined &&
            (s.resumed || s.overlayHidden)) {
            b.firstFrame = secs(Date.now() - tClick);
            b.firstFrameLit = s.lit;
            log(`FIRST FRAME after ${b.firstFrame} s (${s.lit}% of the screen lit)`);
            log(`notes: ${s.notes}`);
            await sample('first-frame', 0);
            await shot('first-frame');
            break;
        }
        await sample('loading', 15000);
        if (Date.now() >= nextStatus) {
            nextStatus = Date.now() + 120000;
            await postStatus('pending', `${elapsed()} ${s.stage} ${s.detail}`);
        }
    }
    if (b.firstFrame === undefined) {
        note(`no frame from Android within the deadline${result.crashed ? ' (crashed)' : ''}`);
        return false;
    }

    // --- the guest's shell: does it answer, and how fast is hot code? ------
    const waitFor = async (pattern, ms, label) => {
        const t = Date.now();
        while (Date.now() - t < ms && !result.crashed) {
            await sleep(1000);
            await drainSerial();
            const m = pattern.exec(serialAll);
            if (m) {
                return { ms: Date.now() - t, match: m };
            }
            await sample(label, 20000);
        }
        return null;
    };
    serialAll = '';
    await send('\recho SHELL:$((6*7)):END\r');
    const shell = await waitFor(/SHELL:42:END/, 180000, 'shell');
    b.shell = shell ? secs(shell.ms) : null;
    log(shell ? `SHELL answered after ${b.shell} s` : 'SHELL did not answer within 180 s');
    if (shell) {
        // A loop in the shell, timed from here (the guest's own clock runs
        // slow by "timescale"): the same few blocks over and over, so after
        // the first round this is compiled code.
        b.loops = [];
        for (let round = 1; round <= 3 && !result.crashed; round++) {
            serialAll = '';
            const tLoop = Date.now();
            await send(`i=0; while [ $i -lt 20000 ]; do i=$((i+1)); done; echo LOOP${round}:$i:END\r`);
            const done = await waitFor(new RegExp(`LOOP${round}:20000:END`), 240000, 'loop');
            b.loops.push(done ? secs(Date.now() - tLoop) : null);
            log(done ? `LOOP ${round}: 20000 shell iterations in ${secs(Date.now() - tLoop)} s`
                : `LOOP ${round}: not finished within 240 s`);
            if (!done) {
                break;
            }
        }
    }
    await sample('before-tap', 0);
    return true;
}

async function inputProbe() {
    const p = result.probe;
    await page.evaluate(() => {
        const c = document.getElementById('screen');
        const seen = {};
        globalThis.__portyProbe = seen;
        for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'touchstart', 'touchend', 'mousedown']) {
            c.addEventListener(t, (e) => {
                const k = `${t}:${e.pointerType || '-'}`;
                seen[k] = (seen[k] || 0) + 1;
            }, { capture: true });
        }
    });
    const r = await page.$eval('#screen', (e) => {
        const b = e.getBoundingClientRect();
        return { x: b.left, y: b.top, w: b.width, h: b.height, cw: e.width, ch: e.height };
    });
    const at = (ax, ay) => [r.x + (ax / (r.cw || 480)) * r.w, r.y + (ay / (r.ch || 800)) * r.h];
    const [gx, gy] = at(150, 565 * (r.ch || 800) / 800);
    log(`INPUT PROBE: canvas ${JSON.stringify(r)}; finger tap at ${gx.toFixed(0)},${gy.toFixed(0)} (the Gallery icon)`);
    const seen = () => page.evaluate(() => globalThis.__portyProbe);
    const tTap = Date.now();
    p.how = 'touchscreen';
    try {
        await page.touchscreen.tap(gx, gy);
    } catch (e) {
        log(`INPUT PROBE: touchscreen.tap failed: ${String(e.message).split('\n')[0]}`);
    }
    await sleep(700);
    let events = await seen();
    if (!Object.keys(events).some((k) => k.startsWith('pointerdown'))) {
        // This browser build makes no pointer events from a synthetic touch:
        // hand the page the two events a finger would have produced.
        p.how = 'synthetic pointer events';
        log(`INPUT PROBE: the tap produced ${JSON.stringify(events)}; dispatching pointer events instead`);
        await page.evaluate(([x, y]) => {
            const c = document.getElementById('screen');
            const init = {
                bubbles: true, cancelable: true, composed: true, pointerId: 7, pointerType: 'touch',
                isPrimary: true, clientX: x, clientY: y, button: 0, buttons: 1, width: 20, height: 20, pressure: 0.5,
            };
            c.dispatchEvent(new PointerEvent('pointerdown', init));
            return new Promise((resolve) => setTimeout(() => {
                c.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0, pressure: 0 }));
                resolve();
            }, 120));
        }, [gx, gy]);
        await sleep(500);
        events = await seen();
    }
    p.events = events;
    log(`INPUT PROBE: the page saw ${JSON.stringify(events)} (${p.how})`);
    await sample('tap', 0);

    // Ask what has the focus every 20 s until it is Gallery.
    let lastFocus = '';
    const deadline = Math.min(tTap + probeSeconds * 1000, t0 + minutes * 60000);
    let shots = 0;
    while (Date.now() < deadline && !result.crashed) {
        serialAll = '';
        await send('echo FOCUS:$(dumpsys window | grep mCurrentFocus | head -1 | cut -c1-90):END\r');
        const tAsk = Date.now();
        let got = null;
        while (Date.now() - tAsk < 20000 && !result.crashed) {
            await sleep(1000);
            await drainSerial();
            const m = /FOCUS:\s*(mCurrentFocus[^\n]*):END/.exec(serialAll);
            if (m && !got) {
                got = m[1];
                lastFocus = got;
                if (/gallery/i.test(got)) {
                    break;
                }
            }
            await sample('probe', 10000);
        }
        if (got && /gallery/i.test(got)) {
            p.gallery = secs(Date.now() - tTap);
            log(`INPUT PROBE: Gallery in front after ${p.gallery} s: ${got}`);
            break;
        }
        if (Date.now() - tTap > 60000 * (shots + 1) && shots < 3) {
            shots++;
            await shot(`probe-${shots}`);
        }
        await postStatus('pending', `${elapsed()} tap sent ${Math.round((Date.now() - tTap) / 1000)} s ago; focus ${lastFocus.slice(0, 60)}`);
    }
    p.lastFocus = lastFocus;
    if (p.gallery === undefined) {
        p.gallery = null;
        log(`INPUT PROBE: Gallery not in front within ${Math.round((Date.now() - tTap) / 1000)} s (last focus: ${lastFocus || 'no answer'})`);
    }
    await sample('after-probe', 0);
    await shot('after-probe');
    // Half a minute more: does compiling go on, does memory settle?
    for (let i = 0; i < 3 && !result.crashed; i++) {
        await sleep(10000);
        await drainSerial();
        await sample('settle', 0);
    }
}

// ------------------------------------------------------------------ run ---
function summarize() {
    const b = result.boot;
    const p = result.probe;
    const last = result.jit[result.jit.length - 1] || {};
    const peak = result.jit.reduce((m, r) => Math.max(m, r.rss || 0), 0);
    const parts = [];
    if (result.crashed) {
        parts.push('CRASHED');
    }
    if (result.coi) {
        parts.push(`isolated via ${result.coi}`);
    }
    if (b.failed) {
        parts.push(`failed: ${b.failed}`);
    }
    if (b.resumed !== undefined) {
        parts.push(`resume ${b.resumed}s`);
    }
    if (b.firstFrame !== undefined) {
        parts.push(`frame ${b.firstFrame}s`);
    }
    if (b.loops && b.loops.length) {
        parts.push(`loop ${b.loops.join('/')}s`);
    }
    if (p.gallery !== undefined) {
        parts.push(p.gallery === null ? 'Gallery: no' : `Gallery ${p.gallery}s`);
    }
    if (last.compiled !== undefined) {
        parts.push(`jit ${last.alive}/${last.compiled}`);
    }
    if (peak) {
        parts.push(`rss peak ${peak}MiB`);
    }
    return parts.join(', ') || 'nothing measured';
}

try {
    log(`opening ${url}`);
    await page.goto(url, { waitUntil: 'load', timeout: 120000 });
    // --- cross-origin isolation ---------------------------------------------
    const isolated = async (ms) => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
            try {
                // coi-serviceworker reloads the page once; the context may vanish.
                if (await page.evaluate(() => globalThis.crossOriginIsolated === true)) {
                    return true;
                }
            } catch (e) {
                // navigating
            }
            await sleep(1000);
        }
        return false;
    };
    if (coiMode !== 'route' && await isolated(coiMode === 'sw' ? 120000 : 45000)) {
        result.coi = 'service worker';
    } else if (coiMode !== 'sw') {
        const sw = await page.evaluate(async () => ({
            isolated: globalThis.crossOriginIsolated,
            controller: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
            registrations: navigator.serviceWorker ? (await navigator.serviceWorker.getRegistrations()).length : -1,
        })).catch((e) => ({ error: String(e.message).split('\n')[0] }));
        log(`not isolated through the service worker (${JSON.stringify(sw)}); adding the headers from the test`);
        result.swState = sw;
        // Everything but the big downloads goes through the test, which adds
        // the headers the service worker would have added.
        await page.context().route((u) => !/\/(image|snapshot)\//.test(u.pathname), async (route) => {
            try {
                const response = await route.fetch();
                await route.fulfill({
                    response,
                    headers: {
                        ...response.headers(),
                        'cross-origin-opener-policy': 'same-origin',
                        'cross-origin-embedder-policy': 'require-corp',
                        'cross-origin-resource-policy': 'cross-origin',
                    },
                });
            } catch (e) {
                await route.continue().catch(() => {});
            }
        });
        await page.evaluate(async () => {
            for (const r of await navigator.serviceWorker.getRegistrations()) {
                await r.unregister();
            }
        }).catch(() => {});
        await page.goto(url, { waitUntil: 'load', timeout: 120000 });
        if (await isolated(60000)) {
            result.coi = 'headers added by the test';
        }
    }
    log(`cross-origin isolated: ${result.coi || 'NO'}`);
    await page.waitForFunction(() => !document.getElementById('start').disabled, null, { timeout: 60000 })
        .catch(() => log('the Start button stayed disabled'));
    log(`precheck: ${await page.$eval('#precheck', (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '?')}`);
    log(`build: ${await page.$eval('#buildid', (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '?')}`);
    log(`config line: ${await page.$eval('#cfgline', (e) => e.textContent.trim()).catch(() => '?')}`);

    result.features = await page.evaluate(featureProbe);
    log(`FEATURES: ${JSON.stringify(result.features)}`);
    await postStatus('pending', `${elapsed()} isolated: ${result.coi || 'no'}; ` +
        `sync XHR ${result.features.worker && result.features.worker.syncXhr}`);

    if (benchMode !== '0') {
        try {
            await jitBench();
        } catch (e) {
            note(`JIT MODEL failed: ${String(e.message || e).split('\n')[0]}`);
        }
        log(`BENCH: ${JSON.stringify(result.bench)}`);
    }
    if (benchMode !== 'only') {
        // A clean page for Android: the probes' memories and modules go with the old one.
        await page.goto(url, { waitUntil: 'load', timeout: 120000 });
        await page.waitForFunction(() => !document.getElementById('start').disabled, null, { timeout: 60000 })
            .catch(() => {});
        await sleep(3000);
        log(`memory before the start: ${describeMemory(memorySample())}`);
        if (await boot()) {
            await inputProbe();
        }
        await shot('final');
    }
} catch (e) {
    note(`TEST ERROR: ${e.stack || e}`);
    await shot('error');
}

const verdict = summarize();
log(`SUMMARY: ${verdict}; elapsed ${elapsed()}`);
console.log(`RESULT ${JSON.stringify(result)}`);
const ok = !result.crashed && !result.boot.failed && (benchMode === 'only' || result.probe.gallery);
await postStatus(ok ? 'success' : (result.crashed || result.boot.failed ? 'failure' : 'error'), verdict);
if (process.env.GITHUB_STEP_SUMMARY) {
    const f = result.features || {};
    const be = result.bench || {};
    const rows = result.jit.filter((r, i, a) => i === a.length - 1 || i % Math.max(1, Math.floor(a.length / 30)) === 0);
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
        `## ${result.version}: \`${queryText || 'defaults'}\``,
        '',
        `- **${verdict}**`,
        `- URL: ${url}`,
        `- Isolation: ${result.coi || 'none'}; SharedArrayBuffer ${f.sharedArrayBuffer}; worker: ${JSON.stringify(f.worker || {})}`,
        `- Shared WebAssembly memory: ${JSON.stringify(f.memory || {})}`,
        `- Boot: ${JSON.stringify(result.boot)}`,
        `- Probe: ${JSON.stringify(result.probe)}`,
        ...(be.make ? [
            `- JIT model (${be.modules} modules of ${be.moduleBytes} bytes): ms per module by thousand ${JSON.stringify(be.make)}; ` +
            `kB per module ${be.kbPerModuleFresh} fresh, ${be.kbPerModuleWarm} after the calls; hot call ${be.hotNs} ns`,
            `- JIT model, ns per call by round: ${be.calls.map((c) => `${c.from}-${c.to}: ${c.ns}`).join(', ')}`,
            `- JIT model, collection: ${JSON.stringify(be.collect)}`,
        ] : []),
        ...(result.errors.length ? ['- Errors:', ...result.errors.map((e) => `  - \`${e.replace(/`/g, "'").split('\n')[0]}\``)] : []),
        '',
        '| s | phase | JIT alive | compiled | QEMU heap MiB | RSS MiB | anon | shmem | wasm mapping | rest |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        ...rows.map((r) => `| ${r.t} | ${r.label} | ${r.alive ?? ''} | ${r.compiled ?? ''} | ${r.heapUsed ?? ''} | ` +
            `${r.rss ?? ''} | ${r.anon ?? ''} | ${r.shmem ?? ''} | ${r.wasmRss ?? ''} | ${r.rest ?? ''} |`),
        '',
    ].join('\n'));
}
closing = true;
await Promise.race([browser.close().catch(() => {}), sleep(15000)]);
process.exit(0);
