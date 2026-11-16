// Unit tests of the disk cache: the service-worker half (web/js/
// diskcache-sw.js, a classic script run here against fake Cache Storage,
// fetch and crypto) and the page half (web/js/diskcache.js).
// Run with: node tests/diskcache.test.mjs
// SPDX-License-Identifier: GPL-2.0-or-later
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
    CONFIG_PATH, DEFAULT_CAP_MB, DISKCACHE_HELP, DiskCache, META_CACHE, MIB, PREFIX, cacheName, describeUsage,
    diskCacheSetting, imageChunkBytes, snapshotVersion,
} from '../web/js/diskcache.js';

const SCOPE = 'https://example.test/porty/';
const swSource = readFileSync(new URL('../web/js/diskcache-sw.js', import.meta.url), 'utf8');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Cache Storage, as far as the code under test uses it. */
class FakeCaches {
    constructor() {
        this.stores = new Map();
        this.failPut = null;
    }
    async open(name) {
        if (!this.stores.has(name)) {
            this.stores.set(name, new Map());
        }
        const store = this.stores.get(name);
        const key = (k) => (typeof k === 'string' ? k : k.url);
        return {
            match: async (k) => (store.has(key(k)) ? store.get(key(k)).clone() : undefined),
            put: async (k, response) => {
                if (this.failPut) {
                    throw this.failPut;
                }
                store.set(key(k), response);
            },
            delete: async (k) => store.delete(key(k)),
            keys: async () => [...store.keys()].map((url) => ({ url })),
        };
    }
    async keys() {
        return [...this.stores.keys()];
    }
    async delete(name) {
        return this.stores.delete(name);
    }
    bytes() {
        let n = 0;
        for (const [name, store] of this.stores) {
            if (name.startsWith(PREFIX)) {
                for (const r of store.values()) {
                    n += Number(r.headers.get('Content-Length'));
                }
            }
        }
        return n;
    }
}

/** A service worker global with the disk cache loaded, and a fake site. */
function worker({ files, caches = new FakeCaches(), estimate = true } = {}) {
    const fetched = [];
    const modes = [];
    const self = {
        registration: { scope: SCOPE },
        location: { href: `${SCOPE}coi-serviceworker.js` },
        caches,
        crypto: webcrypto,
        navigator: estimate ? { storage: { estimate: async () => ({ usage: caches.bytes(), quota: 1e12 }) } } : {},
        fetch: async (request) => {
            const url = typeof request === 'string' ? request : request.url;
            fetched.push(url);
            modes.push(typeof request === 'string' ? 'default' : request.cache);
            const body = files.get(url);
            return body ? new Response(body, { status: 200 }) : new Response('no', { status: 404 });
        },
    };
    new Function('self', 'Response', 'URL', swSource)(self, Response, URL);
    const pending = [];
    const get = async (url, init = {}) => {
        const event = { request: new Request(url, init), waitUntil: (p) => pending.push(p) };
        const answer = self.portyDiskCache.respond(event);
        if (!answer) {
            return null;
        }
        const response = await answer;
        const body = new Uint8Array(await response.arrayBuffer());
        await Promise.all(pending.splice(0));
        return { status: response.status, body };
    };
    return { self, dc: self.portyDiskCache, caches, fetched, modes, get };
}

const bytes = (n, seed) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed) & 255);
const disk = { dir: 'system-0123456789abcdef', size: 2 * 4096 + 100, chunk_size: 4096 };
const imageUrl = (i, dir = disk.dir) => `${SCOPE}image/${dir}/${String(i).padStart(6, '0')}.bin`;
const imageFiles = () => new Map([[imageUrl(0), bytes(4096, 1)], [imageUrl(1), bytes(4096, 2)], [imageUrl(2), bytes(100, 3)]]);
const pageConfig = (over = {}) => ({
    enabled: true, capMb: 64, image: { dir: disk.dir, size: disk.size, chunkSize: disk.chunk_size }, ...over,
});

// --- both halves use the same names ---------------------------------------------------------
{
    const { dc } = worker({ files: new Map() });
    assert.equal(dc.PREFIX, PREFIX);
    assert.equal(dc.META_CACHE, META_CACHE);
    assert.equal(dc.CONFIG_PATH, CONFIG_PATH);
    assert.equal(dc.DEFAULT_CAP_MB, DEFAULT_CAP_MB);
    assert.equal(dc.cacheName('image', 'x'), cacheName('image', 'x'));
}

// --- which requests are chunks ----------------------------------------------------------------
{
    const { dc } = worker({ files: new Map() });
    assert.deepEqual(dc.classify(imageUrl(12)), { kind: 'image', version: disk.dir, index: 12, key: imageUrl(12) });
    const snap = `${SCOPE}snapshot/000003.zz?v=${'a'.repeat(16)}&s=${'b'.repeat(16)}`;
    assert.deepEqual(dc.classify(snap), { kind: 'snapshot', version: 'b'.repeat(16), sha: 'a'.repeat(16), key: snap });
    for (const other of [
        `${SCOPE}image/manifest.json`, `${SCOPE}image/kernel`, `${SCOPE}image/${disk.dir}/000001.bin?x=1`,
        `${SCOPE}image/${disk.dir}/1.bin`, `${SCOPE}image/a/b/000001.bin`,
        `${SCOPE}snapshot/manifest.json`, `${SCOPE}snapshot/000003.zz`, `${SCOPE}snapshot/000003.zz?v=${'a'.repeat(16)}`,
        `${SCOPE}snapshot/000003.zz?v=xyz&s=${'b'.repeat(16)}`,
        `https://example.test/other/image/${disk.dir}/000001.bin`, `https://evil.test/porty/image/${disk.dir}/000001.bin`,
        `${SCOPE}qemu/out.js`, 'not a url',
    ]) {
        assert.equal(dc.classify(other), null, other);
    }
    // Other requests are none of its business.
    const { get } = worker({ files: new Map() });
    assert.equal(await get(`${SCOPE}build.json`), null);
    assert.equal(await get(imageUrl(0), { method: 'HEAD' }), null);
    assert.equal(await get(imageUrl(0), { headers: { Range: 'bytes=0-1' } }), null);
}

// --- image chunks: fetched once, then from the device -------------------------------------------
{
    const files = imageFiles();
    const w = worker({ files });
    w.dc.onMessage({ data: { type: 'portyDiskCacheConfig', config: pageConfig() } });
    for (const i of [0, 1, 2, 0, 2]) {
        const r = await w.get(imageUrl(i));
        assert.equal(r.status, 200);
        assert.deepEqual(r.body, files.get(imageUrl(i)));
    }
    assert.deepEqual(w.fetched, [imageUrl(0), imageUrl(1), imageUrl(2)], 're-reads do not reach the network');
    assert.deepEqual([w.dc.state.stats.hits, w.dc.state.stats.misses, w.dc.state.stats.stored], [2, 3, 3]);
    assert.deepEqual([w.dc.state.stats.hitBytes, w.dc.state.stats.missBytes], [4196, 8292]);
    assert.deepEqual(await w.caches.keys(), [cacheName('image', disk.dir)]);

    // A later visit (a new worker over the same storage, the settings read
    // from the cache the page wrote them to) needs no network at all.
    const meta = await w.caches.open(META_CACHE);
    await meta.put(new URL(CONFIG_PATH, SCOPE).href, new Response(JSON.stringify(pageConfig())));
    const later = worker({ files: new Map(), caches: w.caches });
    assert.deepEqual((await later.get(imageUrl(1))).body, files.get(imageUrl(1)));
    assert.deepEqual(later.fetched, []);

    // A 404 is passed on and not stored.
    assert.equal((await later.get(imageUrl(7))).status, 404);
    assert.equal((await (await w.caches.open(cacheName('image', disk.dir))).keys()).length, 3);

    // A stored chunk that lost bytes is dropped and fetched again.
    const store = w.caches.stores.get(cacheName('image', disk.dir));
    store.set(imageUrl(1), new Response(bytes(50, 9), { headers: { 'Content-Length': '50' } }));
    const again = worker({ files, caches: w.caches });
    assert.deepEqual((await again.get(imageUrl(1))).body, files.get(imageUrl(1)));
    assert.deepEqual(again.fetched, [imageUrl(1)]);
    assert.equal(again.dc.state.stats.rejected, 1);
    assert.deepEqual((await again.get(imageUrl(1))).body, files.get(imageUrl(1)));
    assert.deepEqual(again.fetched, [imageUrl(1)], 'the fresh copy was stored');
}

// --- image chunks are only stored when their length is right ---------------------------------------
{
    const files = imageFiles();
    files.set(imageUrl(1), bytes(4000, 2));            // a short download
    files.set(imageUrl(3), bytes(4096, 4));            // past the end of the disk
    const w = worker({ files });
    w.dc.onMessage({ data: { type: 'portyDiskCacheConfig', config: pageConfig() } });
    assert.equal((await w.get(imageUrl(1))).body.length, 4000, 'QEMU still gets what the server sent');
    await w.get(imageUrl(3));
    await w.get(imageUrl(2));
    assert.deepEqual([w.dc.state.stats.stored, w.dc.state.stats.rejected], [1, 2]);
    // Without the page's description of the image nothing can be checked, so nothing is stored.
    const blind = worker({ files: imageFiles() });
    await blind.get(imageUrl(0));
    assert.deepEqual([blind.dc.state.stats.stored, blind.dc.state.stats.rejected], [0, 1]);
}

// --- snapshot chunks: stored only if the hash matches the tag ----------------------------------------
{
    const good = bytes(3000, 5);
    const version = 'c'.repeat(16);
    const url = (file, body) => `${SCOPE}snapshot/${file}?v=${sha(body).slice(0, 16)}&s=${version}`;
    const goodUrl = url('000000.zz', good);
    const staleUrl = url('000001.zz', bytes(10, 1));   // the site serves other bytes under this name
    const files = new Map([[goodUrl, good], [staleUrl, bytes(10, 2)]]);
    const w = worker({ files });
    assert.deepEqual((await w.get(goodUrl)).body, good);
    assert.deepEqual((await w.get(goodUrl)).body, good);
    await w.get(staleUrl);
    await w.get(staleUrl);
    assert.deepEqual(w.fetched, [goodUrl, staleUrl, staleUrl]);
    assert.deepEqual([w.dc.state.stats.stored, w.dc.state.stats.rejected, w.dc.state.stats.hits], [1, 2, 1]);
    assert.deepEqual(await w.caches.keys(), [META_CACHE, cacheName('snapshot', version)]);

    // A stored chunk that changed on the device is not served.
    w.caches.stores.get(cacheName('snapshot', version)).set(goodUrl, new Response(bytes(3000, 6)));
    assert.deepEqual((await w.get(goodUrl)).body, good);
    assert.equal(w.fetched.length, 4);
}

// --- a new image or snapshot evicts the old one -------------------------------------------------------
{
    const files = imageFiles();
    const next = { dir: 'system-fedcba9876543210', size: 4096, chunk_size: 4096 };
    files.set(imageUrl(0, next.dir), bytes(4096, 8));
    const snapBody = bytes(500, 1);
    const snapUrl = (s) => `${SCOPE}snapshot/000000.zz?v=${sha(snapBody).slice(0, 16)}&s=${s}`;
    files.set(snapUrl('1'.repeat(16)), snapBody);
    files.set(snapUrl('2'.repeat(16)), snapBody);
    const w = worker({ files });
    w.dc.onMessage({ data: { type: 'portyDiskCacheConfig', config: pageConfig() } });
    await w.get(imageUrl(0));
    await w.get(snapUrl('1'.repeat(16)));
    assert.deepEqual((await w.caches.keys()).sort(), [cacheName('image', disk.dir), cacheName('snapshot', '1'.repeat(16))].sort());
    // The site is redeployed with another image and snapshot.
    const after = worker({ files, caches: w.caches });
    after.dc.onMessage({
        data: { type: 'portyDiskCacheConfig', config: pageConfig({ image: { dir: next.dir, size: next.size, chunkSize: 4096 } }) },
    });
    await after.get(imageUrl(0, next.dir));
    await after.get(snapUrl('2'.repeat(16)));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual((await w.caches.keys()).sort(),
        [cacheName('image', next.dir), cacheName('snapshot', '2'.repeat(16))].sort());
    assert.equal(after.dc.state.stats.evicted, 2);
}

// --- the size cap, and storage that refuses -------------------------------------------------------------
for (const estimate of [true, false]) {
    const big = { dir: disk.dir, size: 4 * MIB, chunkSize: MIB };
    const files = new Map([0, 1, 2, 3].map((i) => [imageUrl(i), bytes(MIB, i)]));
    const w = worker({ files, estimate });
    // Without storage.estimate() every stored chunk counts as a full one.
    w.dc.onMessage({ data: { type: 'portyDiskCacheConfig', config: { enabled: true, capMb: 2, image: big } } });
    for (const i of [0, 1, 2, 3, 2]) {
        assert.deepEqual((await w.get(imageUrl(i))).body, files.get(imageUrl(i)));
    }
    assert.equal(w.dc.state.stats.stored, 2, `cap of 2 MB (estimate: ${estimate})`);
    assert.equal(w.dc.state.stats.full, 1);
    assert.equal(w.fetched.length, 5, 'what does not fit comes from the network every time');
    // What is stored here skips the browser's HTTP cache; what is not may use it.
    assert.deepEqual(w.modes, ['no-store', 'no-store', 'no-store', 'default', 'default']);
    assert.deepEqual((await w.get(imageUrl(0))).body, files.get(imageUrl(0)));
    assert.equal(w.fetched.length, 5, 'what was stored first stays');
}
{
    const files = imageFiles();
    const caches = new FakeCaches();
    caches.failPut = Object.assign(new Error('full'), { name: 'QuotaExceededError' });
    const w = worker({ files, caches });
    w.dc.onMessage({ data: { type: 'portyDiskCacheConfig', config: pageConfig() } });
    assert.deepEqual((await w.get(imageUrl(0))).body, files.get(imageUrl(0)));
    assert.deepEqual((await w.get(imageUrl(1))).body, files.get(imageUrl(1)));
    assert.deepEqual((await w.get(imageUrl(0))).body, files.get(imageUrl(0)));
    assert.deepEqual([w.dc.state.stats.stored, w.dc.state.stats.errors, w.fetched.length], [0, 1, 3]);

    // No Cache Storage at all: straight to the network.
    const none = worker({ files });
    none.self.caches = { open: async () => { throw new Error('SecurityError'); }, keys: async () => [] };
    assert.deepEqual((await none.get(imageUrl(2))).body, files.get(imageUrl(2)));
    assert.deepEqual(none.fetched, [imageUrl(2)]);
}

// --- diskcache=0 ------------------------------------------------------------------------------------------
{
    const files = imageFiles();
    const w = worker({ files });
    w.dc.onMessage({ data: { type: 'portyDiskCacheConfig', config: pageConfig() } });
    await w.get(imageUrl(0));
    w.dc.onMessage({ data: { type: 'portyDiskCacheConfig', config: pageConfig({ enabled: false }) } });
    await w.get(imageUrl(0));
    await w.get(imageUrl(1));
    assert.deepEqual(w.fetched, [imageUrl(0), imageUrl(0), imageUrl(1)], 'neither read from nor written to');
    assert.equal(w.dc.state.stats.stored, 1);
    // The counters, as the page asks for them.
    let answer = null;
    assert.equal(w.dc.onMessage({ data: { type: 'portyDiskCacheStats' }, ports: [{ postMessage: (m) => { answer = m; } }] }), true);
    assert.equal(answer.stored, 1);
    assert.equal(answer.epoch, w.dc.state.epoch);
    assert.equal(w.dc.onMessage({ data: { type: 'coepCredentialless', value: false } }), false);
}

// --- the page half: settings ---------------------------------------------------------------------------------
{
    assert.deepEqual(diskCacheSetting(''), { enabled: true, capMb: DEFAULT_CAP_MB });
    assert.deepEqual(diskCacheSetting('?diskcache=0'), { enabled: false, capMb: DEFAULT_CAP_MB });
    assert.deepEqual(diskCacheSetting('?mem=768&diskcache=off'), { enabled: false, capMb: DEFAULT_CAP_MB });
    assert.deepEqual(diskCacheSetting('?diskcache=1'), { enabled: true, capMb: DEFAULT_CAP_MB });
    assert.deepEqual(diskCacheSetting('?diskcache=512'), { enabled: true, capMb: 512 });
    assert.deepEqual(diskCacheSetting('?diskcache=99999999'), { enabled: true, capMb: 16384 });
    assert.deepEqual(diskCacheSetting('?diskcache=junk'), { enabled: true, capMb: DEFAULT_CAP_MB });
    assert.equal(DISKCACHE_HELP[0], 'diskcache');

    assert.equal(snapshotVersion({ uncompressed_sha256: 'ab'.repeat(32) }), 'ab'.repeat(8));
    assert.equal(snapshotVersion({ chunks: [{ sha256: 'cd'.repeat(32) }] }), 'cd'.repeat(8));
    assert.equal(snapshotVersion({}), '');
    assert.deepEqual([0, 1, 2, 3, -1].map((i) => imageChunkBytes(disk, i)), [4096, 4096, 100, 0, 0]);

    assert.match(describeUsage({ supported: false }), /cannot keep/);
    assert.match(describeUsage({ supported: true, enabled: true, bytes: 0, capMb: 1536 }), /^Nothing is stored on this device yet; .*up to 1536 MB.*diskcache=0/);
    assert.match(describeUsage({ supported: true, enabled: true, bytes: 412 * MIB, capMb: 1536 }), /^412 MB of Android is stored on this device/);
    assert.match(describeUsage({ supported: true, enabled: true, bytes: 412 * MIB, capMb: 1536, exact: false }), /^About 412 MB/);
    assert.match(describeUsage({ supported: true, enabled: false, bytes: 0, capMb: 1536 }), /^diskcache=0: nothing is stored/);
    assert.match(describeUsage({ supported: true, enabled: false, bytes: 3 * MIB, capMb: 1536 }), /3 MB from earlier visits is still here/);
}

// --- the page half: against the worker half ------------------------------------------------------------------
{
    const files = imageFiles();
    const snapBody = bytes(700, 4);
    const snap = { uncompressed_sha256: 'e'.repeat(64), chunks: [{ file: '000000.zz', size: 700, sha256: sha(snapBody) }] };
    const snapUrl = `${SCOPE}snapshot/000000.zz?v=${sha(snapBody).slice(0, 16)}&s=${snapshotVersion(snap)}`;
    files.set(snapUrl, snapBody);
    const w = worker({ files });
    let persistAsked = 0;
    const controller = {
        postMessage: (data, transfer = []) => w.dc.onMessage({ data, ports: transfer.map((port) => ({
            postMessage: (m) => port.postMessage(m),
        })) }),
    };
    const env = {
        caches: w.caches,
        navigator: {
            serviceWorker: { controller },
            storage: { persisted: async () => false, persist: async () => { persistAsked++; return true; } },
        },
    };
    const page = new DiskCache({ search: '?diskcache=256', baseUrl: SCOPE, env });
    assert.equal(page.active, true);
    assert.match(await page.prepare(disk), /stored on this device \(up to 256 MB, kept until deleted\)/);
    assert.equal(persistAsked, 1);
    assert.deepEqual(await (await (await w.caches.open(META_CACHE)).match(new URL(CONFIG_PATH, SCOPE).href)).json(),
        { enabled: true, capMb: 256, image: { dir: disk.dir, size: disk.size, chunkSize: 4096 } });
    await w.get(imageUrl(0));
    await w.get(imageUrl(2));
    await w.get(imageUrl(2));
    await w.get(snapUrl);
    assert.deepEqual(await page.stats(), {
        hits: 1, misses: 3, stored: 3, hitBytes: 100, missBytes: 4896, rejected: 0, errors: 0, full: 0, evicted: 0,
    });
    // What is stored, exactly with the manifests and roughly without.
    const exact = await page.usage(disk, snap);
    assert.deepEqual([exact.bytes, exact.imageChunks, exact.snapshotChunks, exact.exact], [4096 + 100 + 700, 2, 1, true]);
    const rough = await page.usage();
    assert.deepEqual([rough.bytes, rough.exact], [3 * 2 * MIB, false]);
    // A later visit counts from its own start, and a restarted worker from zero.
    const visit = new DiskCache({ search: '', baseUrl: SCOPE, env });
    await visit.prepare(disk);
    await w.get(imageUrl(0));
    assert.deepEqual([(await visit.stats()).hits, (await visit.stats()).stored], [1, 0]);
    const restarted = worker({ files, caches: w.caches });
    env.navigator.serviceWorker.controller = {
        postMessage: (data, transfer = []) => restarted.dc.onMessage({ data, ports: transfer }),
    };
    await restarted.get(imageUrl(0));
    await restarted.get(imageUrl(2));
    assert.equal((await visit.stats()).hits, 3);

    await page.clear();
    assert.deepEqual(await w.caches.keys(), [META_CACHE]);
    assert.equal((await page.usage(disk, snap)).bytes, 0);

    // diskcache=0: the worker is told, and says so in its settings.
    const off = new DiskCache({ search: '?diskcache=0', baseUrl: SCOPE, env });
    assert.equal(off.active, false);
    assert.match(await off.prepare(disk), /diskcache=0/);
    assert.equal((await restarted.dc.state.config).enabled, false);
    assert.equal(await off.stats(), null);

    // Browsers without the pieces: no cache, no error.
    const bare = new DiskCache({ search: '', baseUrl: SCOPE, env: { navigator: {} } });
    assert.equal(bare.supported, false);
    assert.match(await bare.prepare(disk), /No disk cache/);
    assert.equal((await bare.usage()).bytes, 0);
    await bare.clear();
    const refused = new DiskCache({
        search: '', baseUrl: SCOPE,
        env: { caches: { open: async () => { throw Object.assign(new Error('no'), { name: 'SecurityError' }); } }, navigator: env.navigator },
    });
    assert.match(await refused.prepare(disk), /refused to store data \(SecurityError\)/);
    // ?nocoi=1 removes the service worker, and with it the cache.
    assert.equal(new DiskCache({ search: '?nocoi=1', baseUrl: SCOPE, env }).supported, false);
}

console.log('diskcache tests passed');
