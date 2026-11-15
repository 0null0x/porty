// Pointer, touch and keyboard input -> QEMU's input ring.
//
// send(type, a, b, c) is the wasm export porty_input_event (ui/wasmfb.c).
// The guest has a USB tablet (absolute pointer) and a PS/2 keyboard:
//   type 1  pointer position, x and y in 0..0x7fff
//   type 2  button (0 left, 1 middle, 2 right), down
//   type 3  key (Linux evdev code), down
//   type 4  wheel (+1 up, -1 down)
//   type 10 control (1 reset, 2 pause, 3 resume)
// SPDX-License-Identifier: GPL-2.0-or-later

import { CODE_TO_EVDEV, KEY, charToKey } from './keymap.js';

const EV = { ABS: 1, BTN: 2, KEY: 3, WHEEL: 4, CONTROL: 10 };
const ABS_MAX = 0x7fff;

export const CONTROL = { RESET: 1, PAUSE: 2, RESUME: 3 };

/** Map a client position to tablet coordinates for a canvas rectangle. */
export function toTablet(clientX, clientY, rect) {
    const fx = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    const fy = rect.height > 0 ? (clientY - rect.top) / rect.height : 0;
    const clamp = (f) => Math.max(0, Math.min(ABS_MAX, Math.round(f * ABS_MAX)));
    return [clamp(fx), clamp(fy)];
}

export class Input {
    /**
     * @param {(type:number,a:number,b:number,c:number)=>number} send
     * @param {HTMLCanvasElement} canvas
     * @param {HTMLInputElement} textInput  hidden field that owns the soft keyboard
     */
    constructor(send, canvas, textInput) {
        this.send = send;
        this.canvas = canvas;
        this.textInput = textInput;
        this.activePointer = null;
        this.pressedKeys = new Set();
        this.dropped = 0;
        this.listeners = [];
    }

    emit(type, a = 0, b = 0, c = 0) {
        if (!this.send(type, a, b, c)) {
            this.dropped++;
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

    releaseAll() {
        for (const code of this.pressedKeys) {
            this.key(code, false);
        }
        this.pressedKeys.clear();
        if (this.activePointer !== null) {
            this.emit(EV.BTN, 0, 0);
            this.activePointer = null;
        }
    }

    on(target, type, handler, options) {
        target.addEventListener(type, handler, options);
        this.listeners.push(() => target.removeEventListener(type, handler, options));
    }

    attach() {
        const canvas = this.canvas;
        const move = (ev) => {
            const [x, y] = toTablet(ev.clientX, ev.clientY, canvas.getBoundingClientRect());
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
            try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
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
        this.on(canvas, 'contextmenu', (ev) => ev.preventDefault());
        this.on(canvas, 'wheel', (ev) => {
            ev.preventDefault();
            if (ev.deltaY) {
                this.emit(EV.WHEEL, ev.deltaY < 0 ? 1 : -1);
            }
        }, { passive: false });

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
