# web/

The static page. No build step: `scripts/assemble-site.sh` copies these files
into the site next to the QEMU build (`qemu/`) and the Android image (`image/`).

| File | Role |
| --- | --- |
| `index.html`, `css/style.css` | Mobile-first UI |
| `coi-serviceworker.js` | Unmodified coi-serviceworker 0.1.7 (MIT); must sit at the site root |
| `js/main.js` | DOM wiring, status, render loop |
| `js/emulator.js` | Downloads, WebAssembly memory, Emscripten `Module`, start-up |
| `js/config.js` | URL parameters to config; memory sizing rules |
| `js/qemu-args.js` | Kernel command line and QEMU argv |
| `js/wasm-patch.js` | Rewrites the module's memory import limits |
| `js/display.js` | Shared-memory framebuffer to canvas |
| `js/input.js`, `js/keymap.js` | Pointer, touch, keyboard to QEMU's input ring |
| `js/serial.js` | Serial console (PTY sink, xterm.js on demand) |
| `package.json`, `package-lock.json` | Pins xterm.js and xterm-pty, copied into `vendor/` at build time |
