// The disk cache in a real browser (headless Chrome, tests/ui/fake-qemu.js
// standing in for QEMU, whose chunk requests are synchronous XHRs from
// workers like the real one's): chunks are stored in Cache Storage by the
// service worker on the first visit, the next visit reads them from the
// device, ?diskcache=0 leaves the cache alone, and the page says what is
// stored and can delete it.
//
// usage: node ui-diskcache-test.mjs <url> [isolated]
//   isolated  the server sends COOP/COEP itself, so coi-serviceworker does
//             not register and the page has to
//   PUPPETEER_DIR, CHROME as for ui-test.mjs
// SPDX-License-Identifier: GPL-2.0-or-later
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { PREFIX, cacheName, snapshotVersion } from '../../web/js/diskcache.js';

const require = createRequire(path.join(process.env.PUPPETEER_DIR || process.cwd(), 'noop.js'));
const puppeteer = require('puppeteer-core');

const url = process.argv[2];
const isolated = process.argv[3] === 'isolated';
const results = [];
const ok = (name) => { results.push(name); console.log(`PASS  ${name}`); };

const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--window-size=420,900'],
});
const errors = [];
// What the server is asked for, by path: the proof that a chunk did or did
// not come from the device.
const requested = [];

async function open(query) {
    const page = await browser.newPage();
    await page.setViewport({ width: 420, height: 900 });
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(url + query, { waitUntil: 'load' });
    await page.waitForFunction(() => globalThis.crossOriginIsolated === true, { timeout: 20000 });
    await page.waitForFunction(() => !document.getElementById('start').disabled, { timeout: 10000 });
    await page.waitForFunction(() => !document.getElementById('diskcache-note').hidden, { timeout: 10000 });
    return page;
}
// The service worker's own fetches are not the page's: watch the whole browser.
browser.on('targetcreated', async (target) => {
    if (target.type() !== 'service_worker') {
        return;
    }
    try {
        const client = await target.createCDPSession();
        await client.send('Network.enable');
        client.on('Network.requestWillBeSent', (ev) => requested.push(new URL(ev.request.url).pathname + new URL(ev.request.url).search));
    } catch (e) {
        // a worker that went away
    }
});

async function resumed(page) {
    await page.click('#start');
    await page.waitForFunction(() => ['running', 'failed'].includes(document.getElementById('app').dataset.state) &&
        globalThis.__porty && globalThis.__porty.module, { timeout: 30000 });
    assert.equal(await page.$eval('#app', (e) => e.dataset.state), 'running');
    await page.waitForFunction(() => globalThis.__porty.resumed === true && globalThis.__porty.module.__chunk, { timeout: 20000 });
    assert.equal(await page.evaluate(() => globalThis.__porty.module.__chunk.status), 200);
}
const stored = (page) => page.evaluate(async (prefix) => {
    const out = {};
    for (const name of await caches.keys()) {
        if (name.startsWith(prefix)) {
            out[name] = (await (await caches.open(name)).keys()).map((r) => r.url).sort();
        }
    }
    return out;
}, PREFIX);
const stats = (page) => page.evaluate(() => globalThis.__porty.diskCache.stats());
const noteText = (page) => page.$eval('#diskcache-text', (e) => e.textContent);
const chunkRequests = () => requested.filter((p) => /\/image\/system-[^/]+\/\d+\.bin$|\/snapshot\/.*\.zz/.test(p));

try {
    const manifest = await (await fetch(`${url}snapshot/manifest.json`)).json();
    const image = await (await fetch(`${url}image/manifest.json`)).json();
    const version = snapshotVersion(manifest);
    const snapUrls = manifest.chunks.map((c) => `${url}snapshot/${c.file}?v=${c.sha256.slice(0, 16)}&s=${version}`).sort();
    const snapBytes = manifest.chunks.reduce((sum, c) => sum + c.size, 0);
    const n = manifest.chunks.length;

    // 1. First visit: everything comes from the network and is stored.
    let page = await open('');
    assert.match(await noteText(page), /^Nothing is stored on this device yet; .*up to 1536 MB.*diskcache=0/);
    assert.equal(await page.$eval('#diskcache-clear', (e) => e.hidden), true);
    assert.ok(await page.$$eval('#params td', (cells) => cells.some((c) => c.textContent === '?diskcache=')));
    ok('the page says that nothing is stored yet, and lists ?diskcache=');
    await resumed(page);
    assert.equal(await page.evaluate(() => !!navigator.serviceWorker.controller), true);
    await page.waitForFunction(async (count) => {
        const s = await globalThis.__porty.diskCache.stats();
        return s && s.stored === count;
    }, { timeout: 10000 }, n + 1);
    let s = await stats(page);
    assert.deepEqual([s.hits, s.misses, s.rejected, s.errors], [0, n + 1, 0, 0]);
    let have = await stored(page);
    assert.deepEqual(have[cacheName('snapshot', version)], snapUrls);
    assert.deepEqual(have[cacheName('image', image.disk.dir)], [`${url}image/${image.disk.dir}/000000.bin`]);
    assert.equal(chunkRequests().length, n + 1);
    assert.match(await page.evaluate(() => globalThis.__porty.notes.join('\n')), /Downloaded chunks are stored on this device \(up to 1536 MB/);
    ok(`first visit${isolated ? ' (the page registered the service worker itself)' : ''}: ` +
        `${n} snapshot chunks and a disk chunk, fetched by synchronous XHR in workers, are stored (hashes and length checked)`);
    await page.close();

    // 2. Second visit: the same chunks, not one request to the server.
    requested.length = 0;
    page = await open('');
    const total = snapBytes + Math.min(image.disk.chunk_size, image.disk.size);
    const shown = total / 1048576 < 10 ? Math.round(total / 104857.6) / 10 : Math.round(total / 1048576);
    assert.match(await noteText(page), new RegExp(`^${String(shown).replace('.', '\\.')} MB of Android is stored on this device`));
    assert.equal(await page.$eval('#diskcache-clear', (e) => e.hidden), false);
    ok(`the page says how much is stored (${shown} MB)`);
    await resumed(page);
    s = await stats(page);
    assert.deepEqual([s.hits, s.misses, s.stored], [n + 1, 0, 0]);
    assert.equal(s.hitBytes, total);
    assert.deepEqual(chunkRequests(), []);
    await page.waitForFunction(() => /from this device/.test(document.getElementById('stats').textContent), { timeout: 15000 });
    ok('second visit: every chunk comes from the device, none from the server, and the toolbar says so');
    await page.close();

    // 3. ?diskcache=0: the cache is neither read nor written, but kept.
    requested.length = 0;
    page = await open('?diskcache=0');
    assert.match(await noteText(page), /^diskcache=0: nothing more is stored on this device\. .* MB from earlier visits is still here/);
    assert.match(await page.$eval('#cfgline', (e) => e.textContent), / diskcache=0/);
    await resumed(page);
    assert.equal(await stats(page), null);
    assert.equal(chunkRequests().length, n + 1);
    assert.deepEqual(await stored(page), have);
    assert.match(await page.evaluate(() => globalThis.__porty.notes.join('\n')), /diskcache=0: chunks are not stored/);
    ok('?diskcache=0 fetches every chunk from the server and leaves the stored ones alone');
    await page.close();

    // 4. "Delete them" empties the cache.
    page = await open('');
    await page.click('#diskcache-clear');
    await page.waitForFunction(() => /^Nothing is stored on this device yet/.test(
        document.getElementById('diskcache-text').textContent), { timeout: 10000 });
    assert.deepEqual(await stored(page), {});
    assert.equal(await page.$eval('#diskcache-clear', (e) => e.hidden), true);
    ok('the Delete button removes what was stored');
    await page.close();

    // 5. A cap that is already reached: nothing is stored, everything still works.
    page = await open('?diskcache=64');
    await page.evaluate(async () => {
        // 72 MB of something else on this origin
        const cache = await caches.open('ui-test-filler');
        const block = new Uint8Array(8 * 1048576);
        for (let i = 0; i < 9; i++) {
            await cache.put(`/filler-${i}`, new Response(block));
        }
    });
    await resumed(page);
    await page.waitForFunction(async () => {
        const st = await globalThis.__porty.diskCache.stats();
        return st && st.full > 0;
    }, { timeout: 10000 });
    s = await stats(page);
    assert.equal(s.stored, 0);
    assert.ok(s.misses >= 1);
    ok('with the limit reached nothing more is stored and Android still starts');
    await page.evaluate(() => caches.delete('ui-test-filler'));
    await page.close();

    assert.deepEqual(errors, [], 'page errors');
    ok('no page errors');
} finally {
    await browser.close();
}
console.log(`ui-diskcache-test${isolated ? ' (isolated)' : ''}: ${results.length} checks passed`);
