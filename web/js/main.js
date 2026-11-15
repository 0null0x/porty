// Porty page logic: wires the DOM to the emulator.
// SPDX-License-Identifier: GPL-2.0-or-later

import { PARAM_HELP, parseConfig, requiredWasmMemoryMb } from './config.js';
import { Emulator, StartError, checkEnvironment } from './emulator.js';
import { CONTROL, Input } from './input.js';
import { SerialConsole } from './serial.js';

const $ = (id) => document.getElementById(id);
const app = $('app');
const cfg = parseConfig(location.search, {
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints,
});
const baseUrl = new URL('.', location.href).href;

let emulator = null;
let input = null;
let serial = null;
let wakeLock = null;
let graphicsSeen = false;
let lastLogLines = [];

// ---------------------------------------------------------------- intro ---
function describeConfig() {
    return `mem=${cfg.mem} tb=${cfg.tb} smp=${cfg.smp} cpu=${cfg.cpu} res=${cfg.width}x${cfg.height} ` +
        `dpi=${cfg.dpi} gfx=${cfg.gfx} disk=${cfg.disk}` + (cfg.mobile ? ' (phone defaults)' : '');
}

function fillIntro() {
    $('cfgline').textContent = describeConfig();
    $('memnote').textContent =
        `${cfg.mem} MB of RAM is reserved for the guest (about ${requiredWasmMemoryMb(cfg)} MB in total).`;
    const table = $('params');
    for (const [name, text] of PARAM_HELP) {
        const row = table.insertRow();
        row.insertCell().textContent = `?${name}=`;
        row.insertCell().textContent = text;
    }
    fetch(`${baseUrl}build.json`, { cache: 'no-cache' })
        .then((r) => (r.ok ? r.json() : null))
        .then((build) => {
            if (build) {
                $('buildid').textContent = `Build ${String(build.id).slice(0, 10)}, ${build.built_at || ''}.`;
            }
        })
        .catch(() => {});
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

function onStatus({ stage, detail, progress }) {
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

function fail(error) {
    console.error(error);
    app.dataset.state = 'failed';
    $('machine').hidden = true;
    $('intro').hidden = true;
    $('failure').hidden = false;
    $('fail-message').textContent = error.message || String(error);
    $('fail-hint').textContent = error instanceof StartError ? error.hint : '';
    const notes = emulator ? emulator.notes : [];
    $('fail-log').textContent = [
        `config: ${describeConfig()}`,
        `browser: ${navigator.userAgent}`,
        `crossOriginIsolated: ${globalThis.crossOriginIsolated}`,
        ...(emulator && emulator.wasmMemoryMb ? [`wasm memory: ${emulator.wasmMemoryMb} MiB`] : []),
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
        if (!graphicsSeen && display.width && !(display.width === 720 && display.height === 400) &&
            !(display.width === 640 && display.height === 480)) {
            // The guest left VGA text mode: Android's graphics stack is up.
            graphicsSeen = true;
            $('overlay').hidden = true;
        }
        if (now - lastStats >= 1000) {
            const disk = emulator.diskStats();
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
                (disk.inFlight ? ` (${disk.inFlight} loading)` : '') +
                (disk.errors ? `, ${disk.errors} retries` : '');
            if (!graphicsSeen) {
                $('stage-detail').textContent =
                    `${disk.megabytes.toFixed(0)} MB of the system image read so far` +
                    (disk.errors ? `, ${disk.errors} download retries` : '');
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
    emulator.display.onResize = fitCanvas;
    emulator.notes.forEach((n) => console.warn(n));

    input = new Input(emulator.sendInput, $('screen'), $('softkeys'));
    input.attach();
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
        if (document.visibilityState === 'visible' && app.dataset.state === 'running') {
            keepAwake();
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
