#!/usr/bin/env python3
"""Print the section sizes and the memory import of a WebAssembly module.

Used by the build to confirm that the module imports a shared memory with
the expected limits (web/js/wasm-patch.js rewrites exactly those limits in
the browser) and to show where the bytes of the .wasm file go.

It also lists the largest function bodies, and the hot functions of the
translator and the interpreter: JavaScriptCore never compiles a body over
Options::maximumOMGCandidateCost bytes (40000 in WebKit 2.48, 100000
later) with its optimizing tier, and compiles one just under it at a high
transient cost in memory.  A hot function over WATCH_LIMIT bytes is
reported with a warning (never an error).

usage: wasm-info.py <file.wasm> [--json out.json] [--expect-memory-mb N]
SPDX-License-Identifier: GPL-2.0-or-later
"""
import argparse
import json
import re
import sys

SECTION_NAMES = {
    0: "custom", 1: "type", 2: "import", 3: "function", 4: "table",
    5: "memory", 6: "global", 7: "export", 8: "start", 9: "element",
    10: "code", 11: "data", 12: "datacount", 13: "tag",
}
PAGE = 65536

# Hot during an app launch: the translator (millions of TBs per launch), the
# interpreter and its helper calls, the execution loop, the soft MMU.
WATCH = re.compile(
    r"^(i386_tr_translate_insn|disas_insn|tcg_gen_code|tcg_optimize|tcg_reg_alloc"
    r"|tcg_out_op|liveness_pass|reachable_code_pass|tcg_qemu_tb_exec|porty_tci_call"
    r"|cpu_exec_loop|tb_gen_code|tb_lookup|helper_lookup_tb_ptr|mmu_translate"
    r"|x86_cpu_tlb_fill|(do|helper)_(ld|st)[0-9_])")
WATCH_LIMIT = 40000


def leb(buf, pos):
    result = shift = 0
    while True:
        byte = buf[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return result, pos
        shift += 7


def name(buf, pos):
    length, pos = leb(buf, pos)
    return buf[pos:pos + length].decode("utf-8", "replace"), pos + length


def limits(buf, pos):
    flags = buf[pos]
    pos += 1
    minimum, pos = leb(buf, pos)
    maximum = None
    if flags & 0x01:
        maximum, pos = leb(buf, pos)
    return {"flags": flags, "min": minimum, "max": maximum}, pos


def memory_import(buf, pos, end):
    count, pos = leb(buf, pos)
    for _ in range(count):
        module, pos = name(buf, pos)
        field, pos = name(buf, pos)
        kind = buf[pos]
        pos += 1
        if kind == 0:      # function: type index
            _, pos = leb(buf, pos)
        elif kind == 1:    # table: reftype + limits
            pos += 1
            _, pos = limits(buf, pos)
        elif kind == 2:    # memory
            lim, pos = limits(buf, pos)
            lim.update(module=module, field=field,
                       shared=bool(lim["flags"] & 0x02))
            return lim
        elif kind == 3:    # global: valtype + mutability
            pos += 2
        elif kind == 4:    # tag: attribute + type index
            pos += 1
            _, pos = leb(buf, pos)
        else:
            raise ValueError(f"unknown import kind {kind}")
        if pos > end:
            raise ValueError("import section overrun")
    return None


def imported_functions(buf, pos):
    count, pos = leb(buf, pos)
    functions = 0
    for _ in range(count):
        _, pos = name(buf, pos)
        _, pos = name(buf, pos)
        kind = buf[pos]
        pos += 1
        if kind == 0:
            functions += 1
            _, pos = leb(buf, pos)
        elif kind in (1, 2):
            pos += 1 if kind == 1 else 0
            _, pos = limits(buf, pos)
        elif kind == 3:
            pos += 2
        elif kind == 4:
            pos += 1
            _, pos = leb(buf, pos)
        else:
            raise ValueError(f"unknown import kind {kind}")
    return functions


def body_sizes(buf, pos):
    count, pos = leb(buf, pos)
    sizes = []
    for _ in range(count):
        size, pos = leb(buf, pos)
        sizes.append(size)
        pos += size
    return sizes


def function_names(buf, pos, end):
    """The name section's function names: {function index: name}."""
    names = {}
    while pos < end:
        kind = buf[pos]
        size, pos = leb(buf, pos + 1)
        if kind == 1:
            count, p = leb(buf, pos)
            for _ in range(count):
                index, p = leb(buf, p)
                names[index], p = name(buf, p)
        pos += size
    return names


def inspect(buf):
    if buf[:8] != b"\0asm\x01\0\0\0":
        raise ValueError("not a WebAssembly 1.0 binary")
    pos = 8
    sections = []
    memory = None
    imported = 0
    sizes = []
    names = {}
    while pos < len(buf):
        section_id = buf[pos]
        size, body = leb(buf, pos + 1)
        label = SECTION_NAMES.get(section_id, f"section-{section_id}")
        if section_id == 0:
            custom, after = name(buf, body)
            label = f"custom:{custom}"
            if custom == "name":
                names = function_names(buf, after, body + size)
        if section_id == 2:
            memory = memory_import(buf, body, body + size)
            imported = imported_functions(buf, body)
        if section_id == 10:
            sizes = body_sizes(buf, body)
        sections.append({"name": label, "size": size})
        pos = body + size
    functions = sorted(((size, names.get(imported + i, f"function {imported + i}"))
                        for i, size in enumerate(sizes)), reverse=True)
    return {
        "size": len(buf), "sections": sections, "memory_import": memory,
        "functions": len(sizes),
        "largest_functions": [{"name": n, "bytes": b} for b, n in functions[:40]],
        "hot_functions": [{"name": n, "bytes": b} for b, n in functions
                          if WATCH.match(n)][:40],
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("wasm")
    parser.add_argument("--json")
    parser.add_argument("--expect-memory-mb", type=int)
    args = parser.parse_args()

    with open(args.wasm, "rb") as f:
        info = inspect(f.read())

    print(f"{args.wasm}: {info['size']} bytes")
    for section in sorted(info["sections"], key=lambda s: -s["size"])[:12]:
        print(f"  {section['size']:>12}  {section['name']}")
    memory = info["memory_import"]
    print(f"  memory import: {memory}")
    print(f"  {info['functions']} functions; the largest bodies:")
    for f in info["largest_functions"][:25]:
        print(f"  {f['bytes']:>12}  {f['name']}")
    print("  hot functions (translator, interpreter, execution loop, soft MMU):")
    for f in info["hot_functions"][:25]:
        print(f"  {f['bytes']:>12}  {f['name']}")
        if f["bytes"] > WATCH_LIMIT:
            print(f"::warning::{f['name']} is {f['bytes']} bytes of WebAssembly, over "
                  f"{WATCH_LIMIT}: JavaScriptCore may never optimize it, or "
                  f"optimize it at a high cost in memory")

    if memory is None:
        sys.exit("error: the module does not import its memory")
    if not memory["shared"] or memory["max"] is None:
        sys.exit("error: the imported memory is not shared with a maximum")
    info["memory_mb"] = memory["min"] * PAGE // (1024 * 1024)
    if args.expect_memory_mb is not None and info["memory_mb"] != args.expect_memory_mb:
        sys.exit(f"error: memory is {info['memory_mb']} MiB, "
                 f"expected {args.expect_memory_mb} MiB")
    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(info, f, indent=2)
            f.write("\n")


if __name__ == "__main__":
    main()
