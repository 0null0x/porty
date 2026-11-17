// Drives the assembled site in headless Chrome, with tests/ui/fake-qemu.js
// standing in for QEMU.  Verifies everything on the JavaScript side of
// Porty in a real browser: service-worker cross-origin isolation, download
// and memory set-up (including the wasm memory patch and a real
// WebAssembly.instantiate), the canvas blitter, pointer/keyboard/navigation
// input, the serial console and the pause control.
//
// usage: node ui-test.mjs <url> [query]
//   PUPPETEER_DIR  directory that has node_modules/puppeteer-core
//   CHROME         path to a Chrome/Chromium binary
// SPDX-License-Identifier: GPL-2.0-or-later
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseConfig } from '../../web/js/config.js';
import { DIET_SCRIPT, dietFixes, dietProps, dietScript } from '../../web/js/boot-diet.js';
import { parseNewc } from '../../web/js/initramfs.js';

const require = createRequire(path.join(process.env.PUPPETEER_DIR || process.cwd(), 'noop.js'));
const puppeteer = require('puppeteer-core');

const url = process.argv[2];
const query = process.argv[3] || '';
const results = [];
const ok = (name) => { results.push(name); console.log(`PASS  ${name}`); };

const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--window-size=420,900'],
});
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 420, height: 900, hasTouch: false });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    // 1. cross-origin isolation through the service worker (server sends no headers)
    await page.goto(url + query, { waitUntil: 'load' });
    await page.waitForFunction(() => globalThis.crossOriginIsolated === true, { timeout: 20000 });
    ok('page becomes cross-origin isolated (coi-serviceworker, no server headers)');
    await page.waitForFunction(() => !document.getElementById('start').disabled, { timeout: 10000 });
    assert.match(await page.$eval('#precheck', (e) => e.textContent), /supports what Porty needs/);
    ok('precheck enables the Start button');

    // 2. start
    await page.click('#start');
    await page.waitForFunction(() => document.getElementById('app').dataset.state === 'running' ||
        document.getElementById('app').dataset.state === 'failed', { timeout: 30000 });
    const state = await page.$eval('#app', (e) => e.dataset.state);
    if (state !== 'running') {
        throw new Error('start failed: ' + await page.$eval('#failure', (e) => e.innerText));
    }
    ok('emulator starts (downloads, memory, WebAssembly.instantiate, preRun files)');

    // The emulator object is module-private; reach the fake through a debug hook.
    const probe = () => page.evaluate(() => {
        const e = globalThis.__porty;
        return {
            args: e.module.__args,
            files: [...e.module.__files.entries()],
            events: e.module.__events,
            memoryBytes: e.module.__memoryBytes,
            patched: e.patched,
            chunk: e.module.__chunk || null,
            wasmMemoryMb: e.wasmMemoryMb,
        };
    });
    let p = await probe();
    assert.ok(p.args.includes('-display') && p.args.includes('wasmfb'));
    assert.deepEqual(p.files.map((f) => f[0]).sort(), [
        '/img/initrd.img', '/img/kernel', '/img/ramdisk.img',
        '/pc-bios/bios-256k.bin', '/pc-bios/kvmvapic.bin', '/pc-bios/linuxboot_dma.bin',
        '/pc-bios/vgabios-stdvga.bin'].sort());
    assert.equal(p.memoryBytes, p.wasmMemoryMb * 1048576);
    ok(`QEMU gets its argv, BIOS/kernel files and a ${p.wasmMemoryMb} MiB shared memory (patched: ${p.patched})`);

    // 2b. boot diet: the initrd QEMU loads is the published one plus one
    // uncompressed cpio archive, on a 4-byte boundary, holding the script.
    const wantProps = dietProps(parseConfig(query, {}));
    assert.ok(wantProps.length >= 3);
    assert.ok((await page.$eval('#cfgline', (e) => e.textContent)).includes(
        ` props: ${wantProps.map((kv) => kv.join('=')).join(' ')}`));
    const initrd = await page.evaluate(async () => {
        const e = globalThis.__porty;
        const published = new Uint8Array(await (await fetch(`image/${e.manifest.initrd.file}`)).arrayBuffer());
        const loaded = e.module.__initrd;
        return {
            size: published.length,
            manifestSize: e.manifest.initrd.size,
            prefixSame: published.every((b, i) => loaded[i] === b),
            tail: Array.from(loaded.subarray(published.length)),
            notes: e.notes,
        };
    });
    assert.equal(initrd.size, initrd.manifestSize);
    assert.ok(initrd.prefixSame, 'the published initrd is the start of the loaded one');
    const padding = (4 - (initrd.size % 4)) % 4;
    assert.ok(initrd.tail.slice(0, padding).every((b) => b === 0));
    const appended = parseNewc(new Uint8Array(initrd.tail), padding);
    assert.equal(appended.end, initrd.tail.length, 'the archive ends the initrd');
    assert.deepEqual(appended.entries.map((e) => e.name), ['scripts', DIET_SCRIPT]);
    const wantFixes = dietFixes(parseConfig(query, {}));
    assert.ok(wantFixes.ttm, 'the default configuration fixes ttm.ko');
    assert.equal(Buffer.from(appended.entries[1].data).toString('latin1'), dietScript(wantProps, wantFixes));
    assert.ok(initrd.notes.some((n) => n.startsWith('The kernel module ttm.ko is replaced at boot')));
    assert.ok(wantFixes.sf, 'the default configuration fixes surfaceflinger');
    assert.ok(Buffer.from(appended.entries[1].data).toString('latin1').includes(`porty_m=${wantFixes.sf.module}\n`));
    assert.ok(initrd.notes.some((n) => n.startsWith('surfaceflinger\'s library is replaced at boot')));
    assert.ok(wantFixes.provision, 'the default configuration provisions Android');
    assert.ok(Buffer.from(appended.entries[1].data).toString('latin1').includes('cmd settings put global device_provisioned 1'));
    assert.ok(initrd.notes.some((n) => n.startsWith('Android is marked as set up once it has booted')));
    assert.ok(initrd.notes.some((n) => n.startsWith('Android properties set at boot: debug.sf.nobootanimation=1, ')));
    ok(`initrd.img gets the boot-diet script appended (${wantProps.length} properties, ${initrd.tail.length} bytes)`);

    // 3. display: mode switch + pixel-exact conversion
    await page.waitForFunction(() => {
        const c = document.getElementById('screen');
        return c.width === 480 && c.height === 800;
    }, { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 300));
    const pixels = await page.evaluate(() => {
        const c = document.getElementById('screen');
        const ctx = c.getContext('2d');
        const at = (x, y) => [...ctx.getImageData(x, y, 1, 1).data];
        return { red: at(20, 20), green: at(460, 20), blue: at(20, 780), white: at(460, 780) };
    });
    assert.deepEqual(pixels, {
        red: [255, 0, 0, 255], green: [0, 255, 0, 255],
        blue: [0, 0, 255, 255], white: [255, 255, 255, 255],
    });
    ok('canvas follows the guest mode switch and colours are converted correctly');
    assert.equal(await page.$eval('#overlay', (e) => e.hidden), true);
    ok('boot overlay hides once the guest leaves text mode');

    // 4. pointer -> tablet coordinates
    const box = await (await page.$('#screen')).boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 4;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 10, cy + 10);
    await page.mouse.up();
    p = await probe();
    const abs = p.events.filter((e) => e[0] === 1);
    const btn = p.events.filter((e) => e[0] === 2);
    assert.ok(abs.length >= 2);
    assert.ok(Math.abs(abs[0][1] - 0x7fff / 2) < 200, `x ${abs[0][1]}`);
    assert.ok(Math.abs(abs[0][2] - 0x7fff / 4) < 200, `y ${abs[0][2]}`);
    assert.deepEqual(btn, [[2, 0, 1, 0], [2, 0, 0, 0]]);
    ok('pointer events map to absolute tablet coordinates and a left click');
    const ring = await page.evaluate(() => {
        const r = document.querySelector('#stage .tap-ring');
        const s = document.getElementById('stage').getBoundingClientRect();
        return r ? [parseFloat(r.style.left) + s.left, parseFloat(r.style.top) + s.top] : null;
    });
    assert.ok(ring && Math.abs(ring[0] - cx) < 2 && Math.abs(ring[1] - cy) < 2, `tap ring at ${ring}`);
    ok('a ring shows where the press landed');
    const dot = await page.evaluate(() => {
        const c = document.getElementById('screen');
        return [...c.getContext('2d').getImageData(c.width / 2, c.height / 4, 1, 1).data];
    });
    await new Promise((r) => setTimeout(r, 200));
    const dot2 = await page.evaluate(() => {
        const c = document.getElementById('screen');
        return [...c.getContext('2d').getImageData(c.width / 2, c.height / 4, 1, 1).data];
    });
    assert.deepEqual(dot2, [0, 0, 0, 255], `dirty-rectangle update not drawn (was ${dot})`);
    ok('partial (dirty rectangle) updates reach the canvas');

    // 5. keys
    const keysSince = async (n) => (await probe()).events.slice(n).filter((e) => e[0] === 3).map((e) => [e[1], e[2]]);
    let mark = (await probe()).events.length;
    await page.click('#nav-back');
    await page.click('#nav-home');
    await page.click('#nav-recents');
    assert.deepEqual(await keysSince(mark), [
        [158, 1], [158, 0], [172, 1], [172, 0], [56, 1], [15, 1], [15, 0], [56, 0]]);
    ok('Back, Home and Recents send KEY_BACK, KEY_HOMEPAGE and Alt+Tab');

    mark = (await probe()).events.length;
    await page.keyboard.press('KeyA');
    await page.keyboard.press('Escape');
    assert.deepEqual(await keysSince(mark), [[30, 1], [30, 0], [1, 1], [1, 0]]);
    ok('hardware keyboard events are forwarded as evdev codes');

    mark = (await probe()).events.length;
    await page.click('#nav-keyboard');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'softkeys');
    await page.keyboard.type('Hi!');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Enter');
    assert.deepEqual(await keysSince(mark), [
        [42, 1], [35, 1], [35, 0], [42, 0],   // H
        [23, 1], [23, 0],                      // i
        [42, 1], [2, 1], [2, 0], [42, 0],      // !
        [14, 1], [14, 0],                      // Backspace
        [28, 1], [28, 0],                      // Enter
    ]);
    ok('text typed into the soft-keyboard field becomes key presses (with Shift)');

    // 6. pause / resume
    mark = (await probe()).events.length;
    await page.click('#btn-pause');
    await page.waitForFunction(() => document.getElementById('btn-pause').textContent === 'Resume', { timeout: 5000 });
    await page.click('#btn-pause');
    await page.waitForFunction(() => document.getElementById('btn-pause').textContent === 'Pause', { timeout: 5000 });
    assert.deepEqual((await probe()).events.slice(mark).filter((e) => e[0] === 10), [[10, 2, 0, 0], [10, 3, 0, 0]]);
    ok('Pause and Resume reach the VM and the button reflects the VM state');

    // 7. serial console
    await page.click('#btn-serial');
    await page.waitForSelector('#terminal .xterm', { timeout: 5000 });
    await page.waitForFunction(() => document.querySelector('#terminal .xterm-rows').textContent.includes('Detecting Android-x86'), { timeout: 5000 });
    ok('serial console opens in xterm.js and replays the boot log');

    // 8. chunk fetch path: synchronous XHR from a worker, through the service worker
    await page.waitForFunction(() => globalThis.__porty.module.__chunk, { timeout: 10000 });
    p = await probe();
    assert.equal(p.chunk.status, 200);
    assert.ok(p.chunk.bytes > 0);
    await page.waitForFunction(() => /disk \d+ MB/.test(document.getElementById('stats').textContent), { timeout: 5000 });
    ok(`synchronous XHR from a worker fetches a disk chunk (${p.chunk.bytes} bytes)`);

    // 9. crash guard: the running start is on record for the next visit
    const crumb = await page.evaluate(() => JSON.parse(localStorage.getItem('porty.run')));
    assert.equal(crumb.ended, false);
    assert.equal(crumb.stage, 'Booting Android');
    assert.equal(crumb.wasmMb, p.wasmMemoryMb);
    ok('a running start is recorded in localStorage');
    await page.close();

    // An iPhone comes back after Safari killed the tab mid-boot: one memory
    // step down, explained on the intro page, and a way back.  (Memory
    // parameters in the URL turn the steps off, so only without a query.)
    if (!query) {
        const phone = await browser.newPage();
        await phone.setViewport({ width: 390, height: 844, hasTouch: true });
        phone.on('pageerror', (e) => errors.push(String(e)));
        phone.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
        await phone.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 ' +
            '(KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1');
        await phone.evaluateOnNewDocument(() => {
            if (sessionStorage.getItem('ui-test-crumb')) {
                return;
            }
            sessionStorage.setItem('ui-test-crumb', '1');
            const now = Date.now();
            localStorage.removeItem('porty.phoneLevel');
            localStorage.setItem('porty.run', JSON.stringify({
                level: 0, mem: 768, tb: 128, cache: 16, mobile: true, stage: 'Booting Android',
                hidden: false, wasmMb: 1280, heapUsed: 1150, diskMb: 300,
                startedAt: now - 6 * 60000, updatedAt: now, ended: false,
            }));
        });
        await phone.goto(url + query, { waitUntil: 'load' });
        await phone.waitForFunction(() => !document.getElementById('lastrun').hidden, { timeout: 10000 });
        const notice = await phone.$eval('#lastrun-text', (e) => e.textContent);
        assert.match(notice, /stopped after 6 min, at "Booting Android", with 768 MB guest RAM, 1280 MB WebAssembly memory \(1150 MB in use\)/);
        assert.match(notice, /This start uses less: 640 MB of RAM for Android \(about 1152 MB in all\)/);
        assert.match(await phone.$eval('#cfgline', (e) => e.textContent), /mem=640 tb=96 cache=12 .*jitcap=4000/);
        assert.equal(await phone.evaluate(() => localStorage.getItem('porty.phoneLevel')), '1');
        assert.equal(await phone.evaluate(() => JSON.parse(localStorage.getItem('porty.run')).ended), 'killed');
        ok('after a killed start an iPhone gets one memory step less, explained on the page');
        await Promise.all([phone.waitForNavigation({ waitUntil: 'load' }), phone.click('#lastrun-reset')]);
        await phone.waitForFunction(() => document.getElementById('cfgline').textContent.length > 0, { timeout: 10000 });
        assert.equal(await phone.$eval('#lastrun', (e) => e.hidden), true);
        assert.match(await phone.$eval('#cfgline', (e) => e.textContent), /^mem=768 tb=128 cache=16 /);
        ok('"Use the normal memory setting" goes back to the phone defaults');
    }

    assert.deepEqual(errors, [], 'page errors');
    ok('no page errors');
} finally {
    await browser.close();
}
console.log(`ui-test: ${results.length} checks passed`);
