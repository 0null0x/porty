// Instruments an Emscripten 3.1.50 glue file (out.js) of QEMU-Wasm so that
// a longjmp no setjmp frame will catch says where it was thrown from, and
// so that each thread's C stack depth is watched.
//
// usage: node tests/boot/longjmp-trace.mjs <out.js> [flags]
//   flags is the sum of:
//   1  count the invoke_* frames (each is the JavaScript try/catch of a C
//      function that called setjmp) on every thread's stack; when
//      __emscripten_throw_longjmp throws with none of them on the stack,
//      nothing can catch it: print the JavaScript and WebAssembly call
//      frames with "PORTY-LONGJMP-ESCAPE".  Allocates nothing per longjmp.
//   2  also keep the call frames of the last 8 longjmps of the thread and
//      print them with the escape, oldest first.  The first of a chain is
//      where the longjmp started; the later ones are rethrows by setjmp
//      frames whose buffer it did not match.  This allocates an Error per
//      longjmp in the worker, and that garbage makes the worker collect
//      more often, which also lets QEMU-Wasm's JIT see dropped compiled
//      blocks freed (a FinalizationRegistry) sooner: it changes how often
//      the JIT sits at its cap.
//   4  also watch each thread's C stack (64 KiB per pthread in the build
//      before patch 0016): the lowest stack pointer seen at longjmps, fiber
//      swaps, sleeps and invoke_* calls, the stack pointer each invoke_*
//      would restore after catching a longjmp (it is taken when the
//      invoke_* is entered, also when Asyncify re-enters it on a rewind),
//      and a canary in the stack's lowest 256 bytes.  "PORTY-STACK" lines
//      report new lows and a damaged canary.  Allocates only to report.
//   Earlier runs used 1, 2 (1+2) and 3 (1+2+4).
//
// Emscripten's setjmp/longjmp without Wasm exceptions: longjmp is "throw
// Infinity"; every call made by a function that called setjmp goes through
// a JavaScript invoke_* wrapper that catches it, and the function then
// looks the jmp_buf up in its own table and rethrows if it is not its own.
// Asyncify unwinds and rewinds through invoke_* normally (they return and
// are called again), so the counter follows the real stack.
//
// For tests only: the page never ships this.
// SPDX-License-Identifier: GPL-2.0-or-later
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
let level = Number(process.argv[3] || 1);
// The first runs' levels: 2 meant 1+2, 3 meant 1+2+4.
const flags = level === 2 ? 3 : level === 3 ? 7 : level;
if (!file) {
    console.error('usage: longjmp-trace.mjs <out.js> [level]');
    process.exit(2);
}
let src = readFileSync(file, 'utf8');
const fail = (why) => {
    console.error(`longjmp-trace: glue not as expected: ${why}`);
    process.exit(1);
};

// 1. invoke_* wrappers: count the frames (and, level 3, watch the stack
//    pointer they would restore).
let wrapped = 0;
src = src.replace(
    /function (invoke_\w+)\(([^)]*)\) \{\n var sp = stackSave\(\);\n try \{\n([\s\S]*?)\n \} catch \(e\) \{\n([\s\S]*?)\n \}\n\}/g,
    (m, name, args, body, katch) => {
        wrapped++;
        return `function ${name}(${args}) {\n var sp = stackSave();\n __portyInvokeDepth++;\n if (__portyFlags & 4) __portyInvokeSp(sp);\n try {\n${body}\n } catch (e) {\n${katch}\n } finally {\n  __portyInvokeDepth--;\n }\n}`;
    });
if (wrapped < 5) {
    fail(`only ${wrapped} invoke wrappers`);
}

// 2. The throw.
const throwRe = /var __emscripten_throw_longjmp = \(\) => \{\n throw Infinity;\n\};/;
if (!throwRe.test(src)) {
    fail('no __emscripten_throw_longjmp');
}
src = src.replace(throwRe, `var __emscripten_throw_longjmp = () => {
 __portyLongjmp();
 throw Infinity;
};`);

// 3. Fiber swaps and sleeps: where Asyncify unwinds (level 3).
const swapAnchor = 'function _emscripten_fiber_swap(oldFiber, newFiber) {\n oldFiber >>>= 0;\n newFiber >>>= 0;\n';
const sleepRe = /var _emscripten_sleep = ms => Asyncify\.handleSleep\(/;
if (!src.includes(swapAnchor) || !sleepRe.test(src)) {
    fail('no _emscripten_fiber_swap or _emscripten_sleep');
}
src = src.replace(swapAnchor, `${swapAnchor} if ((__portyFlags & 4) && Asyncify.state === Asyncify.State.Normal) __portySp("fiber_swap");\n`);
src = src.replace(sleepRe, 'var _emscripten_sleep = ms => ((__portyFlags & 4) && Asyncify.state === Asyncify.State.Normal && __portySp("sleep"), Asyncify.handleSleep(');
src = src.replace('Asyncify.handleSleep(wakeUp => safeSetTimeout(wakeUp, ms));', 'Asyncify.handleSleep(wakeUp => safeSetTimeout(wakeUp, ms)));');

// 4. The helpers, at the top of the module (one copy per thread).
const helpers = `
var __portyInvokeDepth = 0;
var __portyLongjmps = 0;
var __portyEscapes = 0;
var __portyRing = [];
var __portyFlags = ${flags};
var __portyStack = null;
function __portyFrames(e) {
 return String(e && e.stack || e).split("\\n").slice(1).map(l => l.trim().replace(/^at /, "").replace(/ \\(.*\\/([^/]+)\\)$/, " ($1)")).join(" < ");
}
function __portyTid() {
 try { return typeof _pthread_self == "function" ? _pthread_self() : "?"; } catch (x) { return "?"; }
}
function __portyStackInfo() {
 if (__portyStack !== null) return __portyStack;
 __portyStack = false;
 try {
  var p = _pthread_self();
  var high = HEAPU32[(p + 52) >>> 2], size = HEAPU32[(p + 56) >>> 2];
  if (!high || !size || size > 64 * 1048576) return __portyStack;
  var s = { tid: p, low: high - size, high: high, size: size, minFree: size, minInvokeFree: size, reportedFree: size, reportedInvoke: size, canary: false, canaryBroken: false, at: Date.now(), n: 0 };
  var sp = stackSave();
  if (HEAPU32[s.low >>> 2] === 0x5afe57ac && HEAPU32[(s.low + 252) >>> 2] === 0x5afe57ac) {
   /* QEMU patch 0016 painted this stack and guards its lowest words: check its paint, write nothing. */
   s.canary = "qemu";
  } else if (sp > s.low + 4096 && sp <= high) {
   for (var a = s.low; a < s.low + 256; a += 4) HEAPU32[a >>> 2] = 0x5afe57ac ^ a;
   s.canary = true;
  }
  __portyStack = s;
  console.error("PORTY-STACK " + p + " stack " + s.low + ".." + high + " (" + size + " bytes), canary " + s.canary);
 } catch (x) {}
 return __portyStack;
}
function __portyCanary(s) {
 if (!s.canary || s.canaryBroken) return true;
 for (var a = s.low; a < s.low + 256; a += 64) {
  if (HEAPU32[a >>> 2] !== (s.canary === "qemu" ? 0x5afe57ac : ((0x5afe57ac ^ a) >>> 0))) { s.canaryBroken = true; return false; }
 }
 return true;
}
function __portyReport(s, where, why) {
 console.error("PORTY-STACK " + s.tid + " " + why + " at " + where + ": lowest free " + s.minFree + " of " + s.size + " bytes, lowest restore point free " + s.minInvokeFree + ", now free " + (stackSave() - s.low) + ", invoke depth " + __portyInvokeDepth + ", longjmps " + __portyLongjmps + " :: " + __portyFrames(new Error("where")));
}
function __portySp(where) {
 var s = __portyStack === null ? __portyStackInfo() : __portyStack;
 if (!s) return;
 var sp = stackSave();
 if (sp < s.low - 65536 || sp > s.high) return;
 var free = sp - s.low;
 if (free < s.minFree) s.minFree = free;
 if ((++s.n & 255) === 0 || free < 8192) {
  if (!__portyCanary(s) && !s.canaryReported) { s.canaryReported = true; __portyReport(s, where, "CANARY DAMAGED"); }
 }
 if (s.minFree < s.reportedFree - 4096 || (s.minFree < 8192 && s.minFree < s.reportedFree - 512)) { s.reportedFree = s.minFree; __portyReport(s, where, "new low"); }
}
function __portyInvokeSp(sp) {
 var s = __portyStack === null ? __portyStackInfo() : __portyStack;
 if (!s) return;
 if (sp < s.low - 65536 || sp > s.high) return;
 var free = sp - s.low;
 if (free < s.minInvokeFree) s.minInvokeFree = free;
 if (free < s.minFree) s.minFree = free;
 if (s.minInvokeFree < s.reportedInvoke - 2048) { s.reportedInvoke = s.minInvokeFree; __portyReport(s, "invoke", "restore point lower"); }
}
function __portyLongjmp() {
 __portyLongjmps++;
 if (__portyFlags & 4) __portySp("longjmp");
 if (__portyFlags & 2) {
  var saved = Error.stackTraceLimit;
  Error.stackTraceLimit = 60;
  var e = new Error("longjmp");
  Error.stackTraceLimit = saved;
  __portyRing.push({ n: __portyLongjmps, t: Date.now(), depth: __portyInvokeDepth, sp: (__portyFlags & 4) ? stackSave() : 0, e: e });
  if (__portyRing.length > 8) __portyRing.shift();
 }
 if (__portyInvokeDepth === 0) {
  __portyEscapes++;
  var saved2 = Error.stackTraceLimit;
  Error.stackTraceLimit = 80;
  var here = new Error("escape");
  Error.stackTraceLimit = saved2;
  var who = (typeof ENVIRONMENT_IS_PTHREAD != "undefined" && ENVIRONMENT_IS_PTHREAD) ? "pthread" : "main";
  var tid = __portyTid();
  var s = __portyStack || {};
  console.error("PORTY-LONGJMP-ESCAPE " + who + " " + tid + " longjmp #" + __portyLongjmps + " escape #" + __portyEscapes + " asyncify state " + (typeof Asyncify != "undefined" ? Asyncify.state + " exports [" + Asyncify.exportCallStack.join(",") + "] fiber " + (typeof Fibers != "undefined" ? Fibers.trampolineRunning + "/" + Fibers.nextFiber : "-") : "-") + (s.size ? " stack free now " + (stackSave() - s.low) + " lowest " + s.minFree + " restore-point lowest " + s.minInvokeFree + " canary " + (s.canary ? (__portyCanary(s) ? "ok" : "DAMAGED") : "-") : "") + " :: " + __portyFrames(here));
  for (var i = 0; i < __portyRing.length; i++) {
   var r = __portyRing[i];
   console.error("PORTY-LONGJMP-RING " + tid + " #" + r.n + " " + (Date.now() - r.t) + " ms ago, invoke depth " + r.depth + (r.sp ? ", stack free " + (r.sp - (s.low || 0)) : "") + " :: " + __portyFrames(r.e));
  }
 }
}
`;
const anchor = 'var quit_ = (status, toThrow) => {';
if (!src.includes(anchor)) {
    fail('no quit_');
}
src = src.replace(anchor, `${helpers}\n${anchor}`);
writeFileSync(file, src);
console.log(`longjmp-trace: flags ${flags}, ${wrapped} invoke wrappers counted in ${file}`);
