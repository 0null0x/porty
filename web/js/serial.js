// Serial console plumbing.
//
// QEMU-Wasm links xterm-pty's Emscripten library: the guest's serial port
// ("-serial mon:stdio") and QEMU's own stdout/stderr end up in a PTY whose
// other end is normally an xterm.js terminal.  Porty always needs the text
// (boot progress, error reports) but only sometimes a visible terminal, so
// this class sits where the terminal would be, keeps a backlog, and creates
// the real xterm.js instance on demand.
// SPDX-License-Identifier: GPL-2.0-or-later

const BACKLOG_BYTES = 256 * 1024;

export class SerialConsole {
    /** @param {(text: string) => void} onText */
    constructor(onText) {
        if (typeof globalThis.openpty !== 'function') {
            throw new Error('xterm-pty did not load (vendor/xterm-pty.js)');
        }
        const { master, slave } = globalThis.openpty();
        this.slave = slave;
        this.onText = onText;
        this.decoder = new TextDecoder('utf-8', { fatal: false });
        this.backlog = [];
        this.backlogBytes = 0;
        this.inputHandlers = [];
        this.resizeHandlers = [];
        this.term = null;
        // The PTY master only needs these four methods of a "terminal".
        master.activate(this);
    }

    // --- the terminal interface xterm-pty's master talks to --------------
    write(data, done) {
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        this.backlog.push(bytes);
        this.backlogBytes += bytes.length;
        while (this.backlogBytes > BACKLOG_BYTES && this.backlog.length > 1) {
            this.backlogBytes -= this.backlog.shift().length;
        }
        try {
            this.onText(this.decoder.decode(bytes, { stream: true }));
        } catch (e) {
            console.error(e);
        }
        if (this.term) {
            this.term.write(bytes, done);
        } else if (done) {
            // not synchronously: the master calls us back recursively
            Promise.resolve().then(done);
        }
    }

    onData(handler) {
        this.inputHandlers.push(handler);
        return { dispose: () => {} };
    }

    onBinary(handler) {
        return this.onData(handler);
    }

    onResize(handler) {
        this.resizeHandlers.push(handler);
        return { dispose: () => {} };
    }

    // --- optional visible terminal ---------------------------------------
    /** Send text to the guest's serial port (and QEMU's monitor mux). */
    send(text) {
        this.inputHandlers.forEach((h) => h(text));
    }

    /** Create the xterm.js terminal inside `container` (once). */
    open(container) {
        if (this.term) {
            return this.term;
        }
        if (typeof globalThis.Terminal !== 'function') {
            throw new Error('xterm.js did not load (vendor/xterm.js)');
        }
        const term = new globalThis.Terminal({
            cols: 80,
            rows: 24,
            fontSize: 12,
            scrollback: 5000,
            convertEol: false,
        });
        term.open(container);
        this.backlog.forEach((bytes) => term.write(bytes));
        term.onData((d) => this.send(d));
        term.onBinary((d) => this.send(d));
        term.onResize(({ cols, rows }) => this.resizeHandlers.forEach((h) => h({ cols, rows })));
        this.term = term;
        return term;
    }

    /** Last `count` complete lines seen so far. */
    tail(count = 40) {
        const decoder = new TextDecoder('utf-8', { fatal: false });
        const text = this.backlog.slice(-64).map((b) => decoder.decode(b, { stream: true })).join('');
        return text.split(/\r?\n/).slice(-count).join('\n');
    }
}
