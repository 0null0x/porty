// Remembers how far the current start got, so that the next visit can tell
// that it never finished.  iOS kills a Safari tab that uses too much memory
// and Safari then simply reloads it ("This webpage was reloaded because a
// problem occurred"), so the page itself never sees an error.  On phones the
// next start then uses less memory (config.js, PHONE_LEVELS).
// No DOM here: storage is passed in, so tests can use a Map.
// SPDX-License-Identifier: GPL-2.0-or-later

export const RUN_KEY = 'porty.run';
export const LEVEL_KEY = 'porty.phoneLevel';
// An unfinished run older than this is not worth mentioning.
const STALE_MS = 12 * 3600 * 1000;

/** localStorage, or null where it is missing or throws (private modes). */
export function browserStorage(env = globalThis) {
    try {
        const s = env.localStorage;
        const probe = '__porty_probe';
        s.setItem(probe, '1');
        s.removeItem(probe);
        return s;
    } catch (e) {
        return null;
    }
}

export class RunLog {
    /**
     * @param {{getItem(k: string): string|null, setItem(k: string, v: string): void}|null} storage
     * @param {() => number} now
     */
    constructor(storage, now = () => Date.now()) {
        this.storage = storage;
        this.now = now;
        this.run = null;
    }

    read(key) {
        try {
            const raw = this.storage && this.storage.getItem(key);
            return raw ? JSON.parse(raw) : null;
        } catch (e) {
            return null;
        }
    }

    write(key, value) {
        try {
            if (this.storage) {
                this.storage.setItem(key, JSON.stringify(value));
            }
        } catch (e) {
            // A full quota loses the breadcrumb, never the run.
        }
    }

    /** The previous start if it neither ended nor went stale, else null. */
    interrupted() {
        const run = this.read(RUN_KEY);
        if (!run || typeof run !== 'object' || run.ended || !run.startedAt) {
            return null;
        }
        if (this.now() - (run.updatedAt || run.startedAt) > STALE_MS) {
            return null;
        }
        return run;
    }

    /** Mark a run found by interrupted() as seen, so it is reported once. */
    acknowledge(run) {
        this.write(RUN_KEY, { ...run, ended: 'killed' });
    }

    /** Phone memory level the next start should use (0 = defaults). */
    level() {
        const v = this.read(LEVEL_KEY);
        return Number.isInteger(v) && v > 0 ? v : 0;
    }

    setLevel(v) {
        this.write(LEVEL_KEY, Math.max(0, Math.floor(v) || 0));
    }

    begin(info) {
        const t = this.now();
        this.run = { ...info, startedAt: t, updatedAt: t, ended: false };
        this.write(RUN_KEY, this.run);
    }

    update(patch) {
        if (!this.run || this.run.ended) {
            return;
        }
        Object.assign(this.run, patch, { updatedAt: this.now() });
        this.write(RUN_KEY, this.run);
    }

    /** The start ended in a way the page saw: failed, powered off, left. */
    end(reason) {
        if (!this.run || this.run.ended) {
            return;
        }
        this.run.ended = reason;
        this.run.updatedAt = this.now();
        this.write(RUN_KEY, this.run);
    }

    /** The page came back from the back/forward cache: the run goes on. */
    resume() {
        if (this.run && this.run.ended === 'left') {
            this.run.ended = false;
            this.update({});
        }
    }
}

/**
 * What to do about an interrupted run: the level the next start uses and
 * whether that is a step down.  A run killed while the page was hidden says
 * little about memory (iOS reclaims background tabs freely), so it does not
 * step down.
 */
export function nextLevel(run, storedLevel, maxLevel) {
    if (!run || run.hidden) {
        return { level: storedLevel, stepped: false };
    }
    const ran = Number.isInteger(run.level) ? run.level : 0;
    const level = Math.min(maxLevel, Math.max(storedLevel, ran + 1));
    return { level, stepped: level > ran };
}

/** One line for people: how far the interrupted run got. */
export function describeRun(run) {
    const mins = Math.max(0, Math.round(((run.updatedAt || run.startedAt) - run.startedAt) / 60000));
    const parts = [`after ${mins < 1 ? 'less than a minute' : `${mins} min`}`];
    if (run.stage) {
        parts.push(`at "${run.stage}"`);
    }
    const mem = [];
    if (run.mem) {
        mem.push(`${run.mem} MB guest RAM`);
    }
    if (run.wasmMb) {
        mem.push(`${run.wasmMb} MB WebAssembly memory` + (run.heapUsed ? ` (${run.heapUsed} MB in use)` : ''));
    }
    if (mem.length) {
        parts.push(`with ${mem.join(', ')}`);
    }
    if (run.diskMb) {
        parts.push(`${run.diskMb} MB of the system image read`);
    }
    return parts.join(', ');
}
