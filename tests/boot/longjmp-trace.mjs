// Instruments an Emscripten 3.1.50 glue file (out.js) of QEMU-Wasm so that
// a longjmp no setjmp frame will catch says where it was thrown from.
//
// usage: node tests/boot/longjmp-trace.mjs <out.js> [level]
//   level 1  count the invoke_* frames (each is the JavaScript try/catch of
//            a C function that called setjmp) on every thread's stack; when
//            __emscripten_throw_longjmp throws with none of them on the
//            stack, nothing can catch it: print the JavaScript and
//            WebAssembly call frames with "PORTY-LONGJMP-ESCAPE".
//   level 2  also keep the call frames of the last 8 longjmps of the
//            thread and print them with the escape, oldest first.  The
//            first of a chain is where the longjmp started; the later ones
//            are rethrows by setjmp frames whose buffer it did not match.
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
const level = Number(process.argv[3] || 1);
if (!file) {
    console.error('usage: longjmp-trace.mjs <out.js> [level]');
    process.exit(2);
}
let src = readFileSync(file, 'utf8');

// 1. invoke_* wrappers: count the frames.
let wrapped = 0;
src = src.replace(
    /function (invoke_\w+)\(([^)]*)\) \{\n var sp = stackSave\(\);\n try \{\n([\s\S]*?)\n \} catch \(e\) \{\n([\s\S]*?)\n \}\n\}/g,
    (m, name, args, body, katch) => {
        wrapped++;
        return `function ${name}(${args}) {\n var sp = stackSave();\n __portyInvokeDepth++;\n try {\n${body}\n } catch (e) {\n${katch}\n } finally {\n  __portyInvokeDepth--;\n }\n}`;
    });

// 2. The throw.
const throwRe = /var __emscripten_throw_longjmp = \(\) => \{\n throw Infinity;\n\};/;
if (!throwRe.test(src) || wrapped < 5) {
    console.error(`longjmp-trace: glue not as expected (invoke wrappers: ${wrapped}, throw: ${throwRe.test(src)})`);
    process.exit(1);
}
src = src.replace(throwRe, `var __emscripten_throw_longjmp = () => {
 __portyLongjmp();
 throw Infinity;
};`);

// 3. The helpers, at the top of the module (one copy per thread).
const helpers = `
var __portyInvokeDepth = 0;
var __portyLongjmps = 0;
var __portyEscapes = 0;
var __portyRing = [];
var __portyLevel = ${level};
function __portyFrames(e) {
 return String(e && e.stack || e).split("\\n").slice(1).map(l => l.trim().replace(/^at /, "").replace(/ \\(.*\\/([^/]+)\\)$/, " ($1)")).join(" < ");
}
function __portyLongjmp() {
 __portyLongjmps++;
 if (__portyLevel >= 2) {
  var saved = Error.stackTraceLimit;
  Error.stackTraceLimit = 60;
  var e = new Error("longjmp");
  Error.stackTraceLimit = saved;
  __portyRing.push({ n: __portyLongjmps, t: Date.now(), depth: __portyInvokeDepth, e: e });
  if (__portyRing.length > 8) __portyRing.shift();
 }
 if (__portyInvokeDepth === 0) {
  __portyEscapes++;
  var saved2 = Error.stackTraceLimit;
  Error.stackTraceLimit = 80;
  var here = new Error("escape");
  Error.stackTraceLimit = saved2;
  var who = (typeof ENVIRONMENT_IS_PTHREAD != "undefined" && ENVIRONMENT_IS_PTHREAD) ? "pthread" : "main";
  var tid = "?";
  try { tid = typeof _pthread_self == "function" ? _pthread_self() : "?"; } catch (x) {}
  console.error("PORTY-LONGJMP-ESCAPE " + who + " " + tid + " longjmp #" + __portyLongjmps + " escape #" + __portyEscapes + " asyncify state " + (typeof Asyncify != "undefined" ? Asyncify.state + " exports [" + Asyncify.exportCallStack.join(",") + "] fiber " + (typeof Fibers != "undefined" ? Fibers.trampolineRunning + "/" + Fibers.nextFiber : "-") : "-") + " :: " + __portyFrames(here));
  for (var i = 0; i < __portyRing.length; i++) {
   var r = __portyRing[i];
   console.error("PORTY-LONGJMP-RING " + tid + " #" + r.n + " " + (Date.now() - r.t) + " ms ago, invoke depth " + r.depth + " :: " + __portyFrames(r.e));
  }
 }
}
`;
const anchor = 'var quit_ = (status, toThrow) => {';
if (!src.includes(anchor)) {
    console.error('longjmp-trace: no quit_ in the glue');
    process.exit(1);
}
src = src.replace(anchor, `${helpers}\n${anchor}`);
writeFileSync(file, src);
console.log(`longjmp-trace: level ${level}, ${wrapped} invoke wrappers counted in ${file}`);
