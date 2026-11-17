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
    assert.equal(parseCpuLine('serial| something else', store), false);
    const s = store.get('before');
    assert.equal(s.done, true);
    assert.equal(s.uptime, 1234.56);
    assert.deepEqual(s.stat, [100, 5, 50, 1000, 10, 1, 2, 0, 0, 0]);
    assert.equal(s.frames, 0x2e5);
    assert.equal(s.procs.size, 3);
    assert.deepEqual(s.threads.get(1138), { pid: 1138, comm: 'surfaceflinger', ticks: 4900, nice: -8, policy: 1 });
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
        assert.ok(s.stat.length >= 8, `${shell}: /proc/stat`);
        assert.ok(s.procs.size >= 2, `${shell}: processes`);
        assert.ok(s.procs.has(1), `${shell}: pid 1`);
        assert.ok([...s.threads.values()].some((t) => t.pid === 1), `${shell}: threads of pid 1`);
    }
}

console.log('cpu-probe tests passed');
