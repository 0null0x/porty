// Porty's disk cache, service-worker side: the 2 MiB chunks of the system
// image and the chunks of the resume snapshot are kept in Cache Storage, so
// that the guest's re-reads and later visits need neither the network nor
// the browser's HTTP cache.  QEMU fetches chunks with synchronous
// XMLHttpRequests from its worker threads (patches 0002 and 0012); those
// pass through the page's service worker, which loads this file with
// importScripts() and asks respond() about every request.
//
// A classic script (no imports): it also runs under node for the tests,
// which hand in their own `self`.  The page-side half is diskcache.js; the
// names below are shared with it (tests/diskcache.test.mjs compares them).
//
// - Versions: one cache per image directory (image/system-<hash>/, named
//   after the disk's SHA-256) and one per snapshot (the page tags snapshot
//   chunks with "?v=<chunk hash>&s=<snapshot hash>").  The first request
//   for a version deletes the other versions of its kind.
// - Integrity: a snapshot chunk is stored only if its SHA-256 starts with
//   its "v" tag; an image chunk only if it has the length the image
//   manifest gives it (that manifest has no per-chunk hashes).
// - Size cap: nothing more is stored once the origin's storage use would
//   pass the cap.  What is stored stays: the chunks a start reads first.
// - Any error (no Cache Storage, quota, a damaged entry) falls back to the
//   network without a word.
// SPDX-License-Identifier: GPL-2.0-or-later
(function (self) {
    'use strict';

    const PREFIX = 'porty-chunks-v1:';
    const META_CACHE = 'porty-diskcache-meta';
    const CONFIG_PATH = '__porty/diskcache-config.json';
    const DEFAULT_CAP_MB = 1536;
    const MIB = 1048576;
    // After a refused write, do not try again for a while.
    const FULL_PAUSE_MS = 120000;
    // navigator.storage.estimate() is asked again after this many writes.
    const ESTIMATE_EVERY = 8;

    const scope = () => (self.registration && self.registration.scope) || new URL('./', self.location.href).href;
    const cacheName = (kind, version) => `${PREFIX}${kind}:${version}`;

    /**
     * Is this the URL of a chunk?  {kind, version, key, index|sha} or null.
     * Only URLs under the service worker's scope count.
     */
    function classify(url, base = scope()) {
        let u;
        try {
            u = new URL(url);
        } catch (e) {
            return null;
        }
        if (!u.href.startsWith(base) || u.hash) {
            return null;
        }
        const path = u.href.slice(base.length).split('?')[0];
        let m = /^image\/([A-Za-z0-9][A-Za-z0-9._-]*)\/(\d{6})\.bin$/.exec(path);
        if (m && !u.search) {
            return { kind: 'image', version: m[1], index: Number(m[2]), key: u.href };
        }
        m = /^snapshot\/[0-9A-Za-z_-][0-9A-Za-z._-]*$/.exec(path);
        if (m) {
            const v = u.searchParams.get('v') || '';
            const s = u.searchParams.get('s') || '';
            if (/^[0-9a-f]{16}$/.test(v) && /^[0-9a-f]{16}$/.test(s)) {
                return { kind: 'snapshot', version: s, sha: v, key: u.href };
            }
        }
        return null;
    }

    function normalConfig(raw) {
        const c = raw && typeof raw === 'object' ? raw : {};
        const cap = Number(c.capMb);
        const image = c.image && typeof c.image === 'object' ? c.image : null;
        return {
            enabled: c.enabled !== false,
            capMb: Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_CAP_MB,
            image: image && typeof image.dir === 'string' && image.size > 0 && image.chunkSize > 0
                ? { dir: image.dir, size: Number(image.size), chunkSize: Number(image.chunkSize) } : null,
        };
    }

    const state = {
        config: null,          // Promise of normalConfig()
        seen: new Set(),       // cache names whose older versions were evicted
        usage: null,           // { bytes, writes } since the last estimate
        fullUntil: 0,
        epoch: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        stats: { hits: 0, misses: 0, stored: 0, hitBytes: 0, missBytes: 0, rejected: 0, errors: 0, full: 0, evicted: 0 },
    };

    function loadConfig() {
        if (!state.config) {
            state.config = self.caches.open(META_CACHE)
                .then((meta) => meta.match(new URL(CONFIG_PATH, scope()).href))
                .then((r) => (r ? r.json() : null))
                .then(normalConfig, () => normalConfig(null));
        }
        return state.config;
    }

    /** The page's settings changed (it also writes them to META_CACHE). */
    function setConfig(raw) {
        state.config = Promise.resolve(normalConfig(raw));
        state.fullUntil = 0;
        state.usage = null;
    }

    /** Delete the other versions of this kind; they will not be asked for again. */
    async function evictOthers(kind, keep) {
        const names = await self.caches.keys();
        for (const name of names) {
            if (name.startsWith(`${PREFIX}${kind}:`) && name !== keep) {
                if (await self.caches.delete(name)) {
                    state.stats.evicted++;
                    state.usage = null;
                }
            }
        }
    }

    /**
     * The cache of this version.  Opened by name every time, never kept:
     * the page (or another tab) may delete it at any moment, and a kept
     * handle would go on reading and writing a cache that no longer exists.
     */
    function openVersion(info) {
        const name = cacheName(info.kind, info.version);
        if (!state.seen.has(name)) {
            state.seen.add(name);
            evictOthers(info.kind, name).catch(() => {});
        }
        return self.caches.open(name);
    }

    /** Bytes this origin stores, as far as the browser tells. */
    async function storedBytes(cfg) {
        const u = state.usage;
        if (u && u.writes < ESTIMATE_EVERY) {
            return u.bytes;
        }
        let bytes = -1;
        const storage = self.navigator && self.navigator.storage;
        if (storage && typeof storage.estimate === 'function') {
            try {
                const e = await storage.estimate();
                if (e && Number.isFinite(e.usage)) {
                    bytes = e.usage;
                }
            } catch (e) {
                bytes = -1;
            }
        }
        if (bytes < 0) {
            // No estimate: count the entries, each at most one chunk.
            const chunk = (cfg.image && cfg.image.chunkSize) || 2 * MIB;
            bytes = 0;
            for (const name of await self.caches.keys()) {
                if (name.startsWith(PREFIX)) {
                    const cache = await self.caches.open(name);
                    bytes += (await cache.keys()).length * chunk;
                }
            }
        }
        state.usage = { bytes, writes: 0 };
        return bytes;
    }

    function hex(buffer) {
        const b = new Uint8Array(buffer);
        let s = '';
        for (let i = 0; i < b.length; i++) {
            s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
        }
        return s;
    }

    /**
     * Are these bytes this chunk?  'ok', 'bad', or 'unknown' when there is
     * nothing to check an image chunk against.
     */
    async function verify(info, body, cfg) {
        if (!body.byteLength) {
            return 'bad';
        }
        if (info.kind === 'snapshot') {
            const subtle = self.crypto && self.crypto.subtle;
            if (!subtle) {
                return 'unknown';
            }
            return hex(await subtle.digest('SHA-256', body)).startsWith(info.sha) ? 'ok' : 'bad';
        }
        const image = cfg.image;
        if (!image || image.dir !== info.version) {
            // The page has not said what this image looks like (it does so
            // before QEMU starts).
            return 'unknown';
        }
        const count = Math.ceil(image.size / image.chunkSize);
        if (info.index >= count) {
            return 'bad';
        }
        const want = info.index === count - 1 ? image.size - (count - 1) * image.chunkSize : image.chunkSize;
        return body.byteLength === want ? 'ok' : 'bad';
    }

    function chunkResponse(body) {
        return new Response(body, {
            status: 200,
            headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.byteLength) },
        });
    }

    async function store(info, body, cfg) {
        try {
            if (Date.now() < state.fullUntil) {
                return;
            }
            // Only what was checked is kept: a wrong chunk on the device
            // would be served again and again.
            if ((await verify(info, body, cfg)) !== 'ok') {
                state.stats.rejected++;
                return;
            }
            if ((await storedBytes(cfg)) + body.byteLength > cfg.capMb * MIB) {
                state.stats.full++;
                state.fullUntil = Date.now() + FULL_PAUSE_MS;
                state.usage = null;
                return;
            }
            const cache = await openVersion(info);
            await cache.put(info.key, chunkResponse(body));
            state.stats.stored++;
            if (state.usage) {
                state.usage.bytes += body.byteLength;
                state.usage.writes++;
            }
        } catch (e) {
            // Out of quota, private browsing, a failing disk: the network it is.
            state.stats.errors++;
            state.fullUntil = Date.now() + FULL_PAUSE_MS;
            state.usage = null;
        }
    }

    async function serve(request, info, keepAlive) {
        const cfg = await loadConfig();
        if (!cfg.enabled) {
            return self.fetch(request);
        }
        try {
            const cache = await openVersion(info);
            const hit = await cache.match(info.key);
            if (hit) {
                // Checked again on the way out; a damaged entry is dropped
                // and fetched anew.
                const body = await hit.arrayBuffer();
                if ((await verify(info, body, cfg)) !== 'bad') {
                    state.stats.hits++;
                    state.stats.hitBytes += body.byteLength;
                    return chunkResponse(body);
                }
                state.stats.rejected++;
                await cache.delete(info.key);
            }
        } catch (e) {
            state.stats.errors++;
        }
        const response = await self.fetch(request);
        if (response.status !== 200) {
            return response;
        }
        const body = await response.arrayBuffer();
        state.stats.misses++;
        state.stats.missBytes += body.byteLength;
        keepAlive(store(info, body, cfg));
        return chunkResponse(body);
    }

    /**
     * For the service worker's fetch handler: a promise of the response if
     * the request is for a chunk, else null (the caller handles it).
     */
    function respond(event) {
        const request = event.request;
        if (request.method !== 'GET' || request.headers.has('range')) {
            return null;
        }
        const info = classify(request.url);
        if (!info) {
            return null;
        }
        const keepAlive = (p) => {
            try {
                event.waitUntil(p);
            } catch (e) {
                // already responded and settled: the write goes on regardless
            }
        };
        return serve(request, info, keepAlive).catch(() => self.fetch(request));
    }

    /** Messages from the page: new settings, or a request for the counters. */
    function onMessage(event) {
        const data = event.data;
        if (!data || typeof data !== 'object') {
            return false;
        }
        if (data.type === 'portyDiskCacheConfig') {
            setConfig(data.config);
            return true;
        }
        if (data.type === 'portyDiskCacheClaim') {
            // A page this worker does not control yet wants its chunks cached.
            if (self.clients && self.clients.claim) {
                event.waitUntil(self.clients.claim());
            }
            return true;
        }
        if (data.type === 'portyDiskCacheStats') {
            const port = event.ports && event.ports[0];
            if (port) {
                port.postMessage({ epoch: state.epoch, ...state.stats });
            }
            return true;
        }
        return false;
    }

    self.portyDiskCache = {
        PREFIX, META_CACHE, CONFIG_PATH, DEFAULT_CAP_MB,
        cacheName, classify, normalConfig, respond, onMessage, state,
    };
}(typeof self !== 'undefined' ? self : globalThis));
