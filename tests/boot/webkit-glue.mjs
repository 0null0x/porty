// Rewrites of QEMU-Wasm's JavaScript glue (qemu/out.js, Emscripten 3.1.50)
// for the WebKit memory experiments (tests/boot/webkit-test.mjs, GLUE):
//
//   count  counters of what the glue does, in the WebAssembly memory that
//          every thread shares (below Emscripten's GLOBAL_BASE of 1024,
//          where nothing else lives): throws for longjmp, invoke wrappers,
//          caught longjmps, libffi calls, compiled blocks, removals, sleeps
//          (Asyncify.handleSleep runs twice per sleep), XHRs, postMessage
//          from workers, and the contexts that loaded the rewritten glue
//   ffi    libffi's ffi_call_js without the arrays it allocates
//   slice  instantiate_wasm copies a block's bytes once instead of twice
//
// SPDX-License-Identifier: GPL-2.0-or-later

export const COUNTER_BASE = 512;
export const COUNTER_NAMES = ['throws', 'invokes', 'catches', 'ffi', 'compiles', 'removes', 'sleeps', 'xhrs',
    'ffiSlow', 'posts', 'c10', 'c11', 'c12', 'c13', 'c14', 'contexts'];

export const COUNT_PRELUDE = `
var portyCounters = null;
function portyCount(i) {
  try {
    if (!portyCounters) portyCounters = new Int32Array(wasmMemory.buffer, ${COUNTER_BASE}, 16);
    Atomics.add(portyCounters, i, 1);
  } catch (e) {}
}
portyCount(15);
if (typeof ENVIRONMENT_IS_PTHREAD !== 'undefined' && ENVIRONMENT_IS_PTHREAD && typeof self !== 'undefined' && self.postMessage) {
  var portyPostMessage = self.postMessage;
  self.postMessage = function(m, t) { portyCount(9); return t === undefined ? portyPostMessage.call(self, m) : portyPostMessage.call(self, m, t); };
}
`;

// libffi's ffi_call_js (src/wasm32/ffi.c) runs for every helper call of
// QEMU's interpreter: it builds an argument array, a two-element array per
// argument and for the return type (unbox_small_structs), calls three
// exported functions that Asyncify wraps (stackSave, stackRestore,
// stackAlloc) and calls with apply().  This one decodes a signature once
// (QEMU makes its ffi_cif records at start-up and never frees them) and
// calls directly; anything but integer and pointer arguments and results
// (TCG's i32, i64 and pointers) goes to the original, renamed portyFfiSlow.
// Addresses are read with >>> so that memories above 2 GiB work too.
export const FFI_FAST = `
var portyFfiInfo = new Map();
function portyFfiDecode(cif) {
  var p = cif >>> 2;
  var nargs = HEAPU32[p + 1], nfixed = HEAPU32[p + 6], argTypes = HEAPU32[p + 2], rtype = HEAPU32[p + 3];
  if (nargs !== nfixed || nargs > 7) return 0;
  var rid = HEAPU16[(rtype + 6) >>> 1], r;
  if (rid === 0) r = 0;
  else if (rid === 1 || rid === 9 || rid === 10 || rid === 14) r = 1;
  else if (rid === 11 || rid === 12) r = 2;
  else return 0;
  var wide = 0;
  for (var i = 0; i < nargs; i++) {
    var id = HEAPU16[(HEAPU32[(argTypes >>> 2) + i] + 6) >>> 1];
    if (id === 11 || id === 12) wide |= 1 << i;
    else if (!(id === 1 || id === 9 || id === 10 || id === 14)) return 0;
  }
  return 1 + nargs + (r << 4) + (wide << 8);
}
function portyFfiArg(a, i, wide) {
  return (wide >> i) & 1 ? HEAPU64[HEAPU32[a + i] >>> 3] : HEAPU32[HEAPU32[a + i] >>> 2];
}
function ffi_call_js(cif, fn, rvalue, avalue) {
  /*PORTY_FFI_COUNT*/
  var info = portyFfiInfo.get(cif);
  if (info === undefined) {
    info = portyFfiDecode(cif);
    portyFfiInfo.set(cif, info);
  }
  if (info === 0) {
    /*PORTY_FFI_SLOW_COUNT*/
    return portyFfiSlow(cif, fn, rvalue, avalue);
  }
  info -= 1;
  var wide = info >> 8, f = getWasmTableEntry(fn), a = avalue >>> 2, r;
  switch (info & 15) {
  case 0: r = f(); break;
  case 1: r = f(portyFfiArg(a, 0, wide)); break;
  case 2: r = f(portyFfiArg(a, 0, wide), portyFfiArg(a, 1, wide)); break;
  case 3: r = f(portyFfiArg(a, 0, wide), portyFfiArg(a, 1, wide), portyFfiArg(a, 2, wide)); break;
  case 4: r = f(portyFfiArg(a, 0, wide), portyFfiArg(a, 1, wide), portyFfiArg(a, 2, wide), portyFfiArg(a, 3, wide)); break;
  case 5: r = f(portyFfiArg(a, 0, wide), portyFfiArg(a, 1, wide), portyFfiArg(a, 2, wide), portyFfiArg(a, 3, wide),
                portyFfiArg(a, 4, wide)); break;
  case 6: r = f(portyFfiArg(a, 0, wide), portyFfiArg(a, 1, wide), portyFfiArg(a, 2, wide), portyFfiArg(a, 3, wide),
                portyFfiArg(a, 4, wide), portyFfiArg(a, 5, wide)); break;
  default: r = f(portyFfiArg(a, 0, wide), portyFfiArg(a, 1, wide), portyFfiArg(a, 2, wide), portyFfiArg(a, 3, wide),
                 portyFfiArg(a, 4, wide), portyFfiArg(a, 5, wide), portyFfiArg(a, 6, wide)); break;
  }
  var kind = (info >> 4) & 3;
  if (kind === 1) HEAPU32[rvalue >>> 2] = r;
  else if (kind === 2) HEAPU64[rvalue >>> 3] = r;
}
`;

/** Insert text before Emscripten's import object, or else before the first invoke wrapper. */
export function insertBeforeImports(js, text) {
    for (const anchor of [/\n\s*var wasmImports\s*=/, /\nfunction invoke_[a-z]+\(/]) {
        const m = anchor.exec(js);
        if (m) {
            return js.slice(0, m.index) + text + js.slice(m.index);
        }
    }
    return js;
}

/**
 * Rewrite QEMU's JavaScript glue for the experiments in `names`; `applied`
 * gets one entry per rewrite: how many places it changed (0: not found).
 */
export function glueRewrite(js, names, applied = {}) {
    let out = js;
    const count = (re, fn) => {
        let n = 0;
        out = out.replace(re, (...m) => {
            n++;
            return fn(...m);
        });
        return n;
    };
    if (names.includes('ffi')) {
        // Only if both the original and the place for the new one are found.
        const kept = out;
        const renamed = count(/function ffi_call_js\(/, () => 'function portyFfiSlow(');
        let fast = FFI_FAST;
        if (names.includes('count')) {
            fast = fast.replace('/*PORTY_FFI_COUNT*/', 'portyCount(3);').replace('/*PORTY_FFI_SLOW_COUNT*/', 'portyCount(8);');
        }
        const before = out.length;
        out = renamed ? insertBeforeImports(out, fast) : out;
        applied.ffi = renamed && out.length > before ? 1 : 0;
        if (!applied.ffi) {
            out = kept;
        }
    }
    if (names.includes('slice')) {
        applied.slice = count(/new Uint8Array\(HEAP8\.slice\(([^()]*)\)\)/, (m, a) => `HEAP8.slice(${a})`);
    }
    if (names.includes('count')) {
        const before = out.length;
        out = insertBeforeImports(out, COUNT_PRELUDE);
        applied.countPrelude = out.length > before ? 1 : 0;
        applied.countThrow = count(/((?:__emscripten_throw_longjmp\s*=\s*(?:\(\)\s*=>|function\s*\(\))|function\s+__emscripten_throw_longjmp\s*\(\))\s*\{)/,
            (m, a) => `${a} portyCount(0);`);
        applied.countInvoke = count(/(function invoke_[a-zA-Z0-9]+\([^)]*\)\s*\{\s*var sp = stackSave\(\);)/g, (m, a) => `${a} portyCount(1);`);
        applied.countCatch = count(/(_setThrew\(1,\s*0\);)/g, (m, a) => `portyCount(2); ${a}`);
        if (!names.includes('ffi')) {
            applied.countFfi = count(/(function ffi_call_js\([^)]*\)\s*\{)/, (m, a) => `${a} portyCount(3);`);
        }
        applied.countCompile = count(/(function instantiate_wasm\(\)\s*\{)/, (m, a) => `${a} portyCount(4);`);
        applied.countRemove = count(/(function remove_module_js\(\)\s*\{)/, (m, a) => `${a} portyCount(5);`);
        applied.countSleep = count(/(\n\s*handleSleep\(startAsync\)\s*\{)/, (m, a) => `${a} portyCount(6);`);
        applied.countXhr = count(/new XMLHttpRequest\b(?:\(\))?/g, () => '(portyCount(7), new XMLHttpRequest())');
    }
    return out;
}
