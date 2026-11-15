// node tests/wasm-patch.test.mjs
// Builds a real module that imports a shared memory, rewrites the limits
// with web/js/wasm-patch.js and checks that the engine agrees.
// SPDX-License-Identifier: GPL-2.0-or-later
import assert from 'node:assert/strict';
import { findMemoryImport, setMemoryImportPages } from '../web/js/wasm-patch.js';

const leb = (n) => { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; };
const str = (s) => [...leb(s.length), ...Buffer.from(s)];
const section = (id, body) => [id, ...leb(body.length), ...body];

function build(pages) {
    return new Uint8Array([
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
        // type: () -> i32
        ...section(1, [1, 0x60, 0, 1, 0x7f]),
        // imports: a function, a global, then the shared memory, then a table
        ...section(2, [4,
            ...str('env'), ...str('f'), 0x00, 0,
            ...str('env'), ...str('g'), 0x03, 0x7f, 0x00,
            ...str('env'), ...str('memory'), 0x02, 0x03, ...leb(pages), ...leb(pages),
            ...str('env'), ...str('t'), 0x01, 0x70, 0x00, 1,
        ]),
        ...section(3, [1, 0]),
        ...section(7, [1, ...str('size'), 0x00, 1]),
        // code: memory.size
        ...section(10, [1, 4, 0, 0x3f, 0x00, 0x0b]),
        // a trailing custom section must survive untouched
        ...section(0, [...str('porty'), 1, 2, 3]),
    ]);
}

function instantiate(bytes, pages) {
    const memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
    const env = {
        f: () => 0,
        g: new WebAssembly.Global({ value: 'i32', mutable: false }, 0),
        memory,
        t: new WebAssembly.Table({ element: 'anyfunc', initial: 1 }),
    };
    return new WebAssembly.Instance(new WebAssembly.Module(bytes), { env }).exports.size();
}

const BUILT = 2300 * 16; // 2300 MiB in pages, 3-byte LEB128
const original = build(BUILT);
const imp = findMemoryImport(original);
assert.deepEqual(
    { module: imp.module, field: imp.field, shared: imp.shared, min: imp.min, max: imp.max },
    { module: 'env', field: 'memory', shared: true, min: BUILT, max: BUILT });

// unchanged size: same object back
assert.equal(setMemoryImportPages(original, BUILT), original);

// 3-byte -> 3-byte, 3-byte -> 2-byte (below 1 GiB), 3-byte -> larger
for (const pages of [1536 * 16, 768 * 16, 100, 4032 * 16]) {
    const patched = setMemoryImportPages(original, pages);
    assert.notEqual(patched, original);
    assert.deepEqual(patched, build(pages), `patched module for ${pages} pages`);
    const seen = findMemoryImport(patched);
    assert.equal(seen.min, pages);
    assert.equal(seen.max, pages);
    assert.ok(WebAssembly.validate(patched));
}

// the engine accepts the patched module with a matching memory...
const small = setMemoryImportPages(original, 100);
assert.equal(instantiate(small, 100), 100);
// ...and rejects a memory that does not match the declared limits
assert.throws(() => instantiate(original, 100), WebAssembly.LinkError);

assert.throws(() => setMemoryImportPages(original, 0));
assert.throws(() => setMemoryImportPages(original, 65537));
assert.throws(() => findMemoryImport(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])));
console.log('wasm-patch: all checks passed');
