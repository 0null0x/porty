// Keyboard tables: browser key identifiers -> Linux evdev key codes.
// QEMU turns the evdev code into its own QKeyCode (qemu_input_linux_to_qcode)
// so no QEMU-version-specific numbers live in JavaScript.
// SPDX-License-Identifier: GPL-2.0-or-later

export const KEY = {
    ESC: 1, BACKSPACE: 14, TAB: 15, ENTER: 28, LEFTCTRL: 29, LEFTSHIFT: 42,
    LEFTALT: 56, SPACE: 57, HOME: 102, UP: 103, LEFT: 105, RIGHT: 106,
    DOWN: 108, DELETE: 111, COMPOSE: 127, LEFTMETA: 125,
    BACK: 158,      // Android BACK   (Generic.kl: key 158 BACK)
    HOMEPAGE: 172,  // Android HOME   (Generic.kl: key 172 HOME)
    VOLUMEDOWN: 114, VOLUMEUP: 115,
};

// KeyboardEvent.code -> evdev
export const CODE_TO_EVDEV = {
    Escape: 1, Digit1: 2, Digit2: 3, Digit3: 4, Digit4: 5, Digit5: 6,
    Digit6: 7, Digit7: 8, Digit8: 9, Digit9: 10, Digit0: 11, Minus: 12,
    Equal: 13, Backspace: 14, Tab: 15, KeyQ: 16, KeyW: 17, KeyE: 18,
    KeyR: 19, KeyT: 20, KeyY: 21, KeyU: 22, KeyI: 23, KeyO: 24, KeyP: 25,
    BracketLeft: 26, BracketRight: 27, Enter: 28, ControlLeft: 29, KeyA: 30,
    KeyS: 31, KeyD: 32, KeyF: 33, KeyG: 34, KeyH: 35, KeyJ: 36, KeyK: 37,
    KeyL: 38, Semicolon: 39, Quote: 40, Backquote: 41, ShiftLeft: 42,
    Backslash: 43, KeyZ: 44, KeyX: 45, KeyC: 46, KeyV: 47, KeyB: 48,
    KeyN: 49, KeyM: 50, Comma: 51, Period: 52, Slash: 53, ShiftRight: 54,
    NumpadMultiply: 55, AltLeft: 56, Space: 57, CapsLock: 58, F1: 59,
    F2: 60, F3: 61, F4: 62, F5: 63, F6: 64, F7: 65, F8: 66, F9: 67,
    F10: 68, NumLock: 69, ScrollLock: 70, Numpad7: 71, Numpad8: 72,
    Numpad9: 73, NumpadSubtract: 74, Numpad4: 75, Numpad5: 76, Numpad6: 77,
    NumpadAdd: 78, Numpad1: 79, Numpad2: 80, Numpad3: 81, Numpad0: 82,
    NumpadDecimal: 83, IntlBackslash: 86, F11: 87, F12: 88,
    NumpadEnter: 96, ControlRight: 97, NumpadDivide: 98, AltRight: 100,
    Home: 102, ArrowUp: 103, PageUp: 104, ArrowLeft: 105, ArrowRight: 106,
    End: 107, ArrowDown: 108, PageDown: 109, Insert: 110, Delete: 111,
    MetaLeft: 125, MetaRight: 126, ContextMenu: 127,
};

// Printable ASCII on a US layout -> [evdev, needsShift]
const PLAIN = "`1234567890-=qwertyuiop[]\\asdfghjkl;'zxcvbnm,./ ";
const SHIFT = '~!@#$%^&*()_+QWERTYUIOP{}|ASDFGHJKL:"ZXCVBNM<>? ';
const PLAIN_CODES = [
    41, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
    16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 43,
    30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40,
    44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 57,
];

const CHAR_TABLE = new Map();
for (let i = 0; i < PLAIN.length; i++) {
    CHAR_TABLE.set(PLAIN[i], [PLAIN_CODES[i], false]);
    if (!CHAR_TABLE.has(SHIFT[i])) {
        CHAR_TABLE.set(SHIFT[i], [PLAIN_CODES[i], true]);
    }
}
CHAR_TABLE.set('\n', [KEY.ENTER, false]);
CHAR_TABLE.set('\r', [KEY.ENTER, false]);
CHAR_TABLE.set('\t', [KEY.TAB, false]);

// Typographic characters phone keyboards like to substitute.
const FOLD = { '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', ' ': ' ', '…': '.' };

/** @returns {[number, boolean]|null} evdev code and whether Shift is needed */
export function charToKey(ch) {
    return CHAR_TABLE.get(FOLD[ch] || ch) || null;
}
