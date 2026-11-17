// Checks tests/boot/webkit-glue.mjs: the rewrites find their places in
// glue shaped like QEMU-Wasm's out.js (Emscripten 3.1.50), the result still
// parses, and the fast ffi_call_js passes the same arguments and stores the
// same results as libffi's own (src/wasm32/ffi.c, with its macros expanded
// as Emscripten emits them) for the signatures TCG uses.
// usage: node tests/webkit-glue.test.mjs
// SPDX-License-Identifier: GPL-2.0-or-later
import assert from 'node:assert/strict';
import {
    COUNT_PRELUDE, COUNTER_BASE, COUNTER_CONTEXTS, COUNTER_NAMES, COUNTER_ROWS, FFI_FAST, PACE_PRELUDE, glueRewrite,
} from './boot/webkit-glue.mjs';

let failures = 0;
const check = (name, fn) => {
    try {
        fn();
        console.log(`PASS  ${name}`);
    } catch (e) {
        failures++;
        console.log(`FAIL  ${name}: ${e.message}`);
    }
};

// libffi's ffi_call_js as out.js has it (fixed arguments only; no varargs).
const ORIGINAL = `
function unbox_small_structs(type_ptr) {
 var type_id = HEAPU16[(type_ptr + 6 >> 1) + 0 >>> 0];
 while (type_id === 13) {
  var elements = HEAPU32[(type_ptr + 8 >> 2) + 0 >>> 0];
  var first_element = HEAPU32[(elements >> 2) + 0 >>> 0];
  if (first_element === 0) {
   type_id = 0;
   break;
  } else if (HEAPU32[(elements >> 2) + 1 >>> 0] === 0) {
   type_ptr = first_element;
   type_id = HEAPU16[(first_element + 6 >> 1) + 0 >>> 0];
  } else {
   break;
  }
 }
 return [ type_ptr, type_id ];
}
function ffi_call_js(cif, fn, rvalue, avalue) {
 var abi = HEAPU32[(cif >> 2) + 0 >>> 0];
 var nargs = HEAPU32[(cif >> 2) + 1 >>> 0];
 var nfixedargs = HEAPU32[(cif >> 2) + 6 >>> 0];
 var arg_types_ptr = HEAPU32[(cif >> 2) + 2 >>> 0];
 var rtype_unboxed = unbox_small_structs(HEAPU32[(cif >> 2) + 3 >>> 0]);
 var rtype_ptr = rtype_unboxed[0];
 var rtype_id = rtype_unboxed[1];
 var orig_stack_ptr = stackSave();
 var cur_stack_ptr = orig_stack_ptr;
 var args = [];
 var ret_by_arg = false;
 if (rtype_id === 15) {
  throw new Error("complex ret marshalling nyi");
 }
 if (rtype_id < 0 || rtype_id > 15) {
  throw new Error("Unexpected rtype " + rtype_id);
 }
 if (rtype_id === 4 || rtype_id === 13) {
  args.push(rvalue);
  ret_by_arg = true;
 }
 for (var i = 0; i < nfixedargs; i++) {
  var arg_ptr = HEAPU32[(avalue >> 2) + i >>> 0];
  var arg_unboxed = unbox_small_structs(HEAPU32[(arg_types_ptr >> 2) + i >>> 0]);
  var arg_type_ptr = arg_unboxed[0];
  var arg_type_id = arg_unboxed[1];
  switch (arg_type_id) {
  case 1:
  case 10:
  case 9:
  case 14:
   args.push(HEAPU32[(arg_ptr >> 2) + 0 >>> 0]);
   break;
  case 2:
   args.push(HEAPF32[(arg_ptr >> 2) + 0 >>> 0]);
   break;
  case 3:
   args.push(HEAPF64[(arg_ptr >> 3) + 0 >>> 0]);
   break;
  case 5:
   args.push(HEAPU8[arg_ptr + 0 >>> 0]);
   break;
  case 6:
   args.push(HEAP8[arg_ptr + 0 >>> 0]);
   break;
  case 7:
   args.push(HEAPU16[(arg_ptr >> 1) + 0 >>> 0]);
   break;
  case 8:
   args.push(HEAP16[(arg_ptr >> 1) + 0 >>> 0]);
   break;
  case 11:
  case 12:
   args.push(HEAPU64[(arg_ptr >> 3) + 0 >>> 0]);
   break;
  case 13:
   var size = HEAPU32[(arg_type_ptr >> 2) + 0 >>> 0];
   var align = HEAPU16[(arg_type_ptr + 4 >> 1) + 0 >>> 0];
   ((cur_stack_ptr -= (size)), (cur_stack_ptr &= (~((align) - 1))));
   HEAP8.subarray(cur_stack_ptr, cur_stack_ptr + size).set(HEAP8.subarray(arg_ptr, arg_ptr + size));
   args.push(cur_stack_ptr);
   break;
  default:
   throw new Error("Unexpected type " + arg_type_id);
  }
 }
 stackRestore(cur_stack_ptr);
 stackAlloc(0);
 var result = getWasmTableEntry(fn).apply(null, args);
 stackRestore(orig_stack_ptr);
 if (ret_by_arg) {
  return;
 }
 switch (rtype_id) {
 case 0:
  break;
 case 1:
 case 9:
 case 10:
 case 14:
  HEAPU32[(rvalue >> 2) + 0 >>> 0] = result;
  break;
 case 2:
  HEAPF32[(rvalue >> 2) + 0 >>> 0] = result;
  break;
 case 3:
  HEAPF64[(rvalue >> 3) + 0 >>> 0] = result;
  break;
 case 5:
 case 6:
  HEAPU8[rvalue + 0 >>> 0] = result;
  break;
 case 7:
 case 8:
  HEAPU16[(rvalue >> 1) + 0 >>> 0] = result;
  break;
 case 11:
 case 12:
  HEAPU64[(rvalue >> 3) + 0 >>> 0] = result;
  break;
 default:
  throw new Error("Unexpected rtype " + rtype_id);
 }
}
`;

// Pieces of out.js the counters look for, as Emscripten 3.1.50 emits them.
const GLUE = `${ORIGINAL}
function instantiate_wasm() {
 const memory_v = new DataView(HEAP8.buffer);
 const wasmBytes = new Uint8Array(HEAP8.slice(wasm_begin, wasm_begin + wasm_size));
 return 1;
}
function remove_module_js() {
 const memory_v = new DataView(HEAP8.buffer);
}
function porty_js_fetch(url, dst, cap) {
 try {
  var xhr = new XMLHttpRequest;
  xhr.open("GET", UTF8ToString(url), false);
 } catch (e) {
  return -1;
 }
}
var __emscripten_throw_longjmp = () => {
 throw Infinity;
};
var Asyncify = {
 handleSleep(startAsync) {
  return 0;
 },
};
var _emscripten_sleep = ms => Asyncify.handleSleep(wakeUp => safeSetTimeout(wakeUp, ms));
function _clock_time_get(clk_id, ignored_precision, ptime) {
 ignored_precision = bigintToI53Checked(ignored_precision);
 return 0;
}
var ___syscall_poll = (fds, nfds, timeout) => PTY_wrapPoll(() => xterm_pty_old_poll(fds, nfds, timeout));
var wasmImports = {
 /** @export */ ka: ffi_call_js,
 /** @export */ xa: __emscripten_throw_longjmp,
};
function invoke_vi(index, a1) {
 var sp = stackSave();
 try {
  dynCall_vi(index, a1);
 } catch (e) {
  stackRestore(sp);
  if (e !== e + 0) throw e;
  _setThrew(1, 0);
 }
}
function invoke_iij(index, a1, a2) {
 var sp = stackSave();
 try {
  return dynCall_iij(index, a1, a2);
 } catch (e) {
  stackRestore(sp);
  if (e !== e + 0) throw e;
  _setThrew(1, 0);
 }
}
`;

check('every counter finds its place, and the result parses', () => {
    const applied = {};
    const out = glueRewrite(GLUE, ['count', 'ffi', 'slice'], applied);
    assert.deepEqual(applied, {
        poll: 1, ffi: 1, slice: 1, countPrelude: 1, countThrow: 1, countInvoke: 2,
        countCompile: 1, countSleep: 1, countXhr: 1,
    });
    // eslint-disable-next-line no-new-func
    new Function(out);
    assert.ok(out.indexOf('function ffi_call_js(') < out.indexOf('var wasmImports'));
    assert.ok(out.includes('function portyFfiSlow('));
    assert.ok(out.includes('function ffi_call_js(cif, fn, rvalue, avalue) {\n  portyCount(2);'));
    assert.ok(out.includes('  portyCount(8); if (timeout === 0) portyCount(9);'));
    assert.ok(out.includes('const wasmBytes = HEAP8.slice(wasm_begin, wasm_begin + wasm_size);'));
});

check('count alone counts the original ffi_call_js', () => {
    const applied = {};
    const out = glueRewrite(GLUE, ['count'], applied);
    assert.equal(applied.countFfi, 1);
    assert.ok(/function ffi_call_js\(cif, fn, rvalue, avalue\) \{ portyCount\(2\);/.test(out));
    // eslint-disable-next-line no-new-func
    new Function(out);
});

check('each context counts in a row of its own', () => {
    const memory = { buffer: new SharedArrayBuffer(4096) };
    const run = () => {
        // eslint-disable-next-line no-new-func
        const f = new Function('wasmMemory', `${COUNT_PRELUDE}; return portyCount;`);
        return f(memory);
    };
    const a = run();
    const b = run();
    a(0); a(0); a(2); b(7);
    const i32 = new Int32Array(memory.buffer);
    assert.equal(i32[COUNTER_BASE / 4], 2);
    const row = (c) => Array.from(i32.subarray(COUNTER_ROWS / 4 + c * COUNTER_NAMES.length, COUNTER_ROWS / 4 + (c + 1) * COUNTER_NAMES.length));
    assert.deepEqual(row(0), [2, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(row(1), [0, 0, 0, 0, 0, 0, 0, 1, 0, 0]);
    assert.ok(COUNTER_ROWS + COUNTER_CONTEXTS * COUNTER_NAMES.length * 4 <= 1024, 'the rows stay below GLOBAL_BASE');
});

check('pace puts a tick into the busy functions, and the result parses', () => {
    const applied = {};
    const out = glueRewrite(GLUE, ['pace-400', 'count'], applied);
    // ffi_call_js, instantiate_wasm, _clock_time_get, the throw, two invoke wrappers (the poll: below)
    assert.equal(applied.pace, 6);
    assert.equal(applied.poll, 1);
    assert.ok(out.includes('  portyPaceTick();\n  var r = PTY_wrapPoll('));
    assert.ok(out.includes('portyPaceNext = now + 400;'));
    // eslint-disable-next-line no-new-func
    new Function(out);
});

check('the pacer makes a shared memory as big as the main one, at most every PACE_MS', () => {
    let made = [];
    class FakeMemory {
        constructor(d) {
            made.push(d);
        }
    }
    let now = 0;
    // eslint-disable-next-line no-new-func
    const make = new Function('wasmMemory', 'performance', 'WebAssembly',
        `${PACE_PRELUDE(250)}; return { tick: portyPaceTick, count: () => portyPaceCount };`);
    const p = make({ buffer: { byteLength: 1280 * 1048576 } }, { now: () => now }, { Memory: FakeMemory });
    for (let i = 0; i < 5000; i++) {
        p.tick();
    }
    assert.equal(made.length, 1);
    assert.deepEqual(made[0], { initial: 20480, maximum: 20480, shared: true });
    now = 100;
    for (let i = 0; i < 5000; i++) {
        p.tick();
    }
    assert.equal(made.length, 1);
    now = 300;
    for (let i = 0; i < 5000; i++) {
        p.tick();
    }
    assert.equal(made.length, 2);
    made = [];
});

check('pollwait waits only when poll found nothing and may wait, in a worker, at most its ms', () => {
    const out = glueRewrite(GLUE, ['pollwait-3'], {});
    const waits = [];
    const run = (pthread, result, timeout) => {
        // eslint-disable-next-line no-new-func
        const f = new Function('ENVIRONMENT_IS_PTHREAD', 'PTY_wrapPoll', 'xterm_pty_old_poll', 'Atomics', 'SharedArrayBuffer',
            `${out.slice(out.indexOf('var portyPollWord'), out.indexOf('};', out.indexOf('var ___syscall_poll')) + 2)}; return ___syscall_poll;`);
        const poll = f(pthread, (impl) => impl(), () => result, { wait: (v, i, x, ms) => waits.push(ms) }, SharedArrayBuffer);
        return poll(0, 1, timeout);
    };
    assert.equal(run(true, 0, 100), 0);
    assert.equal(run(true, 0, -1), 0);
    assert.equal(run(true, 0, 1), 0);
    assert.equal(run(true, 2, 100), 2);
    assert.equal(run(true, 0, 0), 0);
    assert.equal(run(false, 0, 100), 0);
    assert.deepEqual(waits, [3, 3, 1]);
});

check('nothing changes without names', () => {
    assert.equal(glueRewrite(GLUE, []), GLUE);
});

// --- the fast ffi_call_js against libffi's ------------------------------------
function makeWorld(code) {
    const buffer = new ArrayBuffer(1 << 20);
    const heap = {
        HEAP8: new Int8Array(buffer), HEAPU8: new Uint8Array(buffer), HEAP16: new Int16Array(buffer),
        HEAPU16: new Uint16Array(buffer), HEAPU32: new Uint32Array(buffer), HEAPF32: new Float32Array(buffer),
        HEAPF64: new Float64Array(buffer), HEAPU64: new BigUint64Array(buffer),
    };
    const calls = [];
    const table = new Map();
    const world = { ...heap, calls, table, stackSaves: 0 };
    // eslint-disable-next-line no-new-func
    const make = new Function(...Object.keys(heap), 'getWasmTableEntry', 'stackSave', 'stackRestore', 'stackAlloc',
        `${code}; return { ffi_call_js, portyFfiSlow: typeof portyFfiSlow === 'function' ? portyFfiSlow : null };`);
    Object.assign(world, make(...Object.values(heap), (fn) => table.get(fn), () => { world.stackSaves++; return 65536; },
        () => {}, () => 0));
    return world;
}

// ffi_type records: size, alignment, type id at +6, elements at +8.
const TYPES = { void: 0, int: 1, u32: 9, s32: 10, u64: 11, s64: 12, ptr: 14, double: 3, struct2: 13 };
function layout(world, sig) {
    const U32 = world.HEAPU32;
    const U16 = world.HEAPU16;
    let next = 4096;
    const alloc = (n) => {
        const at = next;
        next += (n + 15) & ~15;
        return at;
    };
    const typeRec = {};
    for (const [name, id] of Object.entries(TYPES)) {
        const at = alloc(16);
        const size = { void: 1, int: 4, u32: 4, s32: 4, u64: 8, s64: 8, ptr: 4, double: 8, struct2: 16 }[name];
        U32[at >> 2] = size;
        U16[(at + 4) >> 1] = Math.min(size, 8);
        U16[(at + 6) >> 1] = id;
        typeRec[name] = at;
    }
    // a struct of two u64 (TCG's Int128): elements = [u64, u64, 0]
    const elements = alloc(12);
    U32[elements >> 2] = typeRec.u64;
    U32[(elements >> 2) + 1] = typeRec.u64;
    U32[(elements >> 2) + 2] = 0;
    U32[(typeRec.struct2 + 8) >> 2] = elements;
    const argTypes = alloc(4 * sig.args.length + 4);
    sig.args.forEach((t, i) => {
        U32[(argTypes >> 2) + i] = typeRec[t];
    });
    const cif = alloc(32);
    U32[cif >> 2] = 1;
    U32[(cif >> 2) + 1] = sig.args.length;
    U32[(cif >> 2) + 2] = argTypes;
    U32[(cif >> 2) + 3] = typeRec[sig.ret];
    U32[(cif >> 2) + 6] = sig.args.length;
    // argument slots (8 bytes each, as TCI's regs[]) and the pointer array
    const slots = alloc(8 * sig.args.length + 8);
    const avalue = alloc(4 * sig.args.length + 4);
    sig.args.forEach((t, i) => {
        const at = slots + 8 * i;
        if (t === 'u64' || t === 's64') {
            world.HEAPU64[at >> 3] = BigInt.asUintN(64, BigInt(sig.values[i]));
        } else if (t === 'double') {
            world.HEAPF64[at >> 3] = sig.values[i];
        } else {
            U32[at >> 2] = sig.values[i] >>> 0;
            U32[(at >> 2) + 1] = 0xdeadbeef;  // the upper half of the register: must not leak in
        }
        U32[(avalue >> 2) + i] = at;
    });
    const rvalue = alloc(16);
    world.HEAPU64[rvalue >> 3] = 0x5555555555555555n;
    world.HEAPU64[(rvalue >> 3) + 1] = 0x5555555555555555n;
    return { cif, avalue, rvalue };
}

const SIGS = [
    { name: '() -> void', args: [], ret: 'void', values: [], result: undefined },
    { name: '(ptr, u32) -> u32', args: ['ptr', 'u32'], ret: 'u32', values: [0x1234, 0xfffffff0], result: -5 },
    { name: '(ptr, u64, u64, s32) -> u64', args: ['ptr', 'u64', 'u64', 's32'], ret: 'u64',
        values: [0x40, -1n, 0x123456789abcdefn, -7], result: -2n },
    { name: '(s64) -> s64', args: ['s64'], ret: 's64', values: [-123456789012n], result: 0x7fffffffffffffffn },
    { name: '7 mixed -> void', args: ['ptr', 'u64', 'u32', 's64', 'int', 'u64', 'ptr'], ret: 'void',
        values: [1, 2n, 3, -4n, -5, 6n, 7], result: undefined },
    { name: '(u32) -> ptr', args: ['u32'], ret: 'ptr', values: [99], result: 0x80000010 },
    { name: '(double) -> double, the slow path', args: ['double'], ret: 'double', values: [1.5], result: 2.5, slow: true },
    { name: '(ptr, struct of two u64) -> void, the slow path', args: ['ptr', 'struct2'], ret: 'void', values: [5, 0], result: undefined, slow: true },
];

const fastApplied = {};
const fastCode = glueRewrite(`${ORIGINAL}\nvar wasmImports = {};\n`, ['ffi'], fastApplied);
check('the fast ffi_call_js goes in before the imports', () => assert.equal(fastApplied.ffi, 1));
check('without a place for it, ffi changes nothing', () => {
    const applied = {};
    assert.equal(glueRewrite(ORIGINAL, ['ffi'], applied), ORIGINAL);
    assert.equal(applied.ffi, 0);
});
for (const sig of SIGS) {
    check(`fast ffi_call_js, ${sig.name}`, () => {
        const runs = [];
        for (const code of [ORIGINAL, fastCode]) {
            const world = makeWorld(code);
            const { cif, avalue, rvalue } = layout(world, sig);
            world.table.set(77, (...args) => {
                world.calls.push(args);
                return sig.result;
            });
            for (let i = 0; i < 3; i++) {
                world.ffi_call_js(cif, 77, rvalue, avalue);
            }
            runs.push({ calls: world.calls, ret: [world.HEAPU64[rvalue >> 3], world.HEAPU64[(rvalue >> 3) + 1]], stackSaves: world.stackSaves });
        }
        const [orig, fast] = runs;
        assert.deepEqual(fast.calls, orig.calls, 'arguments differ');
        assert.deepEqual(fast.ret, orig.ret, 'stored results differ');
        // The fast path never touches the stack; the slow one does as before.
        assert.equal(fast.stackSaves, sig.slow ? orig.stackSaves : 0);
    });
}

check('FFI_FAST is valid JavaScript', () => {
    // eslint-disable-next-line no-new-func
    new Function(FFI_FAST);
});

if (failures) {
    console.log(`webkit-glue: ${failures} checks failed`);
    process.exit(1);
}
console.log('webkit-glue: all checks passed');
