// Control experiment: open QEMU-Wasm's own published demo page (by default
// its x86_64 Alpine Linux demo) in headless Chrome and report whether it
// reaches a login prompt.  Tells "QEMU-Wasm is unstable here for any 64-bit
// guest" apart from "something about Porty's guest, devices or build".
//
// usage: node tests/boot/control-demo.mjs
//   DEMO_URL       page to open (default: QEMU-Wasm's x86_64 Alpine demo)
//   MINUTES        how long to wait (default 15)
//   CHROME         Chrome binary (default /usr/bin/google-chrome)
//   PUPPETEER_DIR  directory that has node_modules/puppeteer-core
// Always exits 0; the verdict is in the log and a warning annotation.
// SPDX-License-Identifier: GPL-2.0-or-later
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(path.join(process.env.PUPPETEER_DIR || process.cwd(), 'noop.js'));
const puppeteer = require('puppeteer-core');

const url = process.env.DEMO_URL || 'https://ktock.github.io/qemu-wasm-demo/alpine-x86_64.html';
const minutes = Math.max(1, Math.min(120, Number(process.env.MINUTES) || 15));
const t0 = Date.now();
const elapsed = () => {
    const s = Math.floor((Date.now() - t0) / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const log = (msg) => console.log(`[${elapsed()}] ${msg}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/usr/bin/google-chrome',
    headless: true,
    protocolTimeout: 300000,
    args: ['--no-sandbox', '--disable-gpu', '--window-size=1000,900',
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => log(`pageerror: ${(e && e.stack) || e}`));
page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warn' || m.type() === 'warning') {
        log(`console.${m.type()}: ${m.text()}`);
    }
});
page.on('workercreated', (worker) => {
    const name = worker.url().split('/').pop().split('?')[0];
    worker.client.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => {
        log(`worker exception (${name}): ${(d.exception && d.exception.description) || d.text}`);
    });
});

let verdict = 'no login prompt before the deadline';
let printed = 0;
try {
    log(`opening ${url}`);
    await page.goto(url, { waitUntil: 'load', timeout: 120000 });
    const deadline = t0 + minutes * 60000;
    while (Date.now() < deadline) {
        await sleep(10000);
        let text = '';
        try {
            text = await page.evaluate(() => {
                const rows = document.querySelector('.xterm-rows');
                return rows ? rows.innerText : '';
            });
        } catch (e) {
            log(`page did not answer: ${e.message}`);
            continue;
        }
        // The terminal shows only its last screenful: print lines once each.
        const lines = text.split('\n').map((l) => l.replace(/\s+$/, '')).filter(Boolean);
        const fresh = lines.slice(Math.max(0, lines.length - 40));
        for (const line of fresh.slice(printed > 0 ? -5 : 0)) {
            console.log(`term| ${line}`);
        }
        printed++;
        if (/login:/.test(text)) {
            verdict = 'reached the login prompt';
            break;
        }
    }
} catch (e) {
    verdict = `test error: ${e.message}`;
}
log(`SUMMARY: ${verdict}; elapsed ${elapsed()}`);
console.log(`::warning title=QEMU-Wasm control demo::${verdict} (${url})`);
await Promise.race([browser.close(), sleep(15000)]);
process.exit(0);
