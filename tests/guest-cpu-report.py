#!/usr/bin/env python3
"""Summarise tests/guest-cpu-native.py results (result.json files) as Markdown.

usage: guest-cpu-report.py result.json...

First line: "ok: ..." or "failed: ...", the rest a table per app: for every
variant the median and the single values of the times (host seconds after
the tap: Android drew the activity, the guest was quiet again) and where
the guest's CPU went (median share of the busy ticks), and surfaceflinger's
frames.  Standard library only; run with "python3 -I".
"""

import json
import statistics
import sys


def med(values):
    values = [v for v in values if v is not None]
    return round(statistics.median(values), 1) if values else None


def share(launch, names):
    d = launch.get("cpu") or {}
    busy = max(1, d.get("busy") or 0)
    ticks = sum(p["ticks"] for p in d.get("procs", []) if p["comm"] in names)
    return 100.0 * ticks / busy


def main(paths):
    results = []
    for path in paths:
        try:
            with open(path, encoding="utf-8") as f:
                results.append(json.load(f))
        except (OSError, ValueError) as e:
            print(f"# unreadable {path}: {e}", file=sys.stderr)
    booted = [r for r in results if r.get("booted")]
    launches = sum(len(r.get("launches", [])) for r in booted)
    first = (f"ok: {len(booted)}/{len(results)} variants booted, {launches} starts"
             if booted and launches else f"failed: {len(booted)}/{len(results)} booted, {launches} starts")
    print(first)
    cpu = next((r.get("cpu") for r in results if r.get("cpu")), "")
    print()
    print(f"Runner CPU: {cpu}")
    apps = []
    for r in booted:
        for one in r.get("launches", []):
            if one["app"] not in apps:
                apps.append(one["app"])
    for app in apps:
        print()
        print(f"### {app}")
        print()
        print("| variant | boot s | drawn s (median; each) | quiet s | Android ms | busy ticks | sf frames | surfaceflinger % | app % "
              "| system_server % | launcher % | systemui % | top threads |")
        print("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
        for r in results:
            runs = [x for x in r.get("launches", []) if x["app"] == app]
            if not runs:
                print(f"| {r.get('variant')} | {r.get('booted_seconds', 'no boot')} | {r.get('error', '')[:80]} |||||||||||")
                continue
            # The app's process: new, named after the package (/proc's comm
            # is the last 15 characters of the process name).
            package = (x.get("component") or "").split("/")[0] if (x := runs[0]) else ""
            app_names = set()
            for x in runs:
                for p in (x.get("cpu") or {}).get("procs", []):
                    if p.get("new") and package and package.endswith(p["comm"]):
                        app_names.add(p["comm"])
            threads = {}
            for x in runs:
                for t in (x.get("cpu") or {}).get("threads", [])[:6]:
                    key = f"{t['proc'].split('.')[-1]}/{t['comm']}"
                    threads[key] = threads.get(key, 0) + t["ticks"]
            top = ", ".join(f"{k} {v // max(1, len(runs))}" for k, v in sorted(threads.items(), key=lambda kv: -kv[1])[:4])
            drawn = [x.get("drawn_s") for x in runs]
            print(f"| {r.get('variant')} | {r.get('booted_seconds')} | {med(drawn)}; {', '.join(str(v) for v in drawn)} "
                  f"| {med([x.get('quiet_s') for x in runs])} | {med([x.get('launch_total_ms') for x in runs])} "
                  f"| {med([(x.get('cpu') or {}).get('busy') for x in runs])} | {med([(x.get('cpu') or {}).get('frames') for x in runs])} "
                  f"| {med([share(x, {'surfaceflinger'}) for x in runs])} | {med([share(x, app_names) for x in runs])} "
                  f"| {med([share(x, {'system_server'}) for x in runs])} | {med([share(x, {'com.android.launcher3'}) for x in runs])} "
                  f"| {med([share(x, {'com.android.systemui'}) for x in runs])} | {top} |")
    uis = [r for r in results if r.get("ui")]
    if uis:
        print()
        print("### UI check (Settings: two finger drags, two pointer moves, typing in its search)")
        print()
        print("| variant | scrolled % | back at the top, % off | pointer moved % | typed % | sf frames | busy ticks "
              "| surfaceflinger % | focus or error |")
        print("|---|---|---|---|---|---|---|---|---|")
        for r in uis:
            u = r["ui"]
            print(f"| {r.get('variant')} | {u.get('scrolled_pct')} | {u.get('scrolled_back_vs_top_pct')} "
                  f"| {u.get('pointer_moved_pct')} | {u.get('typed_pct')} | {u.get('sf_frames')} | {u.get('busy')} "
                  f"| {u.get('surfaceflinger_pct')} | {(u.get('error') or u.get('search_focus') or '')[:70]} |")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
