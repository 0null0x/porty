#!/usr/bin/env python3
"""Check the generated TCI helper dispatch (build/gen-tci-calls.py, patch
0015) natively against libffi: for every signature the switch covers, a
generated helper is called both ways with the same arguments, and the
arguments it sees and the result where TCI reads it must match.  Also
checks that signatures the switch does not cover (Int128 as a struct,
floating point, too many arguments) are refused.

usage: tests/tci-calls-test.py   (needs cc and libffi-dev)
"""
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
MAX_ARGS = 7


def helper(r, n, mask):
    rt = {0: 'void', 1: 'uint32_t', 2: 'uint64_t'}[r]
    params = ', '.join(f'{"uint64_t" if mask >> i & 1 else "uint32_t"} p{i}' for i in range(n)) or 'void'
    body = ''.join(f'    seen[{i}] = p{i};\n' for i in range(n))
    ret = ''
    if r:
        ret = f'    return ({rt})(0x1234567890abcdefULL ^ (uint64_t){r * 1000 + n * 100 + mask}ULL{"".join(f" ^ (uint64_t)p{i}" for i in range(n))});\n'
    return f'static {rt} h_{r}_{n}_{mask}({params})\n{{\n    nseen = {n};\n{body}{ret}}}\n'


def patch_header() -> str:
    """tcg/wasm32-tci-calls.h as patch 0015 adds it."""
    patches = os.path.join(HERE, '..', 'patches', 'qemu-wasm')
    for name in sorted(os.listdir(patches)):
        if not name.startswith('0015-'):
            continue
        lines, inside = [], False
        for line in open(os.path.join(patches, name)):
            if line.startswith('diff --git '):
                inside = line.rstrip().endswith('b/tcg/wasm32-tci-calls.h')
            elif inside and line.startswith('+') and not line.startswith('+++'):
                lines.append(line[1:])
        return ''.join(lines)
    return ''


def main() -> int:
    generated = subprocess.run([sys.executable, os.path.join(HERE, '..', 'build', 'gen-tci-calls.py')],
                               capture_output=True, text=True, check=True).stdout
    if patch_header() != generated:
        print('tci-calls: tcg/wasm32-tci-calls.h in patch 0015 is not what build/gen-tci-calls.py prints')
        return 1
    cases = [(r, n, m) for r in (0, 1, 2) for n in range(MAX_ARGS + 1) for m in range(1 << n)]
    src = ['#include <stdbool.h>', '#include <stdint.h>', '#include <stdio.h>', '#include <string.h>', '#include <ffi.h>',
           '#include "tci-calls.h"', 'static uint64_t seen[8]; static int nseen;']
    src += [helper(*c) for c in cases]
    src.append('''
static ffi_type *ty(int wide) { return wide ? &ffi_type_uint64 : &ffi_type_uint32; }

/* One signature both ways; 0 if they agree. */
static int check(int r, int n, int mask, void *f)
{
    uint64_t slots[8], seen_ffi[8], seen_direct[8];
    void *av[8];
    ffi_type *args[8];
    ffi_cif cif;
    uint64_t ret_ffi[2], ret_direct[2];
    ffi_type *rt = r == 0 ? &ffi_type_void : r == 1 ? &ffi_type_uint32 : &ffi_type_uint64;
    int i, code;

    for (i = 0; i < n; i++) {
        /* 32-bit arguments get garbage in the upper half of their slot, as TCI's registers may */
        slots[i] = 0x9e3779b97f4a7c15ULL * (uint64_t)(i + 1 + mask) ^ (uint64_t)(r << 20 | n << 8);
        av[i] = &slots[i];
        args[i] = ty(mask >> i & 1);
    }
    if (ffi_prep_cif(&cif, FFI_DEFAULT_ABI, n, rt, args) != FFI_OK) {
        printf("FAIL  ffi_prep_cif for r=%d n=%d mask=%d\\n", r, n, mask);
        return 1;
    }
    code = porty_tci_code(&cif);
    if (code != PORTY_TCI_CODE(r, n, mask)) {
        printf("FAIL  r=%d n=%d mask=%d: code %d\\n", r, n, mask, code);
        return 1;
    }
    memset(ret_ffi, 0x55, sizeof(ret_ffi));
    memset(ret_direct, 0x55, sizeof(ret_direct));
    memset(seen, 0, sizeof(seen));
    ffi_call(&cif, FFI_FN(f), ret_ffi, av);
    memcpy(seen_ffi, seen, sizeof(seen));
    memset(seen, 0, sizeof(seen));
    if (!porty_tci_call_direct(code, f, ret_direct, av)) {
        printf("FAIL  r=%d n=%d mask=%d: no case\\n", r, n, mask);
        return 1;
    }
    memcpy(seen_direct, seen, sizeof(seen));
    if (memcmp(seen_ffi, seen_direct, sizeof(seen))) {
        printf("FAIL  r=%d n=%d mask=%d: the helper saw other arguments\\n", r, n, mask);
        return 1;
    }
    /* What TCI reads: the low 32 bits of the first slot for an i32, all 64 for an i64. */
    if (r == 1 && (uint32_t)ret_ffi[0] != (uint32_t)ret_direct[0]) {
        printf("FAIL  r=%d n=%d mask=%d: i32 result %x, libffi %x\\n", r, n, mask, (uint32_t)ret_direct[0], (uint32_t)ret_ffi[0]);
        return 1;
    }
    if (r == 2 && ret_ffi[0] != ret_direct[0]) {
        printf("FAIL  r=%d n=%d mask=%d: i64 result differs\\n", r, n, mask);
        return 1;
    }
    if (r == 0 && ret_direct[0] != 0x5555555555555555ULL) {
        printf("FAIL  r=%d n=%d mask=%d: a void call wrote a result\\n", r, n, mask);
        return 1;
    }
    return 0;
}

static int refused(const char *what, ffi_type *rt, int n, ffi_type **args)
{
    ffi_cif cif;
    if (ffi_prep_cif(&cif, FFI_DEFAULT_ABI, n, rt, args) != FFI_OK) {
        printf("FAIL  ffi_prep_cif for %s\\n", what);
        return 1;
    }
    if (porty_tci_code(&cif) != -1) {
        printf("FAIL  %s is not refused\\n", what);
        return 1;
    }
    return 0;
}

int main(void)
{
    int failures = 0, checked = 0;
''')
    for (r, n, m) in cases:
        src.append(f'    failures += check({r}, {n}, {m}, (void *)h_{r}_{n}_{m}); checked++;')
    src.append('''
    {
        ffi_type *pair[3] = { &ffi_type_uint64, &ffi_type_uint64, NULL };
        ffi_type i128 = { 0, 0, FFI_TYPE_STRUCT, pair };
        ffi_type *a1[1] = { &i128 };
        ffi_type *d1[1] = { &ffi_type_double };
        ffi_type *many[8] = { &ffi_type_uint32, &ffi_type_uint32, &ffi_type_uint32, &ffi_type_uint32,
                              &ffi_type_uint32, &ffi_type_uint32, &ffi_type_uint32, &ffi_type_uint32 };
        failures += refused("an Int128 argument", &ffi_type_void, 1, a1);
        failures += refused("an Int128 result", &i128, 0, NULL);
        failures += refused("a double argument", &ffi_type_void, 1, d1);
        failures += refused("eight arguments", &ffi_type_void, 8, many);
        failures += refused("a float result", &ffi_type_float, 0, NULL);
    }
    if (failures) {
        printf("tci-calls: %d of %d signatures FAILED\\n", failures, checked);
        return 1;
    }
    printf("tci-calls: %d signatures agree with libffi; Int128, floats and 8 arguments are left to libffi\\n", checked);
    return 0;
}
''')
    with tempfile.TemporaryDirectory() as tmp:
        with open(os.path.join(tmp, 'tci-calls.h'), 'w') as f:
            subprocess.run([sys.executable, os.path.join(HERE, '..', 'build', 'gen-tci-calls.py')], stdout=f, check=True,
                           stderr=subprocess.DEVNULL)
        with open(os.path.join(tmp, 't.c'), 'w') as f:
            f.write('\n'.join(src))
        cflags = subprocess.run(['pkg-config', '--cflags', '--libs', 'libffi'], capture_output=True, text=True).stdout.split() or ['-lffi']
        exe = os.path.join(tmp, 't')
        cc = subprocess.run(['cc', '-O1', '-Wall', '-Wno-unused-function', '-o', exe, os.path.join(tmp, 't.c'), '-I', tmp, *cflags],
                            capture_output=True, text=True)
        if cc.returncode:
            print(cc.stderr[-3000:])
            print('tci-calls: does not compile')
            return 1
        return subprocess.run([exe]).returncode


if __name__ == '__main__':
    sys.exit(main())
