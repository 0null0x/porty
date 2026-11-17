// Boots the deployed Porty site in headless Chrome and reports how far
// Android gets: page state, the serial console, and screenshots printed as
// base64 JPEG between marker lines (so they can be recovered from the job
// log with tests/boot/extract-shots.py).
//
// usage: node tests/boot/boot-test.mjs
//   SITE_URL       deployed site, with trailing slash (required)
//   QUERY          extra page parameters, e.g. "smp=1&mem=1024" (optional)
//   MINUTES        how long to let Android boot (default 40)
//   CHROME         Chrome binary (default /usr/bin/google-chrome)
//   PUPPETEER_DIR  directory that has node_modules/puppeteer-core
//   DUMP_FILES     comma-separated paths in QEMU's in-memory filesystem to
//                  print at the end, e.g. the -D log of
//                  QUERY="qemu=-d%20cpu_reset,guest_errors%20-D%20/tmp/q.log"
//   USER_DATA_DIR  browser profile directory to use and keep, so that a
//                  second run is a second visit (service worker, Cache
//                  Storage and HTTP cache of the first are there)
//   CHROME_ARGS    more Chrome flags, space separated
//   CPU_THROTTLE   slow the page and QEMU's threads down this many times,
//                  e.g. 3 or 6 for a phone.  CDP's
//                  Emulation.setCPUThrottlingRate only slows a page's main
//                  thread (workers refuse it: "only supported for pages"),
//                  and the guest's CPU runs in a worker, so the test stops
//                  and continues Chrome's renderer processes instead
//                  (SIGSTOP/SIGCONT, 10 ms on, 10 x (rate - 1) ms off).
//                  CPU_THROTTLE_MODE=cdp uses CDP on the page alone.
//   NO_HTTP_CACHE  1: the browser's HTTP cache is off (CDP
//                  Network.setCacheDisabled on the page, the workers and
//                  the service worker), so a disk chunk QEMU dropped is
//                  downloaded again, as on a browser that does not cache
//                  such files
//   NET_MBPS       download speed limit in Mbit/s (CDP
//                  Network.emulateNetworkConditions; with NET_LATENCY_MS)
//   PROBE_WAIT     seconds the input probe waits for Gallery (default 240;
//                  the later steps wait half and three quarters of it)
//   PROBE_STEPS    "launch": the input probe ends after the Gallery launch
//   PROBE_GUEST_EVERY  seconds between the guest's samples during the
//                  launch (default 30).  0: none, to see how much the
//                  sampling itself slows the launch; the page's counters
//                  and the event log at the end still give the times
//   RESUME_SETTLE  seconds between "Android resumed" and the first check
//                  for the shell (default 120; a normal boot waits 8 min)
//
// Exit status: 0 whatever happened to Android (the verdict is in the log,
// the job summary and a warning annotation: a red run would e-mail the
// repository owner for every experiment); 1 only with BOOT_TEST_STRICT=1
// when the page or QEMU failed; 2 on bad usage.
// SPDX-License-Identifier: GPL-2.0-or-later
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus } from 'node:os';
import path from 'node:path';
import { PCPU_FUNCTION, cpuDelta, describeCpu, parseCpuLine } from './cpu-probe.mjs';

const require = createRequire(path.join(process.env.PUPPETEER_DIR || process.cwd(), 'noop.js'));
const puppeteer = require('puppeteer-core');

const siteUrl = process.env.SITE_URL || '';
if (!/^https?:\/\/.+\/$/.test(siteUrl)) {
    console.error('SITE_URL must be the site root with a trailing slash');
    process.exit(2);
}
const minutes = Math.max(1, Math.min(240, Number(process.env.MINUTES) || 40));
const params = new URLSearchParams((process.env.QUERY || '').trim().replace(/^\?/, ''));
// Typed into Android's root shell once, as soon as its prompt appears.
const shellInit = (process.env.SHELL_INIT || '').trim();
params.set('serial', '1');
const url = `${siteUrl}?${params}`;
const num = (name, fallback, min, max) => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && process.env[name] !== undefined && process.env[name] !== ''
        ? Math.min(max, Math.max(min, v)) : fallback;
};
// Phone-like conditions (see the usage above).
const cpuThrottle = num('CPU_THROTTLE', 1, 1, 50);
const cpuThrottleCdp = process.env.CPU_THROTTLE_MODE === 'cdp';
const noHttpCache = /^(1|true|on)$/.test(process.env.NO_HTTP_CACHE || '');
const netMbps = num('NET_MBPS', 0, 0, 10000);
const netLatencyMs = num('NET_LATENCY_MS', 0, 0, 5000);
const probeWaitMs = num('PROBE_WAIT', 240, 30, 7200) * 1000;
const launchOnly = (process.env.PROBE_STEPS || '') === 'launch';
const resumeSettleMs = num('RESUME_SETTLE', 120, 0, 3600) * 1000;
const guestEveryMs = num('PROBE_GUEST_EVERY', 30, 0, 600) * 1000;
const conditions = [
    cpuThrottle > 1 ? `cpu/${cpuThrottle}${cpuThrottleCdp ? 'cdp' : ''}` : '',
    noHttpCache ? 'nocache' : '',
    netMbps ? `net${netMbps}Mbit` : '',
    guestEveryMs ? '' : 'quiet',
].filter(Boolean).join(' ') || 'plain';

const t0 = Date.now();
const elapsed = () => {
    const s = Math.floor((Date.now() - t0) / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const log = (msg) => console.log(`[${elapsed()}] ${msg}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// eslint-disable-next-line no-control-regex
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b[()][A-Z0-9]/g, '');

// Runners differ by more than 2x; compare times only on the same model.
const hostCpu = `${(cpus()[0] || {}).model || 'unknown CPU'} x${cpus().length}`.replace(/\s+/g, ' ');
log(`host CPU: ${hostCpu}`);
const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/usr/bin/google-chrome',
    headless: true,
    protocolTimeout: 300000,
    ...(process.env.USER_DATA_DIR ? { userDataDir: process.env.USER_DATA_DIR } : {}),
    args: [
        // Without a disk cache the service worker's own fetches cannot be
        // served from it either, whatever CDP reaches.
        ...(noHttpCache ? ['--disk-cache-size=1', '--media-cache-size=1'] : []),
        '--no-sandbox', '--disable-gpu', '--window-size=480,900',
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        ...(process.env.CHROME_ARGS || '').split(/\s+/).filter(Boolean),
    ],
});
const page = await browser.newPage();
// hasTouch: the input probe taps like a finger (pointerType "touch", as on
// a phone).  The page tells phones apart by their user agent, not by this.
await page.setViewport({ width: 480, height: 900, hasTouch: true });
page.on('pageerror', (e) => log(`pageerror: ${(e && e.stack) || e}`));
// Error objects arrive as handles; turn them into their stacks.
const describe = (handle) => handle.evaluate((v) => {
    if (v instanceof Error) {
        return v.stack || String(v);
    }
    if (v && typeof v === 'object') {
        try {
            return JSON.stringify(v);
        } catch (e) {
            return String(v);
        }
    }
    return String(v);
}).catch(() => '?');
// QEMU's stderr reaches the page as console.warn (Module.printErr).
let warnings = 0;
page.on('console', async (m) => {
    if (m.type() === 'error') {
        const parts = await Promise.all(m.args().map(describe));
        log(`console.error: ${parts.join(' ') || m.text()}`);
    } else if ((m.type() === 'warn' || m.type() === 'warning') && warnings++ < 300) {
        log(`console.warn: ${m.text()}`);
    }
});
// The conditions apply to every target that runs or fetches for the guest:
// the page, QEMU's threads (Web Workers: the CPU thread is one, and the
// disk chunks are fetched by others) and the service worker all requests
// pass through.  `net` counts what the Network domain reports.
const net = { responses: 0, fromDiskCache: 0, fromServiceWorker: 0, chunkMs: [], pending: new Map() };
const applied = {};
async function applyConditions(client, kind) {
    const note = (what, e) => {
        const k = `${kind} ${what}: ${e ? `failed (${e.message.split('\n')[0]})` : 'ok'}`;
        applied[k] = (applied[k] || 0) + 1;
        if (applied[k] === 1) {
            log(`conditions: ${k}`);
        }
    };
    if (cpuThrottle > 1 && cpuThrottleCdp && kind === 'page') {
        await client.send('Emulation.setCPUThrottlingRate', { rate: cpuThrottle })
            .then(() => note(`cpu throttle ${cpuThrottle}x`), (e) => note(`cpu throttle ${cpuThrottle}x`, e));
    }
    if (noHttpCache || netMbps) {
        await client.send('Network.enable').then(() => {}, (e) => note('Network.enable', e));
    }
    if (noHttpCache) {
        await client.send('Network.setCacheDisabled', { cacheDisabled: true })
            .then(() => note('no HTTP cache'), (e) => note('no HTTP cache', e));
    }
    if (netMbps) {
        await client.send('Network.emulateNetworkConditions', {
            offline: false,
            latency: netLatencyMs,
            downloadThroughput: Math.round((netMbps * 1e6) / 8),
            uploadThroughput: Math.round((netMbps * 1e6) / 8),
        }).then(() => note(`network ${netMbps} Mbit/s`), (e) => note(`network ${netMbps} Mbit/s`, e));
    }
}
/** Count responses and time the disk chunks on a session with Network on. */
function watchNetwork(client) {
    client.on('Network.requestWillBeSent', (ev) => {
        if (/\/image\//.test(ev.request.url)) {
            net.pending.set(ev.requestId, ev.timestamp);
        }
    });
    client.on('Network.responseReceived', (ev) => {
        net.responses++;
        net.fromDiskCache += ev.response.fromDiskCache ? 1 : 0;
        net.fromServiceWorker += ev.response.fromServiceWorker ? 1 : 0;
    });
    client.on('Network.loadingFinished', (ev) => {
        const t = net.pending.get(ev.requestId);
        if (t !== undefined) {
            net.pending.delete(ev.requestId);
            net.chunkMs.push(Math.round((ev.timestamp - t) * 1000));
        }
    });
}
const netSummary = () => {
    const ms = net.chunkMs.slice().sort((a, b) => a - b);
    const at = (q) => (ms.length ? ms[Math.min(ms.length - 1, Math.floor(q * ms.length))] : 0);
    return `${net.responses} responses, ${net.fromDiskCache} from the HTTP cache, ` +
        `${net.fromServiceWorker} through the service worker; ${ms.length} disk chunks timed` +
        (ms.length ? `: median ${at(0.5)} ms, p90 ${at(0.9)} ms, max ${ms[ms.length - 1]} ms, ` +
            `sum ${Math.round(ms.reduce((a, b) => a + b, 0) / 1000)} s` : '');
};

/** Chrome's renderer processes: descendants of the browser process. */
function rendererPids() {
    const root = browser.process() && browser.process().pid;
    const parent = new Map();
    const renderers = [];
    for (const d of readdirSync('/proc')) {
        if (!/^\d+$/.test(d)) {
            continue;
        }
        try {
            const stat = readFileSync(`/proc/${d}/stat`, 'utf8');
            parent.set(Number(d), Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]));
            if (/--type=renderer/.test(readFileSync(`/proc/${d}/cmdline`, 'utf8'))) {
                renderers.push(Number(d));
            }
        } catch (e) {
            // the process ended meanwhile
        }
    }
    return renderers.filter((pid) => {
        for (let p = pid, n = 0; p > 1 && n < 12; p = parent.get(p) || 0, n++) {
            if (p === root) {
                return true;
            }
        }
        return false;
    });
}
// The slow CPU: every thread of the renderers runs 10 ms, then stands
// still for 10 x (rate - 1) ms.  Clocks go on, as on a slower device.
const throttle = { on: false, stopped: false, pids: [], scanned: 0, timer: null };
function throttleTick() {
    if (!throttle.on) {
        return;
    }
    if (!throttle.stopped && Date.now() - throttle.scanned > 3000) {
        throttle.scanned = Date.now();
        try {
            throttle.pids = rendererPids();
        } catch (e) {
            throttle.pids = [];
        }
    }
    for (const pid of throttle.pids) {
        try {
            process.kill(pid, throttle.stopped ? 'SIGCONT' : 'SIGSTOP');
        } catch (e) {
            // gone
        }
    }
    throttle.stopped = !throttle.stopped;
    throttle.timer = setTimeout(throttleTick, throttle.stopped ? 10 * (cpuThrottle - 1) : 10);
}
function stopThrottle() {
    throttle.on = false;
    clearTimeout(throttle.timer);
    for (const pid of throttle.pids) {
        try {
            process.kill(pid, 'SIGCONT');
        } catch (e) {
            // gone
        }
    }
    throttle.stopped = false;
}
function startThrottle() {
    if (cpuThrottle > 1 && !cpuThrottleCdp && !throttle.on) {
        throttle.on = true;
        throttleTick();
        log(`conditions: renderer processes ${rendererPids().join(', ')} run 10 ms in every ${10 * cpuThrottle} ms`);
    }
}
const pageClient = await page.createCDPSession();
await applyConditions(pageClient, 'page');
await pageClient.send('Network.enable').catch(() => {});
watchNetwork(pageClient);
const seenTargets = new WeakSet();
const adoptServiceWorker = async (target) => {
    if (target.type() !== 'service_worker' || seenTargets.has(target)) {
        return;
    }
    seenTargets.add(target);
    try {
        const client = await target.createCDPSession();
        await applyConditions(client, 'service worker');
        await client.send('Network.enable').catch(() => {});
        watchNetwork(client);
    } catch (e) {
        log(`conditions: service worker: ${e.message}`);
    }
};
browser.on('targetcreated', adoptServiceWorker);
let workerCount = 0;
// Uncaught exceptions inside QEMU's threads (Web Workers), with their wasm
// stacks: the page itself only gets "worker sent an error!" and a line number.
page.on('workercreated', (worker) => {
    const name = worker.url().split('/').pop().split('?')[0];
    workerCount++;
    applyConditions(worker.client, 'worker').then(() => {
        worker.client.send('Network.enable').then(() => watchNetwork(worker.client), () => {});
    });
    worker.client.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => {
        log(`worker exception (${name}): ${(d.exception && d.exception.description) || d.text}`);
        // A thrown value without a stack (Emscripten's longjmp throws
        // Infinity): where it was thrown from, as far as V8 knows.
        const frames = (d.stackTrace && d.stackTrace.callFrames) || [];
        if (frames.length) {
            log(`worker exception stack: ${frames.slice(0, 40).map((f) =>
                `${f.functionName || '?'}@${(f.url || '').split('/').pop().split('?')[0]}:${f.lineNumber}:${f.columnNumber}`).join(' < ')}`);
        }
    });
});

/**
 * Live progress as a commit status ("porty/boot ..."), which the GitHub API
 * shows while the run is going; job logs and annotations only appear when
 * it ends. Needs GITHUB_TOKEN with statuses: write; silently skipped
 * without it.
 */
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
                context: (`porty/boot ${(process.env.QUERY || '').trim() || 'defaults'}` +
                    (conditions !== 'plain' ? ` [${conditions}]` : '') +
                    (shellInit ? ` sh:${shellInit}` : '')).slice(0, 100),
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

/** Print a screenshot of the guest display (and optionally the page). */
async function shot(label, wholePage = false) {
    try {
        const s = await page.evaluate(() => {
            const c = document.getElementById('screen');
            if (!c || !c.width || !c.height) {
                return null;
            }
            const scale = Math.min(1, 640 / Math.max(c.width, c.height));
            const w = Math.max(1, Math.round(c.width * scale));
            const h = Math.max(1, Math.round(c.height * scale));
            const t = document.createElement('canvas');
            t.width = w;
            t.height = h;
            const g = t.getContext('2d');
            g.drawImage(c, 0, 0, w, h);
            const px = g.getImageData(0, 0, w, h).data;
            let lit = 0;
            for (let i = 0; i < px.length; i += 4) {
                if (px[i] + px[i + 1] + px[i + 2] > 30) {
                    lit++;
                }
            }
            return {
                size: `${c.width}x${c.height}`,
                lit: Math.round((1000 * lit) / (w * h)) / 10,
                jpeg: t.toDataURL('image/jpeg', 0.75).split(',')[1],
            };
        });
        if (s) {
            emit(`screen ${label}`, `${s.size} lit=${s.lit}%`, s.jpeg);
        } else {
            log(`screenshot ${label}: no guest display yet`);
        }
        if (wholePage) {
            const b64 = await page.screenshot({ type: 'jpeg', quality: 60, encoding: 'base64' });
            emit(`page ${label}`, '480x900', b64);
        }
    } catch (e) {
        log(`screenshot ${label} failed: ${e.message}`);
    }
}

/** Print files from QEMU's in-memory filesystem (DUMP_FILES). */
let dumped = false;
async function dumpFiles() {
    if (dumped) {
        return;
    }
    dumped = true;
    for (const file of (process.env.DUMP_FILES || '').split(',').map((s) => s.trim()).filter(Boolean)) {
        const text = await page.evaluate((f) => {
            try {
                const fs = globalThis.__porty && globalThis.__porty.module && globalThis.__porty.module.FS;
                if (!fs) {
                    return '(no filesystem)';
                }
                const bytes = fs.readFile(f);
                const tail = bytes.length > 400000 ? bytes.subarray(bytes.length - 400000) : bytes;
                return `(${bytes.length} bytes${tail !== bytes ? ', last 400000 shown' : ''})\n` +
                    new TextDecoder().decode(tail);
            } catch (e) {
                return `(cannot read: ${e})`;
            }
        }, file).catch((e) => `(page did not answer: ${e.message})`);
        log(`file ${file}:`);
        for (const line of text.split('\n')) {
            console.log(`file| ${line}`);
        }
    }
}

/**
 * After the boot: does input reach Android (M4)?  Logs the kernel's input
 * devices and how Android classified them, records the raw events with
 * getevent while it taps the Gallery icon like a finger and then clicks
 * the search bar with the mouse, and reports what the page saw, what has
 * the focus, and screenshots after each.
 */
// Where the guest's CPU goes during the launch (tests/boot/cpu-probe.mjs):
// a snapshot before the tap, one every PROBE_CPU_EVERY rounds of guest
// samples (default 2, about every minute) and one at the end; PROBE_CPU=0
// takes none.
const probeCpu = process.env.PROBE_CPU !== '0';
const probeCpuEvery = num('PROBE_CPU_EVERY', 2, 1, 100);
// surfaceflinger's frames per layer (TimeStats) from the tap to the end;
// PROBE_SFSTATS=0: not asked for.
const probeSfStats = process.env.PROBE_SFSTATS !== '0';

async function inputProbe() {
    const send = (cmd) => page.evaluate((c) => globalThis.__send(c), cmd);
    // Print the serial output as it comes, so that it lands between the
    // probe's own lines (the main loop is not reading it meanwhile).
    let lastFocus = '';
    // Marker lines of the guest, newest of each kind (the output of the
    // commands, never their echo: an echo has "$(" after the colon).
    const marks = { st: null, ps: null, lmk: null, cal: 0, clock: null, events: new Map(), top: [], cpu: new Map() };
    let pendingLine = '';
    let logDone = 0;
    const sleep = async (ms) => {
        await new Promise((resolve) => setTimeout(resolve, ms));
        const text = await page.evaluate(() => (globalThis.__cap ? globalThis.__cap.splice(0).join('') : ''));
        const lines = (pendingLine + stripAnsi(text)).split('\n');
        pendingLine = lines.pop();
        for (const line of lines) {
            // The CPU lines are many; they are reported, not echoed.
            if (parseCpuLine(line.replace(/\r$/, ''), marks.cpu)) {
                if (/^CP[SE]\|/.test(line)) {
                    log(`INPUT PROBE: cpu snapshot ${line.replace(/\r$/, '').slice(0, 120)}`);
                }
                continue;
            }
            if (line.trim()) {
                console.log(`serial| ${line.replace(/\r$/, '')}`);
            }
            let m = line.match(/FOCUS:\s*(mCurrentFocus[^\r\n]*):END/);
            if (m) {
                lastFocus = m[1];
            }
            m = line.match(/ST:cpu ([\d ]+):(.*):END/);
            if (m) {
                const [user, nice, system, idle, iowait, irq, softirq] = m[1].trim().split(/\s+/).map(Number);
                const rest = m[2];
                const pick = (re) => {
                    const r = re.exec(rest);
                    return r ? Number(r[1]) : -1;
                };
                marks.st = {
                    at: Date.now(),
                    user: user + nice,
                    system: system + irq + softirq,
                    idle,
                    iowait,
                    majfault: pick(/pgmajfault (\d+)/),
                    swapin: pick(/pswpin (\d+)/),
                    swapout: pick(/pswpout (\d+)/),
                    memFreeMb: Math.round(pick(/MemFree: (\d+)/) / 1024),
                    memAvailMb: Math.round(pick(/MemAvailable: (\d+)/) / 1024),
                    swapFreeMb: Math.round(pick(/SwapFree: (\d+)/) / 1024),
                    swapTotalMb: Math.round(pick(/SwapTotal: (\d+)/) / 1024),
                    load: (/:(\d+\.\d+) \d+\.\d+ \d+\.\d+ \d+\/\d+/.exec(rest) || [])[1] || '?',
                };
            }
            m = line.match(/PS:(.*):END/);
            if (m && !m[1].includes('$(')) {
                marks.ps = { at: Date.now(), ticks: {} };
                for (const part of m[1].trim().split(/\s+/)) {
                    const r = /^([^/]+)\/(\d+)\+(\d+)$/.exec(part);
                    if (r) {
                        marks.ps.ticks[r[1]] = (marks.ps.ticks[r[1]] || 0) + Number(r[2]) + Number(r[3]);
                    }
                }
            }
            m = line.match(/LMK:(\d+):(\d+):(\d+):END/);
            if (m) {
                marks.lmk = { ...(marks.lmk || { events: -1, anr: -1 }), kernel: Number(m[1]) };
            }
            m = line.match(/AMC:(\d+):(\d+):END/);
            if (m) {
                marks.lmk = { ...(marks.lmk || { kernel: -1 }), events: Number(m[1]), anr: Number(m[2]) };
            }
            if (/TOP\|/.test(line) && !line.includes('sed "s')) {
                marks.top.push(line.replace(/^.*TOP\|/, '').replace(/\r$/, ''));
            }
            if (/LOGDONE:2:END/.test(line)) {
                logDone = Date.now();
            }
            if (/SFTSDONE:2:END/.test(line)) {
                marks.sfts = 'done';
            }
            if (/CALDONE:\d+:END/.test(line) && !marks.cal) {
                marks.cal = Date.now();
            }
            // The log's own clock: the time stamp of a line we just wrote.
            m = line.match(/GCLK:\s*\d\d-\d\d (\d\d):(\d\d):(\d\d)\.(\d+)\s*:END/);
            if (m) {
                marks.clock = {
                    at: Date.now(),
                    tod: Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(`0.${m[4]}`),
                };
            }
            // Event log lines: "EV|11-16 12:00:00.000  1234  1234 I am_...: [..]"
            m = line.match(/EV\|\s*(\d\d-\d\d) (\d\d):(\d\d):(\d\d)\.(\d+)\s.*?(am_\w+)\s*:\s*(.*)$/);
            if (m) {
                const key = `${m[1]} ${m[2]}:${m[3]}:${m[4]}.${m[5]} ${m[6]} ${m[7].trim()}`;
                if (!marks.events.has(key)) {
                    marks.events.set(key, {
                        seen: Date.now(),
                        tod: Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]) + Number(`0.${m[5]}`),
                        tag: m[6],
                        text: m[7].trim().replace(/\r$/, ''),
                    });
                }
            }
        }
    };
    log('INPUT PROBE: input devices, the kernel\'s and Android\'s view');
    await send('\rgrep -E "^(N|H|B: (EV|KEY|ABS|REL))" /proc/bus/input/devices\r');
    await sleep(5000);
    await send('dumpsys input | grep -E "^    [0-9]+: |Classes:|Mode:" | head -24\r');
    await sleep(20000);
    // A dialog for an app that stopped responding, even one not on screen
    // yet, means that app does not answer, and while SystemUI does not,
    // touches are held back.
    await send('echo ANRWIN:$(dumpsys window windows | grep -c "Application Not Responding"):END\r');
    await sleep(10000);
    await send('getevent -lt > /data/local/tmp/porty-ev.txt 2>&1 &\r');
    await sleep(5000);
    await page.evaluate(() => {
        const c = document.getElementById('screen');
        const seen = {};
        globalThis.__portyProbe = seen;
        for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'touchstart', 'touchend']) {
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
    // Android's coordinates on its own screen -> page coordinates.
    const at = (ax, ay) => [r.x + (ax / (r.cw || 480)) * r.w, r.y + (ay / (r.ch || 800)) * r.h];
    log(`INPUT PROBE: canvas ${JSON.stringify(r)}`);
    // Poll the focus with a marker until `want` has it or `ms` pass.
    const focusWait = async (label, want, ms) => {
        const t = Date.now();
        while (Date.now() - t < ms) {
            await send('echo FOCUS:$(dumpsys window | grep mCurrentFocus | head -1 | cut -c1-90):END\r');
            await sleep(30000);
            const got = lastFocus;
            if (want.test(got)) {
                log(`INPUT PROBE: ${label}: ${got} after ${Math.round((Date.now() - t) / 1000)} s`);
                return true;
            }
        }
        log(`INPUT PROBE: ${label}: not within ${Math.round(ms / 1000)} s`);
        return false;
    };
    // --- the launch, measured -------------------------------------------
    // What the page knows: the disk and JIT counters, the frame rate, and
    // how much of the screen differs from the one before the tap (48x80
    // samples; the arrow cursor and the clock are below 2%).
    const pageSample = (setBase) => page.evaluate((base) => {
        const e = globalThis.__porty;
        const c = document.getElementById('screen');
        let diff = -1;
        try {
            const t = document.createElement('canvas');
            t.width = 48;
            t.height = 80;
            const g = t.getContext('2d');
            g.drawImage(c, 0, 0, 48, 80);
            const px = g.getImageData(0, 0, 48, 80).data;
            if (base || !globalThis.__portyBase) {
                globalThis.__portyBase = px;
            }
            const b = globalThis.__portyBase;
            let n = 0;
            for (let i = 0; i < px.length; i += 4) {
                n += Math.abs(px[i] - b[i]) + Math.abs(px[i + 1] - b[i + 1]) + Math.abs(px[i + 2] - b[i + 2]) > 48 ? 1 : 0;
            }
            diff = Math.round((1000 * n) / (48 * 80)) / 10;
        } catch (err) {
            diff = -1;
        }
        const stats = document.getElementById('stats');
        return {
            diff,
            frames: e && e.display && e.display.guestFrames !== undefined ? e.display.guestFrames : -1,
            fps: Number((/^(\d+) fps/.exec(stats ? stats.textContent : '') || [])[1] || -1),
            disk: e && e.diskStats ? e.diskStats() : null,
            heap: e && e.heapStats ? e.heapStats() : null,
            timescale: e && e.cfg ? e.cfg.timescale : 0,
            exited: e ? !!e.exited : false,
        };
    }, setBase);
    // One line of markers from the guest; see the parser in sleep().
    // During the launch only what /proc answers by itself: logcat waits for
    // logd's reader, which runs at background priority, and dumpsys for
    // system_server; with the CPU this busy neither came back for ten
    // minutes and the shell hung on them (run 43903544035).
    const EVENTS = 'am_proc_start|am_proc_died|am_kill|am_activity_launch_time|am_low_memory|am_anr|' +
        'am_proc_bound|am_restart_activity|am_on_resume_called|am_create_activity|am_focused_stack';
    const guestSample = [
        'echo ST:$(head -1 /proc/stat):$(grep -E "^(pgmajfault|pswpin|pswpout) " /proc/vmstat)' +
            ':$(cat /proc/loadavg):$(grep -E "^(MemFree|MemAvailable|SwapTotal|SwapFree):" /proc/meminfo):END',
        'echo PS:$(for n in system_server surfaceflinger com.android.gallery3d com.android.launcher3 ' +
            'com.android.systemui zygote64 zygote logd; do for p in $(pidof $n); do ' +
            'echo $n/$(cut -d" " -f14-15 /proc/$p/stat | tr " " +); done; done):END',
        'echo LMK:$(dmesg | grep -c -i -E "lowmemorykiller|out of memory|killed process"):0:0:END',
    ].join('; ');
    // Before the tap and after the launch: the activity manager's events
    // and the focused window.
    const guestLog = [
        `logcat -b events -d | grep -E "${EVENTS}" > /data/local/tmp/porty-am.txt`,
        'echo AMC:$(grep -c -E "am_low_memory|am_kill" /data/local/tmp/porty-am.txt)' +
            ':$(grep -c am_anr /data/local/tmp/porty-am.txt):END',
        'tail -24 /data/local/tmp/porty-am.txt | cut -c1-170 | sed "s/^/EV|/"',
        'echo FOCUS:$(dumpsys window | grep mCurrentFocus | head -1 | cut -c1-90):END',
    ].join('; ');
    // The busiest threads over one second of the guest's time.
    const guestTop = 'top -b -H -n 1 -d 1 -m 14 -s 1 -o %CPU,PID,TID,PR,S,CMD,NAME 2>&1 | tail -15 | cut -c1-110 | sed "s/^/TOP|/"';
    // How fast the guest runs a hot loop now: seconds for 20000 rounds of
    // the shell's arithmetic.  Comparable between runs and conditions.
    const calibrate = async (label) => {
        marks.cal = 0;
        const t = Date.now();
        await send('i=0; while [ $i -lt 20000 ]; do i=$((i+1)); done; echo CALDONE:$i:END\r');
        while (!marks.cal && Date.now() - t < 300000) {
            await sleep(1000);
        }
        const s = marks.cal ? (marks.cal - t) / 1000 : -1;
        log(`INPUT PROBE: guest speed ${label}: ${s < 0 ? 'no answer in 300 s' : `${s.toFixed(1)} s for 20000 shell loop rounds`}`);
        return s;
    };
    // During a launch the guest's one CPU is busy with ten runnable threads
    // and an ordinary shell did not answer for minutes (run 43900085582).
    // With the highest priority its samples come back; they cost the launch
    // a little, which the "quiet" option shows.
    await send('renice -n -20 -p $$ > /dev/null; echo NICE:$(cut -d" " -f19 /proc/$$/stat):END\r');
    await sleep(4000);
    const result = { conditions, query: String(params), hostCpu, calibrationS: await calibrate('before the tap') };
    // The guest's clock against ours, for the times in the event log: a
    // line written to the log now carries the log's time stamp.  The line
    // is written within moments of the send; reading it back takes longer.
    const guestClock = async () => {
        marks.clock = null;
        const sent = Date.now();
        await send('log -t PORTYCLK now; echo GCLK:$(logcat -d -s PORTYCLK:V | tail -1 | cut -c1-18):END\r');
        for (let i = 0; i < 30 && !marks.clock; i++) {
            await sleep(2000);
        }
        return marks.clock ? { sent, at: marks.clock.at, tod: marks.clock.tod } : null;
    };
    const clock0 = await guestClock();
    log(`INPUT PROBE: guest clock ${clock0 ? `${clock0.tod.toFixed(3)} s of its day, read back in ${clock0.at - clock0.sent} ms` : 'not read'}`);
    // surfaceflinger's scheduling: policy 1 is SCHED_FIFO, which the kernel
    // lets have sched_rt_runtime_us of every second before anything else.
    await send(`${guestSample}; echo SFSCHED:$(for t in /proc/$(pidof surfaceflinger)/task/*; do ` +
        'cut -d" " -f2,40,41 $t/stat; done | sort | uniq -c | tr "\n" ";")' +
        `:rt_runtime $(cat /proc/sys/kernel/sched_rt_runtime_us):END; ${guestLog}; echo LOGDONE:$((1+1)):END\r`);
    // The event log must have answered before the tap, or the shell is
    // still waiting for it during the launch.
    for (let i = 0; i < 36 && !logDone; i++) {
        await sleep(5000);
    }
    log(`INPUT PROBE: the event log ${logDone ? 'answered' : 'did not answer in 180 s'} before the tap`);
    logDone = 0;
    // A pcpu snapshot: wait for its end marker (or give up after `ms`).
    const cpuSnap = async (tag, threads, ms) => {
        if (!probeCpu) {
            return null;
        }
        const t = Date.now();
        marks.cpu.set(tag, { tag, at: t, procs: new Map(), threads: new Map(), done: false });
        // Real-time for the snapshot: surfaceflinger's threads are
        // SCHED_FIFO, and while it composes over and over a shell at nice
        // -20 waits minutes for its turn (run 43980055445).  toybox's chrt
        // takes the pid before the priority.
        await send(`chrt -f -p $$ 99 > /dev/null 2>&1; pcpu ${tag}${threads ? ' threads' : ''}; chrt -o -p $$ 0 > /dev/null 2>&1\r`);
        while (!(marks.cpu.get(tag) || {}).done && Date.now() - t < ms) {
            await sleep(2000);
        }
        const s = marks.cpu.get(tag);
        log(`INPUT PROBE: cpu snapshot ${tag}: ${s && s.done ? `${s.procs.size} processes, ${s.threads.size} threads, ` +
            `sf frames ${s.frames}, in ${Math.round((Date.now() - t) / 1000)} s` : `incomplete after ${Math.round(ms / 1000)} s`}`);
        return s && s.done ? s : null;
    };
    if (probeCpu) {
        await send(`${PCPU_FUNCTION}\r`);
        await sleep(3000);
    }
    // surfaceflinger's own count of the frames it composes, per layer
    // (TimeStats, Android 9): on and cleared now, read at the end.  Both
    // are binder calls (and a permission check with system_server), so
    // they stay out of the launch.
    const sfStats = async (cmd, ms) => {
        if (!probeSfStats) {
            return;
        }
        marks.sfts = '';
        const t = Date.now();
        await send(`${cmd}; echo SFTSDONE:$((1+1)):END\r`);
        while (marks.sfts !== 'done' && Date.now() - t < ms) {
            await sleep(2000);
        }
    };
    await sfStats('dumpsys SurfaceFlinger --timestats -enable -clear > /dev/null 2>&1', 60000);
    const cpuBefore = await cpuSnap('before', true, 180000);
    const cpuTags = cpuBefore ? ['before'] : [];
    let prevSt = marks.st;
    let prevPs = marks.ps;
    const before = await pageSample(true);
    let prevPage = before;
    log(`INPUT PROBE: before the tap: ${JSON.stringify({ ...before, st: prevSt, lmk: marks.lmk })}`);
    const eventsBefore = new Set(marks.events.keys());

    const [gx, gy] = at(150, 565 * (r.ch || 800) / 800);
    log(`INPUT PROBE: finger tap at ${gx.toFixed(0)},${gy.toFixed(0)} (the Gallery icon)`);
    await page.touchscreen.tap(gx, gy);
    const tapAt = Date.now();
    const since = () => Math.round((Date.now() - tapAt) / 1000);
    let nextGuest = tapAt + 20000;
    let nextLine = tapAt + 30000;
    let shotDone = false;
    let guestRound = 0;
    let lastSeenSt = prevSt;
    let lastSeenPs = prevPs;
    let peakInFlight = 0;
    result.firstChangeS = -1;   // 10% of the screen differs: the starting window
    result.screenChangedS = -1; // 40%: another window covers the launcher
    const samples = [];
    const timeline = [];
    let lastDiff = 0;
    while (Date.now() - tapAt < probeWaitMs) {
        // Nothing new is typed while a CPU snapshot is still printing: the
        // terminal's echo of typed text lands in the middle of its lines.
        const lastCpu = cpuTags.length ? marks.cpu.get(cpuTags[cpuTags.length - 1]) : null;
        const cpuBusy = lastCpu && !lastCpu.done && Date.now() - lastCpu.at < 300000;
        if (guestEveryMs && Date.now() >= nextGuest && !cpuBusy) {
            nextGuest = Date.now() + guestEveryMs;
            const round = guestRound++;
            // Every PROBE_CPU_EVERY-th round a CPU snapshot instead of top.
            const cpuTag = cpuBefore && round % probeCpuEvery === probeCpuEvery - 1 ? `t${since()}` : '';
            if (cpuTag) {
                cpuTags.push(cpuTag);
                marks.cpu.set(cpuTag, { tag: cpuTag, at: Date.now(), procs: new Map(), threads: new Map(), done: false });
            }
            await send(`${guestSample}${cpuTag ? `; pcpu ${cpuTag}` : (round % 2 === 1 ? `; ${guestTop}` : '')}\r`);
        }
        await sleep(5000);
        let now;
        try {
            now = await pageSample(false);
        } catch (e) {
            log(`INPUT PROBE: page did not answer: ${e.message}`);
            continue;
        }
        peakInFlight = Math.max(peakInFlight, now.disk ? now.disk.inFlight : 0);
        if (Math.abs(now.diff - lastDiff) >= 1) {
            lastDiff = now.diff;
            timeline.push(`${since()}s:${now.diff}%`);
        }
        if (result.firstChangeS < 0 && now.diff >= 10) {
            result.firstChangeS = since();
            log(`INPUT PROBE: launch t+${since()} s: ${now.diff}% of the screen changed`);
        }
        if (result.screenChangedS < 0 && now.diff >= 40) {
            result.screenChangedS = since();
            log(`INPUT PROBE: launch t+${since()} s: ${now.diff}% of the screen changed`);
            await shot(`launch-changed-t${since()}s`);
        }
        if (!shotDone && since() >= 15) {
            shotDone = true;
            await shot('after-touch', true);
        }
        if (Date.now() >= nextLine || now.exited) {
            nextLine = Date.now() + 30000;
            // Guest ticks are 1/100 s of the guest's own, dilated time.
            const st = marks.st;
            let cpu = 'guest: no new sample';
            if (st && lastSeenSt && st !== lastSeenSt) {
                const d = (k) => st[k] - lastSeenSt[k];
                const total = Math.max(1, d('user') + d('system') + d('idle') + d('iowait'));
                const pct = (k) => Math.round((100 * d(k)) / total);
                cpu = `guest cpu over ${Math.round((st.at - lastSeenSt.at) / 1000)} s: user ${pct('user')}% ` +
                    `system ${pct('system')}% iowait ${pct('iowait')}% idle ${pct('idle')}% (${total} ticks), ` +
                    `majfault +${d('majfault')}, swap in/out +${d('swapin')}/+${d('swapout')}, ` +
                    `free ${st.memFreeMb} MB, available ${st.memAvailMb} MB, ` +
                    `swap ${st.swapTotalMb - st.swapFreeMb}/${st.swapTotalMb} MB, load ${st.load}`;
                samples.push({ t: since(), user: pct('user'), system: pct('system'), iowait: pct('iowait'),
                    idle: pct('idle'), ticks: total, majfault: d('majfault'), wallS: (st.at - lastSeenSt.at) / 1000 });
                lastSeenSt = st;
            }
            let procs = '';
            if (marks.ps && lastSeenPs && marks.ps !== lastSeenPs) {
                procs = '; ticks by process: ' + Object.keys(marks.ps.ticks)
                    .map((k) => [k.replace(/^com\.android\./, ''), marks.ps.ticks[k] - (lastSeenPs.ticks[k] || 0)])
                    .filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ');
                lastSeenPs = marks.ps;
            } else if (marks.ps && !lastSeenPs) {
                lastSeenPs = marks.ps;
            }
            const dk = now.disk || {};
            const pk = prevPage.disk || {};
            const hp = now.heap || {};
            const ph = prevPage.heap || {};
            log(`INPUT PROBE: launch t+${since()} s: screen diff ${now.diff}%, ${now.fps} fps; ` +
                `disk fetched ${dk.chunksFetched} (+${dk.chunksFetched - pk.chunksFetched}), ` +
                `cache hits ${dk.cacheHits} (+${dk.cacheHits - pk.cacheHits}), in flight ${dk.inFlight} ` +
                `(peak ${peakInFlight}), errors ${dk.errors}; ` +
                `jit alive ${hp.jitAlive}/${hp.jitCap}, compiled ${hp.jitCompiled} (+${hp.jitCompiled - ph.jitCompiled}); ` +
                `heap ${hp.used}/${hp.brk} MB; ${cpu}${procs}; ` +
                `lmk ${marks.lmk ? `${marks.lmk.kernel} kernel, ${marks.lmk.events} am_kill/low_memory, ${marks.lmk.anr} anr` : '?'}; ` +
                `focus ${lastFocus.replace(/^mCurrentFocus=/, '').slice(0, 70) || '?'}`);
            prevPage = now;
            peakInFlight = 0;
        }
        if (now.exited) {
            log('INPUT PROBE: QEMU exited during the launch');
            break;
        }
        // Done: Gallery has the focus and its window is on the screen; one
        // more round of samples for the event log's launch time.
        if (!launchOnly && result.screenChangedS >= 0 && since() - result.screenChangedS >= 35) {
            break;
        }
    }
    result.screenTimeline = timeline.join(' ');
    log(`INPUT PROBE: how much of the screen differed from the home screen, when it changed: ${result.screenTimeline || 'never'}`);
    for (const line of marks.top) {
        log(`INPUT PROBE: top| ${line}`);
    }
    // Where the guest's CPU went: from the tap to now, and between the
    // snapshots taken during the launch.
    const cpuEnd = cpuBefore ? await cpuSnap('end', true, 240000) : null;
    await sfStats('dumpsys SurfaceFlinger --timestats -dump -maxlayers 16 2>&1 | grep -E ' +
        '"layerName|totalFrames|droppedFrames|missedFrames|clientCompositionFrames|statsStart|statsEnd|displayOnTime" ' +
        '| sed "s/^/SFTS|/"', 120000);
    if (cpuEnd) {
        cpuTags.push('end');
        const whole = cpuDelta(cpuBefore, cpuEnd);
        log(`INPUT PROBE: CPU from the tap to the end: ${describeCpu(whole, 16)}`);
        const pct = (v) => `${Math.round((1000 * v) / Math.max(1, whole.busy)) / 10}%`;
        for (const p of whole.procs.slice(0, 30)) {
            log(`INPUT PROBE: cpu| process ${p.comm}${p.isNew ? ' (new)' : ''} pid ${p.pid}: ${p.ticks} ticks, ${pct(p.ticks)}`);
        }
        for (const t of whole.threads.slice(0, 40)) {
            log(`INPUT PROBE: cpu| thread ${t.proc}/${t.comm} tid ${t.tid} (nice ${t.nice}, policy ${t.policy}): ${t.ticks} ticks, ${pct(t.ticks)}`);
        }
        const done = cpuTags.map((tag) => marks.cpu.get(tag)).filter((s) => s && s.done && s.stat);
        for (let i = 1; i < done.length; i++) {
            log(`INPUT PROBE: cpu ${done[i - 1].tag} -> ${done[i].tag}: ${describeCpu(cpuDelta(done[i - 1], done[i]), 6)}`);
        }
        const shown = await pageSample(false).catch(() => null);
        const displayUpdates = shown && shown.frames >= 0 && before.frames >= 0 ? shown.frames - before.frames : -1;
        log(`INPUT PROBE: QEMU's display was updated ${displayUpdates} times from the tap to the end`);
        result.cpu = {
            busy: whole.busy, total: whole.total, user: whole.user, system: whole.system, guestSeconds: whole.guestSeconds,
            sfFrames: whole.frames, displayUpdates, uncounted: whole.uncounted, probeTicks: whole.probeTicks,
            top: whole.procs.slice(0, 10).map((p) => [p.comm, p.ticks]),
            threads: whole.threads.slice(0, 12).map((t) => [`${t.proc}/${t.comm}`, t.ticks]),
        };
    }
    // The event log's own account, in guest time since the tap.
    const clock1 = await guestClock();
    lastFocus = '';
    await send(`${guestLog}; ` +
        'logcat -d -b main -b system | grep -E "Displayed |ANR in |Skipped [0-9]+ frames|lowmemorykiller|Low on memory" ' +
        '| tail -12 | cut -c1-170; echo LOGDONE:$((1+1)):END\r');
    // These wait for logd and system_server, which may be starved.
    for (let i = 0; i < 36 && !logDone; i++) {
        await sleep(5000);
    }
    result.logAnsweredS = logDone ? Math.round((logDone - tapAt) / 1000) : -1;
    result.focusedAtEnd = /gallery/i.test(lastFocus);
    result.focusAtEnd = lastFocus.replace(/^mCurrentFocus=/, '').slice(0, 80);
    const ts = before.timescale || 8;
    const day = (d) => (d < -43200 ? d + 86400 : d);
    if (clock0 && clock1) {
        result.guestClockRate = Math.round((1000 * day(clock1.tod - clock0.tod)) / ((clock1.sent - clock0.sent) / 1000)) / 1000;
        log(`INPUT PROBE: the guest's clock ran at ${result.guestClockRate} of real time (timescale ${ts}: ${(1 / ts).toFixed(3)})`);
    }
    const fresh = [...marks.events.entries()].filter(([k]) => !eventsBefore.has(k)).map(([, v]) => v)
        .sort((a, b) => a.tod - b.tod);
    // Guest time of day at the tap, from the clock sample before it, at
    // the rate the guest's clock really ran (else the timescale's).
    const rate = result.guestClockRate > 0 ? result.guestClockRate : 1 / ts;
    const tapTod = clock0 ? clock0.tod + ((tapAt - clock0.sent) / 1000) * rate : -1;
    const wall = (ev) => Math.round(day(ev.tod - tapTod) / rate);
    for (const ev of fresh) {
        log(`INPUT PROBE: event t+${tapTod >= 0 ? wall(ev) : '?'} s: ${ev.tag} ${ev.text.slice(0, 120)}`);
    }
    const count = (tag) => fresh.filter((ev) => ev.tag === tag).length;
    const launched = fresh.find((ev) => ev.tag === 'am_activity_launch_time' && /gallery/i.test(ev.text));
    result.firstFrameS = launched && tapTod >= 0 ? wall(launched) : -1;
    const lt = launched && /,(\d+),(\d+)\]/.exec(launched.text);
    result.launchTimeGuestMs = lt ? Number(lt[2]) : -1;
    result.launchTimeWallS = lt ? Math.round(Number(lt[2]) / 1000 / rate) : -1;
    const procStart = fresh.find((ev) => ev.tag === 'am_proc_start' && /gallery/i.test(ev.text));
    result.procStartS = procStart && tapTod >= 0 ? wall(procStart) : -1;
    result.events = { procStart: count('am_proc_start'), procDied: count('am_proc_died'), kill: count('am_kill'),
        lowMemory: count('am_low_memory'), anr: count('am_anr') };
    result.lmk = marks.lmk;
    const end = await pageSample(false).catch(() => null);
    if (end && end.disk && before.disk) {
        result.disk = { fetched: end.disk.chunksFetched - before.disk.chunksFetched,
            cacheHits: end.disk.cacheHits - before.disk.cacheHits, errors: end.disk.errors - before.disk.errors };
        result.jit = { alive: end.heap && end.heap.jitAlive, cap: end.heap && end.heap.jitCap,
            compiled: end.heap && before.heap ? end.heap.jitCompiled - before.heap.jitCompiled : -1 };
    }
    const sum = (k) => samples.reduce((a, x) => a + x[k] * x.ticks, 0);
    const ticks = Math.max(1, samples.reduce((a, x) => a + x.ticks, 0));
    result.guestCpu = { user: Math.round(sum('user') / ticks), system: Math.round(sum('system') / ticks),
        iowait: Math.round(sum('iowait') / ticks), idle: Math.round(sum('idle') / ticks),
        majfault: samples.reduce((a, x) => a + x.majfault, 0) };
    result.waitedS = since();
    result.network = netSummary();
    launchResult = result;
    log(`LAUNCH RESULT: ${JSON.stringify(result)}`);
    log(`INPUT PROBE: network: ${result.network}`);
    log(`INPUT PROBE: page saw ${JSON.stringify(await page.evaluate(() => globalThis.__portyProbe))}`);
    await shot('after-touch-wait', true);
    if (launchOnly) {
        await send('\rpkill getevent\r');
        await sleep(3000);
        log('INPUT PROBE: done (launch only)');
        return;
    }

    log('INPUT PROBE: the page\'s Home button');
    await page.click('#nav-home').catch((e) => log(`INPUT PROBE: no Home button (${e.message})`));
    await focusWait('launcher in front', /launcher/i, probeWaitMs / 2);

    const [sx, sy] = at((r.cw || 480) / 2, 91 * (r.ch || 800) / 800);
    log(`INPUT PROBE: mouse click at ${sx.toFixed(0)},${sy.toFixed(0)} (the search bar)`);
    await page.mouse.move(sx - 20, sy);
    await page.mouse.move(sx, sy, { steps: 4 });
    await page.mouse.down();
    await sleep(150);
    await page.mouse.up();
    await focusWait('search in front', /search|quicksearchbox|googlequicksearchbox/i, (probeWaitMs * 3) / 4);
    log(`INPUT PROBE: page saw ${JSON.stringify(await page.evaluate(() => globalThis.__portyProbe))}`);
    await shot('after-mouse', true);

    await send('\rpkill getevent; echo PROBE-EVENTS $(wc -l < /data/local/tmp/porty-ev.txt); head -40 /data/local/tmp/porty-ev.txt\r');
    await sleep(20000);
    log('INPUT PROBE: done');
}

function emit(name, info, b64) {
    log(`screenshot ${name}: ${info}, ${b64.length} base64 chars`);
    console.log(`-----BEGIN PORTY SCREENSHOT ${name.replace(/\s+/g, '_')} ${info}-----`);
    for (let i = 0; i < b64.length; i += 1000) {
        console.log(b64.slice(i, i + 1000));
    }
    console.log('-----END PORTY SCREENSHOT-----');
}

let exitCode = 0;
let launchResult = null;
let booted = false;
let finalState = '';
let lastSnap = null;
const serialTail = [];

try {
    // --- open the page and wait for cross-origin isolation -----------------
    log(`opening ${url}`);
    await page.goto(url, { waitUntil: 'load', timeout: 120000 });
    for (let attempt = 1; ; attempt++) {
        try {
            // coi-serviceworker reloads the page once; the context may vanish.
            await page.waitForFunction(() => globalThis.crossOriginIsolated === true, { timeout: 120000 });
            await page.waitForFunction(() => !document.getElementById('start').disabled, { timeout: 60000 });
            break;
        } catch (e) {
            if (attempt >= 3) {
                throw e;
            }
            log(`waiting for the page again (${e.message})`);
            await sleep(3000);
        }
    }
    log('page is cross-origin isolated and ready');
    for (const target of browser.targets()) {
        await adoptServiceWorker(target);
    }
    log(`conditions: ${conditions}`);
    startThrottle();
    log(`precheck: ${await page.$eval('#precheck', (e) => e.textContent.replace(/\s+/g, ' ').trim())}`);
    log(`build: ${await page.$eval('#buildid', (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '?')}`);

    // --- start, and tee the serial console into a capture buffer ------------
    await page.click('#start');
    await page.evaluate(() => {
        globalThis.__cap = [];
        const serial = globalThis.__porty && globalThis.__porty.serial;
        // xterm-pty registers one handler for both typed text and binary
        // input, and the page's serial.send() calls every registration: a
        // command sent that way reaches the guest twice and runs twice.
        // Send to each handler once.
        globalThis.__send = (text) => {
            new Set(serial ? serial.inputHandlers : []).forEach((h) => h(text));
        };
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
    // Progress: a commit status every two minutes (readable while the run is
    // going), plus a notice annotation at a few points (readable at the end).
    let nextStatus = 0;
    const notesAt = [5, 10, 15, 20, 30, 45, 60, 80, 100]
        .map((m) => t0 + m * 60000).filter((t) => t < deadline);
    const shotsAt = [2, 4, 7, 10, 15, 20, 25, 30, 40, 50, 60, 90, 120]
        .map((m) => t0 + m * 60000).filter((t) => t < deadline);
    let printedArgs = false;
    let carry = '';
    let recent = '';
    let probeAt = t0 + 8 * 60000;
    let appsListed = false;
    let resumedSeen = false;
    let shellSent = !shellInit;
    let bootedAt = 0;
    let lastStatusLine = '';
    let lastStatusTime = 0;

    while (Date.now() < deadline) {
        await sleep(10000);
        let snap;
        try {
            snap = await page.evaluate(() => {
                const $ = (id) => document.getElementById(id);
                const text = (id) => ($(id) ? $(id).textContent.replace(/\s+/g, ' ').trim() : '');
                const e = globalThis.__porty;
                let disk = null;
                try {
                    disk = e && e.module && e.diskStats ? e.diskStats() : null;
                } catch (err) {
                    disk = String(err);
                }
                const c = $('screen');
                let lit = -1;
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
                } catch (e) {
                    lit = -1;
                }
                return {
                    lit,
                    state: $('app').dataset.state || '',
                    stage: text('stage-text'),
                    detail: text('stage-detail'),
                    logline: text('logline'),
                    stats: text('stats'),
                    failure: $('app').dataset.state === 'failed' ? text('failure') : '',
                    serial: globalThis.__cap ? globalThis.__cap.splice(0).join('') : '',
                    disk,
                    heap: e && e.module && e.heapStats ? e.heapStats() : null,
                    screen: c ? `${c.width}x${c.height}` : '',
                    exited: e ? !!e.exited : false,
                    args: e && e.args ? e.args.join(' ') : '',
                    cmdline: e && e.cmdline ? e.cmdline : '',
                    memory: e ? `guest ${e.cfg && e.cfg.mem} MiB, smp ${e.cfg && e.cfg.smp}, wasm ${e.wasmMemoryMb} MiB, patched ${e.patched}` : '',
                    notes: e && e.notes ? e.notes.join(' | ') : '',
                };
            });
        } catch (e) {
            log(`page did not answer: ${e.message}`);
            continue;
        }
        lastSnap = snap;
        finalState = snap.state;

        if (!printedArgs && snap.args) {
            printedArgs = true;
            log(`memory: ${snap.memory}`);
            log(`qemu argv: ${snap.args}`);
            log(`kernel cmdline: ${snap.cmdline}`);
            if (snap.notes) {
                log(`notes: ${snap.notes}`);
            }
        }

        // serial console, line by line
        if (snap.serial) {
            recent = (recent + snap.serial).slice(-20000);
            const lines = (carry + snap.serial).split('\n');
            carry = lines.pop();
            for (const raw of lines) {
                const line = stripAnsi(raw).replace(/\r/g, '');
                console.log(`serial| ${line}`);
                serialTail.push(line);
                if (serialTail.length > 40) {
                    serialTail.shift();
                }
            }
        }

        const statusLine = `state=${snap.state} screen=${snap.screen} stage="${snap.stage}" ` +
            `detail="${snap.detail}" stats="${snap.stats}" log="${snap.logline}"` +
            (snap.disk ? ` disk=${JSON.stringify(snap.disk)}` : '') +
            (snap.heap ? ` heap=${JSON.stringify(snap.heap)}` : '');
        if (statusLine !== lastStatusLine || Date.now() - lastStatusTime > 60000) {
            log(statusLine);
            lastStatusLine = statusLine;
            lastStatusTime = Date.now();
        }

        if (snap.state === 'failed') {
            log(`PAGE FAILED: ${snap.failure}`);
            await shot('failed', true);
            await dumpFiles();
            exitCode = 1;
            break;
        }
        if (snap.exited) {
            log('QEMU EXITED');
            await shot('exited', true);
            exitCode = 1;
            break;
        }
        const lastLine = serialTail.filter((l) => l.trim() && !/unsupported syscall/.test(l)).slice(-1)[0] || '';
        const fetched = snap.disk && typeof snap.disk === 'object' ? `${Math.round(snap.disk.megabytes)}MB` : '';
        if (Date.now() >= nextStatus) {
            nextStatus = Date.now() + 120000;
            const heap = snap.heap ? ` heap${snap.heap.used}/${snap.heap.brk}MB` +
                (snap.heap.coroutines !== undefined ? ` co${snap.heap.coroutines}` : '') +
                (snap.heap.jitAlive !== undefined ? ` jit${snap.heap.jitAlive}/${snap.heap.jitCompiled}` : '') : '';
            await postStatus('pending', `${elapsed()} ${snap.screen} lit${snap.lit}%${heap} ${fetched} | ${lastLine.trim()}`);
        }
        if (notesAt.length && Date.now() >= notesAt[0]) {
            notesAt.shift();
            const tail = serialTail.filter((l) => l.trim() && !/unsupported syscall/.test(l)).slice(-4)
                .map((l) => l.trim().slice(0, 140)).join(' | ');
            const msg = `${elapsed()} state=${snap.state} screen=${snap.screen} ${fetched} ${snap.stats} :: ${tail}`;
            console.log(`::notice title=Porty boot ${elapsed()}::${msg.replace(/[\r\n%]/g, ' ')}`);
        }
        while (shotsAt.length && Date.now() >= shotsAt[0]) {
            shotsAt.shift();
            await shot(`t${elapsed().replace(':', 'm')}s`);
        }

        // Ask the serial shell (if Android-x86 runs one) whether boot finished.
        // A resumed Android is on its home screen at once: no eight minutes.
        if (!resumedSeen && /resumed/i.test(snap.stage)) {
            resumedSeen = true;
            log(`resumed; the first check for the shell in ${Math.round(resumeSettleMs / 1000)} s`);
            probeAt = Math.min(probeAt, Date.now() + resumeSettleMs);
        }
        if (!shellSent && /console:\/ #/.test(stripAnsi(recent))) {
            shellSent = true;
            log(`SHELL INIT: ${shellInit}`);
            await page.evaluate((cmd) => globalThis.__send(`\r${cmd}\r`), shellInit);
            await sleep(3000);
        }
        if (!booted && snap.state === 'running' && Date.now() >= probeAt) {
            probeAt = Date.now() + 120000;
            // Where the guest's time goes: cumulative user/nice/system/idle/
            // iowait ticks, and from 14 minutes the busiest processes.
            await page.evaluate(() => globalThis.__send(
                '\rhead -1 /proc/stat; cat /proc/loadavg\r'));
            await sleep(2000);
            if (Date.now() - t0 > 14 * 60000) {
                await page.evaluate(() => globalThis.__send(
                    'top -b -n 2 -d 2 -m 8 2>/dev/null | tail -9 | cut -c1-110\r'));
                await sleep(8000);
            }
            if (!appsListed && Date.now() - t0 > 12 * 60000) {
                // Once: which Google packages the system image ships (the
                // README says none; the boot log mentions Play services).
                appsListed = true;
                await page.evaluate(() => globalThis.__send(
                    '\rls /system/priv-app /system/app 2>/dev/null | grep -i -E "gms|google|vending|phonesky|gsf" | tr "\\n" " "; echo\r'));
                await sleep(3000);
            }
            // Progress first (informational), then the line the regex below reads.
            await page.evaluate(() => globalThis.__send(
                '\rgetprop init.svc.zygote; getprop init.svc.surfaceflinger; getprop init.svc.bootanim\r'));
            await sleep(3000);
            // From 20 minutes on, also the newest Android log lines (what
            // system_server is busy with); they land in the job log.
            if (Date.now() - t0 > 20 * 60000) {
                await page.evaluate(() => globalThis.__send(
                    'logcat -d -b main -b system -t 12 2>/dev/null | cut -c1-150\r'));
                await sleep(5000);
            }
            // A marker the typed command's echo cannot contain: the echo
            // shows "$(getprop ...)", only the output shows the value.  A
            // bare "getprop sys.boot_completed" followed by a "1" matched
            // once when another command's output landed after the echo.
            await page.evaluate(() => globalThis.__send(
                'echo BOOTCHK:$(getprop sys.boot_completed):END\r'));
        }
        if (!booted && /BOOTCHK:1:END/.test(stripAnsi(recent))) {
            booted = true;
            bootedAt = Date.now();
            log('ANDROID BOOT COMPLETED (sys.boot_completed=1)');
            await shot('boot-completed', true);
            if (process.env.INPUT_PROBE !== '0') {
                await inputProbe();
                bootedAt = Date.now();
            }
        }
        if (booted && Date.now() - bootedAt > 90000) {
            break;
        }
    }
    await shot('final', true);
    await dumpFiles();
    // Where the start's time went, and what the disk cache did (pages
    // before the disk cache have neither).
    const visit = await page.evaluate(async () => {
        const e = globalThis.__porty;
        const dc = e && e.diskCache;
        return {
            timings: (e && e.timings) || null,
            diskCache: dc ? await dc.stats().catch(() => null) : null,
            stored: dc ? await dc.usage(e.manifest && e.manifest.disk, e.snapshot).catch(() => null) : null,
            controlled: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
        };
    }).catch((e) => ({ error: e.message }));
    log(`VISIT: ${JSON.stringify(visit)}`);
} catch (e) {
    log(`TEST ERROR: ${e.stack || e}`);
    await shot('error', true);
    exitCode = 1;
}

stopThrottle();
const verdict = exitCode ? 'failed' : (booted ? 'booted' : 'still booting at the deadline');
const secs = (v) => (v >= 0 ? `${v} s` : 'not seen');
const launchLine = launchResult
    ? `Gallery: screen changed ${secs(launchResult.screenChangedS)} (${launchResult.screenTimeline}), ` +
        `first frame by the event log ${secs(launchResult.firstFrameS)}, ` +
        `${launchResult.focusedAtEnd ? 'focused' : 'not focused'} at ${secs(launchResult.logAnsweredS)} ` +
        `(${launchResult.conditions})`
    : '';
log(`SUMMARY: ${verdict}; state=${finalState}; elapsed ${elapsed()}${launchLine ? `; ${launchLine}` : ''}`);
log(`network: ${netSummary()}; ${workerCount} workers`);
await postStatus(exitCode ? 'failure' : (booted ? 'success' : 'error'),
    `${verdict} after ${elapsed()}${launchLine ? `; ${launchLine}` : ''}`);
if (exitCode) {
    const why = lastSnap && lastSnap.failure ? lastSnap.failure.slice(0, 200) : 'see the log';
    console.log(`::warning title=Porty boot test failed::${params} - ${why}`);
} else if (!booted) {
    console.log(`::warning::Android did not report sys.boot_completed=1 within ${minutes} minutes (it may have no serial shell; check the screenshots).`);
}
if (process.env.GITHUB_STEP_SUMMARY) {
    const s = lastSnap || {};
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
        '## Porty boot test',
        '',
        `- URL: ${url}`,
        `- Result: **${verdict}** after ${elapsed()} (page state \`${finalState}\`)`,
        `- Screen: ${s.screen || 'n/a'}; last stage: ${s.stage || 'n/a'} ${s.detail || ''}`,
        `- ${s.memory || ''}`,
        `- Conditions: ${conditions}; host CPU: ${hostCpu}`,
        ...(launchResult ? [`- ${launchLine}`, '', '```json', JSON.stringify(launchResult, null, 1), '```'] : []),
        '',
        'Last serial lines:',
        '',
        '```',
        ...serialTail.slice(-25),
        '```',
        '',
    ].join('\n'));
}
await Promise.race([browser.close(), sleep(15000)]);
process.exit(process.env.BOOT_TEST_STRICT === '1' ? exitCode : 0);
