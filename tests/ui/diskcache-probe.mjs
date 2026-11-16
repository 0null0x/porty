// Runs tests/ui/diskcache-probe.html in a browser Playwright drives
// (WebKit above all: Safari's engine) and says whether synchronous XHR from
// workers reaches the service worker and its disk cache there.
//
// usage: node diskcache-probe.mjs <site-url> [webkit|chromium|firefox]
//   <site-url>     an assembled site with a snapshot, the probe page and its
//                  worker copied next to index.html, with trailing slash
//   PLAYWRIGHT_DIR directory that has node_modules/playwright
//
// Exit status 0 whatever the browser did: the verdict is the last line,
// "PROBE <engine>: ...", and the JSON before it.
// SPDX-License-Identifier: GPL-2.0-or-later
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(path.join(process.env.PLAYWRIGHT_DIR || process.cwd(), 'noop.js'));
const site = process.argv[2];
const engine = process.argv[3] || 'webkit';
if (!/^https?:\/\/.+\/$/.test(site || '') || !['webkit', 'chromium', 'firefox'].includes(engine)) {
    console.error('usage: node diskcache-probe.mjs <site-url with trailing slash> [webkit|chromium|firefox]');
    process.exit(2);
}

let verdict = 'did not run';
try {
    const playwright = require('playwright');
    const browser = await playwright[engine].launch();
    console.log(`${engine} ${browser.version()}`);
    const context = await browser.newContext();
    const visit = async (label) => {
        const page = await context.newPage();
        page.on('console', (m) => console.log(`console(${label}): ${m.text()}`));
        page.on('pageerror', (e) => console.log(`pageerror(${label}): ${e}`));
        await page.goto(`${site}diskcache-probe.html`, { waitUntil: 'load' });
        // coi-serviceworker reloads the page once on the first visit.
        let result = null;
        for (let i = 0; i < 150 && !result; i++) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            result = await page.evaluate(() => globalThis.__probe || null).catch(() => null);
        }
        if (!result) {
            const step = await page.evaluate(() => globalThis.__probeStep || 'the page script did not start').catch((e) => String(e));
            result = { error: `no result after 150 s; last step: ${step}` };
        }
        console.log(`--- ${label} ---`);
        console.log(JSON.stringify(result, null, 1));
        await page.close();
        return result;
    };
    const first = await visit('first visit');
    const second = await visit('second visit');
    await browser.close();

    const all = (r) => [...(r.urlWorker || []), ...(r.blobWorker || []), ...(r.nestedWorker || [])];
    const fine = (list) => list.length > 0 && list.every((x) => x.status === 200 && x.bytes > 0);
    const ms = (list) => Math.round(list.reduce((sum, x) => sum + x.ms, 0));
    if (!first || !second || first.error || second.error) {
        verdict = `the probe page failed (${(first && first.error) || (second && second.error) || 'no result'})`;
    } else {
        const want = first.expected.disk + first.expected.snapshot;
        const parts = [
            `isolated=${first.isolated}`,
            `controlled=${first.controlled}`,
            `XHR in a URL worker ${fine(first.urlWorker) ? 'ok' : 'FAILED'}`,
            `in a blob worker ${fine(first.blobWorker) ? 'ok' : 'FAILED'}`,
            `in a nested worker ${fine(first.nestedWorker) ? 'ok' : 'FAILED'}`,
            `first visit: ${first.stats ? `${first.stats.misses} fetched by the service worker, ${first.stats.stored} stored, ${first.stats.hits} already there` : 'no counters'} of ${want} (${ms(all(first))} ms)`,
            `second visit: ${second.stats ? `${second.stats.hits} from the device, ${second.stats.misses} from the network` : 'no counters'} (${ms(all(second))} ms)`,
            `persist=${second.persisted}`,
        ];
        // (The first visit may find chunks its own first load stored, before
        // coi-serviceworker reloaded the page.)
        const works = first.stats && second.stats && first.stats.hits + first.stats.misses === want &&
            first.stats.hits + first.stats.stored === want && second.stats.hits === want &&
            second.stats.misses === 0 && fine(all(second));
        verdict = `${works ? 'WORKS' : 'DOES NOT WORK'}: ${parts.join('; ')}`;
    }
} catch (e) {
    verdict = `could not run (${String((e && e.message) || e).split('\n')[0]})`;
}
console.log(`PROBE ${engine}: ${verdict}`);
