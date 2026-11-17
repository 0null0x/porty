// Pointer, touch and keyboard input -> QEMU's input ring.
//
// send(type, a, b, c) is the wasm export porty_input_event (ui/wasmfb.c).
// The guest has a PS/2 keyboard and a pointing device: a touchscreen
// (virtio multitouch, ring ABI 2, patch 0020) unless the page runs with
// touch=0, which gives Android the USB tablet, an absolute mouse.
//   type 1  pointer position, x and y in 0..0x7fff      (tablet)
//   type 2  button (0 left, 1 middle, 2 right), down    (tablet)
//   type 3  key (Linux evdev code), down
//   type 4  wheel (+1 up, -1 down)                      (tablet)
//   type 5  finger down: slot 0..9, x and y in 0..0x7fff (touchscreen)
//   type 6  finger moved: slot, x, y                    (touchscreen)
//   type 7  finger lifted: slot                         (touchscreen)
//   type 10 control (1 reset, 2 pause, 3 resume)
// SPDX-License-Identifier: GPL-2.0-or-later

import { CODE_TO_EVDEV, KEY, charToKey } from './keymap.js';

const EV = { ABS: 1, BTN: 2, KEY: 3, WHEEL: 4, TOUCH_DOWN: 5, TOUCH_MOVE: 6, TOUCH_UP: 7, CONTROL: 10 };
const ABS_MAX = 0x7fff;

export const CONTROL = { RESET: 1, PAUSE: 2, RESUME: 3 };

// Fingers QEMU's multitouch device takes at once (INPUT_EVENT_SLOTS_MAX).
export const TOUCH_SLOTS = 10;
// The wheel's finger stays this far from the screen's edges (tablet units).
export const WHEEL_MARGIN = Math.round(0.06 * ABS_MAX);
// Android 9's velocity tracker (VelocityTracker.cpp, "lsq2") fits the
// moves of the last 100 ms of guest time and ignores the lift, so a finger
// that rests and then lifts flings with the speed it had before it
// stopped, unless the device keeps reporting it.  A touchscreen does: so
// do the fingers here, every KEEP_MS while they rest, 1/32768 of the
// screen to and fro (a report that changes nothing can be dropped on the
// way).  A finger that rests for the horizon (FLING_HORIZON_MS times the
// time dilation in real time) then lifts without a fling.
export const FLING_HORIZON_MS = 100;
export const KEEP_MS = 100;
// A wheel's line (deltaMode 1), in CSS pixels.
const LINE_PX = 40;
// Android's touch slop (8 dp) and a little more, in tablet units [x, y],
// for a 480x800 screen at 160 dpi; see touchSlop() for others.  A wheel's
// finger first moves this much farther, or a small scroll would be a
// finger that lifts where it came down: a tap on whatever is there.
const DEFAULT_SLOP = [Math.round((12 / 480) * ABS_MAX), Math.round((12 / 800) * ABS_MAX)];

/** Android's touch slop plus a margin in tablet units, for a screen of width x height at dpi. */
export function touchSlop(width, height, dpi) {
    const px = Math.ceil((8 * (dpi || 160)) / 160) + 4;
    return [Math.round((px / (width || 480)) * ABS_MAX), Math.round((px / (height || 800)) * ABS_MAX)];
}
// A pinch of the trackpad (ctrl+wheel): fingers start this far from the
// pointer, and a wheel delta of 100 pixels spreads them by e.
const PINCH_START = Math.round(0.12 * ABS_MAX);
const PINCH_PX = 100;

/** Map a client position to tablet coordinates for a canvas rectangle. */
export function toTablet(clientX, clientY, rect) {
    const fx = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    const fy = rect.height > 0 ? (clientY - rect.top) / rect.height : 0;
    const clamp = (f) => Math.max(0, Math.min(ABS_MAX, Math.round(f * ABS_MAX)));
    return [clamp(fx), clamp(fy)];
}

/** A wheel event's deltas in CSS pixels. */
export function wheelPixels(ev, pageHeight) {
    const unit = ev.deltaMode === 1 ? LINE_PX : ev.deltaMode === 2 ? pageHeight : 1;
    return [(ev.deltaX || 0) * unit, (ev.deltaY || 0) * unit];
}

export class Input {
    /**
     * @param {(type:number,a:number,b:number,c:number)=>number} send
     * @param {HTMLCanvasElement} canvas
     * @param {HTMLInputElement} textInput  hidden field that owns the soft keyboard
     * @param {{mode?: string, timescale?: number, slop?: number[]}} [options]
     *        mode: 'touch' (a touchscreen, the default), 'tablet' (the USB
     *        tablet, touch=0) or 'none' (usb=0); timescale: the guest's
     *        time dilation (?timescale=), for how long the wheel's finger
     *        rests; slop: touchSlop() of the guest's screen
     */
    constructor(send, canvas, textInput, options = {}) {
        this.send = send;
        this.canvas = canvas;
        this.textInput = textInput;
        this.mode = options.mode || 'touch';
        this.timescale = Math.max(1, Number(options.timescale) || 1);
        this.slop = Array.isArray(options.slop) ? options.slop : DEFAULT_SLOP;
        this.activePointer = null;   // tablet: the pointer that holds the button
        this.fingers = new Map();    // touchscreen: pointerId -> { slot, x, y }
        this.wheel = null;           // touchscreen: the wheel's fingers, see wheelDrag()
        this.keepTimer = 0;
        this.pressedKeys = new Set();
        this.dropped = 0;
        this.listeners = [];
    }

    emit(type, a = 0, b = 0, c = 0) {
        if (this.send(type, a, b, c)) {
            return true;
        }
        this.dropped++;
        // A lifted finger must reach Android, or it stays down there.
        if (type === EV.TOUCH_UP) {
            this.retryUp(a, b, c, 20);
        }
        return false;
    }

    retryUp(slot, x, y, tries) {
        const timer = setTimeout(() => {
            if (!this.send(EV.TOUCH_UP, slot, x, y) && tries > 1) {
                this.retryUp(slot, x, y, tries - 1);
            }
        }, 50);
        if (timer && timer.unref) {
            timer.unref();
        }
    }

    key(code, down) {
        this.emit(EV.KEY, code, down ? 1 : 0);
    }

    tap(code) {
        this.key(code, true);
        this.key(code, false);
    }

    /** Hold the modifiers, tap the key, release in reverse order. */
    chord(modifiers, code) {
        modifiers.forEach((m) => this.key(m, true));
        this.tap(code);
        [...modifiers].reverse().forEach((m) => this.key(m, false));
    }

    typeText(text) {
        for (const ch of text) {
            const hit = charToKey(ch);
            if (!hit) {
                continue;
            }
            const [code, shift] = hit;
            if (shift) {
                this.chord([KEY.LEFTSHIFT], code);
            } else {
                this.tap(code);
            }
        }
    }

    // Android navigation, as Android-x86's key layout understands it.
    back() { this.tap(KEY.BACK); }
    home() { this.tap(KEY.HOMEPAGE); }
    recents() { this.chord([KEY.LEFTALT], KEY.TAB); }
    menu() { this.tap(KEY.COMPOSE); }

    control(command) {
        this.emit(EV.CONTROL, command);
    }

    // --- touchscreen ------------------------------------------------------
    /** The lowest slot no finger holds, -1 if all do. */
    freeSlot() {
        const used = new Set([...this.fingers.values()].map((f) => f.slot));
        for (const f of this.wheel ? this.wheel.fingers : []) {
            used.add(f.slot);
        }
        for (let slot = 0; slot < TOUCH_SLOTS; slot++) {
            if (!used.has(slot)) {
                return slot;
            }
        }
        return -1;
    }

    /** Every finger that is down: real ones and the wheel's. */
    allFingers() {
        return [...this.fingers.values(), ...(this.wheel ? this.wheel.fingers : [])];
    }

    /** A finger comes down in `slot`; returns its record. */
    press(slot, x, y) {
        const f = { slot, x, y, at: Date.now(), jitter: 0 };
        this.emit(EV.TOUCH_DOWN, slot, x, y);
        this.keepReporting();
        return f;
    }

    /** A finger moves (nothing if it stays where it was). */
    slide(f, x, y) {
        if (f.x === x && f.y === y) {
            return;
        }
        f.x = x;
        f.y = y;
        f.at = Date.now();
        this.emit(EV.TOUCH_MOVE, f.slot, x, y);
    }

    /** While fingers rest, report one of them now and then (see KEEP_MS). */
    keepReporting() {
        if (this.keepTimer) {
            return;
        }
        const tick = () => {
            const all = this.allFingers();
            if (!all.length) {
                clearInterval(this.keepTimer);
                this.keepTimer = 0;
                return;
            }
            const now = Date.now();
            // Every report carries every finger (ui/wasmfb.c): one will do.
            if (all.every((f) => now - f.at >= KEEP_MS)) {
                const f = all[0];
                f.jitter ^= 1;
                f.at = now;
                this.emit(EV.TOUCH_MOVE, f.slot, f.x < ABS_MAX ? f.x + f.jitter : f.x - f.jitter, f.y);
            }
        };
        this.keepTimer = setInterval(tick, KEEP_MS);
        if (this.keepTimer && this.keepTimer.unref) {
            this.keepTimer.unref();
        }
    }

    /** A finger (or pen, or the mouse's button) came down; false if it was not sent. */
    fingerDown(id, x, y) {
        this.endWheel();
        if (this.fingers.has(id)) {
            return false;
        }
        const slot = this.freeSlot();
        if (slot < 0) {
            return false;
        }
        this.fingers.set(id, this.press(slot, x, y));
        return true;
    }

    fingerMove(id, x, y) {
        const f = this.fingers.get(id);
        if (f) {
            this.slide(f, x, y);
        }
    }

    fingerUp(id) {
        const f = this.fingers.get(id);
        if (!f) {
            return;
        }
        this.fingers.delete(id);
        this.emit(EV.TOUCH_UP, f.slot, f.x, f.y);
    }

    /** How long the wheel's fingers rest before they lift: no fling then. */
    wheelRestMs() {
        return FLING_HORIZON_MS * this.timescale + 2 * KEEP_MS;
    }

    /**
     * The wheel and a trackpad's two-finger scrolling drag the screen with a
     * finger that comes down where the pointer is, moves against the scroll
     * (content follows it) and stays inside the screen; its first move is
     * longer by Android's touch slop, which Android does not scroll by (and
     * a finger that moved less would be a tap); it lifts once the wheel has
     * rested long enough for Android to see no fling, or when a real finger
     * or button comes down.  A trackpad's pinch (ctrl+wheel) spreads or
     * closes two fingers around the pointer.  Not while a finger or button
     * is down.
     */
    wheelDrag(ev, rect) {
        if (this.fingers.size || !(rect.width > 0 && rect.height > 0)) {
            return;
        }
        let [dx, dy] = wheelPixels(ev, rect.height);
        if (ev.shiftKey && !dx) {
            [dx, dy] = [dy, 0];
        }
        if (!dx && !dy) {
            return;
        }
        const pinch = !!ev.ctrlKey;
        if (this.wheel && this.wheel.pinch !== pinch) {
            this.endWheel();
        }
        const lo = WHEEL_MARGIN;
        const hi = ABS_MAX - WHEEL_MARGIN;
        const inside = (v) => Math.max(lo, Math.min(hi, Math.round(v)));
        let w = this.wheel;
        if (!w) {
            const [x, y] = toTablet(ev.clientX, ev.clientY, rect);
            const at = pinch ? [[x - PINCH_START, y], [x + PINCH_START, y]] : [[x, y]];
            w = this.wheel = { pinch, cx: inside(x), cy: inside(y), spread: PINCH_START, fingers: [], timer: 0, fresh: true };
            for (const [fx, fy] of at) {
                w.fingers.push(this.press(this.freeSlot(), inside(fx), inside(fy)));
            }
        }
        const [slopX, slopY] = w.fresh ? this.slop : [0, 0];
        w.fresh = false;
        if (pinch) {
            // Wheel up (negative) zooms in: the fingers spread.
            const spread = w.spread * Math.exp(-dy / PINCH_PX) + Math.sign(-dy) * slopX;
            w.spread = Math.max(0.02 * ABS_MAX, Math.min(0.45 * ABS_MAX, spread));
            const [a, b] = w.fingers;
            this.slide(a, inside(w.cx - w.spread), a.y);
            this.slide(b, inside(w.cx + w.spread), b.y);
        } else {
            // In tablet units; the finger moves against the scroll, the
            // first time by the slop more along the longer of the two axes.
            const f = w.fingers[0];
            const mx = -(dx / rect.width) * ABS_MAX;
            const my = -(dy / rect.height) * ABS_MAX;
            const along = Math.abs(dy) >= Math.abs(dx);
            this.slide(f, inside(f.x + mx + (along ? 0 : Math.sign(mx) * slopX)),
                inside(f.y + my + (along ? Math.sign(my) * slopY : 0)));
        }
        clearTimeout(w.timer);
        w.timer = setTimeout(() => this.endWheel(), this.wheelRestMs());
        if (w.timer && w.timer.unref) {
            w.timer.unref();
        }
    }

    endWheel() {
        const w = this.wheel;
        if (!w) {
            return;
        }
        this.wheel = null;
        clearTimeout(w.timer);
        for (const f of [...w.fingers].reverse()) {
            this.emit(EV.TOUCH_UP, f.slot, f.x, f.y);
        }
    }

    releaseAll() {
        for (const code of this.pressedKeys) {
            this.key(code, false);
        }
        this.pressedKeys.clear();
        if (this.activePointer !== null) {
            this.emit(EV.BTN, this.activeButton || 0, 0);
            this.activePointer = null;
        }
        for (const id of [...this.fingers.keys()]) {
            this.fingerUp(id);
        }
        this.endWheel();
    }

    on(target, type, handler, options) {
        target.addEventListener(type, handler, options);
        this.listeners.push(() => target.removeEventListener(type, handler, options));
    }

    attach() {
        const canvas = this.canvas;
        const at = (ev) => toTablet(ev.clientX, ev.clientY, canvas.getBoundingClientRect());
        const capture = (ev) => {
            try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
        };
        if (this.mode === 'touch') {
            this.attachTouch(canvas, at, capture);
        } else if (this.mode === 'tablet') {
            this.attachTablet(canvas, at, capture);
        }
        this.on(canvas, 'contextmenu', (ev) => ev.preventDefault());
        this.attachKeyboard();
    }

    /**
     * Touchscreen: every finger (and pen) is a finger on Android's screen,
     * in a slot of its own; so is the mouse while its left button is down.
     * The mouse's right button is Back; hovering does nothing; the wheel
     * drags (wheelDrag()).
     */
    attachTouch(canvas, at, capture) {
        this.on(canvas, 'pointerdown', (ev) => {
            ev.preventDefault();
            if (ev.pointerType === 'mouse' && ev.button !== 0) {
                if (ev.button === 2) {
                    this.back();
                }
                return;
            }
            const [x, y] = at(ev);
            if (this.fingerDown(ev.pointerId, x, y)) {
                capture(ev);
            }
        });
        this.on(canvas, 'pointermove', (ev) => {
            if (!this.fingers.has(ev.pointerId)) {
                return;
            }
            ev.preventDefault();
            const [x, y] = at(ev);
            this.fingerMove(ev.pointerId, x, y);
        });
        const up = (ev) => {
            if (!this.fingers.has(ev.pointerId)) {
                return;
            }
            ev.preventDefault();
            if (ev.type === 'pointerup') {
                const [x, y] = at(ev);
                this.fingerMove(ev.pointerId, x, y);
            }
            this.fingerUp(ev.pointerId);
        };
        this.on(canvas, 'pointerup', up);
        this.on(canvas, 'pointercancel', up);
        // Capture lost without an up (the element went away, a dialog): lift.
        this.on(canvas, 'lostpointercapture', up);
        this.on(canvas, 'wheel', (ev) => {
            ev.preventDefault();
            this.wheelDrag(ev, canvas.getBoundingClientRect());
        }, { passive: false });
    }

    /** USB tablet (touch=0): one pointer, absolute moves and buttons, as before. */
    attachTablet(canvas, at, capture) {
        const move = (ev) => {
            const [x, y] = at(ev);
            this.emit(EV.ABS, x, y);
        };
        const button = (ev) => (ev.pointerType === 'mouse' && ev.button === 2 ? 2
            : ev.pointerType === 'mouse' && ev.button === 1 ? 1 : 0);

        this.on(canvas, 'pointerdown', (ev) => {
            if (this.activePointer !== null && ev.pointerId !== this.activePointer) {
                return; // single pointer: ignore additional fingers
            }
            ev.preventDefault();
            this.activePointer = ev.pointerId;
            this.activeButton = button(ev);
            capture(ev);
            move(ev);
            this.emit(EV.BTN, this.activeButton, 1);
        });
        this.on(canvas, 'pointermove', (ev) => {
            if (this.activePointer === null) {
                if (ev.pointerType === 'mouse') {
                    move(ev); // hover moves the Android mouse cursor
                }
                return;
            }
            if (ev.pointerId !== this.activePointer) {
                return;
            }
            ev.preventDefault();
            // Coalesced events are not needed: the tablet is polled anyway.
            move(ev);
        });
        const up = (ev) => {
            if (ev.pointerId !== this.activePointer) {
                return;
            }
            ev.preventDefault();
            if (ev.type === 'pointerup') {
                move(ev);
            }
            this.emit(EV.BTN, this.activeButton, 0);
            this.activePointer = null;
        };
        this.on(canvas, 'pointerup', up);
        this.on(canvas, 'pointercancel', up);
        this.on(canvas, 'wheel', (ev) => {
            ev.preventDefault();
            if (ev.deltaY) {
                this.emit(EV.WHEEL, ev.deltaY < 0 ? 1 : -1);
            }
        }, { passive: false });
    }

    attachKeyboard() {
        // Hardware keyboard.
        const fromTextInput = (ev) => ev.target === this.textInput;
        const editable = (ev) => !fromTextInput(ev) && ev.target instanceof HTMLElement &&
            (ev.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(ev.target.tagName));
        this.on(window, 'keydown', (ev) => {
            if (editable(ev) || ev.isComposing) {
                return;
            }
            const code = CODE_TO_EVDEV[ev.code];
            if (!code) {
                return;
            }
            // Text typed into the hidden field arrives through beforeinput;
            // only let non-text keys and shortcuts through here.
            if (fromTextInput(ev) && ev.key.length === 1 && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
                return;
            }
            if (fromTextInput(ev) && (ev.code === 'Backspace' || ev.code === 'Enter')) {
                return;
            }
            ev.preventDefault();
            this.pressedKeys.add(code);
            this.key(code, true);
        });
        this.on(window, 'keyup', (ev) => {
            const code = CODE_TO_EVDEV[ev.code];
            if (code && this.pressedKeys.delete(code)) {
                ev.preventDefault();
                this.key(code, false);
            }
        });
        this.on(window, 'blur', () => this.releaseAll());

        // Soft keyboard: a hidden text field that always holds one character
        // so that Backspace still produces an event on iOS.
        const field = this.textInput;
        const reset = () => {
            field.value = '_';
            try { field.setSelectionRange(1, 1); } catch (e) { /* ignore */ }
        };
        reset();
        this.on(field, 'focus', reset);
        this.on(field, 'beforeinput', (ev) => {
            switch (ev.inputType) {
            case 'insertText':
            case 'insertReplacementText':
            case 'insertFromPaste':
                if (ev.data) {
                    this.typeText(ev.data);
                }
                break;
            case 'insertLineBreak':
            case 'insertParagraph':
                this.tap(KEY.ENTER);
                break;
            case 'deleteContentBackward':
            case 'deleteWordBackward':
            case 'deleteSoftLineBackward':
                this.tap(KEY.BACKSPACE);
                break;
            case 'deleteContentForward':
                this.tap(KEY.DELETE);
                break;
            case 'insertCompositionText':
            case 'deleteCompositionText':
                return; // IME in progress: handled at compositionend
            default:
                break;
            }
            ev.preventDefault();
        });
        this.on(field, 'compositionend', (ev) => {
            if (ev.data) {
                this.typeText(ev.data);
            }
            reset();
        });
        this.on(field, 'input', reset);
    }

    detach() {
        this.releaseAll();
        this.listeners.splice(0).forEach((off) => off());
    }

    showKeyboard() {
        this.textInput.focus({ preventScroll: true });
    }

    hideKeyboard() {
        this.textInput.blur();
    }
}
