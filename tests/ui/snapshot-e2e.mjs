// Resumes a saved Linux guest in the real QEMU-Wasm build, in headless
// Chrome, through the page (see tests/snapshot-browser.sh).
//
// usage: node snapshot-e2e.mjs <url> <token> <saved-at-round> <blob-md5>
//   The guest prints "PORTY-SNAP: alive <token> <round> <md5 of a file on
//   its disk>" every second; the token only exists in its RAM.
//   PUPPETEER_DIR, CHROME as for ui-test.mjs; MINUTES (default 15) limits
//   each wait.
// SPDX-License-Identifier: GPL-2.0-or-later
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(path.join(process.env.PUPPETEER_DIR || process.cwd(), 'noop.js'));
const puppeteer = require('puppeteer-core');

const [url, token, savedAtText, blobMd5] = process.argv.slice(2);
const savedAt = Number(savedAtText);
const limitMs = (Number(process.env.MINUTES) || 15) * 60000;
const t0 = Date.now();
const seconds = () => ((Date.now() - t0) / 1000).toFixed(1);
const log = (text) => console.log(`[${seconds().padStart(6)}] ${text}`);
const ok = (name) => console.log(`PASS  ${name}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
let failed = '';
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 480, height: 900 });
    page.on('pageerror', (e) => log(`pageerror: ${(e && e.stack) || e}`));
    // QEMU's stderr reaches the page as console.warn (Module.printErr).
    page.on('console', (m) => {
        if (m.type() === 'error' || m.type() === 'warn') {
            log(`console.${m.type()}: ${m.text().slice(0, 400)}`);
        }
    });
    let navigations = 0;
    page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) {
            navigations++;
        }
    });

    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => globalThis.crossOriginIsolated === true, { timeout: 30000 });
    await page.waitForFunction(() => !document.getElementById('start').disabled, { timeout: 10000 });
    const before = navigations;
    await page.click('#start');
    log('Start pressed');

    // The serial text is taken from the console's whole backlog: bytes
    // arrive one at a time, and SerialConsole.tail() only looks at the
    // last few dozen writes.
    const state = (withSerial = false) => page.evaluate((wantSerial) => {
        const e = globalThis.__porty;
        let serial = '';
        if (wantSerial && e && e.serial) {
            const parts = e.serial.backlog.slice(-60000);
            const bytes = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
            let at = 0;
            for (const b of parts) {
                bytes.set(b, at);
                at += b.length;
            }
            serial = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        }
        const stats = e && e.module ? e.snapshotStats() : null;
        return {
            app: document.getElementById('app').dataset.state,
            stage: document.getElementById('stage-text').textContent,
            detail: document.getElementById('stage-detail').textContent,
            bar: document.getElementById('bar').hidden ? '' : document.getElementById('bar-fill').style.width,
            note: e ? e.resumeNote : '',
            args: e && e.args ? e.args : [],
            resumed: Boolean(e && e.resumed),
            stats,
            heap: e && e.module ? e.heapStats() : null,
            serial,
            failure: document.getElementById('failure').hidden ? '' : document.getElementById('failure').innerText,
        };
    }, withSerial).catch((e) => ({ app: 'navigating', error: String(e), args: [], serial: '' }));

    // 1. The page resumes: QEMU is started with -incoming and loads the stream.
    let s;
    let lastLine = '';
    let peakHeap = 0;
    let sawProgress = false;
    for (;;) {
        s = await state();
        if (navigations > before) {
            failed = 'the page gave up on the resume and reloaded into a normal boot';
            break;
        }
        if (s.app === 'failed') {
            failed = `the page failed: ${s.failure.slice(0, 600)}`;
            break;
        }
        if (s.heap) {
            peakHeap = Math.max(peakHeap, s.heap.used);
        }
        const line = `${s.app} | ${s.stage} | ${s.detail} | bar ${s.bar}` + (s.stats
            ? ` | chunks ${s.stats.chunksFetched}/${s.stats.chunksTotal}, loaded ${s.stats.loadedMb.toFixed(0)}/${s.stats.totalMb.toFixed(0)} MB`
            : '');
        if (line !== lastLine) {
            lastLine = line;
            log(line);
        }
        if (s.stage === 'Resuming Android' && s.stats && s.stats.chunksFetched > 0 && s.stats.state === 1) {
            sawProgress = true;
        }
        if (s.resumed) {
            break;
        }
        if (Date.now() - t0 > limitMs) {
            failed = 'the stream was not loaded in time';
            break;
        }
        await sleep(250);
    }
    if (!failed) {
        assert.deepEqual(s.args.slice(-2), ['-incoming', 'porty:/img/snapshot.idx']);
        assert.equal(s.note, '');
        assert.equal(s.stats.state, 2);
        assert.equal(s.stats.chunksFetched, s.stats.chunksTotal);
        assert.equal(s.stats.errors, 0);
        ok(`QEMU-Wasm loaded the stream: ${s.stats.chunksTotal} chunks, ${s.stats.fetchedMb.toFixed(1)} MB fetched, ` +
            `${s.stats.loadedMb.toFixed(1)} MB of state, ${seconds()} s after Start` +
            (sawProgress ? ' (progress was shown on the way)' : ''));
        if (s.heap) {
            log(`QEMU heap after the resume: ${s.heap.used} MiB in use (peak seen ${peakHeap} MiB), break at ${s.heap.brk} MiB`);
        }

        // 2. The guest carries on: the token from its RAM, a later round,
        //    and a file read from the chunked disk.
        const alive = new RegExp(`PORTY-SNAP: alive ${token} (\\d+) ([0-9a-f]{32})`, 'g');
        const loaded = Date.now();
        let rounds = [];
        for (;;) {
            s = await state(true);
            if (navigations > before || s.app === 'failed') {
                failed = `the page stopped after the resume: ${s.failure || 'reloaded'}`;
                break;
            }
            rounds = [...s.serial.matchAll(alive)].map((m) => [Number(m[1]), m[2]]);
            if (rounds.length >= 3) {
                break;
            }
            if (Date.now() - loaded > limitMs) {
                failed = `the guest printed ${rounds.length} rounds after the resume, wanted 3`;
                break;
            }
            await sleep(1000);
        }
        log(`serial console:\n${s.serial.split('\n').slice(-12).join('\n')}`);
        if (!failed) {
            assert.ok(rounds[0][0] >= savedAt && rounds[0][0] <= savedAt + 2,
                `first round after the resume is ${rounds[0][0]}, saved at ${savedAt}`);
            assert.ok(rounds.every(([, md5]) => md5 === blobMd5), 'the disk returned other data');
            assert.ok(!/PORTY-SNAP: booted|Linux version/.test(s.serial), 'the guest booted instead of resuming');
            ok(`the guest carries on in QEMU-Wasm: token ${token}, rounds ${rounds.map((r) => r[0]).join(', ')} ` +
                `(saved at ${savedAt}), disk readable, ${((Date.now() - loaded) / 1000).toFixed(0)} s after the load`);
            assert.equal(s.app, 'running');
            ok('the page is in its running state');
        }
    }
    if (failed) {
        s = { ...s, ...(await state(true)) };
        log(`serial console:\n${(s.serial || '').split('\n').slice(-25).join('\n')}`);
    }
} finally {
    await browser.close();
}
if (failed) {
    console.log(`FAIL  ${failed}`);
    process.exit(1);
}
console.log('snapshot-e2e: resumed in QEMU-Wasm');
