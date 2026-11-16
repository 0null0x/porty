# web/

The static page. No build step: `scripts/assemble-site.sh` copies these files
into the site next to the QEMU build (`qemu/`) and the Android image (`image/`).

| File | Role |
| --- | --- |
| `index.html`, `css/style.css` | Mobile-first UI |
| `coi-serviceworker.js` | coi-serviceworker 0.1.7 (MIT) with two marked additions that hand chunk requests to `js/diskcache-sw.js`; must sit at the site root |
| `js/main.js` | DOM wiring, status, render loop |
| `js/emulator.js` | Downloads, WebAssembly memory, Emscripten `Module`, start-up |
| `js/config.js` | URL parameters to config; memory sizing rules |
| `js/qemu-args.js` | Kernel command line and QEMU argv |
| `js/diskcache.js` | The disk cache, page side: `?diskcache=`, the settings for the service worker, persistent storage, what is stored |
| `js/diskcache-sw.js` | The disk cache, service-worker side (a classic script): chunks of the image and of the snapshot are answered from Cache Storage and stored there |
| `js/snapshot.js` | Resuming a saved Android: snapshot manifest checks, its QEMU argv, the chunk index for QEMU |
| `js/wasm-patch.js` | Rewrites the module's memory import limits |
| `js/display.js` | Shared-memory framebuffer to canvas |
| `js/input.js`, `js/keymap.js` | Pointer, touch, keyboard to QEMU's input ring |
| `js/serial.js` | Serial console (PTY sink, xterm.js on demand) |
| `package.json`, `package-lock.json` | Pins xterm.js and xterm-pty, copied into `vendor/` at build time |
