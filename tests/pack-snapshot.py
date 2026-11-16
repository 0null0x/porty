#!/usr/bin/env python3
"""Pack a QEMU migration stream as a Porty snapshot (for the tests).

usage: pack-snapshot.py <stream-file> <out-dir> --argv <file> --query <q>
           --qemu-commit <sha> --patches-sha256 <hex> --image-manifest <file>
           [--chunk-size <bytes>] [--booted-seconds <n>]

Writes <out-dir>/000000.zz, 000001.zz, ... (each the zlib compression of the
next --chunk-size bytes of the stream) and <out-dir>/manifest.json in the
format web/js/snapshot.js checks and scripts/assemble-site.sh validates.
--argv names a file with one QEMU argument per line, as printed by
tests/print-qemu-args.mjs.
SPDX-License-Identifier: GPL-2.0-or-later
"""
import argparse
import hashlib
import json
import os
import zlib


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("stream")
    ap.add_argument("out")
    ap.add_argument("--argv", required=True)
    ap.add_argument("--query", required=True)
    ap.add_argument("--qemu-commit", required=True)
    ap.add_argument("--patches-sha256", required=True)
    ap.add_argument("--image-manifest", required=True)
    ap.add_argument("--chunk-size", type=int, default=4194304)
    ap.add_argument("--booted-seconds", type=int, default=0)
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    chunks = []
    total = 0
    with open(args.stream, "rb") as stream:
        while True:
            plain = stream.read(args.chunk_size)
            if not plain:
                break
            total += len(plain)
            packed = zlib.compress(plain, 6)
            name = f"{len(chunks):06d}.zz"
            with open(os.path.join(args.out, name), "wb") as f:
                f.write(packed)
            chunks.append({"file": name, "size": len(packed),
                           "sha256": hashlib.sha256(packed).hexdigest()})
    with open(args.argv, encoding="utf-8") as f:
        argv = [line.rstrip("\n") for line in f if line.rstrip("\n")]
    with open(args.image_manifest, "rb") as f:
        image_sha = hashlib.sha256(f.read()).hexdigest()
    manifest = {
        "format": 1,
        "kind": "qemu-migration",
        "qemu_wasm_commit": args.qemu_commit,
        "porty_patches_sha256": args.patches_sha256,
        "uncompressed_size": total,
        "chunk_size": args.chunk_size,
        "compression": "zlib",
        "chunks": chunks,
        "argv": argv,
        "query": args.query,
        "image_manifest_sha256": image_sha,
        "booted_seconds": args.booted_seconds,
    }
    with open(os.path.join(args.out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")
    print(f"packed {total} bytes into {len(chunks)} chunks "
          f"({sum(c['size'] for c in chunks)} bytes compressed)")


if __name__ == "__main__":
    main()
