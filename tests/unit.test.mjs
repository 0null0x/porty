// node tests/unit.test.mjs
// Unit tests for the DOM-free parts of the page.
// SPDX-License-Identifier: GPL-2.0-or-later
import assert from 'node:assert/strict';
import {
    PHONE_LEVELS, applyPhoneLevel, chooseWasmMemoryMb, fallbackLadder, isMobile, parseConfig,
    requiredWasmMemoryMb,
} from '../web/js/config.js';
import { LEVEL_KEY, RUN_KEY, RunLog, describeRun, nextLevel } from '../web/js/crash-guard.js';
import { buildKernelCmdline, buildQemuArgs, vesaMode } from '../web/js/qemu-args.js';
import { CODE_TO_EVDEV, KEY, charToKey } from '../web/js/keymap.js';
import { Display } from '../web/js/display.js';
import { Input, toTablet } from '../web/js/input.js';
import { checkEnvironment } from '../web/js/emulator.js';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
const manifest = {
    cmdline: 'root=/dev/ram0 androidboot.selinux=permissive buildvariant=userdebug',
    kernel: { file: 'kernel' }, initrd: { file: 'initrd.img' }, ramdisk: { file: 'ramdisk.img' },
    disk: { dir: 'system', size: 900000000, chunk_size: 2097152, chunks: 430 },
};
const paths = { bios: '/pc-bios', kernel: '/img/kernel', initrd: '/img/initrd.img', ramdisk: '/img/ramdisk.img', diskUrl: 'https://example.test/porty/image/system' };

// --- config -----------------------------------------------------------------
{
    assert.equal(isMobile({ userAgent: IPHONE }), true);
    assert.equal(isMobile({ userAgent: MAC, maxTouchPoints: 0 }), false);
    assert.equal(isMobile({ userAgent: MAC, maxTouchPoints: 5 }), true, 'iPadOS in desktop mode');

    const desktop = parseConfig('', { userAgent: MAC });
    assert.deepEqual([desktop.mem, desktop.tb, desktop.smp, desktop.width, desktop.height, desktop.dpi],
        [1024, 384, 1, 480, 800, 160]);
    assert.deepEqual([desktop.usb, desktop.jit], [true, -1]);
    assert.equal(parseConfig('?jit=0', {}).jit, 0);
    assert.equal(parseConfig('?jit=-5', {}).jit, -1);
    assert.equal(parseConfig('?jit=99999999999', {}).jit, 2147483647);
    const phone = parseConfig('', { userAgent: IPHONE });
    assert.deepEqual([phone.mem, phone.tb, phone.cache, phone.jitcap], [768, 128, 16, 4000]);
    assert.deepEqual([desktop.cache, desktop.jitcap], [64, 0]);
    assert.equal(parseConfig('?jitcap=99999', {}).jitcap, 15000);
    assert.deepEqual([desktop.jitgc, parseConfig('?jitgc=0', {}).jitgc], [true, false]);
    // time dilation: off by default (phones too), an integer from 1 to 16
    assert.deepEqual([desktop.timescale, phone.timescale], [1, 1]);
    assert.deepEqual(['?timescale=8', '?timescale=0', '?timescale=99', '?timescale=x', '?timescale=2.9']
        .map((q) => parseConfig(q, {}).timescale), [8, 1, 16, 1, 2]);

    // desktop keeps the linked size (no patching) when the config fits
    assert.equal(requiredWasmMemoryMb(desktop), 1920);
    assert.equal(chooseWasmMemoryMb(desktop, 2300), 2300);
    // phones get the smallest memory that fits
    assert.equal(chooseWasmMemoryMb(phone, 2300), 1280);
    // a bigger guest grows past the linked size
    assert.equal(chooseWasmMemoryMb(parseConfig('?mem=2560', { userAgent: MAC }), 2300), 3456);
    // explicit override wins, rounded to 64 MiB
    assert.equal(chooseWasmMemoryMb(parseConfig('?wasmmem=1000', { userAgent: MAC }), 2300), 1024);

    const clamped = parseConfig('?mem=99999&smp=64&tb=1&res=9999x1&fps=1000&cache=1', {});
    assert.deepEqual([clamped.mem, clamped.smp, clamped.tb, clamped.fps, clamped.cache], [3072, 4, 64, 60, 4]);
    assert.deepEqual([clamped.width, clamped.height], [480, 800], 'malformed res is ignored');
    assert.equal(parseConfig('?res=720x1280', {}).dpi, 240);
    assert.equal(parseConfig('?res=1024x768', {}).dpi, 260);

    // hostile input cannot smuggle shell/QEMU syntax through free-form parameters
    const evil = parseConfig('?append=quiet%20foo;rm%20$(x)%20a=b&cpu=max,%2Bavx%20-drive&qemu=-snapshot%20"x"', {});
    assert.deepEqual(evil.append, ['quiet', 'a=b']);
    assert.equal(evil.cpu, 'Nehalem');
    assert.deepEqual(evil.qemu, ['-snapshot']);

    const ladder = fallbackLadder(parseConfig('?mem=1536', {}));
    assert.deepEqual(ladder.map((s) => s.mem), [1280, 1024, 896, 768]);
    assert.deepEqual(fallbackLadder(desktop).map((s) => s.mem), [896, 768]);
    assert.ok(ladder.every((s) => s.tb <= desktop.tb));
    // phones fall back through their memory steps, caches included
    assert.deepEqual(fallbackLadder(phone), PHONE_LEVELS.slice(1));
    assert.deepEqual(fallbackLadder(parseConfig('?mem=1024', { userAgent: IPHONE })).map((s) => s.mem), [768, 640, 512]);

    // phone memory steps after a killed start
    assert.deepEqual(PHONE_LEVELS[0], { mem: phone.mem, tb: phone.tb, cache: phone.cache });
    const step1 = applyPhoneLevel(phone, 1);
    assert.deepEqual([step1.mem, step1.tb, step1.cache, step1.phoneLevel], [640, 96, 12, 1]);
    assert.equal(requiredWasmMemoryMb(step1), 1152);
    assert.equal(applyPhoneLevel(phone, 9).mem, 512, 'clamped to the last step');
    assert.equal(applyPhoneLevel(phone, 0), phone);
    assert.equal(applyPhoneLevel(desktop, 2), desktop, 'desktops never step down');
    const pinned = parseConfig('?tb=256', { userAgent: IPHONE });
    assert.equal(pinned.memoryExplicit, true);
    assert.equal(applyPhoneLevel(pinned, 2), pinned, 'URL memory parameters win');
    assert.equal(phone.memoryExplicit, false);
}

// --- crash guard (run log in localStorage) -------------------------------------
{
    const store = new Map();
    const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
    let t = 1_000_000;
    const log = new RunLog(storage, () => t);
    assert.equal(log.interrupted(), null);
    assert.equal(log.level(), 0);

    log.begin({ level: 0, mem: 768, stage: 'Starting', hidden: false });
    t += 6 * 60000;
    log.update({ stage: 'Booting Android', wasmMb: 1280, heapUsed: 1150, diskMb: 300 });
    // A new page load (after Safari killed the tab) sees the unfinished run.
    const next = new RunLog(storage, () => t + 1000);
    const run = next.interrupted();
    assert.equal(run.stage, 'Booting Android');
    assert.equal(describeRun(run), 'after 6 min, at "Booting Android", with 768 MB guest RAM, ' +
        '1280 MB WebAssembly memory (1150 MB in use), 300 MB of the system image read');
    assert.deepEqual(nextLevel(run, 0, 2), { level: 1, stepped: true });
    assert.deepEqual(nextLevel({ ...run, level: 2 }, 2, 2), { level: 2, stepped: false }, 'no step below the last');
    assert.deepEqual(nextLevel({ ...run, hidden: true }, 0, 2), { level: 0, stepped: false }, 'killed in the background');
    assert.deepEqual(nextLevel(null, 1, 2), { level: 1, stepped: false });
    next.acknowledge(run);
    assert.equal(new RunLog(storage, () => t).interrupted(), null, 'reported once');
    next.setLevel(1);
    assert.equal(JSON.parse(store.get(LEVEL_KEY)), 1);
    assert.equal(new RunLog(storage).level(), 1);

    // Runs the page saw end are not reported; neither are stale ones.
    const a = new RunLog(storage, () => t);
    a.begin({ stage: 'Starting' });
    a.end('left');
    assert.equal(a.interrupted(), null);
    a.resume();
    assert.equal(JSON.parse(store.get(RUN_KEY)).ended, false, 'back from the bfcache');
    a.end('failed');
    a.update({ stage: 'ignored' });
    assert.equal(JSON.parse(store.get(RUN_KEY)).stage, 'Starting');
    const b = new RunLog(storage, () => t);
    b.begin({ stage: 'Starting' });
    assert.equal(new RunLog(storage, () => t + 13 * 3600 * 1000).interrupted(), null);
    // No storage at all (private browsing): everything is a no-op.
    const none = new RunLog(null);
    none.begin({});
    none.update({ stage: 'x' });
    assert.equal(none.interrupted(), null);
    assert.equal(none.level(), 0);
    store.set(RUN_KEY, '{not json');
    assert.equal(new RunLog(storage).interrupted(), null);
}

// --- kernel command line and argv --------------------------------------------------
{
    const cfg = parseConfig('', { userAgent: MAC });
    assert.equal(buildKernelCmdline(cfg, manifest),
        'root=/dev/ram0 androidboot.selinux=permissive buildvariant=userdebug console=ttyS0 androidboot.console=ttyS0 ' +
        'RAMDISK=vdb SRC= DATA= video=480x800 UVESA_MODE=800x600 DPI=160 SETUPWIZARD=0');
    // gfx=vesa: no KMS, a real VBE mode for vesafb (0x143 + 0x200) and uvesafb
    assert.match(buildKernelCmdline(parseConfig('?gfx=vesa&setup=1&disk=ide&append=DEBUG=1', {}), manifest),
        /RAMDISK=sr1 SRC= DATA= nomodeset vga=0x343 UVESA_MODE=800x600 DPI=160 DEBUG=1$/);
    assert.equal(vesaMode(parseConfig('?res=1280x720', {})), '1280x720');
    assert.equal(vesaMode(parseConfig('?res=720x1280', {})), '1024x768');
    assert.match(buildKernelCmdline(parseConfig('?gfx=vesa&res=1024x768', {}), manifest), /vga=0x344 UVESA_MODE=1024x768/);
    assert.equal(buildKernelCmdline(parseConfig('?cmdline=a=1%20b', {}), manifest), 'a=1 b');

    const args = buildQemuArgs(cfg, manifest, paths);
    const value = (flag) => args[args.indexOf(flag) + 1];
    assert.equal(value('-m'), '1024M');
    assert.equal(value('-accel'), 'tcg,tb-size=384');
    assert.equal(value('-display'), 'wasmfb');
    assert.equal(value('-cpu'), 'Nehalem');
    assert.ok(args.includes('usb-tablet'));
    const drives = args.filter((a, i) => args[i - 1] === '-drive');
    assert.equal(drives.length, 2);
    assert.equal(drives[0],
        'if=virtio,index=0,media=disk,format=raw,read-only=on,file.driver=porty,' +
        'file.url=https://example.test/porty/image/system,file.size=900000000,' +
        'file.chunk-size=2097152,file.cache-chunks=64,file.parallel=4');
    assert.equal(drives[1], 'if=virtio,index=1,media=disk,format=raw,file=/img/ramdisk.img');
    // a qcow2 system disk (manifest format 2) is opened as qcow2 over porty, read-only
    const qcow2 = buildQemuArgs(cfg, { ...manifest, disk: { ...manifest.disk, format: 'qcow2' } }, paths);
    assert.ok(qcow2.includes(drives[0].replace('format=raw', 'format=qcow2')));
    assert.equal(buildQemuArgs(parseConfig('?smp=2', {}), manifest, paths)[9], 'tcg,tb-size=384,thread=multi');
    assert.ok(!buildQemuArgs(parseConfig('?usb=0', {}), manifest, paths).includes('usb-tablet'));
    // the RTC follows the dilated virtual clock, and only then
    assert.ok(!args.includes('-rtc'));
    const slow = buildQemuArgs(parseConfig('?timescale=4', {}), manifest, paths);
    assert.equal(slow[slow.indexOf('-rtc') + 1], 'base=utc,clock=vm');
    assert.deepEqual(slow.filter((a, i) => a !== '-rtc' && slow[i - 1] !== '-rtc'), args);
    const ide = buildQemuArgs(parseConfig('?disk=ide', {}), manifest, paths).filter((a) => a.startsWith('if=ide'));
    assert.ok(ide[0].includes('media=cdrom') && ide[1].endsWith('read-only=on'));
    // commas in the URL are escaped for QEMU's option parser
    assert.ok(buildQemuArgs(cfg, manifest, { ...paths, diskUrl: 'http://h/a,b' }).some((a) => a.includes('file.url=http://h/a,,b,')));
}

// --- keymap ---------------------------------------------------------------------------
{
    assert.deepEqual(charToKey('a'), [30, false]);
    assert.deepEqual(charToKey('Z'), [44, true]);
    assert.deepEqual(charToKey('@'), [3, true]);
    assert.deepEqual(charToKey('“'), [40, true], 'curly quote folds to "');
    assert.equal(charToKey('é'), null);
    assert.equal(CODE_TO_EVDEV.KeyQ, 16);
    assert.equal(KEY.BACK, 158);
    for (let c = 32; c < 127; c++) {
        assert.ok(charToKey(String.fromCharCode(c)), `printable ASCII ${c} is typeable`);
    }
}

// --- display ------------------------------------------------------------------------------
{
    const memory = { buffer: new SharedArrayBuffer(1 << 20) };
    const u32 = new Uint32Array(memory.buffer);
    const INFO = 4096;
    const FB = 8192;
    const W = 4;
    const H = 3;
    const STRIDE = 20; // deliberately wider than width * 4
    let dirty = [0, 0, W, H];
    let gen = 1;
    const poll = () => {
        u32.set([0x31424650, gen, FB, W, H, STRIDE, 0x20020888, 32, 1, ...dirty, 7, 1, 0], INFO >> 2);
        return INFO;
    };
    const px = new DataView(memory.buffer);
    const setPixel = (x, y, xrgb) => px.setUint32(FB + y * STRIDE + x * 4, xrgb, true);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            setPixel(x, y, 0x00102030);
        }
    }
    setPixel(1, 2, 0xff_aa_bb_cc); // X byte must be ignored

    const puts = [];
    const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({
            createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
            putImageData: (image, dx, dy, x, y, w, h) => puts.push({ x, y, w, h, copy: image.data.slice() }),
        }),
    };
    const display = new Display(canvas, memory, poll);
    let resized = null;
    display.onResize = (w, h) => { resized = [w, h]; };

    assert.equal(display.update(0), true);
    assert.deepEqual([canvas.width, canvas.height, resized], [W, H, [W, H]]);
    assert.deepEqual(puts[0], { x: 0, y: 0, w: W, h: H, copy: puts[0].copy });
    assert.deepEqual([...puts[0].copy.slice(0, 4)], [0x10, 0x20, 0x30, 0xff], 'XRGB -> RGBA');
    assert.deepEqual([...puts[0].copy.slice((2 * W + 1) * 4, (2 * W + 1) * 4 + 4)], [0xaa, 0xbb, 0xcc, 0xff]);
    assert.equal(display.heartbeat, 7);
    assert.equal(display.running, true);

    // nothing dirty: nothing drawn
    dirty = [0xffffffff, 0xffffffff, 0, 0];
    assert.equal(display.update(10), false);
    // a dirty rectangle only repaints that rectangle
    setPixel(3, 1, 0x00ff0000);
    dirty = [3, 1, 4, 2];
    assert.equal(display.update(20), true);
    assert.deepEqual([puts[1].x, puts[1].y, puts[1].w, puts[1].h], [3, 1, 1, 1]);
    assert.deepEqual([...puts[1].copy.slice((W + 3) * 4, (W + 3) * 4 + 4)], [0xff, 0, 0, 0xff]);
    // a new surface generation forces a full repaint even without dirt
    gen = 2;
    dirty = [0xffffffff, 0xffffffff, 0, 0];
    assert.equal(display.update(30), true);
    assert.deepEqual([puts[2].w, puts[2].h], [W, H]);
    // the periodic safety repaint
    assert.equal(display.update(5000), true);
    // unaligned pixel data takes the byte-wise path and gives the same result
    const before = puts.length;
    const shifted = new Uint8Array(memory.buffer);
    shifted.copyWithin(FB + 1, FB, FB + STRIDE * H);
    const pollUnaligned = () => { poll(); u32[(INFO >> 2) + 2] = FB + 1; u32[(INFO >> 2) + 1] = 99; return INFO; };
    const display2 = new Display(canvas, memory, pollUnaligned);
    assert.equal(display2.update(0), true);
    assert.deepEqual([...puts[before].copy.slice(0, 4)], [0x10, 0x20, 0x30, 0xff]);
    // garbage descriptions are rejected instead of reading out of bounds
    u32[(INFO >> 2)] = 0x31424650;
    const bad = new Display(canvas, memory, () => { poll(); u32[(INFO >> 2) + 2] = (1 << 20) - 8; return INFO; });
    assert.equal(bad.update(0), false);

    // hasContent(): a black picture (no boot animation) keeps the overlay up
    assert.equal(new Display(canvas, memory, poll).hasContent(), false, 'nothing drawn yet');
    assert.equal(display.hasContent(), true);
    display.out.fill(0xff000000);
    assert.equal(display.hasContent(), false, 'opaque black is no content');
    display.out[Math.floor(H / 2) * W + Math.floor(W / 2)] = 0xff000000 | 0x10;
    assert.equal(typeof display.hasContent(), 'boolean');
    display.out.fill(0xff102030);
    assert.equal(display.hasContent(), true);
}

// --- input ----------------------------------------------------------------------------------
{
    const rect = { left: 10, top: 20, width: 200, height: 400 };
    assert.deepEqual(toTablet(10, 20, rect), [0, 0]);
    assert.deepEqual(toTablet(210, 420, rect), [0x7fff, 0x7fff]);
    assert.deepEqual(toTablet(110, 220, rect), [16384, 16384]);
    assert.deepEqual(toTablet(-50, 9999, rect), [0, 0x7fff], 'clamped');

    const sent = [];
    const input = new Input((...ev) => { sent.push(ev); return 1; }, {}, {});
    input.typeText('a?\né');
    assert.deepEqual(sent, [
        [3, 30, 1, 0], [3, 30, 0, 0],
        [3, 42, 1, 0], [3, 53, 1, 0], [3, 53, 0, 0], [3, 42, 0, 0],
        [3, 28, 1, 0], [3, 28, 0, 0],
    ]);
    sent.length = 0;
    input.recents();
    assert.deepEqual(sent.map((e) => [e[1], e[2]]), [[56, 1], [15, 1], [15, 0], [56, 0]]);
    const full = new Input(() => 0, {}, {});
    full.back();
    assert.equal(full.dropped, 2, 'a full ring is counted, not thrown');
}

// --- environment check ------------------------------------------------------------------------
{
    assert.deepEqual(checkEnvironment({ WebAssembly: {}, SharedArrayBuffer: function () {}, crossOriginIsolated: true, Atomics: {} }), []);
    assert.equal(checkEnvironment({ WebAssembly: {}, Atomics: {}, crossOriginIsolated: false }).length, 1);
}

// Resuming a saved Android (web/js/snapshot.js) has its own file.
await import('./snapshot.test.mjs');

console.log('unit: all checks passed');

// The boot diet (appended initramfs archive, ?diet= and ?props=) has its own file.
await import('./boot-diet.test.mjs');
