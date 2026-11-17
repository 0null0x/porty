// Unit tests for web/js/snapshot.js (run by tests/unit.test.mjs).
// SPDX-License-Identifier: GPL-2.0-or-later
import assert from 'node:assert/strict';
import { parseConfig, requiredWasmMemoryMb } from '../web/js/config.js';
import { buildQemuArgs } from '../web/js/qemu-args.js';
import {
    RESUME_FAILED_KEY, SNAP_LOADING, STAGE_RESUMING, checkSnapshot, describeResume, readSnapshotStats,
    resumeMode, resumeVeto, snapshotArgs, snapshotConfig, snapshotIndex, storeResumeFailure, takeResumeFailure,
} from '../web/js/snapshot.js';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
const imageManifest = {
    cmdline: 'root=/dev/ram0 androidboot.selinux=permissive buildvariant=userdebug',
    kernel: { file: 'kernel' }, initrd: { file: 'initrd.img' }, ramdisk: { file: 'ramdisk.img' },
    disk: { dir: 'system', size: 900000000, chunk_size: 2097152, chunks: 430 },
};
// Where the machine that saved the snapshot kept its files (a CI runner).
const savedPaths = { bios: '/work/bios', kernel: '/work/image/kernel', initrd: '/work/image/initrd.img',
    ramdisk: '/work/image/ramdisk.img', diskUrl: '/work/image/system' };
const pagePaths = { bios: '/pc-bios', kernel: '/img/kernel', initrd: '/img/initrd.img',
    ramdisk: '/img/ramdisk.img', diskUrl: 'https://example.test/porty/a,b/image/system' };
const QUERY = 'mem=768&tb=128&cache=16';
const sha = (c) => c.repeat(64);
const build = {
    qemu_wasm_commit: '0ef7b4e2814b231705d8371dd7997f5b72e70baf',
    porty_patches_sha256: sha('a'),
    image_manifest_sha256: sha('b'),
    snapshot: true,
};
const snapshot = () => ({
    format: 1,
    kind: 'qemu-migration',
    qemu_wasm_commit: build.qemu_wasm_commit,
    porty_patches_sha256: build.porty_patches_sha256,
    uncompressed_size: 2 * 4194304 + 5,
    chunk_size: 4194304,
    compression: 'zlib',
    chunks: [
        { file: '000000.zz', size: 1000, sha256: sha('1') },
        { file: '000001.zz', size: 2000, sha256: sha('2') },
        { file: '000002.zz', size: 30, sha256: sha('3') },
    ],
    argv: buildQemuArgs(parseConfig(`?${QUERY}`, { userAgent: 'node' }), imageManifest, savedPaths),
    query: QUERY,
    image_manifest_sha256: build.image_manifest_sha256,
    booted_seconds: 7200,
});

// --- ?resume= and the reasons not to resume ---------------------------------
{
    assert.equal(resumeMode(''), 'auto');
    assert.equal(resumeMode('?resume=1'), 'on');
    assert.equal(resumeMode('?resume'), 'on');
    assert.equal(resumeMode('?resume=0'), 'off');

    assert.equal(resumeVeto({ search: '' }), '');
    assert.equal(resumeVeto({ search: '?serial=1&fps=10&jitcap=2000' }), '', 'page settings do not matter');
    assert.match(resumeVeto({ search: '?resume=0' }), /resume=0/);
    assert.match(resumeVeto({ search: '?mem=1024&smp=2' }), /sets mem=, smp=/);
    assert.equal(resumeVeto({ search: '?mem=1024&resume=1' }), '', 'resume=1 overrides machine parameters');
    const killed = { stage: STAGE_RESUMING, mem: 768 };
    assert.match(resumeVeto({ search: '', lastRun: killed }), /stopped the last attempt/);
    assert.equal(resumeVeto({ search: '?resume=1', lastRun: killed }), '');
    assert.equal(resumeVeto({ search: '', lastRun: { stage: 'Android resumed' } }), '',
        'a tab killed later resumes again: booting would take hours');
    assert.match(resumeVeto({ search: '?resume=1', failure: { message: 'HTTP 404' } }), /HTTP 404/,
        'after a failed resume even resume=1 boots, or the page would reload forever');

    const store = new Map();
    const storage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { store.set(k, v); },
        removeItem: (k) => { store.delete(k); },
    };
    assert.equal(takeResumeFailure(storage), null);
    assert.equal(storeResumeFailure(storage, 'chunk 3: HTTP 404', 1000), true);
    assert.ok(store.has(RESUME_FAILED_KEY));
    assert.deepEqual(takeResumeFailure(storage, 2000), { message: 'chunk 3: HTTP 404', at: 1000 });
    assert.equal(takeResumeFailure(storage, 2000), null, 'reported once');
    storeResumeFailure(storage, 'old', 1000);
    assert.equal(takeResumeFailure(storage, 1000 + 3600000), null, 'a stale failure is forgotten');
    assert.equal(storeResumeFailure(null, 'x'), false, 'no storage: the page must not reload');
    assert.equal(takeResumeFailure(null), null);
}

// --- the manifest must describe this build and this image -----------------------
{
    assert.deepEqual(checkSnapshot(snapshot(), build), []);
    assert.equal(checkSnapshot(null, build).length, 1);
    const broken = (change, pattern) => {
        const snap = snapshot();
        change(snap);
        const problems = checkSnapshot(snap, build);
        assert.ok(problems.some((p) => pattern.test(p)), `${pattern}: ${problems.join('; ')}`);
    };
    broken((s) => { s.format = 2; }, /unknown snapshot format/);
    broken((s) => { s.kind = 'savevm'; }, /unknown snapshot format/);
    broken((s) => { s.compression = 'zstd'; }, /compression/);
    broken((s) => { s.chunk_size = 100; }, /chunk size/);
    broken((s) => { s.uncompressed_size = 0; }, /stream size/);
    broken((s) => { s.chunks.pop(); }, /2 chunks do not cover/);
    broken((s) => { s.chunks[1].file = '../x.zz'; }, /chunk 1 is malformed/);
    broken((s) => { s.chunks[1].file = 'a b.zz'; }, /chunk 1 is malformed/);
    broken((s) => { s.chunks[2].sha256 = 'abc'; }, /chunk 2 is malformed/);
    broken((s) => { s.chunks[0].size = 0; }, /chunk 0 is malformed/);
    broken((s) => { s.argv = []; }, /arguments are missing/);
    broken((s) => { s.argv.push('-incoming', 'file:/x'); }, /already contain -incoming/);
    broken((s) => { delete s.query; }, /query/);
    broken((s) => { s.qemu_wasm_commit = 'f'.repeat(40); }, /different QEMU-Wasm commit/);
    broken((s) => { s.porty_patches_sha256 = sha('c'); }, /different set of QEMU patches/);
    broken((s) => { s.image_manifest_sha256 = sha('c'); }, /different Android image/);
    // a build that does not say what it is cannot vouch for any snapshot
    assert.equal(checkSnapshot(snapshot(), { qemu_wasm_commit: build.qemu_wasm_commit }).length, 2);
}

// --- a resume runs the snapshot's machine, on any device ---------------------------
{
    const snap = snapshot();
    // A desktop whose own defaults are 1024/384/64 gets the snapshot's 768/128/16.
    const env = { userAgent: MAC };
    const user = parseConfig('?serial=1&fps=12&jitcap=2000', env);
    const desktop = snapshotConfig(snap, user, env);
    assert.deepEqual(desktop.problems, []);
    assert.deepEqual([desktop.cfg.mem, desktop.cfg.tb, desktop.cfg.cache], [768, 128, 16]);
    assert.deepEqual([desktop.cfg.serial, desktop.cfg.fps, desktop.cfg.jitcap, desktop.cfg.mobile],
        [true, 12, 2000, false], 'page settings stay the visitor\'s');
    assert.equal(desktop.cfg.memoryExplicit, true);
    assert.equal(desktop.cfg.resume, true);

    // An iPhone that had stepped down to 640 MiB still resumes with 768.
    const phoneEnv = { userAgent: IPHONE };
    const phoneUser = { ...parseConfig('', phoneEnv), mem: 640, tb: 96, cache: 12, phoneLevel: 1 };
    const phone = snapshotConfig(snap, phoneUser, phoneEnv);
    assert.deepEqual(phone.problems, []);
    assert.deepEqual([phone.cfg.mem, phone.cfg.tb, phone.cfg.cache, phone.cfg.jitcap, phone.cfg.mobile],
        [768, 128, 16, 4000, true]);
    assert.equal(phone.cfg.phoneLevel, undefined);
    assert.equal(requiredWasmMemoryMb(phone.cfg), 1280);

    // The arguments decide, not the query (they are what QEMU gets).
    const odd = snapshot();
    odd.query = 'mem=640';
    assert.equal(snapshotConfig(odd, user, env).cfg.mem, 768);

    // Settings that shape what the page hands QEMU (the initrd's boot-diet
    // archive, time dilation) are the snapshot's, never the visitor's.
    const dilated = snapshot();
    dilated.query = `${QUERY}&diet=0&timescale=4`;
    dilated.argv = buildQemuArgs(parseConfig(`?${dilated.query}`, {}), imageManifest, savedPaths);
    const visitor = parseConfig('?diet=2&timescale=2&props=a.b=c', env);
    const kept = snapshotConfig(dilated, visitor, env).cfg;
    assert.deepEqual([kept.diet, kept.timescale, kept.props], [0, 4, []]);
    const rtc = snapshotArgs(dilated, pagePaths, '/i');
    assert.equal(rtc[rtc.indexOf('-rtc') + 1], 'base=utc,clock=vm', 'the saved -rtc is passed on');
    assert.deepEqual(rtc.slice(0, -2), buildQemuArgs(kept, imageManifest, pagePaths));
    assert.match(resumeVeto({ search: '?timescale=2' }), /sets timescale=/);
    assert.match(resumeVeto({ search: '?diet=0' }), /sets diet=/);
    // ttm.ko fixed or not is decided when the saved machine boots.
    assert.match(resumeVeto({ search: '?ttmfix=0' }), /sets ttmfix=/);
    assert.match(resumeVeto({ search: '?sffix=0' }), /sets sffix=/);
    assert.match(resumeVeto({ search: '?anrtraces=1' }), /sets anrtraces=/);

    // A desktop-sized snapshot is not for phones.
    const big = snapshot();
    big.query = 'mem=1024&tb=384&cache=64';
    big.argv = buildQemuArgs(parseConfig(`?${big.query}`, {}), imageManifest, savedPaths);
    assert.deepEqual(snapshotConfig(big, user, env).problems, []);
    assert.match(snapshotConfig(big, phoneUser, phoneEnv).problems.join(), /needs 1920 MiB of memory, more than the 1280 MiB a phone gets/);

    const noMem = snapshot();
    noMem.argv = noMem.argv.filter((a, i, all) => a !== '-m' && all[i - 1] !== '-m');
    assert.match(snapshotConfig(noMem, user, env).problems.join(), /no "-m/);
}

// --- argv: the snapshot's own, with this page's paths, plus -incoming -----------------
{
    const snap = snapshot();
    const args = snapshotArgs(snap, pagePaths, '/img/snapshot.idx');
    // Exactly what the page would build itself for that configuration...
    const own = buildQemuArgs(parseConfig(`?${QUERY}`, { userAgent: 'node' }), imageManifest, pagePaths);
    assert.deepEqual(args.slice(0, -2), own);
    // ...followed by the stream.
    assert.deepEqual(args.slice(-2), ['-incoming', 'porty:/img/snapshot.idx']);
    assert.ok(!args.join(' ').includes('/work/'), 'no path of the saving machine is left');
    assert.ok(args.some((a) => a.includes('file.url=https://example.test/porty/a,,b/image/system,')), 'commas in the URL are escaped');
    assert.equal(args[args.indexOf('-m') + 1], '768M');
    assert.equal(args[args.indexOf('-append') + 1], snap.argv[snap.argv.indexOf('-append') + 1],
        'the kernel command line is the saved one');
    assert.deepEqual(snap.argv, snapshot().argv, 'the manifest is not modified');

    // Arguments the page does not know are passed through untouched.
    const extra = snapshot();
    extra.argv.push('-rtc', 'base=2026-11-16,clock=vm', '-drive', 'if=none,id=x,file.driver=null-co,file.size=1M');
    const more = snapshotArgs(extra, pagePaths, '/i');
    assert.ok(more.includes('base=2026-11-16,clock=vm'));
    assert.ok(more.includes('if=none,id=x,file.driver=null-co,file.size=1M'));
}

// --- the chunk index QEMU reads ---------------------------------------------------------
{
    const snap = snapshot();
    assert.equal(snapshotIndex(snap, 'https://example.test/porty/snapshot', true), [
        'porty-snapshot 1',
        'url https://example.test/porty/snapshot',
        'chunk-size 4194304',
        `size ${2 * 4194304 + 5}`,
        `chunk 1000 ${sha('1')} 000000.zz?v=${'1'.repeat(16)}`,
        `chunk 2000 ${sha('2')} 000001.zz?v=${'2'.repeat(16)}`,
        `chunk 30 ${sha('3')} 000002.zz?v=${'3'.repeat(16)}`,
        '',
    ].join('\n'));
    // The page also names the snapshot ("&s="), for the disk cache.
    const tagged = snapshotIndex(snap, 'https://example.test/porty/snapshot', 'abcdef0123456789');
    assert.ok(tagged.includes(`chunk 30 ${sha('3')} 000002.zz?v=${'3'.repeat(16)}&s=abcdef0123456789\n`));
    assert.ok(!snapshotIndex(snap, 'https://example.test/s', 'not hex').includes('&s='));
    // Natively the chunks sit next to the index and have plain names.
    const local = snapshotIndex(snap);
    assert.ok(!local.includes('url ') && local.includes(`chunk 30 ${sha('3')} 000002.zz\n`));
    assert.throws(() => snapshotIndex(snap, 'https://example.test/a b'), /white space/);
}

// --- progress ----------------------------------------------------------------------------------
{
    const stats = readSnapshotStats(Uint32Array.from([SNAP_LOADING, 80, 20, 51200, 204800, 81920, 327680, 1]));
    assert.deepEqual([stats.state, stats.chunksTotal, stats.chunksFetched], [SNAP_LOADING, 80, 20]);
    assert.equal(stats.progress, 0.25);
    assert.equal(describeResume(stats), '50 of 200 MB downloaded, 1 download retries');
    assert.equal(readSnapshotStats(new Uint32Array(8)).progress, 0, 'nothing yet: no division by zero');
}

console.log('snapshot: all checks passed');
