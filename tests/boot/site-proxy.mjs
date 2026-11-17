// A local stand-in for the deployed site, for browser experiments:
// http://127.0.0.1:<port>/ serves the deployed site (SITE_URL), with the
// headers that make a page cross-origin isolated (so no service worker is
// needed for that), and can
//   - rewrite QEMU's JavaScript glue (qemu/out.js) for every context that
//     loads it: the page, QEMU's worker threads and service workers alike;
//   - serve the page's own files (index.html, js/, css/, the service
//     workers) from a local directory, so that page changes on a branch run
//     against the deployed QEMU, image and snapshot;
//   - serve qemu/ from a local QEMU-Wasm build (build/build-qemu.sh's
//     output), so that a branch's QEMU patches run with the deployed page,
//     image and snapshot (as long as the device state still fits).
// localhost is a secure context, so isolation works there over plain HTTP.
// SPDX-License-Identifier: GPL-2.0-or-later
import { createReadStream, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
};
const ISOLATION = {
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-embedder-policy': 'require-corp',
    'cross-origin-resource-policy': 'cross-origin',
};
// Upstream response headers worth passing on (not content-length or
// content-encoding: fetch() decodes the body).
const PASS = ['content-type', 'cache-control', 'etag', 'last-modified', 'content-range', 'accept-ranges'];

/**
 * Start the proxy.  upstream: the site root with a trailing slash.
 * rewrite(path, text): new text for qemu/out.js, or null.
 * localDir: serve files that exist there (only for paths outside the big
 * directories) instead of the upstream's.
 * Returns { url, close(), stats }.
 */
export async function startSiteProxy({ upstream, rewrite = null, localDir = '', localQemu = '', log = () => {} }) {
    const stats = { requests: 0, upstreamBytes: 0, rewritten: 0, local: 0, localQemu: 0, errors: 0 };
    const big = /^\/(image|snapshot|qemu)\//;
    const server = http.createServer(async (req, res) => {
        stats.requests++;
        const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        try {
            // QEMU-Wasm from a local build (the output of build/build-qemu.sh).
            if (localQemu && pathname.startsWith('/qemu/') && !pathname.includes('..')) {
                const file = path.join(localQemu, pathname.slice('/qemu/'.length));
                let st = null;
                try {
                    st = statSync(file);
                } catch (e) {
                    st = null;
                }
                if (st && st.isFile()) {
                    stats.localQemu++;
                    const type = TYPES[path.extname(file)] || 'application/octet-stream';
                    if (rewrite && pathname === '/qemu/out.js') {
                        const body = Buffer.from(rewrite(pathname, readFileSync(file, 'utf8')));
                        stats.rewritten++;
                        res.writeHead(200, { 'content-type': type, 'content-length': body.length, 'cache-control': 'no-cache', ...ISOLATION });
                        res.end(req.method === 'HEAD' ? undefined : body);
                        return;
                    }
                    res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'cache-control': 'no-cache', ...ISOLATION });
                    if (req.method === 'HEAD') {
                        res.end();
                    } else {
                        createReadStream(file).pipe(res);
                    }
                    return;
                }
            }
            if (localDir && !big.test(pathname) && !pathname.includes('..')) {
                const file = path.join(localDir, pathname.endsWith('/') ? `${pathname}index.html` : pathname);
                let st = null;
                try {
                    st = statSync(file);
                } catch (e) {
                    st = null;
                }
                if (st && st.isFile()) {
                    stats.local++;
                    res.writeHead(200, {
                        'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
                        'content-length': st.size, 'cache-control': 'no-cache', ...ISOLATION,
                    });
                    if (req.method === 'HEAD') {
                        res.end();
                    } else {
                        createReadStream(file).pipe(res);
                    }
                    return;
                }
            }
            const target = new URL(`.${req.url}`, upstream);
            const headers = {};
            for (const h of ['range', 'accept', 'if-none-match', 'if-modified-since']) {
                if (req.headers[h]) {
                    headers[h] = req.headers[h];
                }
            }
            const r = await fetch(target, { method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers, redirect: 'follow' });
            const out = { ...ISOLATION };
            for (const h of PASS) {
                if (r.headers.get(h)) {
                    out[h] = r.headers.get(h);
                }
            }
            if (rewrite && /\/qemu\/out\.js$/.test(pathname) && r.ok) {
                const text = rewrite(pathname, await r.text());
                stats.rewritten++;
                const body = Buffer.from(text);
                stats.upstreamBytes += body.length;
                res.writeHead(r.status, { ...out, 'content-length': body.length, 'cache-control': 'no-cache' });
                res.end(req.method === 'HEAD' ? undefined : body);
                return;
            }
            // No content-length: fetch() has already undone any
            // content-encoding (GitHub Pages gzips .js and .wasm), so the
            // upstream's length is not this body's.
            res.writeHead(r.status, out);
            if (req.method === 'HEAD' || !r.body) {
                res.end();
                return;
            }
            for await (const chunk of r.body) {
                stats.upstreamBytes += chunk.length;
                if (!res.write(chunk)) {
                    await new Promise((resolve) => res.once('drain', resolve));
                }
            }
            res.end();
        } catch (e) {
            stats.errors++;
            log(`proxy: ${pathname}: ${String(e.message || e).split('\n')[0]}`);
            if (!res.headersSent) {
                res.writeHead(502, ISOLATION);
            }
            res.end();
        }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    return {
        url: `http://127.0.0.1:${port}/`,
        stats,
        close: () => new Promise((resolve) => server.close(() => resolve())),
    };
}
