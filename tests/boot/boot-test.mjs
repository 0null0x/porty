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
await page.setViewport({ width: 480, height: 900 });
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
                context: `porty/boot ${(process.env.QUERY || '').trim() || 'defaults'}`.slice(0, 100),
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
                return {
                    state: $('app').dataset.state || '',
                    stage: text('stage-text'),
                    detail: text('stage-detail'),
                    logline: text('logline'),
                    stats: text('stats'),
                    failure: $('app').dataset.state === 'failed' ? text('failure') : '',
                    serial: globalThis.__cap ? globalThis.__cap.splice(0).join('') : '',
                    disk,
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
            (snap.disk ? ` disk=${JSON.stringify(snap.disk)}` : '');
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
            await postStatus('pending', `${elapsed()} ${snap.screen} ${fetched} | ${lastLine.trim()}`);
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
        if (!booted && snap.state === 'running' && Date.now() >= probeAt) {
            probeAt = Date.now() + 120000;
            // Progress first (informational), then the line the regex below reads.
            await page.evaluate(() => globalThis.__porty.serial.send(
                '\rgetprop init.svc.zygote; getprop init.svc.surfaceflinger; getprop init.svc.bootanim\r'));
            await sleep(3000);
            await page.evaluate(() => globalThis.__porty.serial.send('getprop sys.boot_completed\r'));
        }
        if (!booted && /getprop sys\.boot_completed[^\n]*\n\s*1\s*\r?\n/.test(stripAnsi(recent))) {
            booted = true;
            bootedAt = Date.now();
            log('ANDROID BOOT COMPLETED (sys.boot_completed=1)');
            await shot('boot-completed', true);
        }
        if (booted && Date.now() - bootedAt > 90000) {
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
