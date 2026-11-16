// Porty page logic: wires the DOM to the emulator.
// SPDX-License-Identifier: GPL-2.0-or-later

import { PARAM_HELP, PHONE_LEVELS, applyPhoneLevel, parseConfig, requiredWasmMemoryMb } from './config.js';
import { RunLog, browserStorage, describeRun, nextLevel } from './crash-guard.js';
import { Emulator, StartError, checkEnvironment } from './emulator.js';
import { describeDiet } from './boot-diet.js';
import { DISKCACHE_HELP, DiskCache, describeUsage, megabytes } from './diskcache.js';
import { CONTROL, Input } from './input.js';
import { SerialConsole } from './serial.js';
import { resumeMode, resumeVeto, storeResumeFailure, takeResumeFailure } from './snapshot.js';

const $ = (id) => document.getElementById(id);
const app = $('app');
const deviceEnv = {
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints,
};
const parsedCfg = parseConfig(location.search, deviceEnv);
const baseUrl = new URL('.', location.href).href;

// Did the last start end without the page noticing (Safari killed the tab)?
// Then phones start with less memory; see crash-guard.js.
const runLog = new RunLog(browserStorage());
const lastRun = runLog.interrupted();
const steps = parsedCfg.mobile && !parsedCfg.memoryExplicit;
const decision = nextLevel(lastRun, runLog.level(), PHONE_LEVELS.length - 1);
if (lastRun) {
    runLog.acknowledge(lastRun);
}
if (steps && decision.level !== runLog.level()) {
    runLog.setLevel(decision.level);
}
const cfg = applyPhoneLevel(parsedCfg, steps ? decision.level : 0);

// A snapshot on the site is resumed instead of booting (snapshot.js), unless
// something speaks against it; a resume that failed reloads into a boot.
function sessionStore() {
    try {
        return globalThis.sessionStorage || null;
    } catch (e) {
        return null;
    }
}
// Chunks of the image and of the snapshot stay on this device (diskcache.js).
const diskCache = new DiskCache({ search: location.search, baseUrl });
const resumeFailure = takeResumeFailure(sessionStore());
const resume = {
    mode: resumeMode(location.search),
    veto: resumeVeto({ search: location.search, lastRun, failure: resumeFailure }),
    env: deviceEnv,
};

let emulator = null;
let input = null;
let serial = null;
let wakeLock = null;
let graphicsSeen = false;
let lastLogLines = [];

// ---------------------------------------------------------------- intro ---
function describeConfig() {
    return `mem=${cfg.mem} tb=${cfg.tb} cache=${cfg.cache} smp=${cfg.smp} cpu=${cfg.cpu} ` +
        `res=${cfg.width}x${cfg.height} dpi=${cfg.dpi} gfx=${cfg.gfx} disk=${cfg.disk}` +
        (cfg.usb ? '' : ' usb=0') + (cfg.jit >= 0 ? ` jit=${cfg.jit}` : '') +
        (cfg.jitcap > 0 ? ` jitcap=${cfg.jitcap}` : '') + (cfg.jitgc === false ? ' jitgc=0' : '') +
        (cfg.timescale > 1 ? ` timescale=${cfg.timescale}` : '') +
        (diskCache.setting.enabled ? '' : ' diskcache=0') +
        (cfg.mobile ? (cfg.phoneLevel ? ` (phone, smaller memory step ${cfg.phoneLevel})` : ' (phone defaults)') : '');
}

/** Explain on the intro page why this start uses less memory, if it does. */
function explainLastRun() {
    const box = $('lastrun');
    const text = $('lastrun-text');
    const total = requiredWasmMemoryMb(cfg);
    let message = '';
    if (lastRun && lastRun.hidden) {
        message = `The last start stopped ${describeRun(lastRun)} while Porty was in the background. ` +
            'Browsers, above all on phones, free the memory of background tabs, so keep this ' +
            'tab in front with the screen on while Android boots.';
    } else if (lastRun && steps && decision.stepped) {
        message = `The last start stopped ${describeRun(lastRun)}. On a phone that usually means ` +
            'the browser ran out of memory for this tab and reloaded it. This start uses less: ' +
            `${cfg.mem} MB of RAM for Android (about ${total} MB in all).`;
    } else if (lastRun && steps) {
        message = `The last start stopped ${describeRun(lastRun)}, already with the smallest memory ` +
            'setting. Close other tabs and apps (or restart the phone) and try again.';
    } else if (lastRun) {
        message = `The last start did not finish (${describeRun(lastRun)}): the tab was closed, ` +
            'reloaded or ran out of memory.';
    } else if (cfg.phoneLevel) {
        message = 'An earlier start was stopped by the browser, so Porty uses less memory on this ' +
            `device: ${cfg.mem} MB of RAM for Android (about ${total} MB in all).`;
    }
    if (!message) {
        return;
    }
    text.textContent = message;
    $('lastrun-reset').hidden = !cfg.phoneLevel;
    box.hidden = false;
}

let lastBuild = null; // promise of build.json
/** Say how much of Android is stored on this device, and offer to delete it. */
async function showDiskUsage(buildInfo = lastBuild) {
    const note = $('diskcache-note');
    const text = $('diskcache-text');
    const button = $('diskcache-clear');
    try {
        let usage = await diskCache.usage();
        if (usage.bytes) {
            // The manifests give the real sizes of what is stored.
            const json = (path) => fetch(`${baseUrl}${path}`, { cache: 'no-cache' })
                .then((r) => (r.ok ? r.json() : null)).catch(() => null);
            const build = await buildInfo;
            const [image, snap] = await Promise.all([json('image/manifest.json'),
                build && build.snapshot ? json('snapshot/manifest.json') : null]);
            usage = await diskCache.usage(image && image.disk, snap);
        }
        text.textContent = describeUsage(usage);
        button.hidden = !usage.bytes;
        note.hidden = false;
    } catch (e) {
        note.hidden = true;
    }
}

function fillIntro() {
    explainLastRun();
    $('cfgline').textContent = describeConfig() + describeDiet(cfg);
    $('memnote').textContent =
        `${cfg.mem} MB of RAM is reserved for the guest (about ${requiredWasmMemoryMb(cfg)} MB in total).`;
    const table = $('params');
    for (const [name, text] of [...PARAM_HELP, DISKCACHE_HELP]) {
        const row = table.insertRow();
        row.insertCell().textContent = `?${name}=`;
        row.insertCell().textContent = text;
    }
    lastBuild = fetch(`${baseUrl}build.json`, { cache: 'no-cache' })
        .then((r) => (r.ok ? r.json() : null))
        .then((build) => {
            if (build) {
                $('buildid').textContent = `Build ${String(build.id).slice(0, 10)}, ${build.built_at || ''}.`;
            }
            return build;
        })
        .catch(() => null);
    showDiskUsage();
}

function precheck() {
    const note = $('precheck');
    const problems = checkEnvironment();
    if (!problems.length) {
        note.textContent = 'This browser supports what Porty needs (threads and shared memory).';
        $('start').disabled = false;
        return;
    }
    const sw = 'serviceWorker' in navigator;
    note.textContent = `${problems.join(' ')} ` + (sw
        ? 'If this is the first visit, the page reloads itself once to fix that. ' +
          'If this message stays, reload manually; private browsing and in-app browsers ' +
          '(the ones inside chat or social apps) do not work. Open the page in Safari or Chrome itself.'
        : 'This browser has no service workers, which Porty needs on this host.');
    // Let people try anyway: the precise error is more useful than a dead button.
    $('start').disabled = false;
}

// -------------------------------------------------------------- machine ---
function setPill(text, kind = '') {
    const pill = $('pill');
    pill.textContent = text;
    pill.dataset.kind = kind;
}

let loggedStage = '';
function onStatus({ stage, detail, progress }) {
    if (stage !== loggedStage) {
        loggedStage = stage;
        const memory = emulator && emulator.wasmMemoryMb
            ? { wasmMb: emulator.wasmMemoryMb, mem: emulator.cfg.mem, tb: emulator.cfg.tb, cache: emulator.cfg.cache }
            : {};
        runLog.update({ stage, ...memory });
    }
    $('stage-text').textContent = stage;
    $('stage-detail').textContent = detail || '';
    const bar = $('bar');
    bar.hidden = progress === undefined;
    if (progress !== undefined) {
        $('bar-fill').style.width = `${Math.round(progress * 100)}%`;
    }
    setPill(stage);
}

function onSerialText(text) {
    // Keep the last few non-empty lines for the overlay and error reports.
    const lines = (lastLogLines.pop() || '') + text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    lastLogLines.push(...lines.split(/\r?\n|\r/));
    if (lastLogLines.length > 200) {
        lastLogLines = lastLogLines.slice(-200);
    }
    if (!graphicsSeen) {
        $('logline').textContent = lastLogLines.filter((l) => l.trim()).slice(-3).join('\n');
    }
}

function showTapRing(ev) {
    const stage = $('stage');
    const box = stage.getBoundingClientRect();
    const ring = document.createElement('div');
    ring.className = 'tap-ring';
    ring.style.left = `${ev.clientX - box.left}px`;
    ring.style.top = `${ev.clientY - box.top}px`;
    ring.addEventListener('animationend', () => ring.remove());
    stage.appendChild(ring);
    // Never more than a few at once, even if animationend does not fire.
    const rings = stage.querySelectorAll('.tap-ring');
    for (let i = 0; i < rings.length - 4; i++) {
        rings[i].remove();
    }
}

function hideOverlay() {
    graphicsSeen = true;
    $('overlay').hidden = true;
}

function fitCanvas() {
    const canvas = $('screen');
    const stage = $('stage');
    const w = canvas.width || 1;
    const h = canvas.height || 1;
    const scale = Math.min(stage.clientWidth / w, stage.clientHeight / h);
    canvas.style.width = `${Math.max(1, Math.floor(w * scale))}px`;
    canvas.style.height = `${Math.max(1, Math.floor(h * scale))}px`;
}

async function keepAwake() {
    try {
        if ('wakeLock' in navigator && document.visibilityState === 'visible') {
            wakeLock = await navigator.wakeLock.request('screen');
        }
    } catch (e) {
        // Not fatal: the screen may simply dim during a long boot.
    }
}

/** QEMU stopped while loading the snapshot: start over with a normal boot. */
function resumeFailed(error) {
    console.warn(`resume failed: ${error.message || error}`);
    // QEMU's own words: the line of migration/porty-snapshot.c if there is
    // one ("chunk 12 (...): HTTP 404"), else the last thing it printed.
    const lines = lastLogLines.filter((l) => l.trim());
    const last = lines.filter((l) => l.includes('porty-snapshot:')).slice(-1)[0] || lines.slice(-1)[0] || '';
    const message = `${error.message || error}${last ? ` ${last.trim()}` : ''}`;
    if (!storeResumeFailure(sessionStore(), message)) {
        // Nowhere to remember it: a reload would only try the same again.
        fail(new StartError(message, 'Add ?resume=0 to the address to boot Android normally.'));
        return;
    }
    runLog.end('resume-failed');
    app.dataset.state = 'reloading';
    location.reload();
}

function fail(error) {
    console.error(error);
    app.dataset.state = 'failed';
    $('machine').hidden = true;
    $('intro').hidden = true;
    $('failure').hidden = false;
    $('fail-message').textContent = error.message || String(error);
    $('fail-hint').textContent = error instanceof StartError ? error.hint : '';
    runLog.end('failed');
    const notes = emulator ? emulator.notes : [];
    const heap = emulator && emulator.heapStats ? emulator.heapStats() : null;
    $('fail-log').textContent = [
        `config: ${describeConfig()}${describeDiet(cfg)}`,
        `browser: ${navigator.userAgent}`,
        `crossOriginIsolated: ${globalThis.crossOriginIsolated}`,
        `service worker: ${navigator.serviceWorker && navigator.serviceWorker.controller ? 'controls the page' : 'none'}`,
        ...(emulator && emulator.wasmMemoryMb ? [`wasm memory: ${emulator.wasmMemoryMb} MiB`] : []),
        ...(heap ? [`QEMU heap: ${heap.used} MiB in use, break at ${heap.brk} MiB` +
            (heap.coroutines !== undefined ? `, ${heap.coroutines} coroutines` : '') +
            (heap.jitAlive !== undefined ? `, ${heap.jitAlive} compiled blocks` : '')] : []),
        ...notes,
        '--- last serial output ---',
        ...lastLogLines.filter((l) => l.trim()).slice(-40),
    ].join('\n');
    if (wakeLock) {
        wakeLock.release().catch(() => {});
    }
}

function renderLoop() {
    const interval = 1000 / cfg.fps;
    let last = 0;
    let lastStats = 0;
    let frames = 0;
    let lastBeat = -1;
    let beatAt = performance.now();
    let darkScreen = false;
    let lastContentCheck = 0;
    let lastLogged = 0;
    let fromDevice = '';

    const tick = (now) => {
        if (app.dataset.state !== 'running') {
            return;
        }
        requestAnimationFrame(tick);
        if (now - last < interval - 1) {
            return;
        }
        last = now;
        const display = emulator.display;
        if (display.update(now)) {
            frames++;
        }
        const resuming = emulator.resumeTick();
        if (resuming) {
            return;
        }
        // Once the guest leaves VGA text mode, hide the overlay as soon as
        // Android draws something.  Until then (no boot animation by
        // default) the black screen alone would look like a hang.
        const textMode = (display.width === 720 && display.height === 400) ||
            (display.width === 640 && display.height === 480);
        if (!graphicsSeen && display.width && !textMode && now - lastContentCheck >= 250) {
            lastContentCheck = now;
            darkScreen = !display.hasContent();
            if (!darkScreen) {
                hideOverlay();
            }
        }
        if (now - lastStats >= 1000) {
            const disk = emulator.diskStats();
            if (now - lastLogged >= 5000) {
                lastLogged = now;
                const heap = emulator.heapStats();
                runLog.update({
                    diskMb: Math.round(disk.megabytes),
                    graphics: graphicsSeen,
                    ...(heap ? { heapUsed: heap.used } : {}),
                });
                // How much of that the device's own copy answered.
                diskCache.stats().then((stats) => {
                    emulator.diskCacheStats = stats;
                    fromDevice = stats && stats.hitBytes ? `, ${megabytes(stats.hitBytes)} from this device` : '';
                }).catch(() => {});
            }
            const beat = display.heartbeat;
            if (beat !== lastBeat) {
                lastBeat = beat;
                beatAt = now;
            }
            const stalled = now - beatAt > 8000;
            const paused = !display.running;
            setPill(paused ? 'Paused' : stalled ? 'Busy' : graphicsSeen ? 'Running' : 'Booting',
                paused || stalled ? 'warn' : graphicsSeen ? 'ok' : '');
            $('btn-pause').textContent = paused ? 'Resume' : 'Pause';
            $('stats').textContent = `${frames} fps, disk ${disk.megabytes.toFixed(0)} MB` +
                fromDevice + (disk.inFlight ? ` (${disk.inFlight} loading)` : '') +
                (disk.errors ? `, ${disk.errors} retries` : '');
            if (!graphicsSeen) {
                if (darkScreen) {
                    $('stage-text').textContent = 'Android is starting';
                }
                $('stage-detail').textContent =
                    `${disk.megabytes.toFixed(0)} MB of the system image read so far` +
                    (disk.errors ? `, ${disk.errors} download retries` : '') +
                    (darkScreen ? '. The screen stays dark until the home screen appears.' : '');
            }
            frames = 0;
            lastStats = now;
        }
    };
    requestAnimationFrame(tick);
}

async function start() {
    $('start').disabled = true;
    $('intro').hidden = true;
    $('machine').hidden = false;
    app.dataset.state = 'starting';
    runLog.begin({
        level: cfg.phoneLevel || 0,
        mem: cfg.mem,
        tb: cfg.tb,
        cache: cfg.cache,
        mobile: cfg.mobile,
        stage: 'Starting',
        hidden: document.visibilityState === 'hidden',
    });
    fitCanvas();
    keepAwake();

    try {
        serial = new SerialConsole(onSerialText);
        emulator = new Emulator({
            cfg,
            canvas: $('screen'),
            serial,
            baseUrl,
            onStatus,
            onFatal: fail,
            resume,
            onResumeFailed: resumeFailed,
            diskCache,
        });
        // For debugging from the browser console (and for tests/ui).
        globalThis.__porty = emulator;
        await emulator.start();
    } catch (error) {
        fail(error);
        return;
    }
    if (app.dataset.state === 'failed') {
        return;
    }
    app.dataset.state = 'running';
    if (cfg.mobile && !cfg.memoryExplicit) {
        // The browser may have refused the memory and QEMU fell back to a
        // smaller step: the next step down must go below what really ran.
        const ran = PHONE_LEVELS.findIndex((l) => l.mem === emulator.cfg.mem);
        runLog.update({ level: Math.max(cfg.phoneLevel || 0, ran), mem: emulator.cfg.mem });
    }
    emulator.display.onResize = fitCanvas;
    emulator.notes.forEach((n) => console.warn(n));
    if (emulator.resumeNote) {
        $('resume-note').textContent = emulator.resumeNote;
        $('resume-note').hidden = false;
    }

    input = new Input(emulator.sendInput, $('screen'), $('softkeys'));
    input.attach();
    // Touching the screen also dismisses the boot overlay (it cannot tell
    // every guest video mode apart from the BIOS text mode).
    $('screen').addEventListener('pointerdown', hideOverlay);
    // A ring where the press landed: Android may take many seconds to show
    // its own reaction, and without this a tap looks lost.
    $('screen').addEventListener('pointerdown', showTapRing);
    if (cfg.serial) {
        toggleSerial(true);
    }
    renderLoop();
}

function toggleSerial(force) {
    const panel = $('serial-panel');
    const show = force === undefined ? panel.hidden : force;
    panel.hidden = !show;
    if (show && serial) {
        try {
            serial.open($('terminal'));
        } catch (e) {
            $('terminal').textContent = String(e.message || e);
        }
    }
    fitCanvas();
}

function bind() {
    $('start').addEventListener('click', start);
    $('nav-back').addEventListener('click', () => input && input.back());
    $('nav-home').addEventListener('click', () => input && input.home());
    $('nav-recents').addEventListener('click', () => input && input.recents());
    $('nav-keyboard').addEventListener('click', () => {
        if (!input) {
            return;
        }
        if (document.activeElement === $('softkeys')) {
            input.hideKeyboard();
        } else {
            input.showKeyboard();
        }
    });
    // Buttons must not steal focus from the hidden text field, or the
    // on-screen keyboard closes every time a navigation button is tapped.
    for (const id of ['nav-back', 'nav-home', 'nav-recents', 'nav-keyboard']) {
        $(id).addEventListener('pointerdown', (ev) => ev.preventDefault());
    }
    $('btn-pause').addEventListener('click', () => {
        if (input && emulator && emulator.display) {
            input.control(emulator.display.running ? CONTROL.PAUSE : CONTROL.RESUME);
        }
    });
    $('btn-reset').addEventListener('click', () => {
        if (input && confirm('Reboot Android? The live session is lost.')) {
            graphicsSeen = false;
            $('overlay').hidden = false;
            onStatus({ stage: 'Rebooting Android' });
            input.control(CONTROL.RESUME);
            input.control(CONTROL.RESET);
        }
    });
    $('btn-serial').addEventListener('click', () => toggleSerial());
    $('btn-full').addEventListener('click', () => {
        const el = $('machine');
        const request = el.requestFullscreen || el.webkitRequestFullscreen;
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (document.fullscreenElement || document.webkitFullscreenElement) {
            exit.call(document);
        } else if (request) {
            Promise.resolve(request.call(el)).catch(() => {});
        }
    });
    $('fail-reload').addEventListener('click', () => location.reload());
    $('diskcache-clear').addEventListener('click', () => {
        $('diskcache-clear').disabled = true;
        diskCache.clear().catch(() => {}).then(() => {
            $('diskcache-clear').disabled = false;
            return showDiskUsage();
        });
    });
    $('lastrun-reset').addEventListener('click', () => {
        runLog.setLevel(0);
        location.reload();
    });
    $('fail-copy').addEventListener('click', () => {
        const text = `${$('fail-message').textContent}\n${$('fail-hint').textContent}\n${$('fail-log').textContent}`;
        if (navigator.clipboard) {
            navigator.clipboard.writeText(text).catch(() => {});
        }
    });
    window.addEventListener('resize', fitCanvas);
    window.addEventListener('orientationchange', fitCanvas);
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', fitCanvas);
    }
    document.addEventListener('visibilitychange', () => {
        runLog.update({ hidden: document.visibilityState === 'hidden' });
        if (document.visibilityState === 'visible' && app.dataset.state === 'running') {
            keepAwake();
        }
    });
    // Closing the tab or navigating away is not a crash.
    window.addEventListener('pagehide', () => runLog.end('left'));
    window.addEventListener('pageshow', (ev) => {
        if (ev.persisted) {
            runLog.resume();
        }
    });
    window.addEventListener('error', (ev) => {
        if (app.dataset.state === 'running' || app.dataset.state === 'starting') {
            console.error('uncaught', ev.message);
        }
    });
    window.addEventListener('beforeunload', (ev) => {
        if (app.dataset.state === 'running') {
            ev.preventDefault();
            ev.returnValue = '';
        }
    });
}

fillIntro();
precheck();
bind();
if (resumeFailure) {
    // Reloaded by resumeFailed(): the visitor already pressed Start.
    start();
}
