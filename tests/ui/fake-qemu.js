// A stand-in for QEMU-Wasm's Emscripten module (qemu/out.js), for testing
// and previewing the web UI without the real 1 GB build.
//
// It honours the same contract web/js/emulator.js relies on:
//   - default export: async factory(Module) -> instance
//   - Module.wasmMemory, Module.instantiateWasm, Module.preRun, Module.pty
//   - instance._porty_fb_poll / _porty_input_event / _porty_disk_stats
// and paints a test pattern into the shared memory in the exact layout
// ui/wasmfb.c publishes (PIXMAN_x8r8g8b8, i.e. B, G, R, X bytes).
// SPDX-License-Identifier: GPL-2.0-or-later

const INFO = 1 << 20;          // PortyFbInfo snapshot
const STATS = INFO + 256;      // PortyDiskStats
const FB = 2 << 20;            // pixels
const MAGIC = 0x31424650;

export default async function createFakeQemu(Module) {
    const memory = Module.wasmMemory;
    const args = Module.arguments || [];
    const globalArg = (name, fallback) => {
        const hit = args.find((a) => a.startsWith(`${name}=`));
        return hit ? Number(hit.split('=')[1]) : fallback;
    };
    const guestWidth = globalArg('VGA.xres', 480);
    const guestHeight = globalArg('VGA.yres', 800);

    // Compile the module the way Emscripten does: through the page's hook.
    await new Promise((resolve, reject) => {
        try {
            Module.instantiateWasm({ env: { memory } }, () => resolve());
        } catch (e) {
            reject(e);
        }
    });

    const files = new Map();
    const FS = {
        mkdir() {},
        writeFile(path, data) { files.set(path, data.length); },
    };
    for (const hook of Module.preRun || []) {
        hook({ FS });
    }

    // Emscripten with PROXY_TO_PTHREAD: callMain() hands main() to a pthread,
    // then exitJS(0, implicit) calls quit_(0) synchronously, before the
    // factory's promise resolves, while QEMU goes on running. The page must
    // not take that call for the virtual machine switching off.
    if (typeof Module.quit === 'function') {
        try {
            Module.quit(0, { name: 'ExitStatus', status: 0 });
        } catch (e) {
            // emulator.js rethrows the ExitStatus, as Emscripten's own quit_ does
        }
    }

    const u32 = new Uint32Array(memory.buffer);
    const u8 = new Uint8Array(memory.buffer);
    const events = [];
    const live = { gen: 0, width: 0, height: 0, frame: 0, x0: 0, y0: 0, x1: 0, y1: 0, refreshes: 0, running: 1 };

    const put = (x, y, r, g, b) => {
        const o = FB + (y * live.width + x) * 4;
        u8[o] = b; u8[o + 1] = g; u8[o + 2] = r; u8[o + 3] = 0;
    };
    const fill = (x0, y0, x1, y1, r, g, b) => {
        for (let y = Math.max(0, y0); y < Math.min(live.height, y1); y++) {
            for (let x = Math.max(0, x0); x < Math.min(live.width, x1); x++) {
                put(x, y, r, g, b);
            }
        }
        live.x0 = Math.min(live.x0, Math.max(0, x0));
        live.y0 = Math.min(live.y0, Math.max(0, y0));
        live.x1 = Math.max(live.x1, Math.min(live.width, x1));
        live.y1 = Math.max(live.y1, Math.min(live.height, y1));
        live.frame++;
    };
    const setMode = (w, h) => {
        live.width = w;
        live.height = h;
        live.gen++;
        live.x0 = 0x7fffffff; live.y0 = 0x7fffffff; live.x1 = 0; live.y1 = 0;
        // four quadrants: red, green / blue, white
        fill(0, 0, w >> 1, h >> 1, 255, 0, 0);
        fill(w >> 1, 0, w, h >> 1, 0, 255, 0);
        fill(0, h >> 1, w >> 1, h, 0, 0, 255);
        fill(w >> 1, h >> 1, w, h, 255, 255, 255);
    };

    const say = (text) => Module.pty.write(Array.from(new TextEncoder().encode(`${text}\r\n`)));
    setMode(720, 400); // "VGA text mode"
    say('[    0.000000] Linux version 4.19.110-android-x86_64 (fake)');
    say(`[    0.000000] Command line: ${args[args.indexOf('-append') + 1]}`);

    setTimeout(() => {
        say('[    5.000000] Detecting Android-x86... found at /dev/vda');
        setMode(guestWidth, guestHeight);
    }, 700);

    // Exercise the same path block/porty.c uses: a synchronous XHR issued
    // from a worker, through the service worker.
    const diskArg = args.find((a) => a.includes('file.driver=porty')) || '';
    const diskUrl = (/file\.url=([^,]+)/.exec(diskArg) || [])[1];
    if (diskUrl) {
        const source = `onmessage = (e) => {
            try {
                const xhr = new XMLHttpRequest();
                xhr.open('GET', e.data, false);
                xhr.responseType = 'arraybuffer';
                xhr.send(null);
                postMessage({ status: xhr.status, bytes: xhr.response ? xhr.response.byteLength : 0 });
            } catch (err) { postMessage({ status: -1, bytes: 0, error: String(err) }); }
        };`;
        const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
        worker.onmessage = (e) => {
            const base = STATS >> 2;
            if (e.data.status === 200) {
                u32[base + 1] += 1;
                u32[base + 2] += Math.ceil(e.data.bytes / 1024);
            } else {
                u32[base + 4] += 1;
            }
            instance.__chunk = e.data;
            worker.terminate();
        };
        worker.postMessage(`${diskUrl}/000000.bin`);
    }

    setInterval(() => {
        if (live.running) {
            live.refreshes++;
        }
    }, 30);

    const instance = {
        FS,
        TTY: { stream_ops: { poll: () => 0 } },
        __events: events,
        __files: files,
        __args: args,
        __memoryBytes: memory.buffer.byteLength,
        _porty_abi_version: () => 1,
        _porty_fb_poll() {
            const i = INFO >> 2;
            u32[i] = MAGIC;
            u32[i + 1] = live.gen;
            u32[i + 2] = FB;
            u32[i + 3] = live.width;
            u32[i + 4] = live.height;
            u32[i + 5] = live.width * 4;
            u32[i + 6] = 0x20020888;
            u32[i + 7] = 32;
            u32[i + 8] = live.frame;
            u32[i + 9] = live.x0; u32[i + 10] = live.y0; u32[i + 11] = live.x1; u32[i + 12] = live.y1;
            u32[i + 13] = live.refreshes;
            u32[i + 14] = live.running;
            live.x0 = 0xffffffff; live.y0 = 0xffffffff; live.x1 = 0; live.y1 = 0;
            return INFO;
        },
        _porty_input_event(type, a, b, c) {
            events.push([type, a, b, c]);
            if (type === 1) { // draw a black dot where the pointer is
                const x = Math.round((a / 0x7fff) * (live.width - 1));
                const y = Math.round((b / 0x7fff) * (live.height - 1));
                fill(x - 3, y - 3, x + 4, y + 4, 0, 0, 0);
            } else if (type === 10 && a === 2) {
                live.running = 0;
            } else if (type === 10 && a === 3) {
                live.running = 1;
            }
            return 1;
        },
        _porty_disk_stats: () => STATS,
    };
    return instance;
}
