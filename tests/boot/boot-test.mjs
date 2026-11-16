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
//
// Exit status: 0 whatever happened to Android (the verdict is in the log,
// the job summary and a warning annotation: a red run would e-mail the
// repository owner for every experiment); 1 only with BOOT_TEST_STRICT=1
// when the page or QEMU failed; 2 on bad usage.
// SPDX-License-Identifier: GPL-2.0-or-later
import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

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

const t0 = Date.now();
const elapsed = () => {
    const s = Math.floor((Date.now() - t0) / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const log = (msg) => console.log(`[${elapsed()}] ${msg}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// eslint-disable-next-line no-control-regex
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b[()][A-Z0-9]/g, '');

const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/usr/bin/google-chrome',
    headless: true,
    protocolTimeout: 300000,
    args: [
        '--no-sandbox', '--disable-gpu', '--window-size=480,900',
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
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
// Uncaught exceptions inside QEMU's threads (Web Workers), with their wasm
// stacks: the page itself only gets "worker sent an error!" and a line number.
page.on('workercreated', (worker) => {
    const name = worker.url().split('/').pop().split('?')[0];
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
async function inputProbe() {
    const send = (cmd) => page.evaluate((c) => globalThis.__porty.serial.send(c), cmd);
    // Print the serial output as it comes, so that it lands between the
    // probe's own lines (the main loop is not reading it meanwhile).
    let lastFocus = '';
    const sleep = async (ms) => {
        await new Promise((resolve) => setTimeout(resolve, ms));
        const text = await page.evaluate(() => (globalThis.__cap ? globalThis.__cap.splice(0).join('') : ''));
        for (const line of stripAnsi(text).split('\n')) {
            if (line.trim()) {
                console.log(`serial| ${line.replace(/\r$/, '')}`);
            }
            // The output of the marker command, not its echo.
            const m = line.match(/FOCUS:\s*(mCurrentFocus[^\r\n]*):END/);
            if (m) {
                lastFocus = m[1];
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
    const [gx, gy] = at(150, 565 * (r.ch || 800) / 800);
    log(`INPUT PROBE: finger tap at ${gx.toFixed(0)},${gy.toFixed(0)} (the Gallery icon)`);
    await page.touchscreen.tap(gx, gy);
    await sleep(15000);
    await shot('after-touch', true);
    await focusWait('Gallery in front', /gallery/i, 240000);
    log(`INPUT PROBE: page saw ${JSON.stringify(await page.evaluate(() => globalThis.__portyProbe))}`);
    await shot('after-touch-wait', true);

    log('INPUT PROBE: the page\'s Home button');
    await page.click('#nav-home').catch((e) => log(`INPUT PROBE: no Home button (${e.message})`));
    await focusWait('launcher in front', /launcher/i, 120000);

    const [sx, sy] = at((r.cw || 480) / 2, 91 * (r.ch || 800) / 800);
    log(`INPUT PROBE: mouse click at ${sx.toFixed(0)},${sy.toFixed(0)} (the search bar)`);
    await page.mouse.move(sx - 20, sy);
    await page.mouse.move(sx, sy, { steps: 4 });
    await page.mouse.down();
    await sleep(150);
    await page.mouse.up();
    await focusWait('search in front', /search|quicksearchbox|googlequicksearchbox/i, 180000);
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
    log(`precheck: ${await page.$eval('#precheck', (e) => e.textContent.replace(/\s+/g, ' ').trim())}`);
    log(`build: ${await page.$eval('#buildid', (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '?')}`);

    // --- start, and tee the serial console into a capture buffer ------------
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
        if (!shellSent && /console:\/ #/.test(stripAnsi(recent))) {
            shellSent = true;
            log(`SHELL INIT: ${shellInit}`);
            await page.evaluate((cmd) => globalThis.__porty.serial.send(`\r${cmd}\r`), shellInit);
            await sleep(3000);
        }
        if (!booted && snap.state === 'running' && Date.now() >= probeAt) {
            probeAt = Date.now() + 120000;
            // Where the guest's time goes: cumulative user/nice/system/idle/
            // iowait ticks, and from 14 minutes the busiest processes.
            await page.evaluate(() => globalThis.__porty.serial.send(
                '\rhead -1 /proc/stat; cat /proc/loadavg\r'));
            await sleep(2000);
            if (Date.now() - t0 > 14 * 60000) {
                await page.evaluate(() => globalThis.__porty.serial.send(
                    'top -b -n 2 -d 2 -m 8 2>/dev/null | tail -9 | cut -c1-110\r'));
                await sleep(8000);
            }
            if (!appsListed && Date.now() - t0 > 12 * 60000) {
                // Once: which Google packages the system image ships (the
                // README says none; the boot log mentions Play services).
                appsListed = true;
                await page.evaluate(() => globalThis.__porty.serial.send(
                    '\rls /system/priv-app /system/app 2>/dev/null | grep -i -E "gms|google|vending|phonesky|gsf" | tr "\\n" " "; echo\r'));
                await sleep(3000);
            }
            // Progress first (informational), then the line the regex below reads.
            await page.evaluate(() => globalThis.__porty.serial.send(
                '\rgetprop init.svc.zygote; getprop init.svc.surfaceflinger; getprop init.svc.bootanim\r'));
            await sleep(3000);
            // From 20 minutes on, also the newest Android log lines (what
            // system_server is busy with); they land in the job log.
            if (Date.now() - t0 > 20 * 60000) {
                await page.evaluate(() => globalThis.__porty.serial.send(
                    'logcat -d -b main -b system -t 12 2>/dev/null | cut -c1-150\r'));
                await sleep(5000);
            }
            // A marker the typed command's echo cannot contain: the echo
            // shows "$(getprop ...)", only the output shows the value.  A
            // bare "getprop sys.boot_completed" followed by a "1" matched
            // once when another command's output landed after the echo.
            await page.evaluate(() => globalThis.__porty.serial.send(
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
        // LINGER: seconds to keep watching after the boot (and the input probe);
        // a SHELL_INIT command that takes long needs them.
        if (booted && Date.now() - bootedAt > Math.max(0, Number(process.env.LINGER) || 90) * 1000) {
            break;
        }
    }
    await shot('final', true);
    await dumpFiles();
} catch (e) {
    log(`TEST ERROR: ${e.stack || e}`);
    await shot('error', true);
    exitCode = 1;
}

const verdict = exitCode ? 'failed' : (booted ? 'booted' : 'still booting at the deadline');
log(`SUMMARY: ${verdict}; state=${finalState}; elapsed ${elapsed()}`);
await postStatus(exitCode ? 'failure' : (booted ? 'success' : 'error'), `${verdict} after ${elapsed()}`);
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
