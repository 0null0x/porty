#!/usr/bin/env python3
"""One line about one run of tests/boot/boot-test.mjs (one "visit").

usage: python3 -I visit-report.py <label> <boot-test log> [<server log>]

Reads the boot test's log, and optionally the request log of
tests/ui/serve.py for the same visit, and prints
  <label>|<state>|<text>
where <state> is success, failure or error (a commit status state) and
<text> says when the saved Android was resumed, how the input probe's
Gallery launch went, what the disk cache did and what the server was asked
for.  The logs hold the guest's serial console: they are only matched
against patterns, never run.
SPDX-License-Identifier: GPL-2.0-or-later
"""
import json
import re
import sys


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    label, log_path = sys.argv[1], sys.argv[2]
    try:
        with open(log_path, encoding="utf-8", errors="replace") as f:
            log = f.read()
    except OSError as e:
        print(f"{label}|error|no log ({e.strerror})")
        return
    parts = []
    state = "error"

    summary = re.search(r"^\[(\d+:\d+)\] SUMMARY: ([^;\n]*)", log, re.M)
    if summary:
        verdict = summary.group(2).strip()
        state = "success" if verdict == "booted" else ("failure" if verdict == "failed" else "error")
        parts.append(verdict)
    else:
        parts.append("the test did not finish")

    visit = None
    m = re.search(r"^\[\d+:\d+\] VISIT: (\{.*\})\s*$", log, re.M)
    if m:
        try:
            visit = json.loads(m.group(1))
        except ValueError:
            visit = None
    timings = (visit or {}).get("timings") or {}
    if "resumed" in timings:
        parts.append(f"resumed {timings['resumed'] / 1000:.1f} s after Start "
                     f"(downloads {timings.get('downloaded', 0) / 1000:.1f} s, QEMU up {timings.get('qemu', 0) / 1000:.1f} s)")
    elif "qemu" in timings:
        parts.append(f"QEMU up {timings['qemu'] / 1000:.1f} s after Start, no resume")
    done = re.search(r"^\[(\d+:\d+)\] ANDROID BOOT COMPLETED", log, re.M)
    if done:
        parts.append(f"shell answered at {done.group(1)}")
    gallery = re.search(r"INPUT PROBE: Gallery in front: (?:.* after (\d+) s|not within (\d+) s)", log)
    if gallery:
        parts.append(f"Gallery in front after {gallery.group(1)} s" if gallery.group(1)
                     else f"Gallery not in front within {gallery.group(2)} s")
    disks = re.findall(r'disk=\{"chunksTotal":\d+,"chunksFetched":(\d+),"megabytes":([0-9.]+)', log)
    if disks:
        parts.append(f"QEMU read {disks[-1][0]} disk chunks ({float(disks[-1][1]):.0f} MB)")
    cache = (visit or {}).get("diskCache")
    if cache:
        parts.append(f"disk cache: {cache.get('hits', 0)} chunks ({cache.get('hitBytes', 0) / 1048576:.0f} MB) from the device, "
                     f"{cache.get('misses', 0)} ({cache.get('missBytes', 0) / 1048576:.0f} MB) from the network, "
                     f"{cache.get('stored', 0)} stored"
                     + "".join(f", {cache[k]} {k}" for k in ("rejected", "errors", "full", "evicted") if cache.get(k)))
    elif visit is not None:
        parts.append("disk cache: off or not answering")
    stored = (visit or {}).get("stored")
    if stored and stored.get("bytes"):
        parts.append(f"{stored['bytes'] / 1048576:.0f} MB stored on the device")

    if len(sys.argv) > 3:
        count = {"image": [0, 0], "snapshot": [0, 0], "other": [0, 0]}
        try:
            with open(sys.argv[3], encoding="utf-8", errors="replace") as f:
                for line in f:
                    fields = line.split(None, 3)
                    if len(fields) < 4 or fields[1] != "200":
                        continue
                    path = fields[3].strip()
                    kind = ("image" if re.search(r"/image/[^/]+/\d{6}\.bin$", path)
                            else "snapshot" if re.search(r"/snapshot/[^/?]+\.zz", path) else "other")
                    count[kind][0] += 1
                    count[kind][1] += int(fields[2]) if fields[2].isdigit() else 0
            parts.append("server sent " + ", ".join(
                f"{n} {kind} {'chunks' if kind != 'other' else 'files'} ({size / 1048576:.0f} MB)"
                for kind, (n, size) in count.items()))
        except OSError:
            parts.append("no server log")
    print(f"{label}|{state}|{'; '.join(parts)}")


if __name__ == "__main__":
    main()
