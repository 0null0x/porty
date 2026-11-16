#!/usr/bin/env python3
"""Count guest kernel panics over several native boots of the page's argv.

Used by .github/workflows/ttm-panic.yml.  Android-x86 9.0-r2's kernel dies
("invalid opcode ... RIP: ttm_bo_vm_open ... Kernel panic - not syncing:
Fatal exception") whenever surfaceflinger forks while it has the bochs-drm
framebuffer (/dev/graphics/fb0) mapped; see docs/PLAN.md, "The
ttm_bo_vm_open panic".  This script boots the guest --boots times with one
argument vector and reports, per boot, whether the kernel panicked

  * by itself, within --observe seconds of sys.boot_completed (Android dumps
    surfaceflinger's stack when an app does not respond, or when
    system_server's Watchdog fires), or
  * after one of the --provoke steps (a step may be given more than once):
      anr        stop the focused app and send it key events, so that
                 ActivityManager declares it "not responding" and collects
                 stack traces (the natural trigger, made on purpose)
      debuggerd  "debuggerd -b <pid of surfaceflinger>": the fork itself
      nopanic    clear kernel.panic_on_oops first, then debuggerd: what an
                 oops alone leaves behind

It reuses the Machine class of scripts/snapshot/make-snapshot.py (serial
console and QMP on UNIX sockets).  Writes <work>/result.json and prints one
summary line last.  Always exits 0.  Standard library only; "python3 -I".
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
TTM = re.compile(rb"RIP: 0010:ttm_bo_vm_open")
OOPS = re.compile(rb"invalid opcode: 0000 \[#\d+\]")
# What the page's initrd script said about ttm.ko (web/js/boot-diet.js).
FIX = re.compile(rb"porty: (?:no )?ttm\.ko[^\r\n]*")

# What the first boot of a variant is asked, for the report.
DIAGNOSTICS = (
    ("cmdline", "cat /proc/cmdline"),
    ("panic_sysctls", "cd /proc/sys/kernel; for f in panic panic_on_oops panic_on_warn printk; do echo $f=$(cat $f); done"),
    ("who_sets_panic_on_oops", "grep -n -e panic_on_oops -e 'kernel/panic' /init.rc /init.*.rc /system/etc/init/*.rc 2>/dev/null | head -8"),
    ("proc_fb", "cat /proc/fb; cat /sys/class/graphics/fb0/virtual_size /sys/class/graphics/fb0/bits_per_pixel"),
    ("graphics_props", "for p in ro.hardware.gralloc ro.hardware.hwcomposer ro.hardware.egl dalvik.vm.stack-trace-dir"
                       " dalvik.vm.stack-trace-file ro.debuggable ro.build.type; do echo $p=[$(getprop $p)]; done"),
    ("stack_trace_prop_files", "grep -s -e stack-trace /default.prop /prop.default /system/etc/prop.default"
                               " /system/build.prop /system/default.prop /vendor/build.prop /vendor/default.prop | head -8"),
    ("sf_fb_maps", "grep -e graphics/fb -e dri/ -e ' /dev/fb' /proc/$(pidof surfaceflinger)/maps | head -8"),
    ("fb_mappers", "grep -l -s -e graphics/fb /proc/[0-9]*/maps | head -12"),
    ("modules", "grep -e ttm -e bochs -e drm -e vesa /proc/modules | cut -c1-90"),
    ("ttm_ko", "sha256sum /system/lib/modules/$(uname -r)/kernel/drivers/gpu/drm/ttm/ttm.ko | cut -c1-64;"
               " grep -e ttm /proc/mounts; ls -l /porty-ttm.ko 2>&1"),
    ("ttm_text", "cat /sys/module/ttm/sections/.text 2>/dev/null; grep -e ' ttm_bo_vm_open' -e ' ttm_fbdev_mmap' /proc/kallsyms"),
    ("kconfig", "zcat /proc/config.gz 2>/dev/null | grep -e '^CONFIG_BUG=' -e GENERIC_BUG= -e PANIC_ON_OOPS -e PANIC_TIMEOUT"
                " -e DEBUG_BUGVERBOSE -e 'DRM_BOCHS' -e DRM_VIRTIO_GPU -e 'FB_VESA' -e FB_UVESA -e MODULE_SIG -e MODVERSIONS"),
    ("dmesg_drm", "dmesg | grep -i -e bochs -e '\\[drm\\]' -e vesafb -e 'fb0' -e 'porty' | head -16 | cut -c1-160"),
    ("uname", "uname -a"),
)


def load_snapshot_module():
    spec = importlib.util.spec_from_file_location("porty_make_snapshot", SNAPSHOT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def excerpt(out, around, before=2500, after=1800):
    """Console text around an offset, as lines."""
    text = out[max(0, around - before):around + after].decode("utf-8", "replace").replace("\r", "")
    return [line[:260] for line in text.split("\n")][1:]


class Boot:
    """One boot of the guest: until it panics, or all steps are done."""

    def __init__(self, snap, opts, argv, index):
        self.snap = snap
        self.opts = opts
        self.index = index
        self.work = os.path.join(opts.work, f"boot-{index}")
        os.makedirs(self.work, exist_ok=True)
        self.vm = snap.Machine(opts.qemu, argv, self.work)
        self.vm.max_reboots = 1000  # this script ends a boot at its first panic
        self.result = {"boot": index, "booted": False, "panic": None, "panic_phase": None,
                       "ttm": False, "steps": {}}
        self.phase = "boot"
        self.booted_at = None

    def log(self, text):
        self.snap.log(f"[{self.opts.name} boot {self.index}] {text}")

    def panicked(self):
        """Records the first panic (or oops) seen on the console; True then."""
        if self.result["panic"]:
            return True
        out = self.vm.out
        m = PANIC.search(out)
        oops = OOPS.search(out)
        if self.phase == "nopanic" and not m:
            oops = None
        # A second kernel banner: the guest restarted without a word (the
        # console log level was still Android's).
        banners = [b.start() for b in re.finditer(rb"Linux version ", out)]
        again = banners[1] if len(banners) > 1 else None
        if not m and not oops and again is None:
            return False
        if oops or m:
            at = (oops or m).start()
            self.result["panic"] = (m.group(0) if m else oops.group(0)).decode("utf-8", "replace")
        else:
            at = again
            self.result["panic"] = "the guest restarted (nothing on the console)"
        self.result["panic_phase"] = self.phase
        self.result["panic_at_seconds"] = round(self.vm.elapsed(), 1)
        if self.booted_at is not None:
            self.result["panic_after_boot_seconds"] = round(self.vm.elapsed() - self.booted_at, 1)
        stamp = re.findall(rb"\[ *(\d+\.\d+)\] ", out[max(0, at - 400):at + 200])
        self.result["panic_guest_uptime"] = float(stamp[-1]) if stamp else None
        # Let the rest of the oops arrive before quoting it.
        end = time.monotonic() + 3
        while time.monotonic() < end and self.vm.alive():
            self.vm.pump(0.5)
        self.result["ttm"] = bool(TTM.search(self.vm.out))
        if not PANIC.search(self.vm.out) and self.result["panic"].startswith("invalid opcode") and self.phase != "nopanic":
            self.result["panic"] += " (no panic line followed)"
        m = PANIC.search(self.vm.out)
        if m:
            self.result["panic"] = m.group(0).decode("utf-8", "replace")
        self.result["console"] = excerpt(self.vm.out, at)
        self.log(f"KERNEL PANIC in phase '{self.phase}' ({self.result['panic']}), ttm_bo_vm_open: {self.result['ttm']}")
        if self.index == 1 or self.opts.verbose:
            for line in self.result["console"]:
                print("    | " + line, flush=True)
        return True

    def wait(self, seconds):
        """Pump the console for a while; False as soon as the guest panicked
        or QEMU is gone."""
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if not self.vm.alive():
                return False
            self.vm.pump(min(2.0, max(0.1, end - time.monotonic())))
            if self.panicked():
                return False
        return True

    def sh(self, command, timeout=120):
        status, text = self.vm.sh(command, timeout)
        return status, text

    def run(self, key, command, timeout=120, store=None):
        status, text = self.sh(command, timeout)
        value = text if status == 0 else f"[status {status}] {text}"
        (store if store is not None else self.result["steps"])[key] = value
        self.log(f"{key}: {value[:1800]}")
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
                    # No suspend (as the snapshot producer does), and a
                    # console log level that is not 0: only then does an
                    # oops print itself (oops_begin's console_verbose()
                    # leaves a level of 0 alone, and so the guest restarts
                    # without a word).  1 keeps everything else quiet.
                    self.sh("echo porty > /sys/power/wake_lock; echo 1 > /proc/sys/kernel/printk", 30)
                if status == 0 and "1" in [line.strip() for line in text.split("\n")]:
                    self.booted_at = vm.elapsed()
                    self.result["booted"] = True
                    fix = FIX.search(vm.out)
                    self.result["ttm_ko"] = fix.group(0).decode("utf-8", "replace") if fix else "nothing said (ttmfix=0 or gfx=vesa)"
                    self.result["system_server"] = self.sh("pidof system_server", 30)[1].strip()
                    self.result["booted_seconds"] = round(self.booted_at, 1)
                    self.log(f"sys.boot_completed=1 after {self.booted_at:.0f} s")
                    return True
        self.result["error"] = f"sys.boot_completed was not 1 after {vm.elapsed():.0f} s"
        self.log(self.result["error"])
        return False

    def prepare(self):
        """What the snapshot producer does right after the boot (the
        machine it saves is one that went through these)."""
        steps = self.result["steps"]
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
        steps["prepared"] = True

    def anr_count(self):
        status, text = self.sh("logcat -d -b events -s am_anr | grep -c am_anr", 120)
        try:
            return int(text.strip().split("\n")[-1])
        except (ValueError, IndexError):
            return -1

    def provoke_anr(self):
        """Stops the focused app and sends it keys: the input dispatcher
        reports it after five seconds, and ActivityManager (appNotResponding)
        collects stack traces, surfaceflinger's among them."""
        steps = self.result["steps"]
        before = self.anr_count()
        status, text = self.run("anr_focus", "dumpsys window windows | grep -e mCurrentFocus -e mFocusedApp", 180)
        m = re.search(r"mCurrentFocus=Window\{\S+ \S+ ([A-Za-z0-9_.]+)/", text) or \
            re.search(r"ActivityRecord\{\S+ \S+ ([A-Za-z0-9_.]+)/", text)
        if not m:
            steps["anr"] = "no focused app found"
            return
        package = m.group(1)
        status, text = self.run("anr_pid", f"pidof {package}", 60)
        if status != 0 or not text.strip().isdigit():
            steps["anr"] = f"no process for {package}"
            return
        pid = text.strip()
        self.run("anr_stop", f"kill -STOP {pid}; (input keyevent 20 >/dev/null 2>&1 &);"
                             f" sleep 2; (input keyevent 20 >/dev/null 2>&1 &); echo stopped {package} {pid}", 60)
        deadline = time.monotonic() + self.opts.anr_wait
        seen = False
        while time.monotonic() < deadline:
            if not self.wait(6):
                return
            after = self.anr_count()
            if after > before >= 0 or (before < 0 and after > 0):
                seen = True
                break
        # The stack dumps follow the am_anr event; give them time.
        if seen and not self.wait(self.opts.anr_dump_wait):
            return
        self.run("anr_cont", f"kill -CONT {pid}; echo continued", 60)
        self.run("anr_log", "logcat -d -b events -s am_anr | tail -3 | cut -c1-200;"
                            " logcat -d -s ActivityManager:* | grep -e 'ANR in' -e 'dumpStackTraces' -e 'no trace path'"
                            " -e 'Collecting stacks' -e 'Done dumping' -e 'native pid' | tail -12 | cut -c1-200", 180)
        self.run("anr_files", "ls -l /data/anr 2>&1 | tail -6", 60)
        steps["anr"] = f"ANR of {package} seen" if seen else f"no ANR of {package} within {self.opts.anr_wait:.0f} s"
        self.log(steps["anr"])
        self.wait(10)

    def provoke_debuggerd(self, key="debuggerd"):
        """The fork itself: debuggerd signals surfaceflinger, whose signal
        handler (linker, debuggerd_handler.cpp) clones a thread that forks
        to exec crash_dump64."""
        status, text = self.sh("rm -f /data/local/tmp/porty-sf.txt;"
                               " (debuggerd -b $(pidof surfaceflinger) > /data/local/tmp/porty-sf.txt 2>&1 &);"
                               " sleep 10; head -6 /data/local/tmp/porty-sf.txt | cut -c1-160;"
                               " echo lines=$(grep -c . /data/local/tmp/porty-sf.txt) sf=$(pidof surfaceflinger)", 90)
        n = sum(1 for k in self.result["steps"] if k.startswith(key))
        key = key if n == 0 else f"{key}_{n + 1}"
        self.result["steps"][key] = text if status == 0 else f"[status {status}] {text}"
        self.log(f"{key}: {self.result['steps'][key][:900]}")
        m = re.search(r"lines=(\d+)", text)
        if m and int(m.group(1)) > 3:
            self.result["sf_dumps"] = self.result.get("sf_dumps", 0) + 1
        self.wait(12)

    def provoke_nopanic(self):
        """The same with kernel.panic_on_oops cleared: the oops kills the
        forking thread in the middle of dup_mmap()."""
        steps = self.result["steps"]
        self.run("nopanic_set", "echo 0 > /proc/sys/kernel/panic_on_oops; cat /proc/sys/kernel/panic_on_oops", 30)
        self.phase = "nopanic"
        self.run("nopanic_sf_before", "pidof surfaceflinger; grep -e State -e Threads /proc/$(pidof surfaceflinger)/status", 30)
        self.provoke_debuggerd("nopanic_debuggerd")
        self.wait(10)
        oops = OOPS.search(self.vm.out)
        steps["nopanic_oops"] = bool(oops)
        if oops:
            steps["nopanic_console"] = excerpt(self.vm.out, oops.start(), before=600, after=3500)
            for line in steps["nopanic_console"]:
                print("    | " + line, flush=True)
        self.run("nopanic_sf_after", "pidof surfaceflinger; grep -e State -e Threads /proc/$(pidof surfaceflinger)/status;"
                                     " getprop init.svc.surfaceflinger; getprop init.svc.zygote", 60)
        # Anything that takes surfaceflinger's mmap_sem now waits for ever.
        self.run("nopanic_sf_maps", "rm -f /data/local/tmp/porty-m.txt;"
                                    " (cat /proc/$(pidof surfaceflinger)/maps > /data/local/tmp/porty-m.txt 2>&1 &);"
                                    " sleep 10; echo maps_lines=$(grep -c . /data/local/tmp/porty-m.txt)", 60)
        self.run("nopanic_sf_dumpsys", "rm -f /data/local/tmp/porty-d.txt;"
                                       " (dumpsys SurfaceFlinger --list > /data/local/tmp/porty-d.txt 2>&1 &);"
                                       " sleep 20; echo dumpsys_lines=$(grep -c . /data/local/tmp/porty-d.txt)", 90)
        self.wait(20)
        self.run("nopanic_tail", "dmesg | grep -c 'invalid opcode'; getprop sys.boot_completed;"
                                 " logcat -d -s Watchdog:* | tail -4 | cut -c1-200", 120)

    def go(self):
        try:
            if not self.boot():
                return
            self.phase = "prepare"
            self.prepare()
            if self.panicked():
                return
            if self.index == 1:
                diag = self.result["diagnostics"] = {}
                for key, command in DIAGNOSTICS:
                    self.run(key, command, 120, store=diag)
                    if self.panicked():
                        return
            self.phase = "observe"
            if not self.wait(self.opts.observe):
                return
            self.result["steps"]["observe"] = f"no panic in {self.opts.observe:.0f} s after the boot"
            self.run("anrs_by_themselves", "logcat -d -b events -s am_anr | grep am_anr | cut -c1-160 | tail -4;"
                                           " logcat -d -b events -s watchdog | grep -c watchdog", 120)
            for step in self.opts.provoke:
                if self.panicked() or not self.vm.alive():
                    return
                self.phase = step
                getattr(self, "provoke_" + step)()
            if not self.panicked() and self.vm.alive():
                # Is Android still the one that booted?
                self.run("health", "echo boot_completed=$(getprop sys.boot_completed) sf=$(pidof surfaceflinger)"
                                   " system_server=$(pidof system_server) uptime=$(cut -d' ' -f1 /proc/uptime);"
                                   " logcat -d -b events -s am_anr watchdog | grep -c -e am_anr -e watchdog", 120)
                now = self.sh("pidof system_server", 30)[1].strip()
                self.result["system_server_restarted"] = bool(now) and now != self.result.get("system_server")
            self.result["screen"] = self.vm.screenshot(f"screen-{self.opts.name}-{self.index}",
                                                       show=self.index == 1 and self.opts.show_screen)
        except Exception as e:  # a harness problem is a result, not a failed run
            self.result["error"] = f"{type(e).__name__}: {e}"
            self.log("error: " + self.result["error"])
        finally:
            self.panicked()
            self.result["elapsed_seconds"] = round(self.vm.elapsed(), 1)
            self.result["serial_bytes"] = self.vm.total
            if not self.result["booted"]:
                self.result["serial_tail"] = self.vm.tail(40)
                for line in self.result["serial_tail"]:
                    print("    ~ " + line[:260], flush=True)
            self.vm.kill()


def summarise(name, boots):
    booted = sum(1 for b in boots if b["booted"])
    panics = [b for b in boots if b["panic"]]
    by_phase = {}
    for b in panics:
        by_phase[b["panic_phase"]] = by_phase.get(b["panic_phase"], 0) + 1
    ttm = sum(1 for b in panics if b["ttm"])
    phases = ", ".join(f"{phase} {count}" for phase, count in sorted(by_phase.items()))
    line = f"{name}: {len(panics)} of {len(boots)} boots panicked"
    if panics:
        line += f" ({phases}; ttm_bo_vm_open in {ttm})"
    if booted != len(boots):
        line += f"; {booted} reached sys.boot_completed"
    dumps = sum(b.get("sf_dumps", 0) for b in boots)
    if dumps:
        line += f"; {dumps} stack dumps of surfaceflinger survived"
    fixed = sum(1 for b in boots if "fixed" in b.get("ttm_ko", ""))
    if fixed:
        line += f"; ttm.ko fixed in {fixed}"
    return line


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--qemu", required=True)
    ap.add_argument("--argv-file", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--boots", type=int, default=3)
    ap.add_argument("--boot-timeout", type=float, default=900)
    ap.add_argument("--observe", type=float, default=200, help="seconds to watch a booted guest before provoking")
    ap.add_argument("--provoke", default="", help="comma separated: anr, debuggerd, nopanic")
    ap.add_argument("--anr-wait", type=float, default=90)
    ap.add_argument("--anr-dump-wait", type=float, default=45)
    ap.add_argument("--deadline", type=float, default=3000, help="start no new boot after this many seconds")
    ap.add_argument("--show-screen", type=int, default=1)
    ap.add_argument("--verbose", type=int, default=0)
    opts = ap.parse_args()
    opts.provoke = [s for s in opts.provoke.split(",") if s]
    for step in opts.provoke:
        if step not in ("anr", "debuggerd", "nopanic"):
            ap.error(f"unknown --provoke step {step}")

    snap = load_snapshot_module()
    os.makedirs(opts.work, exist_ok=True)
    with open(opts.argv_file, encoding="utf-8") as f:
        argv = [line.rstrip("\n") for line in f if line.rstrip("\n") != ""]
    started = time.monotonic()
    boots = []
    result = {"name": opts.name, "argv": argv, "provoke": opts.provoke, "observe": opts.observe, "boots": boots}
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
    print("RESULT " + json.dumps({k: v for k, v in result.items() if k != "argv"})[:60000], flush=True)
    print("SUMMARY " + result["summary"], flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
