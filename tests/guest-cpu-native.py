#!/usr/bin/env python3
"""Boot Android-x86 in a native QEMU and measure where the guest's CPU goes
while an app starts.

Used by .github/workflows/guest-cpu.yml.  Starts the argument vector the web
page would use (as tests/provision-native.py does, whose boot loop this
uses), lets the guest settle as scripts/snapshot/make-snapshot.py does before
it saves, and then starts apps one after the other:

  - "tap": a finger tap on the home screen, sent through QEMU's input layer
    to the USB tablet exactly as the page sends it (move, press, move,
    release), so that Android's pointer moves as it does in the browser;
  - "start": "am start" of the activity, without the launcher.

Before every start the app is stopped (a cold start, as the first tap in a
resumed snapshot is) and the guest is left until it is quiet.  For every
start it records

  - when Android drew the activity (am_activity_launch_time, guest ms, and
    host seconds after the tap) and when the guest was quiet again (85 %
    idle for three seconds);
  - the guest's CPU from the tap until quiet, by process and by thread, and
    the frames surfaceflinger composed, from the launch probe's own shell
    function (tests/boot/cpu-probe.mjs, PCPU_FUNCTION; the workflow writes
    it to a file);
  - the screen before and after.

Prints "PORTY_RESULT <json>" and writes <work>/result.json.  Always exits 0
unless the arguments are wrong: the verdict is in the result.  Standard
library only; run with "python3 -I".
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

# What the guest's graphics stack is.  Read-only.
FACTS = (
    ("props", "getprop | grep -i -e egl -e gralloc -e hwc -e hwui -e '\\.sf\\.' -e 'debug\\.' -e opengl -e renderer"
              " -e 'ro.hardware' -e qemu -e lcd_density -e vsync -e 'dalvik.vm.usejit' -e 'dalvik.vm.jit' -e avoid_gfx"
              " -e low_ram -e 'dalvik.vm.dex2oat' -e 'pm.dexopt' | cut -c1-160"),
    ("cmdline", "cat /proc/cmdline; cat /proc/fb; cat /sys/class/graphics/fb0/modes /sys/class/graphics/fb0/virtual_size"),
    ("egl_libs", "ls -l /system/lib64/egl /vendor/lib64/egl /vendor/lib64/hw /system/lib64/hw 2>&1 | cut -c1-140"),
    ("dri", "ls /vendor/lib64/dri /system/lib64/dri 2>&1 | tr '\\n' ' '; echo;"
            " for w in kms_swrast swrast_dri llvmpipe softpipe; do echo $w $(grep -c $w /vendor/lib64/dri/gallium_dri.so 2>&1); done"),
    ("swiftshader", "for w in SwiftShader.ini SWIFTSHADER ThreadCount OptimizationPass EnableSSE4_1 ExactColorRounding"
                    " LLVM Subzero; do echo $w $(grep -c $w /vendor/lib64/egl/libGLESv2_swiftshader.so 2>&1); done"),
    ("init_sh", "grep -n -e HWACCEL -e GRALLOC -e 'HWC' -e 'ro.hardware.egl' -e swiftshader -e 'set_drm_mode' -e 'debug.egl'"
                " /system/etc/init.sh | cut -c1-150"),
    ("sf_rc", "cat /system/etc/init/surfaceflinger.rc; ls /system/etc/init | tr '\\n' ' '"),
    ("sched", "for p in $(pidof surfaceflinger) $(pidof system_server) $(pidof com.android.systemui) $(pidof com.android.launcher3);"
              " do for t in /proc/$p/task/*; do echo $(cut -d' ' -f1,2,18,19,40,41 $t/stat); done; done | sort -k5 -n -r | head -40;"
              " cat /proc/sys/kernel/sched_rt_runtime_us /proc/sys/kernel/sched_rt_period_us"),
    ("sf_dump", "dumpsys SurfaceFlinger | grep -v '^ *$' | head -150 | cut -c1-170"),
    ("gfx_launcher", "dumpsys gfxinfo com.android.launcher3 | head -40 | cut -c1-150"),
    ("dexopt", "dumpsys package dexopt | grep -A3 -e 'gallery3d\\]' -e 'settings\\]' -e 'launcher3\\]' -e 'systemui\\]'"
               " | cut -c1-160"),
)

LAUNCHER_COMPONENT = re.compile(r"^[A-Za-z0-9._]+/[A-Za-z0-9._$]+$")
ABS_MAX = 0x7FFF


# --- the pcpu output (a Python twin of tests/boot/cpu-probe.mjs) ----------------
def parse_cpu(text, tag):
    snap_ = {"tag": tag, "procs": {}, "threads": {}, "done": False, "stat": None, "frames": -1, "uptime": 0.0}
    for line in text.split("\n"):
        line = line.strip()
        m = re.match(r"^CPS\|([a-z0-9]+)\|([\d.]+)\|cpu\s+([\d ]+)\|([0-9a-f]*)$", line)
        if m and m.group(1) == tag:
            snap_["uptime"] = float(m.group(2))
            snap_["stat"] = [int(v) for v in m.group(3).split()]
            snap_["frames"] = int(m.group(4), 16) if m.group(4) else -1
            continue
        m = re.match(r"^CP\|([a-z0-9]+)\|(\d+)\|(.*)\|(\d+)$", line)
        if m and m.group(1) == tag:
            snap_["procs"][int(m.group(2))] = (m.group(3), int(m.group(4)))
            continue
        m = re.match(r"^CT\|([a-z0-9]+)\|(\d+)\|(\d+)\|(.*)\|(\d+)\|(-?\d+)\|(\d+)$", line)
        if m and m.group(1) == tag:
            snap_["threads"][int(m.group(3))] = (int(m.group(2)), m.group(4), int(m.group(5)), int(m.group(6)), int(m.group(7)))
            continue
        m = re.match(rf"^CPE\|{tag}\|2(?:\|(\d+)\|([\d.]+)\|cpu\s+([\d ]+))?$", line)
        if m:
            snap_["done"] = True
            if m.group(1):
                snap_["self"] = int(m.group(1))
                snap_["end_uptime"] = float(m.group(2))
                snap_["end_stat"] = [int(v) for v in m.group(3).split()]
    return snap_


def cpu_delta(a, b):
    if not a or not b or not a.get("stat") or not b.get("stat"):
        return None
    # From the end of a to the start of b (tests/boot/cpu-probe.mjs); the
    # shell that ran the snapshots is not a process of the guest here.
    start = a.get("end_stat") or a["stat"]
    st = [v - (start[i] if i < len(start) else 0) for i, v in enumerate(b["stat"])]
    probe = {pid for pid in (a.get("self"), b.get("self")) if pid is not None}
    probe_ticks = 0
    total = sum(st[:8])
    idle = st[3] + st[4]
    busy = total - idle
    procs = []
    for pid, (comm, ticks) in b["procs"].items():
        before = a["procs"].get(pid)
        same = before is not None and before[0] == comm
        d = ticks - (before[1] if same else 0)
        if pid in probe:
            probe_ticks += max(0, d)
        elif d > 0:
            procs.append({"pid": pid, "comm": comm, "ticks": d, "new": not same})
    procs.sort(key=lambda p: -p["ticks"])
    threads = []
    for tid, (pid, comm, ticks, nice, policy) in b["threads"].items():
        before = a["threads"].get(tid)
        d = ticks - (before[2] if before is not None and before[1] == comm else 0)
        if d > 0:
            threads.append({"tid": tid, "pid": pid, "proc": b["procs"].get(pid, ("?", 0))[0], "comm": comm,
                            "ticks": d, "nice": nice, "policy": policy})
    threads.sort(key=lambda t: -t["ticks"])
    return {
        "guest_seconds": round(b["uptime"] - (a.get("end_uptime") or a["uptime"]), 2),
        "total": total, "busy": busy, "idle": idle,
        "user": st[0] + st[1], "system": st[2] + st[5] + st[6],
        "uncounted": max(0, busy - sum(p["ticks"] for p in procs)),
        "probe_ticks": probe_ticks,
        "frames": b["frames"] - a["frames"] if a["frames"] >= 0 and b["frames"] >= 0 else -1,
        "procs": procs[:30],
        "threads": threads[:40],
    }


def describe(d, count=8):
    if not d:
        return "no CPU data"

    def pct(v):
        return f"{100.0 * v / max(1, d['busy']):.1f}%"
    return (f"{d['busy']} busy of {d['total']} ticks ({d['guest_seconds']} guest s), user {d['user']} system {d['system']},"
            f" sf frames {d['frames']}; "
            + ", ".join(f"{p['comm']}{'*' if p['new'] else ''} {p['ticks']} ({pct(p['ticks'])})" for p in d["procs"][:count])
            + (f", not in a listed process {d['uncounted']} ({pct(d['uncounted'])})" if d["uncounted"] > 0 else ""))


# --- the guest ------------------------------------------------------------------
class Guest:
    def __init__(self, vm, pcpu):
        self.vm = vm
        self.pcpu = pcpu
        self.n = 0

    def sh(self, command, timeout=120):
        return self.vm.sh(command, timeout)

    def cpu(self, tag, threads=False, timeout=240):
        status, text = self.sh(f"pcpu {tag} {'threads' if threads else 'procs'} frames", timeout)
        s = parse_cpu(text, tag)
        if not s["done"]:
            log(f"cpu snapshot {tag}: incomplete (status {status})")
        return s

    def stat(self):
        """(total, idle) ticks so far, from /proc/stat."""
        status, text = self.sh("head -1 /proc/stat", 30)
        m = re.search(r"cpu\s+([\d ]+)", text or "")
        if not m:
            return None
        v = [int(x) for x in m.group(1).split()]
        return sum(v[:8]), v[3] + v[4]

    def quiet(self, idle_share=0.85, seconds=3, timeout=180):
        """Wait until the guest's CPU is idle_share idle over `seconds` one-second windows in a row."""
        t0 = time.monotonic()
        prev = self.stat()
        calm = 0
        while time.monotonic() - t0 < timeout and self.vm.alive():
            prov.wait(self.vm, 1.0)
            now = self.stat()
            if now and prev and now[0] > prev[0]:
                share = (now[1] - prev[1]) / (now[0] - prev[0])
                calm = calm + 1 if share >= idle_share else 0
            prev = now
            if calm >= seconds:
                return round(time.monotonic() - t0, 1)
        return None

    def focus(self):
        text = self.sh("dumpsys window | grep -e mCurrentFocus | head -1", 120)[1]
        return text.strip().replace("mCurrentFocus=", "")[:120]


def tap(vm, fx, fy):
    """A finger tap as the page sends it (web/js/input.js): move, press, move, release."""
    x = max(0, min(ABS_MAX, round(fx * ABS_MAX)))
    y = max(0, min(ABS_MAX, round(fy * ABS_MAX)))
    move = [{"type": "abs", "data": {"axis": "x", "value": x}}, {"type": "abs", "data": {"axis": "y", "value": y}}]
    vm.qmp.cmd("input-send-event", {"events": move})
    vm.qmp.cmd("input-send-event", {"events": [{"type": "btn", "data": {"down": True, "button": "left"}}]})
    time.sleep(0.08)
    vm.qmp.cmd("input-send-event", {"events": move})
    vm.qmp.cmd("input-send-event", {"events": [{"type": "btn", "data": {"down": False, "button": "left"}}]})


def ppm_diff(data, base):
    """Share (%) of 1/7 of the pixels of `data` that differ from `base` (bytes of two PPMs)."""
    if not data or not base or len(base) != len(data):
        return -1.0
    header = data.split(b"\n", 3)
    start = len(data) - len(header[3])
    n = same = 0
    for i in range(start, len(data) - 2, 21):
        n += 1
        if abs(data[i] - base[i]) + abs(data[i + 1] - base[i + 1]) + abs(data[i + 2] - base[i + 2]) <= 48:
            same += 1
    return round(100.0 * (n - same) / max(1, n), 1)


def screen_diff(vm, name, base):
    """Share (%) of 1/7 of the pixels that differ from `base` (bytes of a PPM), and the new PPM."""
    path = vm.fb_prefix + ".ppm"
    try:
        with open(path, "rb") as f:
            data = f.read()
    except OSError:
        return -1.0, None
    return ppm_diff(data, base), data


def abs_at(fx, fy):
    return [{"type": "abs", "data": {"axis": "x", "value": max(0, min(ABS_MAX, round(fx * ABS_MAX)))}},
            {"type": "abs", "data": {"axis": "y", "value": max(0, min(ABS_MAX, round(fy * ABS_MAX)))}}]


def drag(vm, fx0, fy0, fx1, fy1, steps=12, pause=0.25):
    """A finger drag as the page sends it (web/js/input.js): move, press, moves, release."""
    vm.qmp.cmd("input-send-event", {"events": abs_at(fx0, fy0)})
    vm.qmp.cmd("input-send-event", {"events": [{"type": "btn", "data": {"down": True, "button": "left"}}]})
    for i in range(1, steps + 1):
        time.sleep(pause)
        vm.qmp.cmd("input-send-event", {"events": abs_at(fx0 + (fx1 - fx0) * i / steps, fy0 + (fy1 - fy0) * i / steps)})
    time.sleep(pause)
    vm.qmp.cmd("input-send-event", {"events": [{"type": "btn", "data": {"down": False, "button": "left"}}]})


def type_keys(vm, text):
    """Lower-case letters typed on the PS/2 keyboard, as the page's keyboard does."""
    for ch in text:
        for down in (True, False):
            vm.qmp.cmd("input-send-event", {"events": [{"type": "key", "data": {"down": down,
                                                        "key": {"type": "qcode", "data": ch}}}]})
            time.sleep(0.15)


def ui_check(g, opts, result):
    """After the starts: scrolling (finger drags on Settings), the mouse
    pointer (two hover moves) and typing (Settings' search, on the PS/2
    keyboard), each followed by a screenshot in the log and how much of the
    screen it changed, and surfaceflinger's frames and CPU over all of it:
    the same steps for every variant, to see that the screen keeps up when a
    variant changes how surfaceflinger composes."""
    vm = g.vm
    ui = {}
    result["ui"] = ui
    shots = {}

    def shot(name, wait=3):
        prov.wait(vm, wait)
        ui[f"{name}_quiet_s"] = g.quiet(timeout=120)
        _, shots[name] = screen_diff(vm, name, None)
        vm.screenshot(f"ui-{name}", show=True)

    g.sh("am force-stop com.android.settings", 60)
    g.sh("dumpsys SurfaceFlinger --timestats -enable -clear > /dev/null 2>&1", 120)
    a = g.cpu("uia")
    vm.sh("(am start -n com.android.settings/.Settings > /dev/null 2>&1 &)", 30)
    shot("settings", 10)
    drag(vm, 0.5, 0.8, 0.5, 0.3)
    shot("scrolled")
    ui["scrolled_pct"] = ppm_diff(shots["scrolled"], shots["settings"])
    drag(vm, 0.5, 0.3, 0.5, 0.9)
    shot("scrolled_back")
    ui["scrolled_back_vs_top_pct"] = ppm_diff(shots["scrolled_back"], shots["settings"])
    vm.qmp.cmd("input-send-event", {"events": abs_at(0.3, 0.45)})
    shot("pointer_a", 2)
    vm.qmp.cmd("input-send-event", {"events": abs_at(0.7, 0.6)})
    shot("pointer_b", 2)
    ui["pointer_moved_pct"] = ppm_diff(shots["pointer_b"], shots["pointer_a"])
    ui["pointer_layers"] = g.sh("dumpsys SurfaceFlinger --list | grep -i -e sprite -e pointer | head -4", 60)[1].strip()
    # Settings' own search bar, at the top of its first page (back at the
    # top after the second drag): a tap opens the search with its text
    # field focused.
    tap(vm, 0.5, 0.08)
    shot("search", 10)
    ui["search_focus"] = g.focus()
    type_keys(vm, "wifi")
    shot("typed", 4)
    ui["typed_pct"] = ppm_diff(shots["typed"], shots["search"])
    ui["ime"] = g.sh("dumpsys input_method | grep -e mInputShown -e mCurFocusedWindow | head -3 | cut -c1-140", 60)[1].strip()
    b = g.cpu("uib")
    ui["sf_timestats"] = g.sh("dumpsys SurfaceFlinger --timestats -dump -maxlayers 8 2>&1 | grep -E"
                              " 'totalFrames|clientCompositionFrames|statsStart|statsEnd' | head -4 | cut -c1-120", 120)[1]
    m = re.search(r"totalFrames\s*=\s*(\d+)", ui["sf_timestats"])
    ui["sf_frames"] = int(m.group(1)) if m else None
    d = cpu_delta(a, b)
    if d:
        busy = max(1, d["busy"])
        ui["busy"] = d["busy"]
        ui["total"] = d["total"]
        ui["surfaceflinger_pct"] = round(100.0 * sum(p["ticks"] for p in d["procs"] if p["comm"] == "surfaceflinger") / busy, 1)
    log(f"ui check: scrolled {ui['scrolled_pct']}%, back at the top {ui['scrolled_back_vs_top_pct']}% off,"
        f" pointer moved {ui['pointer_moved_pct']}% ({ui['pointer_layers'] or 'no pointer layer'}),"
        f" typed {ui['typed_pct']}% (focus {ui['search_focus']}; {ui['ime']}); sf frames {ui['sf_frames']},"
        f" {describe(d) if d else 'no CPU snapshot'}")
    g.sh("input keyevent 3", 60)
    prov.wait(vm, 2)


def launch(g, app, opts, index):
    """One cold start of `app` ({"name", "component", "how": "tap"|"start", "x", "y"})."""
    vm = g.vm
    component = app["component"]
    package = component.split("/")[0]
    out = {"app": app["name"], "how": app["how"], "index": index, "component": component}
    g.sh(f"am force-stop {package}", 60)
    out["anr_dismissed"] = dismiss_anr(vm)
    out["focus_before"] = g.focus()
    out["quiet_before_s"] = g.quiet(timeout=90)
    before_events = g.sh(f"grep -c 'am_activity_launch_time.*{package}' /data/local/tmp/porty-ev.txt", 30)[1].strip()
    seen = int(before_events) if before_events.isdigit() else 0
    _, base = screen_diff(vm, "base", None)
    g.sh("dumpsys SurfaceFlinger --timestats -enable -clear > /dev/null 2>&1; dumpsys SurfaceFlinger --latency-clear > /dev/null 2>&1", 120)
    anr0 = g.sh("logcat -b events -d | grep -c am_anr", 60)[1].strip()
    anr0 = int(anr0) if anr0.isdigit() else 0
    g.sh("dumpsys gfxinfo com.android.systemui reset > /dev/null 2>&1", 120)
    a = g.cpu("a", threads=True)
    d_snap = None
    t0 = time.monotonic()
    if app["how"] == "tap":
        tap(vm, app["x"], app["y"])
    else:
        vm.sh(f"(am start -n {component} > /dev/null 2>&1 &)", 30)
    drawn = None
    changed = None
    timeline = []
    shots = [5, 15, 30, 60, 90, 120, 160]
    prev = g.stat()
    calm = 0
    quiet_at = None
    while time.monotonic() - t0 < opts.launch_timeout and vm.alive():
        prov.wait(vm, 1.0)
        now_t = round(time.monotonic() - t0, 1)
        status, text = g.sh(f"head -1 /proc/stat; grep -c 'am_activity_launch_time.*{package}' /data/local/tmp/porty-ev.txt", 30)
        lines = text.split("\n")
        m = re.search(r"cpu\s+([\d ]+)", lines[0] if lines else "")
        count = lines[-1].strip() if len(lines) > 1 else ""
        if drawn is None and count.isdigit() and int(count) > seen:
            drawn = now_t
            # From here on: what keeps the guest busy after the app shows.
            out["sf_timestats_to_drawn"] = g.sh("dumpsys SurfaceFlinger --timestats -dump -maxlayers 16 2>&1 | grep -E"
                                                " 'layerName|totalFrames' | cut -c1-120; dumpsys SurfaceFlinger --timestats -clear"
                                                " > /dev/null 2>&1", 120)[1]
            d_snap = g.cpu("d", threads=True)
        diff, _ = screen_diff(vm, "now", base)
        if changed is None and diff >= 40:
            changed = now_t
        if index <= opts.watch and shots and now_t >= shots[0]:
            shot_at = shots.pop(0)
            if index == 1:
                vm.screenshot(f"{app['name']}-{index}-t{shot_at}", show=opts.show_screens)
            # Who is in which state while surfaceflinger keeps composing.
            watched = g.sh("dumpsys activity activities | grep -e 'state=' -e 'mResumedActivity' -e 'mLastPausedActivity'"
                           " | grep -v -e '^ *$' | cut -c1-150 | head -12; dumpsys SurfaceFlinger | grep -e '^+ ' -e 'queued-frames'"
                           " -e 'mRefreshPending' | cut -c1-140 | head -40", 120)[1]
            out.setdefault("watch", []).append([shot_at, watched])
            log(f"    t+{shot_at} s: " + " | ".join(line.strip() for line in watched.split("\n") if line.strip())[:2500])
        if m:
            v = [int(x) for x in m.group(1).split()]
            cur = (sum(v[:8]), v[3] + v[4])
            if prev and cur[0] > prev[0]:
                share = (cur[1] - prev[1]) / (cur[0] - prev[0])
                timeline.append((now_t, round(100 * (1 - share)), diff))
                calm = calm + 1 if share >= 0.85 else 0
            prev = cur
        if drawn is not None and calm >= 3:
            quiet_at = now_t
            break
    b = g.cpu("b", threads=True)
    out["sf_timestats"] = g.sh("dumpsys SurfaceFlinger --timestats -dump -maxlayers 16 2>&1 | grep -E"
                               " 'layerName|totalFrames|droppedFrames|missedFrames|clientCompositionFrames|statsStart|statsEnd'"
                               " | cut -c1-150", 120)[1]
    # Frames per layer since the clear: lines of three non-zero times.
    out["sf_latency"] = g.sh("dumpsys SurfaceFlinger --list | while read -r n; do"
                             " echo \"LAT|$(dumpsys SurfaceFlinger --latency \"$n\" | tail -n +2 | grep -c '^[1-9]')|$n\"; done"
                             " | grep -v '^LAT|0|' | cut -c1-120", 300)[1]
    log("    sf frames per layer (latency): " + " | ".join(line.strip() for line in out["sf_latency"].split("\n") if line.strip())[:3000])
    out["sf_log"] = g.sh("logcat -d -s SurfaceFlinger:* -t 400 | grep -v -e 'Registering a buffer' | tail -12 | cut -c1-160", 120)[1]
    log("    surfaceflinger log: " + " | ".join(line.strip() for line in out["sf_log"].split("\n") if line.strip())[:2000])
    out["drawn_s"] = drawn
    out["screen_changed_s"] = changed
    out["quiet_s"] = quiet_at
    out["timeline"] = timeline
    line = g.sh(f"grep 'am_activity_launch_time.*{package}' /data/local/tmp/porty-ev.txt | tail -1 | cut -c1-200", 30)[1]
    m = re.search(r",(\d+),(\d+)\]", line)
    out["launch_ms"] = int(m.group(1)) if m else None
    out["launch_total_ms"] = int(m.group(2)) if m else None
    out["focus_after"] = g.focus()
    after = cpu_delta(d_snap, b) if d_snap else None
    if after:
        out["cpu_after_drawn"] = after
        log(f"    after Android drew it: {describe(after, 10)}")
        for t in after["threads"][:12]:
            log(f"      thread {t['proc']}/{t['comm']} (nice {t['nice']}, policy {t['policy']}): {t['ticks']}")
    anr_lines = g.sh(f"logcat -b events -d | grep am_anr | tail -n +{anr0 + 1} | cut -c1-200", 60)[1].strip()
    out["anr"] = [line for line in anr_lines.split("\n") if "am_anr" in line]
    if out["anr"]:
        out["anr_log"] = g.sh("logcat -d -b system -b main | grep -A3 'ANR in ' | tail -24 | cut -c1-170", 120)[1]
        log("    not responding: " + " | ".join(out["anr"])[:1500])
        log("    ANR log: " + " | ".join(line.strip() for line in out["anr_log"].split("\n") if line.strip())[:2500])
    out["anr_files"] = g.sh("ls /data/anr 2>/dev/null | wc -l", 30)[1].strip()
    out["gfx_systemui"] = g.sh("dumpsys gfxinfo com.android.systemui | grep -e 'Total frames' -e 'Janky frames' | cut -c1-80", 120)[1]
    log("    SystemUI's frames: " + " | ".join(line.strip() for line in out["gfx_systemui"].split("\n") if line.strip()))
    d = cpu_delta(a, b)
    out["cpu"] = d
    out["screen"] = vm.screenshot(f"{app['name']}-{index}", show=opts.show_screens)
    log(f"launch {app['name']} #{index} ({app['how']}): drawn {drawn} s, screen changed {changed} s, quiet {quiet_at} s,"
        f" Android {out['launch_ms']}/{out['launch_total_ms']} ms; {describe(d)}")
    if d:
        for t in d["threads"][:14]:
            log(f"    thread {t['proc']}/{t['comm']} (nice {t['nice']}, policy {t['policy']}): {t['ticks']}")
    if out.get("sf_timestats_to_drawn"):
        log("    sf timestats until drawn: " + " | ".join(line.strip() for line in out["sf_timestats_to_drawn"].split("\n")
                                                         if line.strip())[:2000])
    log(f"    sf timestats{' after drawn' if d_snap else ''}: " + " | ".join(line.strip() for line in out["sf_timestats"].split("\n") if line.strip())[:3000])
    gfx = g.sh(f"dumpsys gfxinfo {package} | grep -e 'Total frames' -e 'Janky' -e 'Pipeline' -e '90th' | cut -c1-120", 120)[1]
    out["gfxinfo"] = gfx
    g.sh("input keyevent 3", 60)
    prov.wait(vm, 2)
    out["quiet_home_s"] = g.quiet(timeout=90)
    return out


def profile(g, app, opts, result):
    """One more start of `app`, sampled by simpleperf (cpu-clock, every CPU),
    reported by process, by library and by symbol."""
    vm = g.vm
    package = app["component"].split("/")[0]
    out = {}
    g.sh(f"am force-stop {package}", 60)
    g.quiet(timeout=90)
    _, base = screen_diff(vm, "base", None)
    del base
    g.sh("echo 0 > /proc/sys/kernel/kptr_restrict; echo -1 > /proc/sys/kernel/perf_event_paranoid; rm -f /data/local/tmp/perf.data", 30)
    g.sh(f"(simpleperf record -a -e cpu-clock -f {opts.profile_hz} --duration {opts.profile_seconds} "
         f"-o /data/local/tmp/perf.data > /data/local/tmp/perf.log 2>&1 &)", 30)
    prov.wait(vm, 2)
    if app["how"] == "tap":
        tap(vm, app["x"], app["y"])
    else:
        vm.sh(f"(am start -n {app['component']} > /dev/null 2>&1 &)", 30)
    prov.wait(vm, opts.profile_seconds + 5)
    for _ in range(30):
        status, text = g.sh("pidof simpleperf || echo done", 30)
        if "done" in text:
            break
        prov.wait(vm, 5)
    out["record"] = g.sh("cat /data/local/tmp/perf.log | tail -5", 30)[1]
    for key, sort, limit in (("by_process", "comm", 0.5), ("by_dso", "comm,dso", 0.7), ("by_symbol", "comm,dso,symbol", 0.4)):
        status, text = g.sh(f"simpleperf report -i /data/local/tmp/perf.data --sort {sort} --percent-limit {limit} 2>&1"
                            f" | head -70 | cut -c1-200", 600)
        out[key] = text
        log(f"profile {app['name']} {key}:\n{text}")
    g.sh("input keyevent 3", 60)
    prov.wait(vm, 2)
    g.quiet(timeout=90)
    result["profile"] = out


def set_time_scale(vm, scale):
    """The page's time dilation (patch 0011, ?timescale=), which the native
    QEMU has but no option for: gdb calls porty_set_time_scale() in the
    running process, as the page calls the wasm export before the guest
    runs.  Without it Android's timeouts fire natively all the time
    ("System UI isn't responding" over the launcher)."""
    import subprocess
    try:
        out = subprocess.run(["sudo", "-n", "gdb", "-p", str(vm.proc.pid), "-batch", "-nx",
                              "-ex", f"call (int)porty_set_time_scale({int(scale)})"],
                             capture_output=True, text=True, timeout=120)
        text = (out.stdout + out.stderr).strip().split("\n")
        got = next((line for line in reversed(text) if line.startswith("$")), "")
        log(f"time scale {scale} via gdb: {got or text[-3:]}")
        return got
    except (OSError, subprocess.SubprocessError) as e:
        log(f"time scale via gdb failed: {e}")
        return f"error: {e}"


CAL_LOOP = ("t0=$(cut -d' ' -f1 /proc/uptime); i=0; while [ $i -lt 20000 ]; do i=$((i+1)); done; "
            "t1=$(cut -d' ' -f1 /proc/uptime); echo CAL:$t0:$t1:END")


def calibrate(vm):
    """Guest seconds for the browser probe's calibration (20000 rounds of a
    shell loop, tests/boot/boot-test.mjs): in the browser 10-21 s of wall
    time at timescale 8, so 1.2-2.6 guest seconds."""
    status, text = vm.sh(CAL_LOOP, 600)
    m = re.search(r"CAL:([\d.]+):([\d.]+):END", text or "")
    return round(float(m.group(2)) - float(m.group(1)), 3) if m else None


def limit_cpu(vm, fraction):
    """Limit QEMU, all its threads, to `fraction` of one CPU (cgroup v2
    cpu.max); 0 lifts the limit.  Returns cpu.max as set.  The period is as
    short as the kernel's 1 ms least quota allows, so that the guest's
    pauses stay short, as in the browser, where it never stops but runs
    slowly."""
    import math
    import subprocess
    path = "/sys/fs/cgroup/porty-qemu"
    if fraction:
        period = max(10000, math.ceil(1000 / fraction))
        quota = max(1000, int(period * fraction))
        cmd = (f"grep -qw cpu /sys/fs/cgroup/cgroup.subtree_control || echo +cpu > /sys/fs/cgroup/cgroup.subtree_control; "
               f"mkdir -p {path} && echo '{quota} {period}' > {path}/cpu.max && echo {vm.proc.pid} > {path}/cgroup.procs && cat {path}/cpu.max")
    else:
        cmd = f"echo max > {path}/cpu.max; cat {path}/cpu.max"
    try:
        r = subprocess.run(["sudo", "-n", "sh", "-c", cmd], capture_output=True, text=True, timeout=60)
        return (r.stdout + r.stderr).strip()
    except (OSError, subprocess.SubprocessError) as e:
        return f"error: {e}"


def browser_like(vm, target, result):
    """Slow QEMU down until the guest runs the browser's calibration loop in
    `target` guest seconds, as the page's guest does (about 2 at timescale 8):
    Android's timeouts then fire as they do in the browser."""
    before = calibrate(vm)
    info = {"target_guest_s": target, "unlimited_guest_s": before}
    if before and before < target:
        fraction = before / target
        info["fraction"] = round(fraction, 4)
        info["cpu_max"] = limit_cpu(vm, fraction)
        info["limited_guest_s"] = calibrate(vm)
    result["browser_like"] = info
    log(f"browser-like speed: {info}")


def dismiss_anr(vm):
    """End the processes Android shows an "isn't responding" dialog for (as
    make-snapshot.py does before it saves); returns their names."""
    status, windows = vm.sh("dumpsys window windows | grep -o 'Application Not Responding: [A-Za-z0-9_.]*' | sort -u", 180)
    anrs = sorted(set(re.findall(r"Application Not Responding: ([A-Za-z0-9_.]+)", windows if status == 0 else "")))
    if anrs:
        vm.sh("; ".join(f"kill $(pidof {p})" for p in anrs) + "; echo killed", 120)
        prov.wait(vm, 20)
    return anrs


def settle(vm, opts, result):
    """As scripts/snapshot/make-snapshot.py does before it saves."""
    prov.wait(vm, opts.settle)
    text = ""
    for _ in range(12):
        status, text = vm.sh("cat /proc/loadavg", 30)
        try:
            if float(text.split()[0]) < opts.max_load:
                break
        except (ValueError, IndexError):
            pass
        prov.wait(vm, 30)
    result["load_settled"] = text.strip()
    result["anr_dismissed"] = []
    for _ in range(3):
        status, windows = vm.sh("dumpsys window windows | grep -o 'Application Not Responding: [A-Za-z0-9_.]*' | sort -u", 180)
        anrs = sorted(set(re.findall(r"Application Not Responding: ([A-Za-z0-9_.]+)", windows if status == 0 else "")))
        if not anrs:
            break
        result["anr_dismissed"].extend(anrs)
        vm.sh("; ".join(f"kill $(pidof {p})" for p in anrs) + "; echo killed", 120)
        prov.wait(vm, 60)
    log(f"settled: load {result['load_settled']}, dialogs dismissed {result['anr_dismissed']}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--qemu", required=True)
    ap.add_argument("--argv-file", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--pcpu", required=True, help="file with the shell function pcpu (tests/boot/cpu-probe.mjs)")
    ap.add_argument("--plan", required=True, help="tests/guest-cpu-variants.json")
    ap.add_argument("--variant", required=True)
    ap.add_argument("--cpu", default="", help="the host's CPU model, for the result")
    ap.add_argument("--query", default="")
    ap.add_argument("--facts", type=int, default=1)
    ap.add_argument("--boot-timeout", type=float, default=2400)
    ap.add_argument("--settle", type=float, default=180)
    ap.add_argument("--max-load", type=float, default=1.5)
    ap.add_argument("--launch-timeout", type=float, default=180)
    ap.add_argument("--show-screens", type=int, default=0)
    ap.add_argument("--timescale", type=int, default=8, help="the page's time dilation, set through gdb (1: none)")
    ap.add_argument("--watch", type=int, default=1, help="starts per app (from the first) during which activity and layer states are sampled")
    ap.add_argument("--profile", type=int, default=0, help="1: one more start of the first app, sampled by simpleperf")
    ap.add_argument("--profile-seconds", type=int, default=60)
    ap.add_argument("--profile-hz", type=int, default=1000)
    opts = ap.parse_args()
    with open(opts.plan, encoding="utf-8") as f:
        plan = json.load(f)
    variant = plan["variants"][opts.variant]
    with open(opts.pcpu, encoding="utf-8") as f:
        pcpu = f.read().strip()
    opts.wake_lock = 1
    opts.trace = 0
    os.makedirs(opts.work, exist_ok=True)
    opts.work = os.path.abspath(opts.work)
    with open(opts.argv_file, encoding="utf-8") as f:
        argv = [line.rstrip("\n") for line in f if line.rstrip("\n") != ""]

    result = {"mode": "guest-cpu", "variant": opts.variant, "cpu": opts.cpu, "query": opts.query, "booted": False,
              "milestones": {}, "launches": [], "guest": {}}
    vm = snap.Machine(opts.qemu, argv, opts.work)
    log("QEMU started: " + " ".join(vm.args))
    timescale = int(variant.get("timescale", opts.timescale))
    if timescale > 1:
        result["timescale"] = set_time_scale(vm, timescale)
    if "launch_timeout" in variant:
        opts.launch_timeout = float(variant["launch_timeout"])
    g = Guest(vm, pcpu)

    def run(key, command, timeout=240):
        status, text = vm.sh(command, timeout)
        result["guest"][key] = text if status == 0 else f"[status {status}] {text}"
        log(f"guest {key}: {result['guest'][key][:6000]}")
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
            run("log_buffers", "logcat -b events -G 2M; logcat -g | cut -c1-90")
            for i, command in enumerate(variant.get("setup", [])):
                run(f"setup_{i}", command)
            settle(vm, opts, result)
            run("screen_on", "settings put system screen_off_timeout 2147483647; svc power stayon true")
            # The shell answers first, as the browser probe's does; the
            # events of every start go to a file.
            run("shell", "renice -n -20 -p $$; logcat -b events -v epoch > /data/local/tmp/porty-ev.txt 2>&1 & echo started")
            vm.sh(pcpu, 30)
            if opts.facts:
                for key, command in FACTS:
                    run(key, command)
            if variant.get("browser_like"):
                browser_like(vm, float(variant["browser_like"]), result)
            result["home_screen"] = vm.screenshot("home", show=True)
            result["focus_home"] = g.focus()
            apps = []
            for app in plan["apps"]:
                one = dict(app)
                if not LAUNCHER_COMPONENT.match(one.get("component", "")):
                    continue
                apps.append(one)
            for rnd in range(plan.get("rounds", 1)):
                for app in apps:
                    for i in range(app.get("times", 1)):
                        if not vm.alive():
                            raise RuntimeError("QEMU is gone")
                        index = rnd * app.get("times", 1) + i + 1
                        result["launches"].append(launch(g, app, opts, index))
                        snap.write_json(os.path.join(opts.work, "result.json"), result)
            if opts.profile and apps:
                profile(g, apps[0], opts, result)
                snap.write_json(os.path.join(opts.work, "result.json"), result)
            if plan.get("ui"):
                try:
                    ui_check(g, opts, result)
                except Exception as e:  # the starts above still count
                    result.setdefault("ui", {})["error"] = f"{type(e).__name__}: {e}"
                    log(f"ui check: {result['ui']['error']}")
                snap.write_json(os.path.join(opts.work, "result.json"), result)
            result["reboots"] = list(vm.reboots)
            run("crashes", "logcat -b crash -d | grep -e 'Process: ' -e '>>> ' | cut -c1-200 | head -20")
            run("anr", "logcat -b events -d | grep -c am_anr")
            run("gfx_gallery", "dumpsys gfxinfo com.android.gallery3d | head -30 | cut -c1-150")
    except Exception as e:  # the verdict must always be written
        result["error"] = f"{type(e).__name__}: {e}"
        log(f"error: {result['error']}")
    finally:
        vm.quit()
        snap.write_json(os.path.join(opts.work, "result.json"), result)
    print("PORTY_RESULT " + json.dumps({k: v for k, v in result.items() if k not in ("guest",)})[:200000], flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
