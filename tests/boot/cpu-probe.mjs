// Where the guest's CPU goes: a shell function typed into Android's root
// shell, the parser of its output and the differences between two of its
// snapshots.  Used by the launch probe of tests/boot/boot-test.mjs and by
// tests/cpu-probe.test.mjs.  Pure functions (no browser).
//
// pcpu <tag> [threads] prints, from /proc alone (no logd, no
// system_server, which may not answer during a launch):
//   CPS|tag|uptime|cpu line of /proc/stat|surfaceflinger's frame count
//   CP|tag|pid|comm|user+system ticks           one per process
//   CT|tag|pid|tid|comm|ticks|nice|policy        with "threads": one per
//                                                thread of THREAD_PROCS
//   CPE|tag|2|shell pid|uptime|cpu line of /proc/stat   the end
// The frame count is surfaceflinger's transaction 1013, the display's page
// flip count: one per composed frame.  Ticks are 1/100 s of the guest's own
// (dilated) time.  mksh (Android's /system/bin/sh), also bash and dash.
//
// A snapshot itself takes the guest seconds (in the browser, 10-50 s of
// wall time), all of them in the shell that runs it.  So the difference of
// two snapshots spans from the end of the first (CPE's /proc/stat) to the
// start of the second (CPS's), and the shell that ran them is reported on
// its own (probeTicks), not as a process of the guest: its ticks are mostly
// its own snapshots, read at points that do not line up with that span.
// SPDX-License-Identifier: GPL-2.0-or-later

// The processes whose threads are listed, by their /proc comm (the last 15
// characters of an app's process name).
export const THREAD_PROCS = ['surfaceflinger', 'system_server', 'ndroid.systemui',
    'droid.launcher3', 'droid.gallery3d'];

const STAT = 'read -r l < $f || continue; c=${l#*\\(}; c=${c%%\\)*}; set -- ${l##*\\) }; ';

// No pidof (toybox reads every /proc/<pid>/cmdline, which waits for the
// mmap lock of each process) and no binder call unless asked for
// ("frames": surfaceflinger's transaction 1013, which checks a permission
// with system_server; during a launch in the browser that held the shell
// for minutes).
export const PCPU_FUNCTION = [
    'pcpu() { t=$1; w=$2; q=$3; n=; ',
    'echo "CPS|$t|$(cut -d\' \' -f1 /proc/uptime)|$(head -1 /proc/stat)|',
    '$([ "$q" = frames ] && timeout 10 service call SurfaceFlinger 1013 2>/dev/null | sed -n \'s/.*Parcel(\\([0-9a-f]*\\).*/\\1/p\' | head -1)"; ',
    'for f in /proc/[0-9]*/stat; do ', STAT, 'echo "CP|$t|${l%% *}|$c|$((${12}+${13}))"; ',
    `case $c in ${THREAD_PROCS.join('|')}) n="$n \${l%% *}";; esac; `,
    'done 2>/dev/null; ',
    'if [ "$w" = threads ]; then for p in $n; do for f in /proc/$p/task/[0-9]*/stat; do ', STAT,
    'echo "CT|$t|$p|${l%% *}|$c|$((${12}+${13}))|${17}|${39}"; done; done 2>/dev/null; fi; ',
    'read -r u x < /proc/uptime; read -r s < /proc/stat; echo "CPE|$t|$((1+1))|$$|$u|$s"; }',
].join('');

/** Parse one line of pcpu output into `store` (tag -> snapshot); false if it is none. */
export function parseCpuLine(line, store, now = Date.now()) {
    const get = (tag) => {
        if (!store.has(tag)) {
            store.set(tag, { tag, at: now, procs: new Map(), threads: new Map(), done: false });
        }
        return store.get(tag);
    };
    // Output lines only: the shell's echo of the typed function has "$t".
    let m = /^CPS\|([a-z0-9]+)\|([\d.]+)\|cpu\s+([\d ]+)\|([0-9a-f]*)\s*$/.exec(line);
    if (m) {
        const s = get(m[1]);
        s.at = now;
        s.uptime = Number(m[2]);
        s.stat = m[3].trim().split(/\s+/).map(Number);
        s.frames = m[4] ? Number.parseInt(m[4], 16) : -1;
        return true;
    }
    m = /^CP\|([a-z0-9]+)\|(\d+)\|(.*)\|(\d+)\s*$/.exec(line);
    if (m) {
        get(m[1]).procs.set(Number(m[2]), { comm: m[3], ticks: Number(m[4]) });
        return true;
    }
    m = /^CT\|([a-z0-9]+)\|(\d+)\|(\d+)\|(.*)\|(\d+)\|(-?\d+)\|(\d+)\s*$/.exec(line);
    if (m) {
        get(m[1]).threads.set(Number(m[3]), {
            pid: Number(m[2]), comm: m[4], ticks: Number(m[5]), nice: Number(m[6]), policy: Number(m[7]),
        });
        return true;
    }
    m = /^CPE\|([a-z0-9]+)\|2(?:\|(\d+)\|([\d.]+)\|cpu\s+([\d ]+))?\s*$/.exec(line);
    if (m) {
        const s = get(m[1]);
        s.done = true;
        if (m[2]) {
            s.self = Number(m[2]);
            s.endAt = now;
            s.endUptime = Number(m[3]);
            s.endStat = m[4].trim().split(/\s+/).map(Number);
        }
        return true;
    }
    return false;
}

/**
 * The difference between two pcpu snapshots: the guest's ticks by kind
 * (/proc/stat, from the end of `a` to the start of `b`), by process and by
 * thread (largest first), and surfaceflinger's frames.  A pid whose name
 * changed counts as new.  The shell that ran the snapshots is not among the
 * processes: its ticks are probeTicks.
 */
export function cpuDelta(a, b) {
    if (!a || !b || !a.stat || !b.stat) {
        return null;
    }
    const from = a.endStat || a.stat;
    const st = b.stat.map((v, i) => v - (from[i] || 0));
    const probe = new Set([a.self, b.self].filter((pid) => pid !== undefined));
    let probeTicks = 0;
    // user nice system idle iowait irq softirq steal
    const total = st.slice(0, 8).reduce((x, y) => x + y, 0);
    const idle = (st[3] || 0) + (st[4] || 0);
    const busy = total - idle;
    const procs = [];
    for (const [pid, p] of b.procs) {
        const before = a.procs.get(pid);
        const same = before && before.comm === p.comm;
        const d = p.ticks - (same ? before.ticks : 0);
        if (probe.has(pid)) {
            probeTicks += Math.max(0, d);
        } else if (d > 0) {
            procs.push({ pid, comm: p.comm, ticks: d, isNew: !same });
        }
    }
    procs.sort((x, y) => y.ticks - x.ticks);
    const threads = [];
    for (const [tid, t] of b.threads) {
        const before = a.threads.get(tid);
        const d = t.ticks - (before && before.comm === t.comm ? before.ticks : 0);
        if (d > 0) {
            threads.push({
                tid, pid: t.pid, proc: (b.procs.get(t.pid) || {}).comm || '?',
                comm: t.comm, ticks: d, nice: t.nice, policy: t.policy,
            });
        }
    }
    threads.sort((x, y) => y.ticks - x.ticks);
    const counted = procs.reduce((s, p) => s + p.ticks, 0);
    return {
        guestSeconds: Math.round(((b.uptime || 0) - (a.endUptime || a.uptime || 0)) * 10) / 10,
        wallSeconds: Math.round((b.at - (a.endAt || a.at)) / 1000),
        total,
        busy,
        idle,
        user: (st[0] || 0) + (st[1] || 0),
        system: (st[2] || 0) + (st[5] || 0) + (st[6] || 0),
        // Processes that started and ended in between, and accounting slack.
        uncounted: Math.max(0, busy - counted),
        probeTicks,
        frames: a.frames >= 0 && b.frames >= 0 ? b.frames - a.frames : -1,
        procs,
        threads,
    };
}

/** One line: the busiest processes of a delta, with their share of the busy ticks. */
export function describeCpu(d, count = 8) {
    if (!d) {
        return 'no CPU data';
    }
    const pct = (v) => `${Math.round((1000 * v) / Math.max(1, d.busy)) / 10}%`;
    return `${d.busy} busy of ${d.total} ticks (${d.guestSeconds} guest s, ${d.wallSeconds} s), ` +
        `user ${d.user} system ${d.system}, sf frames ${d.frames}; ` +
        d.procs.slice(0, count).map((p) => `${p.comm}${p.isNew ? '*' : ''} ${p.ticks} (${pct(p.ticks)})`).join(', ') +
        (d.uncounted > 0 ? `, not in a listed process ${d.uncounted} (${pct(d.uncounted)})` : '') +
        (d.probeTicks > 0 ? `; the probe's own shell ${d.probeTicks} more (its snapshots, not counted)` : '');
}
