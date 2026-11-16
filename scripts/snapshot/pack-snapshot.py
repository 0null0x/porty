#!/usr/bin/env python3
"""Publish a QEMU migration stream as independently compressed chunks.

  pack-snapshot.py pack   --state vm.state --out snapshot/ --argv-file ARGS
                          --query Q --image-manifest image/manifest.json
                          --patches-dir patches/qemu-wasm --qemu-commit SHA
                          --booted-seconds N [--runstate running]
                          [--rom-dir pc-bios]
  pack-snapshot.py unpack --dir snapshot/ --state vm.state

Layout written by "pack" (format 1, shared with the page):

  snapshot/000000.zz, 000001.zz, ...   the stream cut into chunk_size pieces
                                       (the last one shorter), each a zlib
                                       stream (RFC 1950, level 9)
  snapshot/manifest.json
    format              1
    kind                "qemu-migration"
    qemu_wasm_commit    the QEMU-Wasm commit both builds come from
    porty_patches_sha256  SHA-256 over patches/qemu-wasm/*.patch, concatenated
                        in name order
    uncompressed_size   bytes of the stream
    chunk_size          4194304
    compression         "zlib"
    chunks              [{file, size, sha256}]: compressed size and hash
    argv                QEMU arguments as the page builds them (page paths),
                        without "-incoming"
    query               the page parameters those arguments come from
    image_manifest_sha256  SHA-256 of the image manifest.json booted from
    booted_seconds      how long the native boot took
  Additions to the agreed format (readers may ignore them):
    uncompressed_sha256 SHA-256 of the whole stream
    runstate            "running": QEMU starts the guest after loading;
                        "paused": it waits for "cont"
    firmware            {file: sha256} of the pc-bios files the saved ROM
                        blocks were made from
    image_disk          the image manifest's "disk" entry without its chunk
                        list (format, sizes, content hash): what the guest's
                        system disk must contain

"unpack" rebuilds the stream from a directory and checks every hash; the
workflow restores from that copy, so the published files are what is tested.
Standard library only; run with "python3 -I".
"""

import argparse
import hashlib
import json
import os
import sys
import zlib

CHUNK = 4 * 1024 * 1024


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def patches_sha256(directory):
    digest = hashlib.sha256()
    names = sorted(n for n in os.listdir(directory) if n.endswith(".patch"))
    if not names:
        raise SystemExit(f"no patches in {directory}")
    for name in names:
        with open(os.path.join(directory, name), "rb") as f:
            digest.update(f.read())
    return digest.hexdigest(), names


def pack(opts):
    os.makedirs(opts.out, exist_ok=True)
    if os.listdir(opts.out):
        raise SystemExit(f"{opts.out} is not empty")
    with open(opts.argv_file, encoding="utf-8") as f:
        argv = [line.rstrip("\n") for line in f if line.rstrip("\n") != ""]
    if "-incoming" in argv:
        raise SystemExit("argv must not contain -incoming")

    chunks = []
    whole = hashlib.sha256()
    total = 0
    packed = 0
    with open(opts.state, "rb") as f:
        while True:
            block = f.read(CHUNK)
            if not block:
                break
            whole.update(block)
            total += len(block)
            data = zlib.compress(block, 9)
            name = f"{len(chunks):06d}.zz"
            with open(os.path.join(opts.out, name), "wb") as out:
                out.write(data)
            packed += len(data)
            chunks.append({"file": name, "size": len(data),
                           "sha256": hashlib.sha256(data).hexdigest()})
    if not total:
        raise SystemExit(f"{opts.state} is empty")

    patch_hash, _ = patches_sha256(opts.patches_dir)
    manifest = {
        "format": 1,
        "kind": "qemu-migration",
        "qemu_wasm_commit": opts.qemu_commit,
        "porty_patches_sha256": patch_hash,
        "uncompressed_size": total,
        "chunk_size": CHUNK,
        "compression": "zlib",
        "chunks": chunks,
        "argv": argv,
        "query": opts.query,
        "image_manifest_sha256": sha256_file(opts.image_manifest),
        "booted_seconds": opts.booted_seconds,
        "uncompressed_sha256": whole.hexdigest(),
        "runstate": opts.runstate,
    }
    with open(opts.image_manifest, encoding="utf-8") as f:
        disk = json.load(f).get("disk", {})
    manifest["image_disk"] = {k: v for k, v in disk.items() if not isinstance(v, (list, dict))}
    if opts.rom_dir:
        manifest["firmware"] = {name: sha256_file(os.path.join(opts.rom_dir, name))
                                for name in sorted(os.listdir(opts.rom_dir))}
    with open(os.path.join(opts.out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=1)
        f.write("\n")
    largest = max(c["size"] for c in chunks)
    print(f"packed {total} bytes into {len(chunks)} chunks, {packed} bytes compressed "
          f"({100.0 * packed / total:.1f}%), largest chunk {largest} bytes")
    print(json.dumps({"raw": total, "compressed": packed, "chunks": len(chunks)}))


def unpack(opts):
    with open(os.path.join(opts.dir, "manifest.json"), encoding="utf-8") as f:
        manifest = json.load(f)
    if manifest.get("format") != 1 or manifest.get("compression") != "zlib":
        raise SystemExit("unsupported snapshot manifest")
    size = manifest["chunk_size"]
    whole = hashlib.sha256()
    total = 0
    last = len(manifest["chunks"]) - 1
    with open(opts.state, "wb") as out:
        for i, chunk in enumerate(manifest["chunks"]):
            with open(os.path.join(opts.dir, chunk["file"]), "rb") as f:
                data = f.read()
            if len(data) != chunk["size"] or hashlib.sha256(data).hexdigest() != chunk["sha256"]:
                raise SystemExit(f"{chunk['file']}: size or hash mismatch")
            block = zlib.decompress(data)
            if (len(block) != size and i != last) or len(block) > size or not block:
                raise SystemExit(f"{chunk['file']}: unexpected uncompressed size {len(block)}")
            whole.update(block)
            total += len(block)
            out.write(block)
    if total != manifest["uncompressed_size"]:
        raise SystemExit(f"stream is {total} bytes, manifest says {manifest['uncompressed_size']}")
    if "uncompressed_sha256" in manifest and whole.hexdigest() != manifest["uncompressed_sha256"]:
        raise SystemExit("stream hash mismatch")
    print(f"unpacked {total} bytes from {len(manifest['chunks'])} chunks, hashes match")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="mode", required=True)
    p = sub.add_parser("pack")
    p.add_argument("--state", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--argv-file", required=True)
    p.add_argument("--query", required=True)
    p.add_argument("--image-manifest", required=True)
    p.add_argument("--patches-dir", required=True)
    p.add_argument("--qemu-commit", required=True)
    p.add_argument("--booted-seconds", type=float, required=True)
    p.add_argument("--runstate", default="running")
    p.add_argument("--rom-dir")
    u = sub.add_parser("unpack")
    u.add_argument("--dir", required=True)
    u.add_argument("--state", required=True)
    opts = ap.parse_args()
    if opts.mode == "pack":
        pack(opts)
    else:
        unpack(opts)
    return 0


if __name__ == "__main__":
    sys.exit(main())
