// A minimal writer (and reader, for tests) of "newc" cpio archives, the
// format of Linux initramfs images, and the rule for appending one archive
// to an initrd that already exists.
//
// Linux unpacks every archive in the initrd buffer in turn; they may be
// compressed or not, and NUL bytes between them are skipped
// (Documentation/early-userspace/buffer-format.txt: 'initramfs := ("\0" |
// cpio_archive | cpio_gzip_archive)*').  An uncompressed archive is only
// recognised at an offset that is a multiple of four (init/initramfs.c,
// unpack_to_rootfs: "*buf == '0' && !(this_header & 3)"), so the first
// archive is padded with NULs before the next one is appended.
// Pure functions (no DOM).
// SPDX-License-Identifier: GPL-2.0-or-later

const MAGIC = '070701';
const TRAILER = 'TRAILER!!!';
const HEADER_BYTES = 110; // magic + 13 fields of 8 hex digits

const pad4 = (n) => (n + 3) & ~3;
const hex8 = (n) => (n >>> 0).toString(16).toUpperCase().padStart(8, '0');

function toBytes(data) {
    return typeof data === 'string' ? new TextEncoder().encode(data) : data;
}

/**
 * @param {{name: string, mode: number, data?: Uint8Array|string}[]} entries
 *   name: path without a leading slash; mode: file type and permissions
 *   (0o100644 regular file, 0o040755 directory).  Parent directories that
 *   may be missing must be listed first.
 * @returns {Uint8Array} the archive with its trailer, a multiple of 4 bytes
 */
export function newcArchive(entries) {
    const parts = [];
    let ino = 0;
    const add = (name, mode, nlink, body) => {
        if (!/^[\x21-\x7e]+$/.test(name) || name.startsWith('/')) {
            throw new Error(`newcArchive: bad name ${JSON.stringify(name)}`);
        }
        const fields = [
            ino, mode, 0, 0, nlink, 0, body.length, // ino mode uid gid nlink mtime filesize
            0, 0, 0, 0,                             // devmajor devminor rdevmajor rdevminor
            name.length + 1, 0,                     // namesize (with the NUL), check
        ];
        const head = new TextEncoder().encode(MAGIC + fields.map(hex8).join('') + name);
        const out = new Uint8Array(pad4(head.length + 1) + pad4(body.length));
        out.set(head);
        out.set(body, pad4(head.length + 1));
        parts.push(out);
    };
    for (const entry of entries) {
        const dir = (entry.mode & 0o170000) === 0o040000;
        ino += 1;
        add(entry.name, entry.mode, dir ? 2 : 1, dir ? new Uint8Array(0) : toBytes(entry.data || ''));
    }
    ino = 0;
    add(TRAILER, 0, 1, new Uint8Array(0));
    return concat(parts);
}

function concat(parts) {
    const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
    let pos = 0;
    for (const part of parts) {
        out.set(part, pos);
        pos += part.length;
    }
    return out;
}

/**
 * Reads one uncompressed newc archive, the way the kernel does.
 * @returns {{entries: {name: string, mode: number, data: Uint8Array}[], end: number}}
 *   end: offset just past the trailer's padding
 */
export function parseNewc(bytes, start = 0) {
    const text = (from, to) => String.fromCharCode(...bytes.subarray(from, to));
    const entries = [];
    let pos = start;
    for (;;) {
        if (pos + HEADER_BYTES > bytes.length || text(pos, pos + 6) !== MAGIC) {
            throw new Error(`parseNewc: no newc header at offset ${pos}`);
        }
        const field = (i) => Number.parseInt(text(pos + 6 + i * 8, pos + 14 + i * 8), 16);
        const size = field(6);
        const nameSize = field(11);
        const dataAt = start + pad4(pos - start + HEADER_BYTES + nameSize);
        const next = start + pad4(dataAt - start + size);
        if (nameSize < 1 || next > bytes.length) {
            throw new Error(`parseNewc: truncated entry at offset ${pos}`);
        }
        const name = text(pos + HEADER_BYTES, pos + HEADER_BYTES + nameSize - 1);
        if (name === TRAILER) {
            return { entries, end: next };
        }
        entries.push({ name, mode: field(1), data: bytes.slice(dataAt, dataAt + size) });
        pos = next;
    }
}

/** Offset at which an archive appended to an initrd of this size starts. */
export function appendOffset(initrdBytes) {
    return pad4(initrdBytes);
}

/** initrd + NUL padding to a multiple of four + archive. */
export function appendInitramfs(initrd, archive) {
    const at = appendOffset(initrd.length);
    const out = new Uint8Array(at + archive.length);
    out.set(initrd);
    out.set(archive, at);
    return out;
}
