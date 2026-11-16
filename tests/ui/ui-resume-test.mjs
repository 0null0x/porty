// Drives a site that publishes a snapshot (tests/site-smoke.sh builds one
// with scripts/assemble-site.sh --snapshot) in headless Chrome, with
// tests/ui/fake-qemu.js standing in for QEMU: the page must resume the
// saved machine instead of booting it, and boot normally whenever a resume
// is not possible or fails.
//
// usage: node ui-resume-test.mjs <url> ok|broken
//   ok      the snapshot is complete
//   broken  one of its chunk files is missing from the site
//   PUPPETEER_DIR, CHROME as for ui-test.mjs
// SPDX-License-Identifier: GPL-2.0-or-later
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { snapshotVersion } from '../../web/js/diskcache.js';

const require = createRequire(path.join(process.env.PUPPETEER_DIR || process.cwd(), 'noop.js'));
const puppeteer = require('puppeteer-core');

const url = process.argv[2];
const mode = process.argv[3] || 'ok';
const results = [];
const ok = (name) => { results.push(name); console.log(`PASS  ${name}`); };
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 ' +
    '(KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';

const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--window-size=420,900'],
});
const errors = [];
// The browser itself logs the missing chunk of the "broken" site.
const expected = (text) => /404/.test(text);

async function open(query, { phone = false, before = null } = {}) {
    const page = await browser.newPage();
    await page.setViewport({ width: 420, height: 900, hasTouch: phone });
    if (phone) {
        await page.setUserAgent(IPHONE);
    }
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => {
        if (m.type() === 'error' && !(mode === 'broken' && expected(m.text()))) {
            errors.push(m.text());
        }
    });
    if (before) {
        await page.evaluateOnNewDocument(before);
    }
    await page.goto(url + query, { waitUntil: 'load' });
    await page.waitForFunction(() => globalThis.crossOriginIsolated === true, { timeout: 20000 });
    await page.waitForFunction(() => !document.getElementById('start').disabled, { timeout: 10000 });
    return page;
}

async function running(page) {
    await page.waitForFunction(() => ['running', 'failed'].includes(document.getElementById('app').dataset.state) &&
        globalThis.__porty && globalThis.__porty.module, { timeout: 30000 });
    const state = await page.$eval('#app', (e) => e.dataset.state);
    if (state !== 'running') {
        throw new Error('start failed: ' + await page.$eval('#failure', (e) => e.innerText));
    }
}

const probe = (page) => page.evaluate(() => {
    const e = globalThis.__porty;
    return {
        args: e.module.__args,
        index: e.module.__texts.get('/img/snapshot.idx') || '',
        snapshot: e.module.__snapshot,
        stats: e.snapshotStats(),
        cfg: { mem: e.cfg.mem, tb: e.cfg.tb, cache: e.cfg.cache, mobile: e.cfg.mobile },
        wasmMemoryMb: e.wasmMemoryMb,
        memoryBytes: e.module.__memoryBytes,
        resumed: e.resumed,
        resuming: e.resuming,
        note: e.resumeNote,
        stage: document.getElementById('stage-text').textContent,
        noteShown: document.getElementById('resume-note').hidden ? '' : document.getElementById('resume-note').textContent,
    };
});

try {
    if (mode === 'ok') {
        // 1. A desktop with no parameters resumes, with the snapshot's machine.
        const page = await open('');
        assert.match(await page.$eval('#cfgline', (e) => e.textContent), /^mem=1024 tb=384 cache=64 /,
            'this desktop\'s own defaults differ from the snapshot\'s');
        await page.click('#start');
        await running(page);
        // Progress is on screen while the chunks arrive.
        await page.waitForFunction(() => document.getElementById('stage-text').textContent === 'Resuming Android' &&
            !document.getElementById('bar').hidden &&
            /^\d+ of \d+ MB downloaded/.test(document.getElementById('stage-detail').textContent) &&
            parseInt(document.getElementById('bar-fill').style.width, 10) > 0 &&
            parseInt(document.getElementById('bar-fill').style.width, 10) < 100, { timeout: 10000 });
        ok('"Resuming Android" shows a progress bar fed by QEMU\'s counters');
        let p = await probe(page);
        const manifest = await (await fetch(`${url}snapshot/manifest.json`)).json();
        assert.deepEqual(p.args.slice(-2), ['-incoming', 'porty:/img/snapshot.idx']);
        assert.equal(p.args[p.args.indexOf('-m') + 1], '768M');
        assert.ok(p.args[p.args.indexOf('-accel') + 1].includes('tb-size=128'));
        assert.equal(p.args[p.args.indexOf('-L') + 1], '/pc-bios');
        assert.equal(p.args[p.args.indexOf('-kernel') + 1], '/img/kernel');
        assert.ok(p.args.some((a) => a.includes(`file.url=${url}image/system`) && a.includes('file.cache-chunks=16')));
        assert.equal(p.args[p.args.indexOf('-append') + 1], manifest.argv[manifest.argv.indexOf('-append') + 1]);
        assert.deepEqual(p.cfg, { mem: 768, tb: 128, cache: 16, mobile: false });
        assert.equal(p.memoryBytes, p.wasmMemoryMb * 1048576);
        ok(`QEMU gets the snapshot's own argv (768 MiB guest) plus -incoming, in a ${p.wasmMemoryMb} MiB memory`);
        const lines = p.index.trim().split('\n');
        assert.equal(lines[0], 'porty-snapshot 1');
        assert.equal(lines[1], `url ${url}snapshot`);
        assert.equal(lines[2], `chunk-size ${manifest.chunk_size}`);
        assert.equal(lines[3], `size ${manifest.uncompressed_size}`);
        // "v" names the chunk and "s" the snapshot (the disk cache's version).
        const version = snapshotVersion(manifest);
        assert.match(version, /^[0-9a-f]{16}$/);
        assert.deepEqual(lines.slice(4), manifest.chunks.map((c) =>
            `chunk ${c.size} ${c.sha256} ${c.file}?v=${c.sha256.slice(0, 16)}&s=${version}`));
        ok(`the chunk index for QEMU lists all ${manifest.chunks.length} chunks with size and SHA-256`);

        // 2. The stream ends: the normal running UI, without a boot.
        await page.waitForFunction(() => globalThis.__porty.resumed === true, { timeout: 15000 });
        await page.waitForFunction(() => {
            const c = document.getElementById('screen');
            return c.width === 480 && c.height === 800 && document.getElementById('overlay').hidden &&
                document.getElementById('pill').textContent === 'Running';
        }, { timeout: 10000 });
        p = await probe(page);
        assert.equal(p.stats.state, 2);
        assert.equal(p.stats.chunksFetched, manifest.chunks.length);
        assert.equal(p.stats.progress, 1);
        assert.deepEqual(p.snapshot.urls, manifest.chunks.map((c) =>
            `${url}snapshot/${c.file}?v=${c.sha256.slice(0, 16)}&s=${version}`));
        assert.equal(p.note, '');
        ok('every chunk was fetched (synchronous XHR in a worker, through the service worker); then the running UI');
        const crumb = await page.evaluate(() => JSON.parse(localStorage.getItem('porty.run')));
        assert.equal(crumb.ended, false);
        assert.equal(crumb.stage, 'Android resumed');
        assert.equal(crumb.mem, 768);
        ok('the crash guard has the resumed run on record');
        await page.close();

        // 3. ?resume=0 boots.
        const boot = await open('?resume=0');
        await boot.click('#start');
        await running(boot);
        p = await probe(boot);
        assert.ok(!p.args.includes('-incoming'));
        assert.equal(p.args[p.args.indexOf('-m') + 1], '1024M');
        assert.equal(p.stage, 'Booting Android');
        assert.equal(p.noteShown, '');
        ok('?resume=0 boots normally');
        await boot.close();

        // 4. Machine parameters in the address: a normal boot with a note,
        //    unless resume=1 insists.
        const custom = await open('?mem=896');
        await custom.click('#start');
        await running(custom);
        p = await probe(custom);
        assert.ok(!p.args.includes('-incoming'));
        assert.equal(p.args[p.args.indexOf('-m') + 1], '896M');
        assert.match(p.noteShown, /Not resuming the saved Android: the address sets mem=.*Booting normally instead/);
        ok('?mem= boots normally and says why the snapshot was not used');
        await custom.close();
        const forced = await open('?mem=896&resume=1');
        await forced.click('#start');
        await running(forced);
        p = await probe(forced);
        assert.deepEqual(p.args.slice(-2), ['-incoming', 'porty:/img/snapshot.idx']);
        assert.equal(p.args[p.args.indexOf('-m') + 1], '768M');
        ok('?resume=1 resumes anyway, with the snapshot\'s memory');
        await forced.close();

        // 5. An iPhone resumes with the phone-sized memory; one that was
        //    killed while resuming boots instead (with one memory step less).
        const phone = await open('', { phone: true });
        await phone.click('#start');
        await running(phone);
        p = await probe(phone);
        assert.deepEqual(p.args.slice(-2), ['-incoming', 'porty:/img/snapshot.idx']);
        assert.deepEqual([p.cfg.mem, p.cfg.mobile, p.wasmMemoryMb], [768, true, 1280]);
        await phone.waitForFunction(() => globalThis.__porty.resumed === true, { timeout: 15000 });
        ok('an iPhone resumes in a 1280 MiB WebAssembly memory');
        await phone.close();
        const killed = await open('', {
            phone: true,
            before: () => {
                if (sessionStorage.getItem('ui-test-crumb')) {
                    return;
                }
                sessionStorage.setItem('ui-test-crumb', '1');
                const now = Date.now();
                localStorage.removeItem('porty.phoneLevel');
                localStorage.setItem('porty.run', JSON.stringify({
                    level: 0, mem: 768, tb: 128, cache: 16, mobile: true, stage: 'Resuming Android',
                    hidden: false, wasmMb: 1280, startedAt: now - 60000, updatedAt: now, ended: false,
                }));
            },
        });
        await killed.click('#start');
        await running(killed);
        p = await probe(killed);
        assert.ok(!p.args.includes('-incoming'));
        assert.equal(p.args[p.args.indexOf('-m') + 1], '640M');
        assert.match(p.noteShown, /the browser stopped the last attempt while the saved Android was loading/);
        ok('an iPhone whose tab was killed while resuming boots normally next time');
        await killed.close();
    } else {
        // A chunk is missing: "QEMU" fails the incoming migration and exits.
        // The page reloads itself into a normal boot and says why.
        const page = await open('');
        await page.click('#start');
        await page.waitForFunction(() => globalThis.__porty && globalThis.__porty.module &&
            globalThis.__porty.module.__args.includes('-incoming'), { timeout: 30000 });
        ok('the page tries to resume');
        await page.waitForNavigation({ waitUntil: 'load', timeout: 30000 });
        await running(page);
        const p = await probe(page);
        assert.ok(!p.args.includes('-incoming'));
        assert.equal(p.args[p.args.indexOf('-m') + 1], '1024M');
        assert.match(p.noteShown, /Not resuming the saved Android: the last attempt failed \(.*HTTP 404/);
        assert.equal(await page.evaluate(() => sessionStorage.getItem('porty.resumeFailed')), null);
        ok('a failed resume reloads into a normal boot, started without another tap, with the reason shown');
        await page.waitForFunction(() => document.getElementById('overlay').hidden, { timeout: 10000 });
        const crumb = await page.evaluate(() => JSON.parse(localStorage.getItem('porty.run')));
        assert.equal(crumb.stage, 'Booting Android');
        assert.equal(crumb.ended, false);
        ok('the boot that follows runs and is on record for the crash guard');
        // Reloading by hand afterwards offers the snapshot again.
        await page.close();
    }

    assert.deepEqual(errors, [], 'page errors');
    ok('no page errors');
} finally {
    await browser.close();
}
console.log(`ui-resume-test (${mode}): ${results.length} checks passed`);
