// node tests/unit.test.mjs
// Unit tests for the DOM-free parts of the page.
// SPDX-License-Identifier: GPL-2.0-or-later
import assert from 'node:assert/strict';
import {
    PHONE_LEVELS, applyPhoneLevel, chooseWasmMemoryMb, fallbackLadder, isAppleMobile, isMobile, parseConfig,
    requiredWasmMemoryMb,
} from '../web/js/config.js';
import { LEVEL_KEY, RUN_KEY, RunLog, describeRun, nextLevel } from '../web/js/crash-guard.js';
import { TABLET_DEVICE, TOUCH_DEVICE, buildKernelCmdline, buildQemuArgs, inputArgs, inputDevice, vesaMode } from '../web/js/qemu-args.js';
import { CODE_TO_EVDEV, KEY, charToKey } from '../web/js/keymap.js';
import { Display } from '../web/js/display.js';
import { FLING_HORIZON_MS, Input, KEEP_MS, TOUCH_SLOTS, WHEEL_MARGIN, toTablet, touchSlop, wheelPixels } from '../web/js/input.js';
import { checkEnvironment } from '../web/js/emulator.js';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
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
    assert.equal(isMobile({ userAgent: ANDROID }), true);
    assert.deepEqual([IPHONE, ANDROID, MAC].map((userAgent) => isAppleMobile({ userAgent })), [true, false, false]);
    assert.equal(isAppleMobile({ userAgent: MAC, maxTouchPoints: 5 }), true, 'iPadOS in desktop mode');

    const desktop = parseConfig('', { userAgent: MAC });
    assert.deepEqual([desktop.mem, desktop.tb, desktop.smp, desktop.width, desktop.height, desktop.dpi],
        [1024, 384, 1, 480, 800, 160]);
    assert.deepEqual([desktop.usb, desktop.jit], [true, -1]);
    // the USB tablet unless touch=1 (then a touchscreen; off by default, see config.js)
    assert.deepEqual([desktop.touch, parseConfig('?touch=0', {}).touch, parseConfig('?touch=1', {}).touch], [false, false, true]);
    assert.equal(parseConfig('?jit=0', {}).jit, 0);
    assert.equal(parseConfig('?jit=-5', {}).jit, -1);
    assert.equal(parseConfig('?jit=99999999999', {}).jit, 2147483647);
    const phone = parseConfig('', { userAgent: IPHONE });
    const android = parseConfig('', { userAgent: ANDROID });
    assert.deepEqual([android.mem, android.tb, android.cache, android.jitcap], [768, 128, 16, 4000]);
    // iPhones: a cap of 8000 with the module ring and policies 6 (QEMU patches 0022-0024).
    assert.deepEqual([phone.mem, phone.tb, phone.cache, phone.jitcap], [768, 128, 16, 8000]);
    assert.deepEqual([phone.jitring, phone.jitpolicy], [24576, 6]);
    assert.deepEqual([desktop.cache, desktop.jitcap], [64, 0]);
    assert.equal(parseConfig('?jitcap=99999', {}).jitcap, 15000);
    assert.deepEqual([desktop.jitgc, parseConfig('?jitgc=0', {}).jitgc], [true, false]);
    // QEMU patch 0023: the cap's wait for the collector, no limit by default
    assert.deepEqual(['', '?jitgcwait=5000', '?jitgcwait=-3', '?jitgcwait=9999999'].map((q) => parseConfig(q, {}).jitgcwait),
        [0, 5000, 0, 600000]);
    // Elsewhere both are off: QEMU-Wasm as before.
    assert.deepEqual([desktop.jitpolicy, desktop.jitring, android.jitpolicy, android.jitring], [0, 0, 0, 0]);
    assert.deepEqual([parseConfig('?jitring=0', { userAgent: IPHONE }).jitring, parseConfig('?jitpolicy=-1', {}).jitpolicy], [0, -1]);
    assert.deepEqual([parseConfig('?jitpolicy=0&jitring=0', {}).jitpolicy, parseConfig('?jitpolicy=0&jitring=0', {}).jitring], [0, 0]);
    assert.deepEqual([parseConfig('?jitpolicy=9&jitring=999999', {}).jitpolicy, parseConfig('?jitpolicy=9&jitring=999999', {}).jitring], [7, 262144]);
    // time dilation: 8 by default (phones too), an integer from 1 (off) to 16
    assert.deepEqual([desktop.timescale, phone.timescale], [8, 8]);
    assert.deepEqual(['?timescale=1', '?timescale=0', '?timescale=99', '?timescale=x', '?timescale=2.9']
        .map((q) => parseConfig(q, {}).timescale), [1, 1, 16, 8, 2]);

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
    // ...and an iPhone goes back to other phones' cap on compiled blocks, unless the URL set one
    assert.deepEqual([step1.jitcap, step1.jitring], [4000, 24576]);
    assert.equal(applyPhoneLevel(parseConfig('?jitcap=9000', { userAgent: IPHONE }), 1).jitcap, 9000);
    assert.equal(applyPhoneLevel(android, 1).jitcap, 4000);
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

    const args = buildQemuArgs(parseConfig('?touch=1', { userAgent: MAC }), manifest, paths);
    const value = (flag) => args[args.indexOf(flag) + 1];
    assert.equal(value('-m'), '1024M');
    assert.equal(value('-accel'), 'tcg,tb-size=384');
    assert.equal(value('-display'), 'wasmfb');
    assert.equal(value('-cpu'), 'Nehalem');
    // touch=1: the pointing device is a touchscreen, no USB controller and no tablet
    assert.equal(value('-device'), 'virtio-multitouch-pci');
    assert.equal(TOUCH_DEVICE, 'virtio-multitouch-pci');
    assert.ok(!args.includes('-usb') && !args.includes('usb-tablet'));
    assert.equal(inputDevice(args), 'touch');
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
    // by default (and with touch=0): the USB tablet, at the same place in the argv
    const tablet = buildQemuArgs(cfg, manifest, paths);
    assert.deepEqual(buildQemuArgs(parseConfig('?touch=0', { userAgent: MAC }), manifest, paths), tablet);
    assert.deepEqual(tablet.slice(tablet.indexOf('-usb'), tablet.indexOf('-usb') + 3), ['-usb', '-device', TABLET_DEVICE]);
    assert.ok(!tablet.includes(TOUCH_DEVICE));
    assert.equal(inputDevice(tablet), 'tablet');
    assert.deepEqual(args.filter((a) => a !== '-device' && a !== TOUCH_DEVICE),
        tablet.filter((a) => a !== '-usb' && a !== '-device' && a !== TABLET_DEVICE), 'nothing else differs');
    // usb=0: no pointing device at all, whichever touch= says
    for (const q of ['?usb=0', '?usb=0&touch=0', '?usb=0&touch=1']) {
        const none = buildQemuArgs(parseConfig(q, {}), manifest, paths);
        assert.ok(!none.includes('-device') && !none.includes('-usb'), q);
        assert.equal(inputDevice(none), 'none');
        assert.deepEqual(inputArgs(parseConfig(q, {})), []);
    }
    // the device as a snapshot's argv may name it, with properties
    assert.equal(inputDevice(['-device', 'virtio-multitouch-pci,id=touch0']), 'touch');
    assert.equal(inputDevice(['-device', 'usb-tablet,bus=usb-bus.0']), 'tablet');
    assert.equal(inputDevice(['-usb', 'virtio-multitouch-pci']), 'none', 'only a -device counts');
    // the RTC follows the dilated virtual clock (timescale 8 by default), and only then
    assert.equal(value('-rtc'), 'base=utc,clock=vm');
    const realTime = buildQemuArgs(parseConfig('?timescale=1&touch=1', { userAgent: MAC }), manifest, paths);
    assert.ok(!realTime.includes('-rtc'));
    assert.deepEqual(args.filter((a, i) => a !== '-rtc' && args[i - 1] !== '-rtc'), realTime);
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

// --- input: the touchscreen (fingers in slots), the mouse and the wheel, the tablet ----------
{
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    // Just enough DOM for Input.attach(): event targets and a canvas rectangle.
    const rect = { left: 10, top: 20, width: 200, height: 400 };
    const fakeCanvas = () => Object.assign(new EventTarget(), {
        getBoundingClientRect: () => rect, setPointerCapture() {}, captured: 0,
    });
    const field = Object.assign(new EventTarget(), { value: '', setSelectionRange() {}, focus() {}, blur() {} });
    globalThis.window = globalThis.window || new EventTarget();
    const pointer = (target, type, props) => {
        const ev = new Event(type, { cancelable: true });
        Object.assign(ev, { pointerId: 1, pointerType: 'touch', button: 0, ...props });
        target.dispatchEvent(ev);
        return ev;
    };
    const wheel = (target, props) => {
        const ev = new Event('wheel', { cancelable: true });
        Object.assign(ev, { deltaX: 0, deltaY: 0, deltaMode: 0, shiftKey: false, ctrlKey: false, ...props });
        target.dispatchEvent(ev);
        return ev;
    };
    const at = (fx, fy) => ({ clientX: rect.left + fx * rect.width, clientY: rect.top + fy * rect.height });
    const T = (fx, fy) => toTablet(rect.left + fx * rect.width, rect.top + fy * rect.height, rect);

    // Fingers: each pointer its own slot, the lowest free one; moves report
    // only changes; a lift reports the slot.
    let sent = [];
    const canvas = fakeCanvas();
    const touch = new Input((...ev) => { sent.push(ev); return 1; }, canvas, field, { mode: 'touch', timescale: 1 });
    touch.attach();
    const down = pointer(canvas, 'pointerdown', { pointerId: 7, ...at(0.5, 0.25) });
    assert.ok(down.defaultPrevented);
    pointer(canvas, 'pointermove', { pointerId: 7, ...at(0.5, 0.25) }); // no change: nothing sent
    pointer(canvas, 'pointermove', { pointerId: 7, ...at(0.5, 0.5) });
    pointer(canvas, 'pointerdown', { pointerId: 8, ...at(0.25, 0.75) });
    pointer(canvas, 'pointermove', { pointerId: 9, ...at(0.1, 0.1) }); // not down: nothing
    pointer(canvas, 'pointerup', { pointerId: 7, ...at(0.5, 0.5) });
    pointer(canvas, 'pointerdown', { pointerId: 9, ...at(1, 1) });      // slot 0 is free again
    pointer(canvas, 'pointercancel', { pointerId: 8 });
    pointer(canvas, 'pointerup', { pointerId: 9, ...at(0.9, 0.9) });   // moved before it lifted
    assert.deepEqual(sent, [
        [5, 0, ...T(0.5, 0.25)], [6, 0, ...T(0.5, 0.5)], [5, 1, ...T(0.25, 0.75)], [7, 0, ...T(0.5, 0.5)],
        [5, 0, 0x7fff, 0x7fff], [7, 1, ...T(0.25, 0.75)], [6, 0, ...T(0.9, 0.9)], [7, 0, ...T(0.9, 0.9)],
    ]);
    assert.equal(touch.fingers.size, 0);

    // At most TOUCH_SLOTS fingers; the eleventh is ignored, also when it moves and lifts.
    sent = [];
    for (let id = 1; id <= TOUCH_SLOTS + 1; id++) {
        pointer(canvas, 'pointerdown', { pointerId: 100 + id, ...at(id / 20, 0.5) });
    }
    pointer(canvas, 'pointermove', { pointerId: 100 + TOUCH_SLOTS + 1, ...at(0.9, 0.9) });
    pointer(canvas, 'pointerup', { pointerId: 100 + TOUCH_SLOTS + 1, ...at(0.9, 0.9) });
    assert.deepEqual(sent.map((e) => [e[0], e[1]]), [...Array(TOUCH_SLOTS).keys()].map((slot) => [5, slot]));
    // A lost window focus lifts every finger.
    sent = [];
    touch.releaseAll();
    assert.deepEqual(sent.map((e) => [e[0], e[1]]).sort((a, b) => a[1] - b[1]),
        [...Array(TOUCH_SLOTS).keys()].map((slot) => [7, slot]));

    // The mouse: its left button is a finger, hovering sends nothing, the
    // right button is Back, the middle one nothing.
    sent = [];
    pointer(canvas, 'pointermove', { pointerType: 'mouse', pointerId: 1, ...at(0.3, 0.3) });
    pointer(canvas, 'pointerdown', { pointerType: 'mouse', pointerId: 1, button: 0, ...at(0.3, 0.3) });
    pointer(canvas, 'pointermove', { pointerType: 'mouse', pointerId: 1, ...at(0.3, 0.6) });
    pointer(canvas, 'pointerup', { pointerType: 'mouse', pointerId: 1, button: 0, ...at(0.3, 0.6) });
    pointer(canvas, 'pointerdown', { pointerType: 'mouse', pointerId: 1, button: 2, ...at(0.3, 0.6) });
    pointer(canvas, 'pointerup', { pointerType: 'mouse', pointerId: 1, button: 2, ...at(0.3, 0.6) });
    pointer(canvas, 'pointerdown', { pointerType: 'mouse', pointerId: 1, button: 1, ...at(0.3, 0.6) });
    assert.deepEqual(sent, [[5, 0, ...T(0.3, 0.3)], [6, 0, ...T(0.3, 0.6)], [7, 0, ...T(0.3, 0.6)], [3, 158, 1, 0], [3, 158, 0, 0]]);

    // A resting finger keeps reporting (to and fro by one unit), so that
    // Android's velocity tracker sees it stop; nothing once it lifted.
    sent = [];
    pointer(canvas, 'pointerdown', { pointerId: 3, ...at(0.5, 0.5) });
    await sleep(KEEP_MS * 3.5);
    const [x5, y5] = T(0.5, 0.5);
    const kept = sent.slice(1);
    assert.ok(kept.length >= 2 && kept.length <= 4, `${kept.length} reports while resting`);
    assert.deepEqual(kept.slice(0, 2), [[6, 0, x5 + 1, y5], [6, 0, x5, y5]]);
    pointer(canvas, 'pointerup', { pointerId: 3, ...at(0.5, 0.5) });
    const lifted = sent.length;
    await sleep(KEEP_MS * 2.5);
    assert.equal(sent.length, lifted, 'no reports after the lift');
    assert.equal(touch.keepTimer, 0);

    // The wheel drags with a finger where the pointer is: down a page
    // (deltaY > 0) moves it up; it stays inside the margins; it lifts after
    // resting for the fling horizon times the dilation.
    assert.deepEqual(wheelPixels({ deltaX: 0, deltaY: 3, deltaMode: 1 }, 400), [0, 120]);
    assert.deepEqual(wheelPixels({ deltaX: 2, deltaY: 1, deltaMode: 2 }, 400), [800, 400]);
    sent = [];
    // Android's touch slop (8 dp) and 4 pixels more, in tablet units: the
    // wheel's first move is that much longer, so a small scroll is no tap.
    assert.deepEqual(touchSlop(480, 800, 160), [Math.round(12 / 480 * 0x7fff), Math.round(12 / 800 * 0x7fff)]);
    assert.deepEqual(touchSlop(720, 1280, 240), [Math.round(16 / 720 * 0x7fff), Math.round(16 / 1280 * 0x7fff)]);
    const slop = [100, 200];
    const slow = new Input((...ev) => { sent.push(ev); return 1; }, canvas, field, { mode: 'touch', timescale: 2, slop });
    assert.equal(slow.wheelRestMs(), FLING_HORIZON_MS * 2 + 2 * KEEP_MS);
    touch.detach();
    slow.attach();
    const w = wheel(canvas, { deltaY: 50, ...at(0.5, 0.5) });  // an eighth of the screen
    assert.ok(w.defaultPrevented);
    wheel(canvas, { deltaY: 50, ...at(0.5, 0.5) });
    wheel(canvas, { deltaY: 400, ...at(0.5, 0.5) }); // past the top margin: stops there
    wheel(canvas, { deltaY: 400, ...at(0.5, 0.5) }); // still there: nothing new
    const [wx, wy] = T(0.5, 0.5);
    const eighth = Math.round(0x7fff / 8);
    assert.deepEqual(sent.slice(0, 4), [[5, 0, wx, wy], [6, 0, wx, wy - eighth - slop[1]], [6, 0, wx, wy - 2 * eighth - slop[1]],
        [6, 0, wx, WHEEL_MARGIN]]);
    assert.equal(sent.length, 4);
    // A finger coming down lifts the wheel's at once.
    pointer(canvas, 'pointerdown', { pointerId: 4, ...at(0.2, 0.2) });
    assert.deepEqual(sent.slice(-2), [[7, 0, wx, WHEEL_MARGIN], [5, 0, ...T(0.2, 0.2)]]);
    wheel(canvas, { deltaY: 100, ...at(0.5, 0.5) }); // not while a finger is down
    assert.equal(sent.length, 6);
    pointer(canvas, 'pointerup', { pointerId: 4, ...at(0.2, 0.2) });
    // Sideways: shift+wheel and deltaX move x; then the rest lifts it.
    sent = [];
    wheel(canvas, { deltaY: 50, shiftKey: true, ...at(0.5, 0.5) });
    assert.deepEqual(sent, [[5, 0, wx, wy], [6, 0, wx - Math.round(0x7fff / 4) - slop[0], wy]]);
    await sleep(slow.wheelRestMs() + 3 * KEEP_MS);
    assert.deepEqual(sent[sent.length - 1], [7, 0, wx - Math.round(0x7fff / 4) - slop[0], wy]);
    assert.ok(sent.slice(2, -1).every((e) => e[0] === 6), 'only resting reports before the lift');
    // A trackpad's pinch (ctrl+wheel): two fingers spread around the pointer.
    sent = [];
    wheel(canvas, { deltaY: -50, ctrlKey: true, ...at(0.5, 0.5) });
    assert.deepEqual(sent.slice(0, 2).map((e) => [e[0], e[1], e[3]]), [[5, 0, wy], [5, 1, wy]]);
    assert.ok(sent[0][2] < wx && sent[1][2] > wx);
    const spread = sent.slice(2).map((e) => e[2]);
    assert.ok(spread[0] < sent[0][2] && spread[1] > sent[1][2], 'the fingers moved apart');
    slow.detach();
    assert.deepEqual(sent.slice(-2).map((e) => [e[0], e[1]]), [[7, 1], [7, 0]], 'detach lifts them');

    // touch=0: the USB tablet as before, one pointer, moves and buttons.
    sent = [];
    const tabletInput = new Input((...ev) => { sent.push(ev); return 1; }, canvas, field, { mode: 'tablet' });
    tabletInput.attach();
    pointer(canvas, 'pointermove', { pointerType: 'mouse', ...at(0.5, 0.25) });
    pointer(canvas, 'pointerdown', { pointerType: 'mouse', button: 0, ...at(0.5, 0.25) });
    pointer(canvas, 'pointerdown', { pointerId: 2, ...at(0.1, 0.1) }); // a second finger is ignored
    pointer(canvas, 'pointerup', { pointerType: 'mouse', button: 0, ...at(0.5, 0.5) });
    wheel(canvas, { deltaY: -3 });
    tabletInput.detach();
    assert.deepEqual(sent, [[1, ...T(0.5, 0.25), 0], [1, ...T(0.5, 0.25), 0], [2, 0, 1, 0],
        [1, ...T(0.5, 0.5), 0], [2, 0, 0, 0], [4, 1, 0, 0]]);

    // usb=0: no pointing device, nothing is sent for pointers.
    sent = [];
    const none = new Input((...ev) => { sent.push(ev); return 1; }, canvas, field, { mode: 'none' });
    none.attach();
    pointer(canvas, 'pointerdown', at(0.5, 0.5));
    wheel(canvas, { deltaY: 10 });
    none.detach();
    assert.deepEqual(sent, []);

    // A lift the ring had no room for is sent again.
    let room = 0;
    sent = [];
    const busy = new Input((...ev) => { if (room > 0) { room--; sent.push(ev); return 1; } return 0; }, canvas, field);
    busy.fingers.set(1, { slot: 2, x: 5, y: 6, at: 0, jitter: 0 });
    busy.fingerUp(1);
    assert.equal(busy.dropped, 1);
    room = 1;
    await sleep(120);
    assert.deepEqual(sent, [[7, 2, 5, 6]]);
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

// So has the disk cache (web/js/diskcache.js and diskcache-sw.js).
await import('./diskcache.test.mjs');
