#!/usr/bin/env python3
"""Measure what surfaceflinger costs in a booted guest, natively.

Used by .github/workflows/sf-cpu.yml.  Boots the page's argument vector
(optionally with another display device) --boots times in the native QEMU
and reports, per boot,

  * the time to sys.boot_completed;
  * for each --window-at offset (seconds after the preparation that follows
    the boot), over --window seconds: CPU time (utime+stime from
    /proc/<pid>/stat) of surfaceflinger, of the composer service and of
    every other process, per thread for surfaceflinger; the frames
    surfaceflinger composed (page flips, "service call SurfaceFlinger
    1013"); the guest's own account of its CPU (/proc/stat) and the load
    average;
  * the screen (PNG, lit%), and whether it changes when the notification
    shade is pulled down with the pointer (QMP input events through the
    USB tablet: input and rendering end to end);
  * on the first boot, which graphics stack is in use (properties, HALs,
    libraries mapped by surfaceflinger, "dumpsys SurfaceFlinger" before and
    after a window, stack samples of surfaceflinger).

It reuses the Machine class of scripts/snapshot/make-snapshot.py.  Writes
<work>/result.json and prints one summary line last.  Always exits 0.
Standard library only; "python3 -I".
"""

import argparse
import importlib.util
import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SNAPSHOT = os.path.join(HERE, "..", "scripts", "snapshot", "make-snapshot.py")

PANIC = re.compile(rb"Kernel panic - not syncing[^\r\n]*")
HZ = 100  # USER_HZ of the guest

# Display devices other than the page's "-vga std" (experiments).
DEVICES = {
    "bochs-display": "bochs-display,xres=480,yres=800,romfile=",
    "virtio-vga": "virtio-vga,xres=480,yres=800,romfile=",
    "virtio-gpu-pci": "virtio-gpu-pci,xres=480,yres=800",
}

DIAGNOSTICS = (
    ("cmdline", "cat /proc/cmdline"),
    ("proc_fb", "cat /proc/fb; cd /sys/class/graphics/fb0 && for f in name modes virtual_size bits_per_pixel stride; do echo $f=$(cat $f 2>&1); done"),
    ("props", "getprop | grep -i -e gralloc -e hwc -e egl -e '\\.sf\\.' -e hwui -e opengles -e 'kernel.qemu' -e lcd_density"
              " -e 'hardware\\]' -e vulkan -e 'sys.boot' -e bootanim | cut -c1-160"),
    ("hw_libs", "ls /system/lib64/hw /vendor/lib64/hw 2>&1 | grep -i -e gralloc -e hwcomposer -e ':' -e vulkan -e memtrack"),
    ("egl_libs", "ls -l /system/lib64/egl /vendor/lib64/egl /system/vendor/lib64/egl 2>&1 | cut -c1-140; ls /vendor/lib64/dri /system/lib64/dri 2>&1 | head -30"),
    ("init_sh_gralloc", "f=/system/etc/init.sh; ls -l $f; sed -n '/^function init_hal_gralloc/,/^}/p;/^function init_egl/,/^}/p;"
                        "/^function init_hal_hwcomposer/,/^}/p;/^function init_uvesafb/,/^}/p;/^function set_drm_mode/,/^}/p' $f | cut -c1-200"),
    ("init_sh_words", "grep -n -e HWACCEL -e GRALLOC -e 'HWC' -e swiftshader -e 'ro.hardware.egl' -e VULKAN -e 'debug.sf' -e 'video=' /system/etc/init.sh | cut -c1-200"),
    ("graphics_procs", "ps -A -o PID,PPID,NI,RSS,NAME | grep -i -e composer -e allocator -e surfacefl -e bootanim -e configstore"),
    ("sf_libs", "sed -e 's/.* //' /proc/$(pidof surfaceflinger)/maps | grep '\\.so' | sort -u | grep -i -e egl -e gles -e swift -e gralloc -e hwc"
                " -e llvm -e dri -e mesa -e gbm -e drm -e subzero -e vulkan -e composer"),
    ("composer_libs", "sed -e 's/.* //' /proc/$(pidof android.hardware.graphics.composer@2.1-service)/maps | grep '\\.so' | sort -u | grep -i -e egl -e gles"
                      " -e swift -e gralloc -e hwc -e llvm -e dri -e mesa -e gbm -e drm -e composer"),
    ("sf_fb_maps", "grep -e graphics/fb -e dri/ -e ' /dev/fb' -e dmabuf -e ashmem /proc/$(pidof surfaceflinger)/maps | cut -c1-140 | tail -12"),
    ("logcat_graphics", "logcat -d | grep -i -e 'EGL_' -e 'OpenGL ES' -e 'GLES' -e gralloc -e hwcomposer -e 'HWC2' -e 'swiftshader' -e 'vsync' -e 'fps' "
                        "-e 'refresh' -e 'FramebufferSurface' -e 'RenderEngine' | head -60 | cut -c1-220"),
    ("dispsync", "dumpsys SurfaceFlinger --dispsync 2>&1 | head -30 | cut -c1-200"),
    ("latency", "dumpsys SurfaceFlinger --latency 2>&1 | head -3"),
    ("kconfig", "zcat /proc/config.gz 2>/dev/null | grep -e 'CONFIG_HZ' -e DRM_BOCHS -e DRM_VIRTIO_GPU -e 'FB_VESA' -e FB_UVESA -e NO_HZ -e CONFIG_PREEMPT"),
    ("uname", "uname -a"),
)


def load_snapshot_module():
    spec = importlib.util.spec_from_file_location("porty_make_snapshot", SNAPSHOT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def change_device(args, device):
    """The page's argv with another display device in place of -vga std."""
    if not device:
        return list(args)
    spec = DEVICES[device]
    out = []
    i = 0
    while i < len(args):
        if args[i] == "-vga" and args[i + 1] == "std":
            out += ["-vga", "none", "-device", spec]
            i += 2
        elif args[i] == "-global" and args[i + 1].startswith("VGA."):
            i += 2
        else:
            out.append(args[i])
            i += 1
    return out


def parse_stat_lines(text):
    """/proc/<pid>/stat lines -> {pid: (comm, utime+stime ticks)}."""
    out = {}
    for line in text.split("\n"):
        m = re.match(r"\s*(\d+) \((.*)\) (\S) (.*)$", line)
        if not m:
            continue
        rest = m.group(4).split()
        if len(rest) < 12:
            continue
        try:
            out[int(m.group(1))] = (m.group(2), int(rest[10]) + int(rest[11]))
        except ValueError:
            continue
    return out


SAMPLE = (
    "S=$(pidof surfaceflinger); echo sf=$S; echo hwc=$(pidof android.hardware.graphics.composer@2.1-service); echo up=$(cut -d' ' -f1 /proc/uptime); echo load=$(cat /proc/loadavg);"
    " head -1 /proc/stat; echo flips=$(service call SurfaceFlinger 1013 | cut -c1-60);"
    " echo ---threads; cat /proc/$S/task/*/stat 2>/dev/null; echo ---procs; cat /proc/[0-9]*/stat 2>/dev/null; echo ---end"
)


def parse_sample(text):
    sample = {"sf": None, "hwc": None, "up": None, "load": None, "cpu": None, "flips": None, "threads": {}, "procs": {}}
    head, _, rest = text.partition("---threads")
    threads, _, rest = rest.partition("---procs")
    procs, _, _ = rest.partition("---end")
    for line in head.split("\n"):
        line = line.strip()
        if line.startswith("sf="):
            sample["sf"] = line[3:].strip() or None
        elif line.startswith("hwc="):
            sample["hwc"] = line[4:].strip() or None
        elif line.startswith("up="):
            try:
                sample["up"] = float(line[3:])
            except ValueError:
                pass
        elif line.startswith("load="):
            sample["load"] = line[5:]
        elif line.startswith("cpu "):
            try:
                sample["cpu"] = [int(x) for x in line.split()[1:]]
            except ValueError:
                pass
        elif line.startswith("flips="):
            m = re.search(r"Parcel\(\s*([0-9a-f]{8})", line)
            sample["flips"] = int(m.group(1), 16) if m else None
    sample["threads"] = parse_stat_lines(threads)
    sample["procs"] = parse_stat_lines(procs)
    return sample


def window_delta(a, b):
    """What happened between two samples."""
    out = {}
    if a["up"] is None or b["up"] is None or b["up"] <= a["up"]:
        return {"error": "no uptime"}
    dt = b["up"] - a["up"]
    out["guest_seconds"] = round(dt, 1)
    out["load_start"] = a["load"]
    out["load_end"] = b["load"]
    try:
        out["load1"] = float(b["load"].split()[0])
    except (AttributeError, ValueError, IndexError):
        out["load1"] = None
    if a["cpu"] and b["cpu"]:
        d = [y - x for x, y in zip(a["cpu"], b["cpu"])]
        total = sum(d) or 1
        names = ["user", "nice", "system", "idle", "iowait", "irq", "softirq", "steal"]
        out["cpu_percent"] = {n: round(100.0 * v / total, 1) for n, v in zip(names, d)}
    if a["flips"] is not None and b["flips"] is not None:
        out["frames"] = b["flips"] - a["flips"]
        out["frames_per_second"] = round(out["frames"] / dt, 2)
    out["sf_pid"] = b["sf"]
    out["sf_restarted"] = a["sf"] != b["sf"]

    def deltas(x, y):
        rows = []
        for pid, (comm, ticks) in y.items():
            before = x.get(pid)
            if before is None or before[0] != comm:
                d = ticks
            else:
                d = ticks - before[1]
            if d > 0:
                rows.append((d, pid, comm))
        rows.sort(reverse=True)
        return rows

    procs = deltas(a["procs"], b["procs"])
    out["top"] = [{"pid": pid, "name": comm, "cpu_seconds": round(d / HZ, 2), "percent": round(100.0 * d / HZ / dt, 1)}
                  for d, pid, comm in procs[:12]]
    out["all_seconds"] = round(sum(d for d, _, _ in procs) / HZ, 2)
    by_name = {}
    for d, pid, comm in procs:
        by_name[comm] = by_name.get(comm, 0) + d
    by_pid = {str(pid): d for d, pid, _ in procs}
    for key, name in (("sf", "surfaceflinger"), ("composer", None), ("system_server", "system_server"),
                      ("systemui", "ndroid.systemui")):
        ticks = by_name.get(name, 0) if name else by_pid.get(b.get("hwc") or "", 0)
        out[key + "_cpu_seconds"] = round(ticks / HZ, 2)
        out[key + "_percent"] = round(100.0 * ticks / HZ / dt, 1)
    threads = deltas(a["threads"], b["threads"])
    out["sf_threads"] = [{"tid": tid, "name": comm, "cpu_seconds": round(d / HZ, 2)} for d, tid, comm in threads[:10]]
    return out


class Boot:
    def __init__(self, snap, opts, argv, index):
        self.snap = snap
        self.opts = opts
        self.index = index
        self.work = os.path.join(opts.work, f"boot-{index}")
        os.makedirs(self.work, exist_ok=True)
        self.vm = snap.Machine(opts.qemu, argv, self.work)
        self.vm.max_reboots = 1000
        self.result = {"boot": index, "booted": False, "panic": None, "windows": [], "steps": {}}
        self.booted_at = None

    def log(self, text):
        self.snap.log(f"[{self.opts.name} boot {self.index}] {text}")

    def panicked(self):
        if self.result["panic"]:
            return True
        m = PANIC.search(self.vm.out)
        banners = len(re.findall(rb"Linux version ", self.vm.out))
        if not m and banners < 2:
            return False
        self.result["panic"] = m.group(0).decode("utf-8", "replace") if m else "the guest restarted"
        self.result["panic_at_seconds"] = round(self.vm.elapsed(), 1)
        self.log("KERNEL PANIC: " + self.result["panic"])
        at = m.start() if m else len(self.vm.out)
        for line in self.vm.out[max(0, at - 2500):at + 600].decode("utf-8", "replace").replace("\r", "").split("\n")[1:]:
            print("    | " + line[:260], flush=True)
        return True

    def wait(self, seconds):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if not self.vm.alive():
                return False
            self.vm.pump(min(2.0, max(0.1, end - time.monotonic())))
            if self.panicked():
                return False
        return True

    def sh(self, command, timeout=120):
        return self.vm.sh(command, timeout)

    def run(self, key, command, timeout=120, store=None, quiet=False):
        status, text = self.sh(command, timeout)
        value = text if status == 0 else f"[status {status}] {text}"
        (store if store is not None else self.result["steps"])[key] = value
        if not quiet:
            self.log(f"{key}: {value[:6000]}")
        return status, text

    def boot(self):
        vm = self.vm
        last_probe = 0.0
        armed = False
        while vm.elapsed() < self.opts.boot_timeout:
            if not self.wait(2.0):
                return False
            now = vm.elapsed()
            if self.snap.PROMPT.search(vm.out) and now - last_probe >= 8:
                last_probe = now
                status, text = self.sh("getprop sys.boot_completed", 45)
                if status is None:
                    continue
                if not armed:
                    armed = True
                    self.result["shell_seconds"] = round(now, 1)
                    self.sh("echo porty > /sys/power/wake_lock; echo 1 > /proc/sys/kernel/printk", 30)
                if status == 0 and "1" in [line.strip() for line in text.split("\n")]:
                    self.booted_at = vm.elapsed()
                    self.result["booted"] = True
                    self.result["booted_seconds"] = round(self.booted_at, 1)
                    self.log(f"sys.boot_completed=1 after {self.booted_at:.0f} s")
                    return True
        self.result["error"] = f"sys.boot_completed was not 1 after {vm.elapsed():.0f} s"
        self.log(self.result["error"])
        return False

    def prepare(self):
        """As the snapshot producer does: screen on, and a home screen even
        when the setup wizard did not finish."""
        self.run("sf_at_boot", "cat /proc/$(pidof surfaceflinger)/stat | cut -d' ' -f1,2,14,15; cat /proc/uptime; cat /proc/loadavg")
        self.run("screen_timeout", "settings put system screen_off_timeout 2147483647")
        self.run("stay_on", "svc power stayon true")
        status, text = self.run("provisioned", "settings get global device_provisioned;"
                                               " settings get secure user_setup_complete", 180)
        if status == 0 and text.split() != ["1", "1"]:
            self.run("provision_1", "settings put global device_provisioned 1;"
                                    " settings put secure user_setup_complete 1", 180)
            self.run("provision_2", "pm disable-user --user 0 com.google.android.setupwizard", 180)
            status, text = self.run("home_candidates", "cmd package query-activities --brief -a android.intent.action.MAIN"
                                                       " -c android.intent.category.HOME | grep /", 180)
            launcher = [line.strip() for line in text.split("\n") if "launcher3" in line.lower()]
            if launcher:
                self.run("provision_3", f"cmd package set-home-activity {launcher[0]}", 180)
            self.run("provision_4", "am start -a android.intent.action.MAIN -c android.intent.category.HOME", 180)
        for command in self.opts.guest_command:
            self.run(f"extra_{len([k for k in self.result['steps'] if k.startswith('extra_')])}", command, 300)

    def sample(self):
        status, text = self.sh(SAMPLE, 120)
        if status is None:
            return None
        return parse_sample(text)

    def dump_sf(self, name):
        """The whole "dumpsys SurfaceFlinger", to a file of the artifact."""
        status, text = self.sh("dumpsys SurfaceFlinger 2>&1", 240)
        path = os.path.join(self.work, name + ".txt")
        with open(path, "w", encoding="utf-8") as f:
            f.write(text + "\n")
        return text

    def window(self, label, diagnose):
        if diagnose:
            before = self.dump_sf(f"dumpsys-sf-{label}-before")
        a = self.sample()
        if a is None:
            self.result["windows"].append({"label": label, "error": "no first sample"})
            return
        if not self.wait(self.opts.window):
            return
        b = self.sample()
        if b is None:
            self.result["windows"].append({"label": label, "error": "no second sample"})
            return
        w = window_delta(a, b)
        w["label"] = label
        w["after_boot_seconds"] = round(self.vm.elapsed() - self.booted_at, 1)
        self.result["windows"].append(w)
        self.log(f"window {label}: sf {w.get('sf_cpu_seconds')} s CPU in {w.get('guest_seconds')} guest s ({w.get('sf_percent')}%),"
                 f" composer {w.get('composer_percent')}%, frames {w.get('frames')}, load {w.get('load_end')}, cpu {w.get('cpu_percent')}")
        self.log(f"window {label} top: " + ", ".join(f"{t['name']} {t['percent']}%" for t in w.get("top", [])))
        self.log(f"window {label} sf threads: " + ", ".join(f"{t['name']} {t['cpu_seconds']}s" for t in w.get("sf_threads", [])))
        if diagnose:
            after = self.dump_sf(f"dumpsys-sf-{label}-after")
            w["layer_frames"] = layer_frames(before, after)
            self.log(f"window {label} frames queued per layer: {json.dumps(w['layer_frames'])}")
            self.run(f"top_threads_{label}", "top -H -b -n 1 -m 14 -o PID,TID,%CPU,TIME+,CMD,ARGS 2>&1 | head -24 | cut -c1-150;"
                                             " top -b -n 1 -m 10 | head -16 | cut -c1-150", 240)

    def screen(self, name):
        # ui/wasmfb.c writes the dump when the display refreshes.
        self.wait(3)
        stats = self.vm.screenshot(f"{name}-{self.opts.name}-{self.index}", show=False)
        self.log(f"screen {name}: {stats}")
        return stats

    def pointer(self, x, y, down):
        """One absolute pointer event through QMP (0..0x7fff per axis)."""
        events = [{"type": "abs", "data": {"axis": "x", "value": int(x * 0x7fff)}},
                  {"type": "abs", "data": {"axis": "y", "value": int(y * 0x7fff)}}]
        if down is not None:
            events.append({"type": "btn", "data": {"button": "left", "down": down}})
        self.vm.qmp.cmd("input-send-event", {"events": events})

    def input_test(self):
        """Pulls the notification shade down with the pointer and looks at
        the screen before and after."""
        res = self.result["input"] = {}
        try:
            self.run("home", "input keyevent 3; sleep 4; dumpsys window windows | grep -e mCurrentFocus", 180)
            res["before"] = self.screen("screen-idle")
            self.sh("rm -f /data/local/tmp/porty-ev.txt; (getevent -c 8 > /data/local/tmp/porty-ev.txt 2>&1 &)", 30)
            self.wait(2)
            self.pointer(0.5, 0.01, None)
            self.wait(0.5)
            self.pointer(0.5, 0.01, True)
            for step in range(1, 13):
                self.wait(0.25)
                self.pointer(0.5, 0.01 + 0.07 * step, None)
            self.wait(0.3)
            self.pointer(0.5, 0.85, False)
            self.wait(self.opts.redraw_wait)
            status, text = self.run("getevent", "grep -c . /data/local/tmp/porty-ev.txt; tail -3 /data/local/tmp/porty-ev.txt | cut -c1-80;"
                                                " dumpsys window windows | grep -e mCurrentFocus;"
                                                " dumpsys statusbar 2>/dev/null | grep -m2 -i -e mExpandedVisible -e 'mState=' | cut -c1-120", 180)
            try:
                res["kernel_events"] = int(text.split("\n")[0])
            except (ValueError, IndexError):
                res["kernel_events"] = None
            res["after"] = self.screen("screen-shade")
            res["shade"] = "mExpandedVisible=true" in text
            a, b = res["before"] or {}, res["after"] or {}
            res["screen_changed"] = bool(a and b and (a.get("lit_percent"), a.get("sampled_colours")) != (b.get("lit_percent"), b.get("sampled_colours")))
            self.run("collapse", "cmd statusbar collapse; input keyevent 3", 120)
            self.wait(6)
        except Exception as e:  # diagnostics only
            res["error"] = f"{type(e).__name__}: {e}"
        self.log(f"input: {res}")

    def stacks(self):
        """Where surfaceflinger's threads are, a few times."""
        for i in range(self.opts.stacks):
            status, text = self.sh("debuggerd -b $(pidof surfaceflinger) 2>&1 | grep -v -e '^$' | head -400 | cut -c1-170", 240)
            with open(os.path.join(self.work, f"sf-stack-{i + 1}.txt"), "w", encoding="utf-8") as f:
                f.write(text + "\n")
            # The busiest threads' first frames, for the log.
            head = []
            for block in re.split(r"\n(?=\"|--- )", text):
                lines = block.split("\n")
                if lines and ("surfaceflinger" in lines[0] or "SwiftShader" in lines[0] or "main" in lines[0] or "sf" in lines[0].lower()):
                    head.append(" | ".join(l.strip()[:110] for l in lines[:9]))
            self.log(f"stack sample {i + 1}: " + "\n      ".join(head[:8])[:5000])
            if not self.wait(4):
                return

    def go(self):
        try:
            if not self.boot():
                return
            self.prepare()
            if self.panicked():
                return
            prepared = self.vm.elapsed()
            first = self.index == 1
            if first:
                diag = self.result["diagnostics"] = {}
                for key, command in DIAGNOSTICS:
                    self.run(key, command, 180, store=diag)
                    if self.panicked():
                        return
            for n, offset in enumerate(self.opts.window_at):
                left = prepared + offset - self.vm.elapsed()
                if left > 0 and not self.wait(left):
                    return
                self.window(f"w{n + 1}", first and n in (0, len(self.opts.window_at) - 1))
                if self.panicked() or not self.vm.alive():
                    return
            self.result["screen"] = self.screen("screen-final")
            self.input_test()
            if self.opts.window_after_input:
                self.window("after-input", False)
            if first and self.opts.stacks:
                self.stacks()
            self.run("health", "echo boot_completed=$(getprop sys.boot_completed) sf=$(pidof surfaceflinger)"
                               " system_server=$(pidof system_server) uptime=$(cut -d' ' -f1 /proc/uptime);"
                               " echo anr=$(logcat -d -b events -s am_anr | grep -c am_anr) crashes=$(logcat -d -b crash | grep -c 'FATAL EXCEPTION');"
                               " logcat -d -b crash | grep -e 'Process: ' | sort | uniq -c | head -8;"
                               " cat /proc/$(pidof surfaceflinger)/stat | cut -d' ' -f14,15", 180)
        except Exception as e:  # a harness problem is a result, not a failed run
            self.result["error"] = f"{type(e).__name__}: {e}"
            self.log("error: " + self.result["error"])
        finally:
            self.panicked()
            self.result["elapsed_seconds"] = round(self.vm.elapsed(), 1)
            if not self.result["booted"]:
                self.result["serial_tail"] = self.vm.tail(40)
                for line in self.result["serial_tail"]:
                    print("    ~ " + line[:260], flush=True)
                self.result["screen"] = self.vm.screenshot(f"screen-final-{self.opts.name}-{self.index}")
            self.vm.kill()


def layer_frames(before, after):
    """Buffers queued per layer between two "dumpsys SurfaceFlinger" texts:
    the highest "frame=" of each BufferQueue's slots."""
    def parse(text):
        out = {}
        name = None
        for line in text.split("\n"):
            m = re.match(r"\+ (?:Buffer|Color|Container)?Layer \((.*)\)", line.strip()) or re.match(r"\+ Layer 0x\S+ \((.*)\)", line.strip())
            if m:
                name = m.group(1)[:70]
                out.setdefault(name, 0)
                continue
            if name:
                for f in re.findall(r"frame=(\d+)", line):
                    out[name] = max(out[name], int(f))
        return out
    a, b = parse(before), parse(after)
    return {name: b[name] - a.get(name, 0) for name in b if b[name] - a.get(name, 0) > 0}


def summarise(name, boots):
    booted = [b for b in boots if b["booted"]]
    line = f"{name}: {len(booted)}/{len(boots)} booted"
    if booted:
        line += " in " + "/".join(f"{b['booted_seconds']:.0f}" for b in booted) + " s"
    sf = []
    load = []
    for b in booted:
        ws = [w for w in b["windows"] if "sf_percent" in w and w["label"].startswith("w")]
        if ws:
            sf.append("+".join(f"{w['sf_percent']:.0f}" for w in ws))
            load.append("+".join(f"{w['load1']:.1f}" if w.get("load1") is not None else "?" for w in ws))
    if sf:
        line += f"; sf% {' / '.join(sf)}; load {' / '.join(load)}"
    lit = [str((b.get("screen") or {}).get("lit_percent", "?")) for b in booted]
    if lit:
        line += f"; lit% {'/'.join(lit)}"
    changed = [("y" if (b.get("input") or {}).get("screen_changed") else "n") for b in booted]
    if changed:
        line += f"; shade {'/'.join(changed)}"
    panics = sum(1 for b in boots if b["panic"])
    if panics:
        line += f"; {panics} panicked"
    return line


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--qemu", required=True)
    ap.add_argument("--argv-file", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--device", default="", help="another display device: " + ", ".join(DEVICES))
    ap.add_argument("--boots", type=int, default=2)
    ap.add_argument("--boot-timeout", type=float, default=1500)
    ap.add_argument("--window", type=float, default=60)
    ap.add_argument("--window-at", default="60", help="comma separated seconds after the preparation at which a window starts")
    ap.add_argument("--window-after-input", type=int, default=0)
    ap.add_argument("--redraw-wait", type=float, default=10)
    ap.add_argument("--stacks", type=int, default=3)
    ap.add_argument("--guest-command", action="append", default=[], help="run in the guest after the preparation")
    ap.add_argument("--deadline", type=float, default=6000, help="start no new boot after this many seconds")
    opts = ap.parse_args()
    opts.window_at = [float(s) for s in opts.window_at.split(",") if s]
    if opts.device and opts.device not in DEVICES:
        ap.error(f"unknown --device {opts.device}")

    snap = load_snapshot_module()
    os.makedirs(opts.work, exist_ok=True)
    with open(opts.argv_file, encoding="utf-8") as f:
        argv = [line.rstrip("\n") for line in f if line.rstrip("\n") != ""]
    argv = change_device(argv, opts.device)
    started = time.monotonic()
    boots = []
    result = {"name": opts.name, "argv": argv, "window": opts.window, "window_at": opts.window_at, "boots": boots}
    path = os.path.join(opts.work, "result.json")
    try:
        for index in range(1, opts.boots + 1):
            if time.monotonic() - started > opts.deadline:
                snap.log(f"out of time after {len(boots)} boots")
                break
            boot = Boot(snap, opts, argv, index)
            if index == 1:
                snap.log("QEMU started: " + " ".join(boot.vm.args))
            boot.go()
            boots.append(boot.result)
            result["summary"] = summarise(opts.name, boots)
            snap.write_json(path, result)
            snap.progress(opts.work, result["summary"])
            snap.log(result["summary"])
    except BaseException as e:  # noqa: B036 - never a failed run
        result["error"] = f"{type(e).__name__}: {e}"
        snap.log("error: " + result["error"])
    result["summary"] = summarise(opts.name, boots) if boots else f"{opts.name}: no boot was made ({result.get('error', 'no time')})"
    snap.write_json(path, result)
    print("SUMMARY " + result["summary"], flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
