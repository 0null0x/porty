// node tests/cpu-probe.test.mjs
// The launch probe's CPU accounting (tests/boot/cpu-probe.mjs): the parser,
// the differences, and the shell function itself, run by this machine's
// sh and bash against its own /proc (Linux only; skipped elsewhere).
// SPDX-License-Identifier: GPL-2.0-or-later
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { PCPU_FUNCTION, THREAD_PROCS, cpuDelta, describeCpu, parseCpuLine } from './boot/cpu-probe.mjs';

// --- parser -------------------------------------------------------------------
{
    const store = new Map();
    assert.equal(parseCpuLine('CPS|before|1234.56|cpu  100 5 50 1000 10 1 2 0 0 0|000002e5', store, 1000), true);
    assert.equal(parseCpuLine('CP|before|1|init|30', store), true);
    assert.equal(parseCpuLine('CP|before|1138|surfaceflinger|5000', store), true);
    assert.equal(parseCpuLine('CP|before|2000|Jit thread pool|7', store), true, 'names with spaces');
    assert.equal(parseCpuLine('CT|before|1138|1138|surfaceflinger|4900|-8|1', store), true);
    assert.equal(parseCpuLine('CPE|before|2', store), true);
    // The shell's echo of the typed function is not output.
    assert.equal(parseCpuLine('console:/ # pcpu() { t=$1; echo "CPS|$t|$(cut -d\' \' -f1 /proc/uptime)', store), false);
    assert.equal(parseCpuLine('echo "CP|$t|${l%% *}|$c|$((${12}+${13}))"; done', store), false);
    assert.equal(parseCpuLine('CPE|$t|$((1+1))', store), false);
    assert.equal(parseCpuLine('echo "CPE|$t|$((1+1))|$$|$u|$s"; }', store), false);
    assert.equal(parseCpuLine('serial| something else', store), false);
    const s = store.get('before');
    assert.equal(s.done, true);
    assert.equal(s.uptime, 1234.56);
    assert.deepEqual(s.stat, [100, 5, 50, 1000, 10, 1, 2, 0, 0, 0]);
    assert.equal(s.frames, 0x2e5);
    assert.equal(s.procs.size, 3);
    assert.deepEqual(s.threads.get(1138), { pid: 1138, comm: 'surfaceflinger', ticks: 4900, nice: -8, policy: 1 });
    assert.equal(s.self, undefined, 'an end marker without the shell\'s pid');
    // The end marker with the shell's pid, uptime and /proc/stat at the end.
    assert.equal(parseCpuLine('CPE|after|2|1157|1250.75|cpu  130 5 60 1010 10 1 2 0 0 0', store, 9000), true);
    const e = store.get('after');
    assert.equal(e.done, true);
    assert.equal(e.self, 1157);
    assert.equal(e.endUptime, 1250.75);
    assert.equal(e.endAt, 9000);
    assert.deepEqual(e.endStat, [130, 5, 60, 1010, 10, 1, 2, 0, 0, 0]);
    // No frame count (service missing): -1.
    parseCpuLine('CPS|x|1.0|cpu  1 2 3 4 5 6 7 8|', store);
    assert.equal(store.get('x').frames, -1);
}

// --- differences --------------------------------------------------------------
{
    const store = new Map();
    for (const line of [
        'CPS|a|100.0|cpu  1000 0 500 3000 0 0 0 0 0 0|00000064',
        'CP|a|1138|surfaceflinger|800', 'CP|a|900|system_server|400', 'CP|a|50|gone|10', 'CP|a|77|kworker/0:1-events|5',
        'CT|a|1138|1138|surfaceflinger|700|-8|1', 'CT|a|1138|1139|DispSync|50|-8|1',
        'CPE|a|2',
        'CPS|b|110.0|cpu  1600 0 700 3100 0 0 0 0 0 0|00000078',
        'CP|b|1138|surfaceflinger|1200', 'CP|b|900|system_server|450', 'CP|b|3000|com.android.gallery3d|200',
        'CP|b|77|kworker/0:1-mm_percpu_wq|9',
        'CT|b|1138|1138|surfaceflinger|1080|-8|1', 'CT|b|1138|1139|DispSync|60|-8|1', 'CT|b|3000|3001|RenderThread|150|-4|0',
        'CPE|b|2',
    ]) {
        assert.equal(parseCpuLine(line, store, line.startsWith('CPS|b') ? 31000 : 1000), true, line);
    }
    const d = cpuDelta(store.get('a'), store.get('b'));
    assert.equal(d.total, 900);
    assert.equal(d.busy, 800);
    assert.equal(d.idle, 100);
    assert.equal(d.user, 600);
    assert.equal(d.system, 200);
    assert.equal(d.frames, 0x14);
    assert.equal(d.guestSeconds, 10);
    assert.equal(d.wallSeconds, 30);
    assert.deepEqual(d.procs.map((p) => [p.comm, p.ticks, p.isNew]), [
        ['surfaceflinger', 400, false], ['com.android.gallery3d', 200, true], ['system_server', 50, false],
        ['kworker/0:1-mm_percpu_wq', 9, true],
    ]);
    assert.equal(d.uncounted, 800 - 659);
    assert.deepEqual(d.threads.map((t) => [t.proc, t.comm, t.ticks, t.policy]), [
        ['surfaceflinger', 'surfaceflinger', 380, 1], ['com.android.gallery3d', 'RenderThread', 150, 0],
        ['surfaceflinger', 'DispSync', 10, 1],
    ]);
    const text = describeCpu(d, 2);
    assert.match(text, /^800 busy of 900 ticks \(10 guest s, 30 s\), user 600 system 200, sf frames 20; /);
    assert.match(text, /surfaceflinger 400 \(50%\), com\.android\.gallery3d\* 200 \(25%\)/);
    assert.equal(cpuDelta(null, store.get('b')), null);
    assert.equal(describeCpu(null), 'no CPU data');
}
{
    // The snapshots' own work (in the shell, pid 1157) falls between CPS and
    // CPE of each: the difference spans from a's CPE to b's CPS, and the
    // shell's ticks are reported apart.
    const store = new Map();
    for (const [line, at] of [
        ['CPS|a|100.0|cpu  1000 0 500 3000 0 0 0 0 0 0|', 1000],
        ['CP|a|1138|surfaceflinger|800', 1000], ['CP|a|1157|sh|100', 1000],
        ['CPE|a|2|1157|105.0|cpu  1400 0 600 3000 0 0 0 0 0 0', 41000],
        ['CPS|b|115.0|cpu  2200 0 700 3100 0 0 0 0 0 0|', 121000],
        ['CP|b|1138|surfaceflinger|1300', 121000], ['CP|b|1157|sh|600', 121000], ['CP|b|3000|droid.gallery3d|150', 121000],
        ['CPE|b|2|1157|120.0|cpu  2600 0 800 3100 0 0 0 0 0 0', 161000],
    ]) {
        assert.equal(parseCpuLine(line, store, at), true, line);
    }
    const d = cpuDelta(store.get('a'), store.get('b'));
    assert.equal(d.total, 1000, 'from the end of a (1400+600+3000) to the start of b (2200+700+3100)');
    assert.equal(d.busy, 900);
    assert.equal(d.guestSeconds, 10);
    assert.equal(d.wallSeconds, 80);
    assert.equal(d.probeTicks, 500);
    assert.deepEqual(d.procs.map((p) => [p.comm, p.ticks]), [['surfaceflinger', 500], ['droid.gallery3d', 150]]);
    assert.equal(d.uncounted, 900 - 650);
    assert.match(describeCpu(d), /surfaceflinger 500 \(55\.6%\), droid\.gallery3d\* 150 \(16\.7%\).*; the probe's own shell 500 more \(its snapshots, not counted\)$/);
}

// --- the shell function on this machine --------------------------------------
if (existsSync('/proc/self/stat') && existsSync('/proc/stat')) {
    for (const shell of ['sh', 'bash']) {
        let out;
        try {
            // pid 1 stands in for surfaceflinger, to exercise the thread loop.
            const comm = readFileSync('/proc/1/comm', 'utf8').trim();
            assert.ok(PCPU_FUNCTION.includes(`case $c in ${THREAD_PROCS.join('|')})`));
            const fn = PCPU_FUNCTION.replace(`case $c in ${THREAD_PROCS[0]}|`, `case $c in ${comm}|`);
            out = execFileSync(shell, ['-c', `${fn}\npcpu t1 threads frames`], { encoding: 'utf8' });
        } catch (e) {
            console.log(`cpu-probe: ${shell} not usable here (${e.message.split('\n')[0]}), skipped`);
            continue;
        }
        const store = new Map();
        const lines = out.split('\n').filter(Boolean);
        for (const line of lines) {
            assert.equal(parseCpuLine(line, store), true, `${shell}: unparsed line ${JSON.stringify(line)}`);
        }
        const s = store.get('t1');
        assert.ok(s && s.done, `${shell}: end marker`);
        assert.ok(Number.isInteger(s.self) && s.self > 1, `${shell}: the shell's pid in the end marker`);
        assert.ok(s.endStat && s.endStat.length >= 8 && s.endUptime > 0, `${shell}: /proc/stat and uptime at the end`);
        assert.ok(s.endStat[0] >= s.stat[0], `${shell}: the end comes after the start`);
        assert.ok(s.stat.length >= 8, `${shell}: /proc/stat`);
        assert.ok(s.procs.size >= 2, `${shell}: processes`);
        assert.ok(s.procs.has(1), `${shell}: pid 1`);
        assert.ok([...s.threads.values()].some((t) => t.pid === 1), `${shell}: threads of pid 1`);
    }
}

console.log('cpu-probe tests passed');
