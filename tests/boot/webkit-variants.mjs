// Runs tests/boot/webkit-test.mjs once per variant, one after another on
// this machine (so every variant of a job runs on the same CPU), and puts
// the results side by side: peak and steady resident memory of WebKit's web
// content process, the shell loop, the Gallery launch.
//
// usage: node tests/boot/webkit-variants.mjs
//   SITE_URL        deployed site, with trailing slash (required)
//   VARIANTS        variants separated by ";", each a list of words:
//                     name=<label>        the label in the table and status
//                     q=<parameters>      page parameters added to BASE_QUERY
//                                         (a variant's value wins)
//                     JSC_<option>=<v>    an option of WebKit's JavaScript
//                                         engine, as an environment variable
//                     glue=<p>+<p>        rewrites of QEMU's JavaScript glue
//                                         (webkit-test.mjs, GLUE)
//                     probe=0             no tap on Gallery: the shell loop
//                                         and LOOP_ROUNDS more rounds only
//                     loops=<n>           shell loop rounds (default 3)
//                     proxy=1             through the test's local proxy of
//                                         the site even without glue
//                     qemu=local          QEMU-Wasm from LOCAL_QEMU_DIR (this
//                                         branch's build), the rest from the site
//                     browser=chrome      Chrome instead of WebKit
//                     local=1             the page's own files from this
//                                         checkout's web/ (LOCAL_WEB), the
//                                         rest from the site (site-proxy.mjs)
//                   e.g. "name=base; name=nostack JSC_exceptionStackTraceLimit=0"
//   BASE_QUERY      page parameters of every variant (default
//                   wasmmem=1280&jitcap=4000)
//   MINUTES         deadline of one variant (default 14)
//   PROBE_SECONDS   wait for Gallery after the tap (default 360)
//   REPLICA         number of this job among identical ones (for the labels)
//   WORK_DIR        where each variant's full log goes (default: a temp dir)
//
// Prints each variant's log without its screenshots, a "VARIANT ROW {json}"
// line per variant and "VARIANTS RESULT [...]" at the end; adds a table to
// the job summary.  Always exits 0.
// SPDX-License-Identifier: GPL-2.0-or-later
import { spawn } from 'node:child_process';
import { appendFileSync, createWriteStream, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const testScript = path.join(here, 'webkit-test.mjs');
const workDir = process.env.WORK_DIR || mkdtempSync(path.join(os.tmpdir(), 'porty-variants-'));
const baseQuery = (process.env.BASE_QUERY || 'wasmmem=1280&jitcap=4000').trim().replace(/^\?/, '');
const replica = (process.env.REPLICA || '1').replace(/[^0-9]/g, '') || '1';
const minutes = Math.max(4, Math.min(60, Number(process.env.MINUTES) || 14));
const probeSeconds = Math.max(30, Math.min(1800, Number(process.env.PROBE_SECONDS) || 360));
// The page files for local=1: this checkout's web/ unless LOCAL_WEB names another.
const localWeb = process.env.LOCAL_WEB || path.join(here, '..', '..', 'web');
// QEMU-Wasm for qemu=local: a build/build-qemu.sh output (the workflow
// restores this branch's from branch-check's cache).
const localQemu = process.env.LOCAL_QEMU_DIR || '';

// Only the characters page parameters, option names and labels need.
const WORD = /^[A-Za-z0-9_=&.,:%+-]{1,120}$/;

/** "name=x q=a=1&b=2 JSC_y=0 glue=count+ffi" -> {name, query, env, glue, probe, loops, words} */
export function parseVariant(text, base = '') {
    const words = text.trim().split(/\s+/).filter(Boolean);
    const v = {
        name: '', query: new URLSearchParams(base), env: [], glue: [], probe: true, loops: 3, proxy: false, local: false,
        qemu: '', browser: 'webkit', words: [],
    };
    for (const w of words) {
        if (!WORD.test(w)) {
            continue;
        }
        v.words.push(w);
        const eq = w.indexOf('=');
        const key = eq < 0 ? w : w.slice(0, eq);
        const value = eq < 0 ? '' : w.slice(eq + 1);
        if (key === 'name') {
            v.name = value.slice(0, 40);
        } else if (key === 'q') {
            for (const [k, val] of new URLSearchParams(value)) {
                v.query.set(k, val);
            }
        } else if (/^JSC_[A-Za-z0-9]+$/.test(key) && /^[A-Za-z0-9._-]+$/.test(value)) {
            v.env.push(`${key}=${value}`);
        } else if (key === 'glue') {
            v.glue.push(...value.split('+').filter((g) => /^[a-z0-9-]+$/.test(g)));
        } else if (key === 'probe') {
            v.probe = value !== '0';
        } else if (key === 'proxy') {
            v.proxy = value === '1';
        } else if (key === 'local') {
            v.local = value === '1';
        } else if (key === 'qemu') {
            v.qemu = value === 'local' ? 'local' : '';
        } else if (key === 'browser') {
            v.browser = value === 'chrome' ? 'chrome' : 'webkit';
        } else if (key === 'loops') {
            v.loops = Math.max(1, Math.min(12, Number(value) || 3));
        }
    }
    v.query = v.query.toString();
    if (!v.name) {
        v.name = v.words.filter((w) => !w.startsWith('name=')).join(' ').slice(0, 40) || 'base';
    }
    return v;
}

export function parseVariants(text, base = '') {
    return (text || 'name=base').split(';').map((t) => t.trim()).filter(Boolean).slice(0, 12)
        .map((t) => parseVariant(t, base));
}

/**
 * GC lines of JSC_logGC, as Playwright forwards the browser's stderr
 * (DEBUG=pw:browser): collections per heap, heap size after them, and what
 * was allocated between them.
 */
export function gcSummary(text) {
    // One collection starts with
    //   [GC<0x..>: START M 2758658kb => EdenCollection, ca=699.1kb h=2023695.5kb ...
    // (conductor M = mutator or C = collector thread, capacity, kind, then the
    // scheduler's bytes allocated this cycle and headroom) and ends, maybe on
    // a later line, with "=> 2622247kb, p=4.5ms (max 215.3), cycle 9.2ms END]"
    // (heap size after it).  "Requesting GC because ..." lines name no heap.
    const heaps = new Map();
    const get = (id) => {
        if (!heaps.has(id)) {
            heaps.set(id, {
                id, full: 0, eden: 0, maxCapacityKb: 0, maxAllocatedKb: 0, maxHeadroomKb: 0, lastAfterKb: 0,
                maxAfterKb: 0, maxPauseMs: 0, first: null, last: null, events: [],
            });
        }
        return heaps.get(id);
    };
    const open = [];
    for (const line of text.split('\n')) {
        const when = (/(\d\d:\d\d:\d\d\.\d+)Z/.exec(line) || [])[1] || '';
        for (const m of line.matchAll(/\[GC<(0x[0-9a-fA-F]+)>: START (\w) (\d+)kb => (Eden|Full)Collection, ca=([\d.]+)kb h=([\d.]+)kb/g)) {
            const h = get(m[1]);
            const ev = { when, conductor: m[2], capacityKb: Number(m[3]), kind: m[4], allocatedKb: Number(m[5]), headroomKb: Number(m[6]) };
            h[m[4] === 'Full' ? 'full' : 'eden']++;
            h.maxCapacityKb = Math.max(h.maxCapacityKb, ev.capacityKb);
            h.maxAllocatedKb = Math.max(h.maxAllocatedKb, ev.allocatedKb);
            h.maxHeadroomKb = Math.max(h.maxHeadroomKb, ev.headroomKb);
            h.first = h.first || when;
            h.last = when;
            h.events.push(ev);
            open.push(h);
        }
        for (const m of line.matchAll(/=> (\d+)kb, p=([\d.]+)ms \(max ([\d.]+)\), cycle ([\d.]+)ms END/g)) {
            // Belongs to the oldest open collection of the heap named last on this line, or else the oldest open one.
            const named = [...line.matchAll(/\[GC<(0x[0-9a-fA-F]+)>/g)].map((x) => x[1]);
            let i = named.length ? open.findIndex((h) => h.id === named[named.length - 1]) : -1;
            if (i < 0) {
                i = 0;
            }
            const h = open.splice(i, 1)[0];
            if (h) {
                const kb = Number(m[1]);
                h.lastAfterKb = kb;
                h.maxAfterKb = Math.max(h.maxAfterKb, kb);
                h.maxPauseMs = Math.max(h.maxPauseMs, Number(m[3]));
                const ev = h.events[h.events.length - 1];
                if (ev && ev.afterKb === undefined) {
                    ev.afterKb = kb;
                }
            }
        }
    }
    const seconds = (t) => {
        const m = /(\d\d):(\d\d):(\d\d\.\d+)/.exec(t || '');
        return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
    };
    for (const h of heaps.values()) {
        // What the heap allocated after it first held the WebAssembly memory
        // (its first full collection), per second up to its last collection.
        const i = h.events.findIndex((ev) => ev.kind === 'Full');
        const later = i < 0 ? [] : h.events.slice(i + 1);
        const span = later.length ? seconds(later[later.length - 1].when) - seconds(h.events[i].when) : 0;
        h.allocatedMb = Math.round(later.reduce((sum, ev) => sum + ev.allocatedKb, 0) / 1024);
        h.mbPerSecond = span > 5 ? Math.round((h.allocatedMb / span) * 10) / 10 : null;
    }
    return [...heaps.values()].sort((a, b) => (b.allocatedMb || 0) - (a.allocatedMb || 0));
}

const mib = (kb) => Math.round(kb / 1024);

function runOne(v, index) {
    return new Promise((resolve) => {
        const logPath = path.join(workDir, `variant-${index + 1}.log`);
        const errPath = path.join(workDir, `variant-${index + 1}.err`);
        const full = createWriteStream(logPath);
        const errOut = createWriteStream(errPath);
        const gcLog = v.env.some((e) => e.startsWith('JSC_logGC='));
        const env = {
            ...process.env,
            BROWSER: v.browser,
            DEVICE: 'iphone',
            QUERY: v.query,
            BROWSER_ENV: v.env.join(' '),
            GLUE: v.glue.join(','),
            // Glue rewrites and page files go through the test's local
            // proxy of the site (site-proxy.mjs); proxy=1 forces it.
            PROXY: v.proxy ? '1' : (v.glue.length || v.local || v.qemu ? '1' : '0'),
            LOCAL_WEB: v.local ? localWeb : '',
            LOCAL_QEMU: v.qemu === 'local' ? localQemu : '',
            BENCH: '0',
            SCAN: '0',
            MINUTES: String(minutes),
            PROBE_SECONDS: String(probeSeconds),
            PROBE: v.probe ? '1' : '0',
            LOOP_ROUNDS: String(v.loops),
            STATUS_CONTEXT: `porty/webkit-mem r${replica} ${v.name}`,
            VARIANT: v.name,
            ...(gcLog ? { DEBUG: 'pw:browser' } : {}),
        };
        const child = spawn(process.execPath, [testScript], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let resultLine = '';
        let carry = '';
        let inShot = false;
        child.stdout.on('data', (chunk) => {
            full.write(chunk);
            const lines = (carry + chunk.toString()).split('\n');
            carry = lines.pop();
            for (const line of lines) {
                if (line.startsWith('-----BEGIN PORTY')) {
                    inShot = true;
                    continue;
                }
                if (line.startsWith('-----END PORTY')) {
                    inShot = false;
                    continue;
                }
                if (inShot) {
                    continue;
                }
                if (line.startsWith('RESULT ')) {
                    resultLine = line.slice(7);
                    continue;
                }
                console.log(`[${v.name}] ${line}`);
            }
        });
        // The browser's stderr (with DEBUG=pw:browser) is the GC log: to the
        // file only, or it would drown the job log.
        let gcLines = 0;
        child.stderr.on('data', (chunk) => {
            errOut.write(chunk);
            if (!gcLog) {
                process.stderr.write(chunk);
            } else {
                gcLines += chunk.toString().split('\n').length - 1;
            }
        });
        const kill = setTimeout(() => child.kill('SIGKILL'), (minutes + 6) * 60000);
        child.on('close', (code) => {
            clearTimeout(kill);
            full.end();
            errOut.end();
            let result = null;
            try {
                result = resultLine ? JSON.parse(resultLine) : null;
            } catch (e) {
                result = null;
            }
            resolve({ code, result, logPath, errPath, gcLines });
        });
    });
}

const median = (xs) => {
    const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : null;
};

function row(v, r) {
    const res = r.result || {};
    const samples = res.jit || [];
    const rss = samples.map((s) => s.rss).filter(Number.isFinite);
    const peak = Math.max(res.peakRss || 0, ...rss, 0) || null;
    const heaps = samples.map((s) => s.heaps).filter(Number.isFinite);
    const settle = samples.filter((s) => s.label === 'settle' || s.label === 'after-probe').map((s) => s.rss);
    const boot = res.boot || {};
    const probe = res.probe || {};
    const counters = res.counterRates || {};
    return {
        replica: Number(replica), name: v.name, words: v.words.join(' '), query: v.query, env: v.env.join(' '), glue: v.glue.join('+'),
        cpu: res.cpu || '', version: res.version || '', crashed: !!res.crashed, failed: boot.failed || '',
        resumed: boot.resumed ?? null, loops: boot.loops || [], loopMedian: median(boot.loops || []),
        gallery: probe.gallery ?? null, launcherGone: probe.launcherGone ?? null,
        peakRss: peak, steadyRss: median(settle) ?? (rss.length ? rss[rss.length - 1] : null),
        peakHeaps: heaps.length ? Math.max(...heaps) : null,
        peakTotal: Math.max(res.peakTotal || 0, ...samples.map((s) => s.total).filter(Number.isFinite), 0) || null,
        jit: samples.length ? `${samples[samples.length - 1].alive}/${samples[samples.length - 1].compiled}` : '',
        counters, glueApplied: res.glueApplied || {}, errors: (res.errors || []).slice(0, 5),
        exit: r.code,
    };
}

const fmt = (x) => (x === null || x === undefined || x === '' ? '-' : String(x));

async function main() {
    if (!/^https?:\/\/.+\/$/.test(process.env.SITE_URL || '')) {
        console.error('SITE_URL must be the site root with a trailing slash');
        process.exit(0);
    }
    const variants = parseVariants(process.env.VARIANTS, baseQuery);
    console.log(`${variants.length} variants, base query ${baseQuery}, ${minutes} min each, logs in ${workDir}`);
    for (const v of variants) {
        console.log(`  ${v.name}: query=${v.query} env=${v.env.join(' ') || '-'} glue=${v.glue.join('+') || '-'} probe=${v.probe}`);
    }
    const rows = [];
    for (let i = 0; i < variants.length; i++) {
        const v = variants[i];
        if (v.qemu === 'local' && !localQemu) {
            console.log(`variant ${v.name}: skipped, no local QEMU-Wasm build (LOCAL_QEMU_DIR)`);
            rows.push({ replica: Number(replica), name: v.name, words: v.words.join(' '), skipped: 'no local QEMU-Wasm build', loops: [], counters: {}, errors: [] });
            continue;
        }
        console.log(`::group::variant ${i + 1}/${variants.length}: ${v.name}`);
        const t = Date.now();
        const r = await runOne(v, i);
        console.log('::endgroup::');
        const out = row(v, r);
        out.minutes = Math.round((Date.now() - t) / 6000) / 10;
        if (v.env.some((e) => e.startsWith('JSC_logGC='))) {
            try {
                const text = readFileSync(r.errPath, 'utf8');
                const heaps = gcSummary(text);
                out.gc = heaps.slice(0, 16).map(({ events, ...h }) => h);
                console.log(`[${v.name}] GC LOG: ${r.gcLines} lines, ${heaps.length} heaps`);
                for (const h of heaps.slice(0, 16)) {
                    console.log(`[${v.name}] GC heap ${h.id}: ${h.full} full + ${h.eden} eden from ${h.first} to ${h.last}; ` +
                        `${h.allocatedMb} MiB allocated after its first full collection (${h.mbPerSecond ?? '?'} MiB/s); ` +
                        `allocated before a collection up to ${mib(h.maxAllocatedKb)} MiB, capacity at the start up to ` +
                        `${mib(h.maxCapacityKb)} MiB, headroom up to ${mib(h.maxHeadroomKb)} MiB, size after up to ` +
                        `${mib(h.maxAfterKb)} MiB (last ${mib(h.lastAfterKb)}), longest pause ${h.maxPauseMs} ms`);
                }
                // The collections of the heaps that allocated most before collecting.
                for (const h of heaps.filter((x) => x.maxAllocatedKb > 65536).slice(0, 4)) {
                    const big = h.events.filter((ev) => ev.allocatedKb > 16384 || ev.kind === 'Full').slice(0, 60);
                    console.log(`[${v.name}] GC heap ${h.id} collections after 16 MiB or more, and full ones:\n` +
                        big.map((ev) => `  ${ev.when} ${ev.kind} by ${ev.conductor}: allocated ${mib(ev.allocatedKb)} MiB, ` +
                            `capacity ${mib(ev.capacityKb)} MiB, headroom ${mib(ev.headroomKb)} MiB, after ${ev.afterKb === undefined ? '?' : mib(ev.afterKb)} MiB`).join('\n'));
                }
                const requests = text.split('\n').filter((l) => /Requesting GC because/.test(l));
                console.log(`[${v.name}] GC requests: ${requests.length}; the first and last ten:\n` +
                    [...requests.slice(0, 10), ...requests.slice(-10)].map((l) => `  ${l.replace(/^.*\]\[err\] /, '').slice(0, 300)}`).join('\n'));
            } catch (e) {
                console.log(`[${v.name}] GC log not read: ${e.message}`);
            }
        }
        rows.push(out);
        console.log(`VARIANT ROW ${JSON.stringify(out)}`);
    }
    console.log(`VARIANTS RESULT ${JSON.stringify(rows)}`);
    const cpu = rows.map((r) => r.cpu).find(Boolean) || '?';
    const table = [
        `## WebKit memory, replica ${replica}: ${cpu}`,
        '',
        `Base query \`${baseQuery}\`; ${rows[0] ? rows[0].version : ''}. RSS of the web content process in MiB.`,
        '',
        '| variant | peak RSS | steady RSS | peak heaps | resume s | loop s | Gallery s | JIT alive/compiled | JS heaps: MiB/s, most allocated before a GC | counters per s | notes |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        ...rows.map((r) => `| ${r.name} (\`${r.words || '-'}\`) | ${fmt(r.peakRss)} | ${fmt(r.steadyRss)} | ${fmt(r.peakHeaps)} | ` +
            `${fmt(r.resumed)} | ${r.loops.map(fmt).join('/') || '-'} | ${fmt(r.gallery)} | ${r.jit || '-'} | ` +
            `${(r.gc || []).filter((h) => h.allocatedMb > 50).slice(0, 4).map((h) => `${h.mbPerSecond ?? '?'}/s, ${Math.round(h.maxAllocatedKb / 1024)}`).join('; ') || '-'} | ` +
            `${Object.entries(r.counters).map(([t, row]) => `${t}: ${Object.entries(row).map(([k, x]) => `${k} ${x}`).join(' ')}`).join('; ') || '-'} | ` +
            `${[r.crashed ? 'CRASHED' : '', r.failed, ...r.errors.map((e) => e.slice(0, 80))].filter(Boolean).join('; ').replace(/\|/g, '/') || ''} |`),
        '',
    ].join('\n');
    console.log(table);
    if (process.env.GITHUB_STEP_SUMMARY) {
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`);
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    try {
        await main();
    } catch (e) {
        console.log(`variants runner error: ${e.stack || e}`);
    }
    process.exit(0);
}
