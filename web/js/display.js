// Blits QEMU's framebuffer from the shared WebAssembly memory to a canvas.
//
// ui/wasmfb.c (see patches/qemu-wasm/0001-*.patch) publishes a description
// of the current DisplaySurface; porty_fb_poll() returns the address of a
// 16 x uint32 snapshot of it and clears the accumulated dirty rectangle.
// Pixels are PIXMAN_x8r8g8b8: little-endian 0xXXRRGGBB words, i.e. B, G, R,
// X bytes.  Canvas ImageData wants R, G, B, A bytes, i.e. 0xAABBGGRR words.
// ImageData cannot wrap a SharedArrayBuffer, so one copy is unavoidable;
// this loop is that copy and the format conversion in a single pass.
// SPDX-License-Identifier: GPL-2.0-or-later

const FB_MAGIC = 0x31424650; // "PFB1"
const F = {
    MAGIC: 0, GEN: 1, DATA: 2, WIDTH: 3, HEIGHT: 4, STRIDE: 5, FORMAT: 6,
    BPP: 7, FRAME: 8, X0: 9, Y0: 10, X1: 11, Y1: 12, REFRESHES: 13,
    RUNNING: 14,
};
const FULL_REFRESH_MS = 1000;

export class Display {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {WebAssembly.Memory} memory
     * @param {() => number} poll  the wasm export porty_fb_poll
     */
    constructor(canvas, memory, poll) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
        this.memory = memory;
        this.poll = poll;
        this.gen = -1;
        this.image = null;
        this.out = null;
        this.width = 0;
        this.height = 0;
        this.lastFull = 0;
        this.frames = 0;
        this.heartbeat = 0;
        this.running = true;
        this.onResize = null;
    }

    /** Draw whatever changed.  Returns true when something was drawn. */
    update(now) {
        const buffer = this.memory.buffer;
        const info = new Uint32Array(buffer, this.poll() >>> 0, 16);
        if (info[F.MAGIC] !== FB_MAGIC) {
            return false;
        }
        this.heartbeat = info[F.REFRESHES];
        this.running = info[F.RUNNING] !== 0;

        const data = info[F.DATA];
        const width = info[F.WIDTH];
        const height = info[F.HEIGHT];
        const stride = info[F.STRIDE];
        if (!data || !width || !height || info[F.BPP] !== 32 ||
            width > 8192 || height > 8192 || stride < width * 4 ||
            data + stride * height > buffer.byteLength) {
            return false;
        }

        let x0 = info[F.X0];
        let y0 = info[F.Y0];
        let x1 = Math.min(info[F.X1], width);
        let y1 = Math.min(info[F.Y1], height);

        const resized = width !== this.width || height !== this.height;
        if (resized) {
            this.width = width;
            this.height = height;
            this.canvas.width = width;
            this.canvas.height = height;
            this.image = this.ctx.createImageData(width, height);
            this.out = new Uint32Array(this.image.data.buffer);
            if (this.onResize) {
                this.onResize(width, height);
            }
        }
        // A new surface, or the periodic safety net against torn reads
        // (the guest may be drawing while we copy): repaint everything.
        if (resized || info[F.GEN] !== this.gen || now - this.lastFull > FULL_REFRESH_MS) {
            this.gen = info[F.GEN];
            this.lastFull = now;
            x0 = 0;
            y0 = 0;
            x1 = width;
            y1 = height;
        }
        if (x1 <= x0 || y1 <= y0) {
            return false;
        }

        const out = this.out;
        if ((data & 3) === 0 && (stride & 3) === 0) {
            const words = stride >>> 2;
            const src = new Uint32Array(buffer, data, words * height);
            for (let y = y0; y < y1; y++) {
                let s = y * words + x0;
                let d = y * width + x0;
                for (let x = x0; x < x1; x++) {
                    const v = src[s++];
                    out[d++] = 0xff000000 | ((v & 0xff) << 16) | (v & 0xff00) | ((v >>> 16) & 0xff);
                }
            }
        } else {
            const src = new Uint8Array(buffer, data, stride * height);
            for (let y = y0; y < y1; y++) {
                let s = y * stride + x0 * 4;
                let d = y * width + x0;
                for (let x = x0; x < x1; x++, s += 4) {
                    out[d++] = 0xff000000 | (src[s] << 16) | (src[s + 1] << 8) | src[s + 2];
                }
            }
        }
        this.ctx.putImageData(this.image, 0, 0, x0, y0, x1 - x0, y1 - y0);
        this.frames++;
        return true;
    }
}
