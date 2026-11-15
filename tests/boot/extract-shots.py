#!/usr/bin/env python3
"""Recover the screenshots that tests/boot/boot-test.mjs prints into a log.

usage: python3 -I tests/boot/extract-shots.py <log-file> <out-dir>

<log-file> is a job log as printed by `gh run view <run-id> --log` (lines
prefixed with job, step and timestamp) or as downloaded raw from GitHub.
Writes <out-dir>/NN-<name>.jpg and prints one line per image.
"""
import base64
import binascii
import os
import re
import sys

# "<job>\t<step>\t2026-11-15T19:39:21.1996317Z " in `gh run view --log`
# output, or just the timestamp in a raw job log.
PREFIX = re.compile(r"^(?:[^\t]*\t[^\t]*\t)?﻿?(?:\d{4}-\d\d-\d\dT[0-9:.]+Z )?")
BEGIN = re.compile(r"^-----BEGIN PORTY SCREENSHOT (\S+) (.*)-----$")
END = "-----END PORTY SCREENSHOT-----"


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    log_path, out_dir = sys.argv[1], sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)
    name = info = None
    parts: list[str] = []
    count = 0
    with open(log_path, encoding="utf-8", errors="replace") as log:
        for raw in log:
            line = PREFIX.sub("", raw.rstrip("\r\n"), count=1)
            if name is None:
                match = BEGIN.match(line)
                if match:
                    name, info, parts = match.group(1), match.group(2), []
                continue
            if line != END:
                parts.append(line.strip())
                continue
            count += 1
            safe = re.sub(r"[^A-Za-z0-9._-]", "_", name)
            path = os.path.join(out_dir, f"{count:02d}-{safe}.jpg")
            try:
                data = base64.b64decode("".join(parts), validate=True)
            except (binascii.Error, ValueError) as err:
                print(f"skipping {name}: {err}", file=sys.stderr)
            else:
                with open(path, "wb") as out:
                    out.write(data)
                print(f"{path}  {info}  ({len(data)} bytes)")
            name = info = None
    if count == 0:
        print("no screenshots found", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
