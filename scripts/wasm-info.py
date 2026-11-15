#!/usr/bin/env python3
"""Print the section sizes and the memory import of a WebAssembly module.

Used by the build to confirm that the module imports a shared memory with
the expected limits (web/js/wasm-patch.js rewrites exactly those limits in
the browser) and to show where the bytes of the .wasm file go.

usage: wasm-info.py <file.wasm> [--json out.json] [--expect-memory-mb N]
SPDX-License-Identifier: GPL-2.0-or-later
"""
import argparse
import json
import sys

SECTION_NAMES = {
    0: "custom", 1: "type", 2: "import", 3: "function", 4: "table",
    5: "memory", 6: "global", 7: "export", 8: "start", 9: "element",
    10: "code", 11: "data", 12: "datacount", 13: "tag",
}
PAGE = 65536


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


def inspect(buf):
    if buf[:8] != b"\0asm\x01\0\0\0":
        raise ValueError("not a WebAssembly 1.0 binary")
    pos = 8
    sections = []
    memory = None
    while pos < len(buf):
        section_id = buf[pos]
        size, body = leb(buf, pos + 1)
        label = SECTION_NAMES.get(section_id, f"section-{section_id}")
        if section_id == 0:
            custom, _ = name(buf, body)
            label = f"custom:{custom}"
        if section_id == 2:
            memory = memory_import(buf, body, body + size)
        sections.append({"name": label, "size": size})
        pos = body + size
    return {"size": len(buf), "sections": sections, "memory_import": memory}


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
