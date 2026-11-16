#!/usr/bin/env python3
"""One result.json of tests/guest-memory-native.py as a line and a table.

usage: guest-memory-report.py <result.json>...   (python3 -I)
With several files (or "PORTY_RESULT" lines on stdin, "-"), one row each.
"""
import json
import sys


def load(path):
    if path == "-":
        out = []
        for line in sys.stdin:
            i = line.find("PORTY_RESULT ")
            if i >= 0:
                try:
                    out.append(json.loads(line[i + 13:]))
                except ValueError:
                    pass
        return out
    try:
        with open(path, encoding="utf-8") as f:
            return [json.load(f)]
    except (OSError, ValueError):
        return []


def summary(r):
    launches = r.get("launches", [])
    end = r.get("end", {})
    home = r.get("home", {})

    def total(rnd):
        times = [x.get("TotalTime") for x in launches if x["round"] == rnd]
        return sum(times) if times and all(t is not None for t in times) else None

    def delta(key):
        return end.get(key, 0) - home.get(key, 0)

    return {
        "name": r.get("name", "?"),
        "ok": bool(r.get("booted")) and bool(launches) and all(x.get("drawn") for x in launches)
              and not r.get("error") and not r.get("reboots"),
        "error": r.get("error", "" if r.get("booted") else "not booted"),
        "boot_s": r.get("booted_seconds"),
        "r1_ms": total(1),
        "r2_ms": total(2),
        "host_s": r.get("series_host_seconds"),
        "warm2": sum(1 for x in launches if x["round"] == 2 and x["kind"] == "warm"),
        "timeouts": sum(1 for x in launches if not x.get("drawn")),
        "ss_restart": len(set(r.get("system_server", []))) > 1,
        "avail_home_mb": home.get("MemAvailable", 0) // 1024,
        "avail_end_mb": end.get("MemAvailable", 0) // 1024,
        "swap_end_mb": end.get("swap_used_kb", 0) // 1024,
        "zram_used_mb": end.get("zram_used_kb", 0) // 1024,
        "load_end": end.get("load1"),
        "majfault": delta("pgmajfault"),
        "disk_mb": delta("vda_sectors") // 2048,
        "kills": delta("am_kill"),
        "lmkd": delta("lmkd"),
        "died": delta("am_proc_died"),
        "starts": delta("am_proc_start"),
        "anr": end.get("am_anr", 0),
        "crash": end.get("am_crash", 0),
        "reboots": len(r.get("reboots", [])),
    }


COLUMNS = ("name", "ok", "boot_s", "r1_ms", "r2_ms", "host_s", "warm2", "timeouts", "ss_restart", "avail_home_mb", "avail_end_mb",
           "swap_end_mb", "zram_used_mb", "load_end", "majfault", "disk_mb", "kills", "lmkd", "died", "starts",
           "anr", "crash", "reboots")


def main():
    results = [r for path in sys.argv[1:] for r in load(path)]
    if not results:
        print("no result")
        return
    rows = sorted((summary(r) for r in results), key=lambda s: s["name"])
    if len(rows) == 1:
        s = rows[0]
        print(("ok" if s["ok"] else "FAILED " + str(s["error"])) + ": round 1 %s ms, round 2 %s ms (%s warm), "
              "disk %s MB, majfault %s, kills %s, swap %s MB, avail %s MB" % (
                  s["r1_ms"], s["r2_ms"], s["warm2"], s["disk_mb"], s["majfault"], s["kills"], s["swap_end_mb"],
                  s["avail_end_mb"]))
        print()
    print("| " + " | ".join(COLUMNS) + " |")
    print("|" + " --- |" * len(COLUMNS))
    for s in rows:
        print("| " + " | ".join(str(s[c]) for c in COLUMNS) + " |")
    if len(results) == 1:
        print()
        print("| round | app | kind | TotalTime ms | host s | avail MB | swap MB | load | majfault | disk MB | kills |")
        print("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
        for x in results[0].get("launches", []):
            a = x.get("after", {})
            print("| %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |" % (
                x["round"], x["component"].split("/")[0], x["kind"], x.get("TotalTime"), x["host_seconds"],
                a.get("MemAvailable", 0) // 1024, a.get("swap_used_kb", 0) // 1024, a.get("load1"),
                a.get("pgmajfault"), a.get("vda_sectors", 0) // 2048, a.get("am_kill")))


if __name__ == "__main__":
    main()
