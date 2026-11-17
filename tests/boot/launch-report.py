#!/usr/bin/env python3
"""A table of Gallery launches from boot test logs (tests/boot/boot-test.mjs).

usage: python3 -I launch-report.py <label>=<boot-test log>...

Reads the "LAUNCH RESULT" line of each log (the input probe's account of
the launch) and prints a Markdown table: when the screen changed and when
Android drew Gallery (seconds after the tap), whether Gallery had the focus
at the end, where the guest's CPU went (from the probe's CPU snapshots) and
the JIT counters.  The first line is "ok: ..." when at least one launch was
measured.  The logs hold the guest's serial console: they are only matched
against patterns, never run.
SPDX-License-Identifier: GPL-2.0-or-later
"""
import json
import re
import sys


def main(args):
    rows = []
    for arg in args:
        label, _, path = arg.partition("=")
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                log = f.read()
        except OSError as e:
            rows.append((label, None, f"no log ({e.strerror})"))
            continue
        m = re.search(r"^\[\d+:\d+\] LAUNCH RESULT: (\{.*\})\s*$", log, re.M)
        result = None
        if m:
            try:
                result = json.loads(m.group(1))
            except ValueError:
                result = None
        cpu = re.search(r"^\[\d+:\d+\] host CPU: (.*)$", log, re.M)
        rows.append((label, result, cpu.group(1).strip() if cpu else "?"))
    measured = [r for r in rows if r[1]]
    print(f"ok: {len(measured)} of {len(rows)} launches measured" if measured else f"failed: none of {len(rows)} launches measured")
    print()
    print("| visit | host CPU | screen changed s | screen timeline | drawn (event log) s | Android's launch time s | focused at end "
          "| guest busy ticks | display updates | top processes (ticks) | top threads | JIT compiled |")
    print("|---|---|---|---|---|---|---|---|---|---|---|---|")
    for label, r, cpu in rows:
        if not r:
            print(f"| {label} | {cpu} | no launch result |||||||||")
            continue
        c = r.get("cpu") or {}
        top = ", ".join(f"{name} {ticks}" for name, ticks in (c.get("top") or [])[:5])
        threads = ", ".join(f"{name} {ticks}" for name, ticks in (c.get("threads") or [])[:5])
        jit = r.get("jit") or {}
        print(f"| {label} | {r.get('hostCpu', cpu)} | {r.get('screenChangedS')} | {r.get('screenTimeline', '')} "
              f"| {r.get('firstFrameS')} | {r.get('launchTimeWallS')} | {r.get('focusedAtEnd')} "
              f"| {c.get('busy', '')} | {c.get('displayUpdates', '')} | {top} | {threads} | {jit.get('compiled', '')} |")
    after = [(label, r) for label, r, _ in rows if r and (r.get("cpuAfterContent") or r.get("anr"))]
    if after:
        print()
        print("After the app's content showed (90% of the screen changed), and \"not responding\" reports:")
        print()
        print("| visit | content s | busy ticks after | of | guest s | probe's shell | top processes after (ticks) "
              "| top threads after | not responding after the tap |")
        print("|---|---|---|---|---|---|---|---|---|")
        for label, r in after:
            c = r.get("cpuAfterContent") or {}
            a = r.get("anr") or {}
            top = ", ".join(f"{name} {ticks}" for name, ticks in (c.get("top") or [])[:5])
            threads = ", ".join(f"{name} {ticks}" for name, ticks in (c.get("threads") or [])[:5])
            listed = "; ".join(f"{proc}: {reason[:60]}" for proc, reason in (a.get("afterTapList") or [])[:3])
            print(f"| {label} | {r.get('contentS', '')} | {c.get('busy', '')} | {c.get('total', '')} | {c.get('guestSeconds', '')} "
                  f"| {c.get('probeTicks', '')} | {top} | {threads} | {a.get('afterTap', '')} {listed} |")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
