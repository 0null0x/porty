// A stand-in for QEMU-Wasm's Emscripten module (qemu/out.js), for testing
// and previewing the web UI without the real 1 GB build.
//
// It honours the same contract web/js/emulator.js relies on:
//   - default export: async factory(Module) -> instance
//   - Module.wasmMemory, Module.instantiateWasm, Module.preRun, Module.pty
//   - instance._porty_fb_poll / _porty_input_event / _porty_disk_stats
//   - "-incoming porty:<index>": the chunks the index lists are fetched one
//     by one (synchronous XHR in a worker, as migration/porty-snapshot.c
//     does), progress is published through _porty_snapshot_stats, and the
//     "guest" then appears already booted; a chunk that cannot be fetched
//     ends "QEMU" with status 1, as a failed incoming migration does
// and paints a test pattern into the shared memory in the exact layout
// ui/wasmfb.c publishes (PIXMAN_x8r8g8b8, i.e. B, G, R, X bytes).
// SPDX-License-Identifier: GPL-2.0-or-later

const INFO = 1 << 20;          // PortyFbInfo snapshot
const STATS = INFO + 256;      // PortyDiskStats
const SNAP_STATS = INFO + 512; // PortySnapshotStats
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
    let initrd = null; // a copy of what -initrd would load, for the test
    const texts = new Map();
    const FS = {
        mkdir() {},
        writeFile(path, data) {
            files.set(path, data.length);
            if (path.endsWith('/initrd.img')) {
                initrd = data.slice();
            }
            if (typeof data === 'string') {
                texts.set(path, data);
            }
        },
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
    const syncFetchWorker = `onmessage = (e) => {
        try {
            const xhr = new XMLHttpRequest();
            xhr.open('GET', e.data, false);
            xhr.responseType = 'arraybuffer';
            xhr.send(null);
            postMessage({ status: xhr.status, bytes: xhr.response ? xhr.response.byteLength : 0 });
        } catch (err) { postMessage({ status: -1, bytes: 0, error: String(err) }); }
    };`;
    const incoming = args.includes('-incoming') ? args[args.indexOf('-incoming') + 1] : '';
    const snapshot = { urls: [], done: false, error: '' };
    if (incoming) {
        // A saved machine: no boot, the stream is loaded and the guest is there.
        const snap = SNAP_STATS >> 2;
        const fail = (text) => {
            snapshot.error = text;
            u32[snap] = 3;
            say(`qemu-system-x86_64: porty-snapshot: ${text}`);
            say('qemu-system-x86_64: load of migration failed: Input/output error');
            setTimeout(() => {
                try {
                    Module.quit(1, { name: 'ExitStatus', status: 1 });
                } catch (e) {
                    // rethrown ExitStatus, as above
                }
            }, 50);
        };
        const lines = (texts.get(incoming.replace(/^porty:/, '')) || '').split('\n');
        const field = (name) => (lines.find((l) => l.startsWith(`${name} `)) || '').slice(name.length + 1);
        const chunks = lines.filter((l) => l.startsWith('chunk ')).map((l) => l.split(' '));
        const chunkSize = Number(field('chunk-size'));
        const size = Number(field('size'));
        if (!incoming.startsWith('porty:') || lines[0] !== 'porty-snapshot 1' || !chunks.length) {
            setTimeout(() => fail('cannot read the index'), 0);
        } else {
            u32[snap] = 1;
            u32[snap + 1] = chunks.length;
            u32[snap + 4] = Math.round(chunks.reduce((sum, c) => sum + Number(c[1]), 0) / 1024);
            u32[snap + 6] = Math.floor(size / 1024);
            const worker = new Worker(URL.createObjectURL(new Blob([syncFetchWorker], { type: 'text/javascript' })));
            let next = 0;
            let fetched = 0;
            const step = () => {
                if (next === chunks.length) {
                    worker.terminate();
                    u32[snap] = 2;
                    snapshot.done = true;
                    setMode(guestWidth, guestHeight);
                    return;
                }
                const url = `${field('url')}/${chunks[next][3]}`;
                snapshot.urls.push(url);
                worker.postMessage(url);
            };
            worker.onmessage = (e) => {
                const want = Number(chunks[next][1]);
                if (e.data.status !== 200 || e.data.bytes !== want) {
                    worker.terminate();
                    u32[snap + 7] += 1;
                    fail(`chunk ${next} (${snapshot.urls[next]}): ` + (e.data.status !== 200
                        ? `HTTP ${e.data.status}` : `got ${e.data.bytes} bytes, expected ${want}`));
                    return;
                }
                fetched += e.data.bytes;
                next++;
                u32[snap + 2] = next;
                u32[snap + 3] = Math.round(fetched / 1024);
                u32[snap + 5] = Math.floor(Math.min(size, next * chunkSize) / 1024);
                // Slow enough for the page (and the test) to show progress.
                setTimeout(step, 150);
            };
            setTimeout(step, 150);
        }
    } else {
        say('[    0.000000] Linux version 4.19.110-android-x86_64 (fake)');
        say(`[    0.000000] Command line: ${args[args.indexOf('-append') + 1]}`);

        setTimeout(() => {
            say('[    5.000000] Detecting Android-x86... found at /dev/vda');
            setMode(guestWidth, guestHeight);
        }, 700);
    }

    // Exercise the same path block/porty.c uses: a synchronous XHR issued
    // from a worker, through the service worker.
    const diskArg = args.find((a) => a.includes('file.driver=porty')) || '';
    const diskUrl = (/file\.url=([^,]+)/.exec(diskArg) || [])[1];
    if (diskUrl) {
        const worker = new Worker(URL.createObjectURL(new Blob([syncFetchWorker], { type: 'text/javascript' })));
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
        __initrd: initrd,
        __args: args,
        __texts: texts,
        __snapshot: snapshot,
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
        _porty_snapshot_stats: () => SNAP_STATS,
    };
    return instance;
}
