// Reads and rewrites the memory import of a WebAssembly binary.
//
// Emscripten (without ALLOW_MEMORY_GROWTH) links the module so that it
// imports a shared memory whose minimum and maximum are both the link-time
// TOTAL_MEMORY.  The browser refuses to instantiate the module with a
// memory of any other size.  Rewriting those two numbers lets one build run
// with whatever memory the device can actually provide, and nothing else in
// the module depends on them: Emscripten's JS glue takes the heap size from
// the WebAssembly.Memory it is handed (Module.wasmMemory), and malloc asks
// for the heap size at run time.
//
// Pure functions, no DOM.  SPDX-License-Identifier: GPL-2.0-or-later

export const WASM_PAGE = 65536;

function readLeb(bytes, pos) {
    let result = 0;
    let shift = 0;
    for (;;) {
        if (pos >= bytes.length) {
            throw new Error('wasm: truncated LEB128');
        }
        const byte = bytes[pos++];
        result += (byte & 0x7f) * 2 ** shift; // no 32-bit overflow
        if (!(byte & 0x80)) {
            return [result, pos];
        }
        shift += 7;
        if (shift > 35) {
            throw new Error('wasm: LEB128 too long');
        }
    }
}

function encodeLeb(value) {
    const out = [];
    do {
        let byte = value % 128;
        value = Math.floor(value / 128);
        if (value) {
            byte |= 0x80;
        }
        out.push(byte);
    } while (value);
    return out;
}

function readName(bytes, pos) {
    const [len, next] = readLeb(bytes, pos);
    return [new TextDecoder().decode(bytes.subarray(next, next + len)), next + len];
}

function readLimits(bytes, pos) {
    const start = pos;
    const flags = bytes[pos++];
    let min;
    let max = null;
    [min, pos] = readLeb(bytes, pos);
    if (flags & 0x01) {
        [max, pos] = readLeb(bytes, pos);
    }
    return [{ flags, min, max, start, end: pos }, pos];
}

/**
 * Locate the (single) memory import.
 * @param {Uint8Array} bytes
 * @returns {{module:string, field:string, flags:number, shared:boolean,
 *            min:number, max:number|null, start:number, end:number,
 *            sectionStart:number, bodyStart:number, bodyEnd:number}|null}
 */
export function findMemoryImport(bytes) {
    if (bytes.length < 8 || bytes[0] !== 0x00 || bytes[1] !== 0x61 ||
        bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
        throw new Error('wasm: bad magic');
    }
    let pos = 8;
    while (pos < bytes.length) {
        const sectionStart = pos;
        const id = bytes[pos++];
        let size;
        [size, pos] = readLeb(bytes, pos);
        const bodyStart = pos;
        const bodyEnd = pos + size;
        if (id === 2) {
            let count;
            [count, pos] = readLeb(bytes, pos);
            for (let i = 0; i < count; i++) {
                let module;
                let field;
                [module, pos] = readName(bytes, pos);
                [field, pos] = readName(bytes, pos);
                const kind = bytes[pos++];
                if (kind === 0) {            // function
                    [, pos] = readLeb(bytes, pos);
                } else if (kind === 1) {     // table
                    pos++;
                    [, pos] = readLimits(bytes, pos);
                } else if (kind === 2) {     // memory
                    const [limits] = readLimits(bytes, pos);
                    return {
                        module, field, ...limits,
                        shared: !!(limits.flags & 0x02),
                        sectionStart, bodyStart, bodyEnd,
                    };
                } else if (kind === 3) {     // global
                    pos += 2;
                } else if (kind === 4) {     // tag
                    pos++;
                    [, pos] = readLeb(bytes, pos);
                } else {
                    throw new Error(`wasm: unknown import kind ${kind}`);
                }
                if (pos > bodyEnd) {
                    throw new Error('wasm: import section overrun');
                }
            }
            return null;
        }
        if (id > 2) {
            return null; // sections are ordered; the import section is absent
        }
        pos = bodyEnd;
    }
    return null;
}

/**
 * Return a copy of the module whose memory import is exactly `pages` pages
 * (minimum == maximum).  Returns the input untouched when nothing changes.
 * @param {Uint8Array} bytes
 * @param {number} pages  64 KiB pages, 1..65536
 */
export function setMemoryImportPages(bytes, pages) {
    if (!Number.isInteger(pages) || pages < 1 || pages > 65536) {
        throw new Error(`wasm: invalid page count ${pages}`);
    }
    const imp = findMemoryImport(bytes);
    if (!imp) {
        throw new Error('wasm: the module does not import a memory');
    }
    if (imp.max === null) {
        throw new Error('wasm: the imported memory has no maximum');
    }
    if (imp.min === pages && imp.max === pages) {
        return bytes;
    }
    const limits = [imp.flags, ...encodeLeb(pages), ...encodeLeb(pages)];
    const bodyLen = (imp.bodyEnd - imp.bodyStart) - (imp.end - imp.start) + limits.length;
    const header = [2, ...encodeLeb(bodyLen)];
    const out = new Uint8Array(
        imp.sectionStart + header.length + bodyLen + (bytes.length - imp.bodyEnd));
    let pos = 0;
    out.set(bytes.subarray(0, imp.sectionStart), pos);
    pos += imp.sectionStart;
    out.set(header, pos);
    pos += header.length;
    out.set(bytes.subarray(imp.bodyStart, imp.start), pos);
    pos += imp.start - imp.bodyStart;
    out.set(limits, pos);
    pos += limits.length;
    out.set(bytes.subarray(imp.end, imp.bodyEnd), pos);
    pos += imp.bodyEnd - imp.end;
    out.set(bytes.subarray(imp.bodyEnd), pos);
    return out;
}
