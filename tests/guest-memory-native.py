#!/usr/bin/env python3
"""Boot Android-x86 in a native QEMU and measure how apps start in a small guest.

Used by .github/workflows/guest-memory.yml.  Starts the argument vector the
web page would use (as tests/provision-native.py does, whose boot loop this
uses), waits for the home screen, and then starts a list of apps one after
the other with "am start -W", twice round.  After every start it records

  - the time until the app was drawn: am's TotalTime, or Android's
    am_activity_launch_time event when am gave up waiting (guest
    milliseconds), and the host's seconds;
  - whether the app's process was still there from the round before;
  - MemAvailable, swap in use, the load average;
  - what the memory pressure cost: major page faults, sectors read from the
    system disk (every one of them is a chunk download and a qcow2 inflate
    in the browser), pages swapped, processes killed and started.

Prints one line "PORTY_RESULT <json>" and writes <work>/result.json.  Always
exits 0 unless the arguments are wrong: the verdict is in the result.
Standard library only; run with "python3 -I".
"""

import argparse
import importlib.util
import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))


def load(name, *path):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, *path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


prov = load("porty_provision_native", "provision-native.py")
snap = prov.snap
log = snap.log

# What the guest's kernel and Android can do about memory.  Read-only.
FACTS = (
    ("kconfig", "zcat /proc/config.gz | grep -e ZRAM -e ZSMALLOC -e ZSWAP -e ZPOOL -e CONFIG_SWAP -e LZ4 -e CONFIG_LZO"
                " -e CRYPTO_ZSTD -e LOW_MEMORY -e CONFIG_KSM -e CONFIG_PSI -e CONFIG_MEMCG -e CLEANCACHE -e FRONTSWAP"
                " -e CONFIG_COMPACTION -e TRANSPARENT_HUGE"),
    ("zram_modules", "find /system/lib/modules -name 'zram*' -o -name 'zsmalloc*' -o -name 'lz4*' -o -name 'lzo*' -o -name 'zstd*'"),
    ("zram_sys", "ls /sys/block/ | tr '\\n' ' '; ls -l /dev/block/zram0; cat /sys/block/zram0/comp_algorithm /sys/block/zram0/disksize"),
    ("crypto", "grep -B1 -A1 -e lz4 -e lzo -e zstd -e deflate /proc/crypto | grep -e name -e driver | tr '\\n' ' '"),
    ("fstab", "cat /fstab.* | grep -v '^#'"),
    ("lmk_kernel", "ls /sys/module/lowmemorykiller/parameters/ && grep . /sys/module/lowmemorykiller/parameters/*"),
    ("lmk_props", "getprop | grep -e lmk -e low_ram -e zram -e dalvik.vm.heap -e hwui -e 'sys.sysctl' -e config.max -e bg_apps"),
    ("vm_sysctl", "cd /proc/sys/vm; grep . swappiness min_free_kbytes extra_free_kbytes vfs_cache_pressure dirty_ratio"
                  " page-cluster watermark_scale_factor overcommit_memory"),
    ("memcg", "mount | grep -e cgroup -e memcg | cut -c1-120; ls /dev/memcg | head -12"),
    ("tools", "for t in mkswap swapon swapoff modprobe insmod; do echo $t $(which $t); done"),
    ("data_fs", "df -k /data /cache /dev /system | cut -c1-120; du -sk /data/dalvik-cache /data/app /data/data /data/system /data/misc /data/user_de 2>/dev/null"),
    ("am_config", "dumpsys activity settings | grep -e max_cached -e low_ram -e CUR_MAX -e trim; dumpsys activity oom | head -24"),
    ("packages", "pm list packages | sort | tr '\\n' ' '"),
    ("meminfo_boot", "cat /proc/meminfo | head -24"),
    ("kmodules", "sed 's/^Linux version/kernel/' /proc/version; zcat /proc/config.gz | grep -e MODVERSIONS -e MODULE_SIG -e MODULE_FORCE -e 'CONFIG_CMA' -e LOCALVERSION"
                 " -e RANDSTRUCT -e RETPOLINE -e CONFIG_CC_ -e CONFIG_GCC -e CONFIG_CLANG -e CONFIG_BLK_DEV_RAM -e CONFIG_CRYPTO_LZO"
                 " -e CONFIG_ZBUD -e CONFIG_Z3FOLD -e MODULE_UNLOAD -e CONFIG_TRIM_UNUSED; modinfo /system/lib/modules/*/kernel/crypto/lz4.ko"),
    ("dexopt", "dumpsys package dexopt | grep -A3 -e 'gallery3d\\]' -e 'settings\\]' -e 'calculator2\\]' -e 'deskclock\\]' -e 'systemui\\]'"
               " -e 'launcher3\\]' | cut -c1-200; ls /system/app/Gallery2 /system/app/Gallery2/oat/* /system/framework/x86_64 | head -30 | tr '\\n' ' '"),
)

METRICS_A = ("grep -e MemFree -e MemAvailable -e '^Cached' -e Shmem: -e SwapTotal -e SwapFree -e 'Active(anon)'"
             " -e 'Inactive(anon)' -e '^Mapped' /proc/meminfo; echo loadavg: $(cat /proc/loadavg);"
             " echo uptime: $(cat /proc/uptime); grep -e pgmajfault -e pgpgin -e pswpin -e pswpout -e '^allocstall'"
             " -e pgscan_ -e pgsteal_ /proc/vmstat; echo vda: $(cat /sys/block/vda/stat);"
             " echo zram: $(cat /sys/block/zram0/mm_stat 2>/dev/null)")
EVENTS = ("am_proc_start", "am_proc_died", "am_kill", "am_low_memory", "am_anr", "am_crash", "am_pss")
METRICS_B = ("logcat -b events -d > /data/local/tmp/porty-ev.txt; for e in " + " ".join(EVENTS) + ";"
             " do echo $e: $(grep -c $e /data/local/tmp/porty-ev.txt); done;"
             " echo lmkd: $(logcat -b main,system -d -s lowmemorykiller | grep -c -e \"Kill '\")")

LAUNCHER_COMPONENT = re.compile(r"^[A-Za-z0-9._]+/[A-Za-z0-9._$]+$")


def numbers(text):
    """"key: 123 kB" lines and "key 123" lines -> {key: int}; the rest by name."""
    out = {}
    for line in text.split("\n"):
        m = re.match(r"^([A-Za-z_()]+):?\s+(-?\d+)(?:\s+kB)?\s*$", line.strip())
        if m:
            out[m.group(1)] = int(m.group(2))
            continue
        m = re.match(r"^(loadavg|uptime|vda|zram):\s*(.*)$", line.strip())
        if m:
            fields = m.group(2).split()
            if m.group(1) == "loadavg" and fields:
                out["load1"] = float(fields[0])
                out["load5"] = float(fields[1])
            elif m.group(1) == "uptime" and fields:
                out["uptime"] = float(fields[0])
            elif m.group(1) == "vda" and len(fields) >= 3:
                out["vda_reads"] = int(fields[0])
                out["vda_sectors"] = int(fields[2])
            elif m.group(1) == "zram" and len(fields) >= 3:
                # mm_stat: orig_data_size compr_data_size mem_used_total ...
                out["zram_orig_kb"] = int(fields[0]) // 1024
                out["zram_compr_kb"] = int(fields[1]) // 1024
                out["zram_used_kb"] = int(fields[2]) // 1024
    return out


def metrics(vm):
    a = vm.sh(METRICS_A, 120)[1]
    b = vm.sh(METRICS_B, 240)[1]
    m = numbers(a + "\n" + b)
    if "SwapTotal" in m:
        m["swap_used_kb"] = m["SwapTotal"] - m.get("SwapFree", 0)
    return m


def brief(m):
    return ("avail %d MB, free %d MB, swap %d MB, load %.1f, majfault %d, vda %d MB, kills %d/lmkd %d, starts %d, anr %d"
            % (m.get("MemAvailable", 0) // 1024, m.get("MemFree", 0) // 1024, m.get("swap_used_kb", 0) // 1024,
               m.get("load1", -1), m.get("pgmajfault", 0), m.get("vda_sectors", 0) // 2048,
               m.get("am_kill", 0), m.get("lmkd", 0), m.get("am_proc_start", 0), m.get("am_anr", 0)))


def resolve(vm, app):
    """A package name -> its launcher activity; a component stays as it is."""
    if "/" in app:
        return app
    status, text = vm.sh(f"cmd package resolve-activity --brief -c android.intent.category.LAUNCHER {app} | tail -1", 120)
    line = text.strip().split("\n")[-1].strip() if text.strip() else ""
    return line if status == 0 and LAUNCHER_COMPONENT.match(line) else None


def displayed(vm, component):
    """The launch times Android logged for a component (am_activity_launch_time)."""
    text = vm.sh(f"logcat -b events -d | grep 'am_activity_launch_time.*{component}' | cut -c1-200", 120)[1]
    return [int(m.group(2)) for m in re.finditer(r",(\d+),(\d+)\]", text)], len(text.strip().split("\n")) if text.strip() else 0


def launch(vm, component, timeout):
    """Start an activity and wait until Android has drawn it.

    "am start -W" gives up after ten guest seconds ("Status: timeout"); the
    start goes on, and ends with an am_activity_launch_time event.
    """
    package = component.split("/")[0]
    before = vm.sh(f"pidof {package}", 60)[1].strip()
    seen = displayed(vm, component)[1]
    t0 = time.monotonic()
    status, text = vm.sh(f"am start -W -n {component} 2>&1 | grep -v '^$' | cut -c1-200", timeout)
    out = {"component": component, "status": status, "pid_before": before}
    for key in ("ThisTime", "TotalTime", "WaitTime"):
        m = re.search(rf"^{key}: (\d+)", text, re.M)
        if m:
            out[key] = int(m.group(1))
    m = re.search(r"^Status: (\S+)", text, re.M)
    out["am_status"] = m.group(1) if m else text[-200:]
    out["drawn"] = out["am_status"] == "ok"
    while not out["drawn"] and time.monotonic() - t0 < timeout and vm.alive():
        prov.wait(vm, 5)
        times, count = displayed(vm, component)
        if count > seen and times:
            out["drawn"] = True
            out["TotalTime"] = times[-1]
    out["host_seconds"] = round(time.monotonic() - t0, 1)
    after = vm.sh(f"pidof {package}", 60)[1].strip()
    out["pid_after"] = after
    out["kind"] = "warm" if before and before == after else "cold"
    return out


def settle(vm, opts, result):
    """As scripts/snapshot/make-snapshot.py does before it saves: wait, wait
    for the load to fall, end the processes Android shows an "isn't
    responding" dialog for.  What is measured then is what a resumed
    snapshot starts from, not the minutes after a first boot."""
    prov.wait(vm, opts.settle)

    def calm():
        text = ""
        for _ in range(12):
            status, text = vm.sh("cat /proc/loadavg", 30)
            try:
                if float(text.split()[0]) < opts.max_load:
                    break
            except (ValueError, IndexError):
                pass
            prov.wait(vm, 30)
        return text.strip()

    result["load_settled"] = calm()
    result["anr_dismissed"] = []
    for _ in range(3):
        status, windows = vm.sh("dumpsys window windows | grep -o 'Application Not Responding: [A-Za-z0-9_.]*' | sort -u", 180)
        anrs = sorted(set(re.findall(r"Application Not Responding: ([A-Za-z0-9_.]+)", windows if status == 0 else "")))
        if not anrs:
            break
        result["anr_dismissed"].extend(anrs)
        vm.sh("; ".join(f"kill $(pidof {p})" for p in anrs) + "; echo killed", 120)
        prov.wait(vm, 90)
        result["load_settled"] = calm()
    log(f"settled: load {result['load_settled']}, dialogs dismissed {result['anr_dismissed']}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--qemu", required=True)
    ap.add_argument("--argv-file", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--name", default="")
    ap.add_argument("--boot-timeout", type=float, default=2400)
    ap.add_argument("--settle", type=float, default=300, help="seconds between sys.boot_completed=1 and the first start")
    ap.add_argument("--max-load", type=float, default=1.5, help="then wait (up to 6 min) for the load average to fall below this")
    ap.add_argument("--setup", action="append", default=[],
                    help="shell command to run in the guest right after sys.boot_completed=1 (repeatable)")
    ap.add_argument("--app", action="append", default=[], help="package or component to start (repeatable)")
    ap.add_argument("--rounds", type=int, default=2)
    ap.add_argument("--launch-timeout", type=float, default=420, help="host seconds to wait for one start")
    ap.add_argument("--pause", type=float, default=10, help="host seconds between starts")
    ap.add_argument("--facts", type=int, default=1)
    ap.add_argument("--variants", help="tests/guest-memory-variants.json: the apps, and a variant's setup commands")
    ap.add_argument("--variant", default="")
    opts = ap.parse_args()
    if opts.variants:
        with open(opts.variants, encoding="utf-8") as f:
            plan = json.load(f)
        opts.app = opts.app or list(plan["apps"])
        opts.setup = opts.setup or list(plan["variants"][opts.variant].get("setup", []))
        opts.name = opts.name or opts.variant
    opts.wake_lock = 1
    opts.trace = 0

    os.makedirs(opts.work, exist_ok=True)
    opts.work = os.path.abspath(opts.work)
    with open(opts.argv_file, encoding="utf-8") as f:
        argv = [line.rstrip("\n") for line in f if line.rstrip("\n") != ""]

    result = {"mode": "guest-memory", "name": opts.name, "booted": False, "milestones": {}, "launches": [], "guest": {}}
    vm = snap.Machine(opts.qemu, argv, opts.work)
    log("QEMU started: " + " ".join(vm.args))

    def run(key, command, timeout=240):
        status, text = vm.sh(command, timeout)
        result["guest"][key] = text if status == 0 else f"[status {status}] {text}"
        log(f"guest {key}: {result['guest'][key][:4000]}")
        return result["guest"][key]

    try:
        booted = prov.boot(vm, opts, result)
        result["reboots"] = list(vm.reboots)
        if booted is None:
            result["serial_tail"] = vm.tail(60)
            for line in result["serial_tail"]:
                print("    | " + line[:300], flush=True)
        else:
            result["booted"] = True
            result["booted_seconds"] = round(booted - vm.boot_started, 1)
            log(f"sys.boot_completed=1 after {result['booted_seconds']:.0f} s")
            # Room for every event and lmkd line of the run (the default
            # buffers wrap within minutes).
            run("log_buffers", "logcat -b events -G 2M; logcat -b main -G 4M; logcat -g | cut -c1-90")
            for i, command in enumerate(opts.setup):
                run(f"setup_{i}", command)
            settle(vm, opts, result)
            run("screen_on", "settings put system screen_off_timeout 2147483647; svc power stayon true")
            if opts.facts:
                for key, command in FACTS:
                    run(key, command)
            run("swaps", "cat /proc/swaps; cat /proc/sys/vm/swappiness; getprop ro.config.low_ram;"
                         " getprop | grep -e dalvik.vm.heap; cat /sys/module/lowmemorykiller/parameters/minfree")
            run("focus_home", "dumpsys window | grep -e mCurrentFocus -e mFocusedApp")
            result["system_server"] = [vm.sh("pidof system_server", 60)[1].strip()]
            result["home"] = metrics(vm)
            log("home: " + brief(result["home"]))
            apps = []
            for app in opts.app:
                component = resolve(vm, app)
                log(f"app {app}: {component}")
                if component:
                    apps.append(component)
            result["apps"] = apps
            started = time.monotonic()
            for rnd in range(1, opts.rounds + 1):
                for component in apps:
                    if not vm.alive():
                        raise RuntimeError("QEMU is gone")
                    one = launch(vm, component, opts.launch_timeout)
                    one["round"] = rnd
                    prov.wait(vm, opts.pause)
                    one["after"] = metrics(vm)
                    result["launches"].append(one)
                    log(f"round {rnd} {component}: {one['kind']}, TotalTime {one.get('TotalTime')} ms, "
                        f"host {one['host_seconds']} s, am {one['am_status']}, drawn {one['drawn']}; " + brief(one["after"]))
            result["series_host_seconds"] = round(time.monotonic() - started, 1)
            result["end"] = metrics(vm)
            result["reboots"] = list(vm.reboots)
            result["system_server"].append(vm.sh("pidof system_server", 60)[1].strip())
            run("proc_starts", "grep am_proc_start /data/local/tmp/porty-ev.txt | cut -d, -f4,5 | cut -d']' -f1 | sort | uniq -c | sort -rn | head -60 | tr '\\n' ';'")
            run("focus_end", "dumpsys window | grep -e mCurrentFocus -e mFocusedApp")
            run("lmkd_log", "logcat -b main,system -d -s lowmemorykiller | tail -30 | cut -c1-200")
            run("kills", "grep -e am_kill -e am_low_memory -e am_anr -e am_crash /data/local/tmp/porty-ev.txt | cut -c1-200 | tail -60")
            run("crashes", "logcat -b crash -d | grep -e 'Process: ' -e '>>> ' -e 'FATAL' -e 'Caused by' | cut -c1-200 | head -30")
            run("procs", "ps -A -o RSS,NAME | sort -n | tail -32 | tr '\\n' ';'")
            run("meminfo_end", "cat /proc/meminfo | head -24; cat /proc/swaps; cat /sys/block/zram0/mm_stat")
            run("dmesg_mem", "dmesg | grep -i -e zram -e 'out of memory' -e oom -e lowmemory -e 'swap' -e porty | tail -30 | cut -c1-200")
            run("dumpsys_meminfo", "dumpsys -t 240 meminfo | tail -22 | cut -c1-160", 400)
            result["screen"] = vm.screenshot("screen-final", show=True)
    except Exception as e:  # the verdict must always be written
        result["error"] = f"{type(e).__name__}: {e}"
        log(f"error: {result['error']}")
    finally:
        vm.quit()
        snap.write_json(os.path.join(opts.work, "result.json"), result)
    print("PORTY_RESULT " + json.dumps({k: v for k, v in result.items() if k != "guest"}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
