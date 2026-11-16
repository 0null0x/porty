// Porty's disk cache, page side.  The service worker keeps the chunks of
// the system image and of the resume snapshot in Cache Storage
// (diskcache-sw.js explains how); this module tells it the visitor's
// settings, asks the browser to keep the data, and reports what is stored.
// Everything here may fail quietly: without the cache Porty downloads as
// before.
// SPDX-License-Identifier: GPL-2.0-or-later

export const MIB = 1048576;
// Shared with diskcache-sw.js (tests/diskcache.test.mjs compares them).
export const PREFIX = 'porty-chunks-v1:';
export const META_CACHE = 'porty-diskcache-meta';
export const CONFIG_PATH = '__porty/diskcache-config.json';
export const DEFAULT_CAP_MB = 1536;
export const SERVICE_WORKER = 'coi-serviceworker.js';

export const DISKCACHE_HELP = ['diskcache',
    '0 keeps nothing on this device: by default the chunks of Android\'s system image and of the saved Android ' +
    `are stored here once downloaded, so re-reads and later visits skip the network. A number is the limit in MB (default ${DEFAULT_CAP_MB}).`];

/** ?diskcache=0 turns the cache off; ?diskcache=<MiB> (64 or more) sets the cap. */
export function diskCacheSetting(search) {
    const raw = new URLSearchParams(search).get('diskcache');
    if (raw === null || raw === '') {
        return { enabled: true, capMb: DEFAULT_CAP_MB };
    }
    if (/^(0|false|off|no)$/i.test(raw)) {
        return { enabled: false, capMb: DEFAULT_CAP_MB };
    }
    const n = Number.parseInt(raw, 10);
    return { enabled: true, capMb: Number.isFinite(n) && n >= 64 ? Math.min(n, 16384) : DEFAULT_CAP_MB };
}

export const cacheName = (kind, version) => `${PREFIX}${kind}:${version}`;

/**
 * What names a snapshot in chunk URLs ("&s=") and in the cache: 16 hex
 * digits of the hash of its whole stream, or of its first chunk.
 */
export function snapshotVersion(snap) {
    const hex = (v) => (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? v.slice(0, 16) : '');
    return hex(snap && snap.uncompressed_sha256) ||
        hex(snap && Array.isArray(snap.chunks) && snap.chunks[0] && snap.chunks[0].sha256) || '';
}

/** Bytes of chunk `index` of the system disk; 0 if there is no such chunk. */
export function imageChunkBytes(disk, index) {
    const count = Math.ceil(disk.size / disk.chunk_size);
    if (!(index >= 0 && index < count)) {
        return 0;
    }
    return index === count - 1 ? disk.size - (count - 1) * disk.chunk_size : disk.chunk_size;
}

/** "412 MB", "3.2 MB" */
export function megabytes(bytes) {
    const mb = bytes / MIB;
    return `${mb < 10 ? Math.round(mb * 10) / 10 : Math.round(mb)} MB`;
}

/**
 * One sentence for the page about what is stored.
 * @param {{supported: boolean, enabled: boolean, bytes: number, capMb: number, exact?: boolean}} u
 */
export function describeUsage(u) {
    if (!u.supported) {
        return 'This browser cannot keep Android\'s files on the device (no Cache Storage or no service worker), ' +
            'so they are downloaded on every visit.';
    }
    const about = u.exact === false ? 'About ' : '';
    if (!u.enabled) {
        return u.bytes > 0
            ? `diskcache=0: nothing more is stored on this device. ${about}${megabytes(u.bytes)} from earlier visits is still here.`
            : 'diskcache=0: nothing is stored on this device.';
    }
    return (u.bytes > 0
        ? `${about}${megabytes(u.bytes)} of Android is stored on this device`
        : 'Nothing is stored on this device yet') +
        `; what is downloaded is kept (up to ${u.capMb} MB) so that later visits and re-reads skip the network. ` +
        'diskcache=0 in the address turns that off.';
}

export class DiskCache {
    /**
     * @param {object} o
     * @param {string} o.search    location.search
     * @param {string} o.baseUrl   site root, with trailing slash
     * @param {object} [o.env]     { caches, navigator } (the browser's by default)
     */
    constructor({ search, baseUrl, env = globalThis }) {
        this.setting = diskCacheSetting(search);
        this.baseUrl = baseUrl;
        this.caches = (() => {
            try {
                return env.caches || null;
            } catch (e) {
                return null;
            }
        })();
        this.navigator = env.navigator || null;
        this.sw = (this.navigator && this.navigator.serviceWorker) || null;
        this.noWorker = /[?&]nocoi=1/.test(search);
        this.supported = !!(this.caches && this.sw) && !this.noWorker;
        this.persisted = null;
        // Counters of every service worker instance seen (it restarts when
        // idle), and where the one of this visit's start stood then.
        this.epochs = new Map();
        this.baseline = new Map();
    }

    get active() {
        return this.supported && this.setting.enabled;
    }

    /** What the service worker needs to know (it also reads this at start). */
    config(disk = null) {
        return {
            enabled: this.setting.enabled,
            capMb: this.setting.capMb,
            image: disk ? { dir: disk.dir, size: disk.size, chunkSize: disk.chunk_size } : null,
        };
    }

    /**
     * Before QEMU starts: hand the settings to the service worker, make
     * sure it controls this page, ask the browser not to evict the data.
     * @returns {Promise<string>} a note for the log; '' if all is as usual
     */
    async prepare(disk) {
        if (!this.supported) {
            return this.noWorker ? '' : 'No disk cache: this browser has no Cache Storage or no service worker.';
        }
        const config = this.config(disk);
        try {
            const meta = await this.caches.open(META_CACHE);
            await meta.put(new URL(CONFIG_PATH, this.baseUrl).href, new Response(JSON.stringify(config), {
                headers: { 'Content-Type': 'application/json' },
            }));
        } catch (e) {
            // Private browsing or no quota at all: nothing will be stored.
            return this.setting.enabled ? `No disk cache: the browser refused to store data (${e.name || e}).` : '';
        }
        if (!this.setting.enabled) {
            this.post({ type: 'portyDiskCacheConfig', config });
            return 'diskcache=0: chunks are not stored on this device.';
        }
        const controlled = await this.control();
        this.post({ type: 'portyDiskCacheConfig', config });
        if (!controlled) {
            return 'No disk cache: the service worker does not control this page.';
        }
        this.persisted = await this.persist();
        // Count from here: the worker may have served earlier visits.
        await this.stats(2000, true);
        return `Downloaded chunks are stored on this device (up to ${this.setting.capMb} MB` +
            `${this.persisted ? ', kept until deleted' : ', the browser may clear them when space is short'}).`;
    }

    post(message, transfer = []) {
        try {
            const target = this.sw && this.sw.controller;
            if (target) {
                target.postMessage(message, transfer);
                return true;
            }
        } catch (e) {
            // a worker that is being replaced
        }
        return false;
    }

    /**
     * Is this page controlled by the service worker?  On hosts that send
     * COOP/COEP themselves coi-serviceworker never registers, so do it here.
     */
    async control(timeoutMs = 8000) {
        const sw = this.sw;
        if (sw.controller) {
            return true;
        }
        try {
            const taken = new Promise((resolve) => {
                sw.addEventListener('controllerchange', () => resolve(true), { once: true });
                setTimeout(() => resolve(false), timeoutMs);
            });
            const registration = await sw.register(new URL(SERVICE_WORKER, this.baseUrl).href);
            if (registration.active && !sw.controller) {
                // Already running, but this load bypassed it (a forced reload).
                registration.active.postMessage({ type: 'portyDiskCacheClaim' });
            }
            await taken;
        } catch (e) {
            return false;
        }
        return !!sw.controller;
    }

    /** Ask the browser to keep this origin's data when space runs short. */
    async persist() {
        const storage = this.navigator && this.navigator.storage;
        try {
            if (storage && typeof storage.persisted === 'function' && await storage.persisted()) {
                return true;
            }
            if (storage && typeof storage.persist === 'function') {
                return !!(await storage.persist());
            }
        } catch (e) {
            // not available here
        }
        return false;
    }

    /**
     * What is stored, from the cache's entries and the manifests' sizes.
     * Without the manifests a chunk counts as 2 MiB (exact: false).
     *
     * @param {object|null} disk  image manifest's "disk"
     * @param {object|null} snap  snapshot manifest
     */
    async usage(disk = null, snap = null) {
        const out = {
            supported: this.supported, enabled: this.setting.enabled, capMb: this.setting.capMb,
            bytes: 0, imageChunks: 0, snapshotChunks: 0, versions: 0, exact: true,
        };
        if (!this.caches) {
            return out;
        }
        const snapSizes = new Map((snap && Array.isArray(snap.chunks) ? snap.chunks : []).map((c) => [c.file, c.size]));
        try {
            for (const name of await this.caches.keys()) {
                if (!name.startsWith(PREFIX)) {
                    continue;
                }
                out.versions++;
                const [kind, version] = name.slice(PREFIX.length).split(':');
                const keys = await (await this.caches.open(name)).keys();
                for (const request of keys) {
                    const file = new URL(request.url).pathname.split('/').pop();
                    let bytes = 0;
                    if (kind === 'image') {
                        out.imageChunks++;
                        bytes = disk && disk.dir === version ? imageChunkBytes(disk, Number.parseInt(file, 10)) : 0;
                    } else {
                        out.snapshotChunks++;
                        bytes = snap && snapshotVersion(snap) === version ? snapSizes.get(file) || 0 : 0;
                    }
                    if (!bytes) {
                        out.exact = false;
                        bytes = 2 * MIB;
                    }
                    out.bytes += bytes;
                }
            }
        } catch (e) {
            out.exact = false;
        }
        return out;
    }

    /** Delete every stored chunk. */
    async clear() {
        if (!this.caches) {
            return;
        }
        for (const name of await this.caches.keys()) {
            if (name.startsWith(PREFIX)) {
                await this.caches.delete(name);
            }
        }
    }

    /**
     * The service worker's counters, summed over its restarts; null if it
     * does not answer.
     */
    async stats(timeoutMs = 2000, asBaseline = false) {
        if (!this.active || typeof MessageChannel !== 'function') {
            return null;
        }
        const answer = await new Promise((resolve) => {
            const channel = new MessageChannel();
            const done = (value) => {
                clearTimeout(timer);
                channel.port1.close();
                resolve(value);
            };
            const timer = setTimeout(() => done(null), timeoutMs);
            channel.port1.onmessage = (ev) => done(ev.data);
            if (!this.post({ type: 'portyDiskCacheStats' }, [channel.port2])) {
                done(null);
            }
        });
        if (answer && answer.epoch) {
            this.epochs.set(answer.epoch, answer);
            if (asBaseline) {
                this.baseline.set(answer.epoch, answer);
            }
        }
        if (!this.epochs.size) {
            return null;
        }
        const total = { hits: 0, misses: 0, stored: 0, hitBytes: 0, missBytes: 0, rejected: 0, errors: 0, full: 0, evicted: 0 };
        for (const [epoch, s] of this.epochs) {
            const from = this.baseline.get(epoch) || {};
            for (const k of Object.keys(total)) {
                total[k] += (Number(s[k]) || 0) - (Number(from[k]) || 0);
            }
        }
        return total;
    }
}
