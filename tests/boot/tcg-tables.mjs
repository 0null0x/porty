// QEMU patch 0018: how full the wasm32 backend's per-TB tables get.
// Module._porty_tcg_stats() points at 2 + 6 * 6 words: TBs built, TBs
// started over because a table was full, then for each table below the
// largest fill of a TB built, the table's size, its size before the patch,
// TBs that needed more than that (they overflowed it in the old build), TBs
// that needed more than half of it, and TBs started over because it was
// full.
// SPDX-License-Identifier: GPL-2.0-or-later

export const TCG_TABLES = ['types', 'helpers', 'labelIds', 'labels', 'branches', 'body'];
export const TCG_TABLE_WORDS = 2 + TCG_TABLES.length * 6;

/** Read in the page: the words, or null on a build without the patch. */
export function readTcgWords(e) {
    const m = e && e.module;
    if (!m || typeof m._porty_tcg_stats !== 'function' || !e.memory) {
        return null;
    }
    return Array.from(new Uint32Array(e.memory.buffer, m._porty_tcg_stats() >>> 0, 2 + 6 * 6));
}

/** {built, restarts, types: {max, size, before, over, half, restarts}, ...} */
export function tcgTables(words) {
    if (!Array.isArray(words) || words.length < TCG_TABLE_WORDS) {
        return null;
    }
    const out = { built: words[0], restarts: words[1] };
    TCG_TABLES.forEach((name, t) => {
        const [max, size, before, over, half, restarts] = words.slice(2 + 6 * t, 8 + 6 * t);
        out[name] = { max, size, before, over, half, restarts };
    });
    return out;
}

/** One line: "built 1234, restarted 0; types max 180 of 2032 (was 200: 3 over, 40 over half) ..." */
export function describeTcgTables(t) {
    if (!t) {
        return 'no statistics (a build without patch 0018)';
    }
    const parts = TCG_TABLES.map((name) => {
        const x = t[name];
        return `${name} max ${x.max} of ${x.size} (was ${x.before}: ${x.over} over, ${x.half} over half)` +
            (x.restarts ? `, ${x.restarts} restarts` : '');
    });
    return `built ${t.built}, restarted ${t.restarts}; ${parts.join('; ')}`;
}
