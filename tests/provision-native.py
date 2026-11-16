#!/usr/bin/env python3
"""Boot Android-x86 in a native QEMU and check that it ends on the home screen.

Used by .github/workflows/provisioning.yml.  Starts the argument vector the
web page would use (tests/print-qemu-args.mjs, with the page's initrd from
tests/apply-boot-diet.mjs), waits on the serial root shell for
sys.boot_completed=1, lets the guest settle, and then checks what a first
boot must look like:

  - settings: global device_provisioned = 1, secure user_setup_complete = 1;
  - the focused window belongs to the launcher;
  - no crash of a setup wizard (crash buffer, "keeps stopping" dialogs);
  - the screen is not black.

Nothing is typed into the guest before those checks except "getprop
sys.boot_completed" and the kernel wake lock (Android-x86 suspends the
machine when the screen times out), so what is checked is what a boot in
the browser does by itself.

Writes <work>/result.json, prints the screen as base64 PNG, and exits 0 only
if every check passed.  QEMU, the serial console and the screenshot come
from scripts/snapshot/make-snapshot.py.  Standard library only; run with
"python3 -I".
"""

import argparse
import importlib.util
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))


def load_snapshot_module():
    path = os.path.join(HERE, "..", "scripts", "snapshot", "make-snapshot.py")
    spec = importlib.util.spec_from_file_location("porty_make_snapshot", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


snap = load_snapshot_module()
log = snap.log

# What the log should show about the guest, whatever the verdict.  Read-only.
FACTS = (
    ("home_candidates", "cmd package query-activities -a android.intent.action.MAIN -c android.intent.category.HOME"
                        " | grep -e priority= -e ' name=' -e packageName= -e enabled= | cut -c1-160"),
    ("home_resolved", "cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME"),
    ("preferred", "dumpsys package preferred-xml | cut -c1-200 | head -40"),
    ("porty_log", "logcat -d -v time -s porty:* | cut -c1-240 | tail -30"),
    ("porty_dmesg", "dmesg | grep -i -e porty | cut -c1-240 | tail -20"),
    ("init_svc", "getprop | grep -e porty -e setupwizard -e sys.boot_completed"),
    ("setupwizard_package", "pm list packages -f | grep -i -e setupwizard -e provision -e launcher -e taskbar -e tscal"),
    ("crash_processes", "logcat -b crash -d | grep -e 'Process: ' -e '>>> ' | cut -c1-200 | sort -k5 | uniq -c -f4 | head -20"),
    ("am_crashes", "logcat -b events -d | grep -e am_crash -e am_anr | cut -c1-240 | head -20"),
    ("activity_starts", "logcat -b events -d | grep -e am_create_activity -e am_finish_activity -e boot_progress | cut -c1-200 | head -40"),
    ("uptime", "cat /proc/uptime; cat /proc/loadavg"),
)


def wait(vm, seconds):
    end = time.monotonic() + seconds
    while time.monotonic() < end and vm.alive():
        vm.pump(2.0)


def boot(vm, opts, result):
    """Wait for sys.boot_completed=1; returns seconds since QEMU started or None."""
    marks = result["milestones"]
    last_probe = 0.0
    last_report = 0.0
    awake = False
    while vm.elapsed() < opts.boot_timeout:
        if not vm.alive():
            result["error"] = f"QEMU exited with status {vm.proc.returncode} during boot"
            return None
        vm.pump(2.0)
        now = vm.elapsed()
        if "kernel" not in marks and b"Linux version" in vm.out:
            marks["kernel"] = round(now, 1)
        if "shell" not in marks and snap.PROMPT.search(vm.out):
            marks["shell"] = round(now, 1)
            log(f"root shell at {now:.0f} s")
        shell = "shell" in marks
        if (shell and now - last_probe >= 5) or (not shell and now > 600 and now - last_probe >= 60):
            last_probe = now
            status, text = vm.sh("getprop sys.boot_completed", timeout=45)
            if status is not None:
                marks.setdefault("shell", round(now, 1))
                if vm.rearm:
                    vm.rearm = False
                    awake = False
                if not awake:
                    awake = True
                    if opts.wake_lock:
                        vm.sh("echo porty > /sys/power/wake_lock", 30)
                    if opts.trace:
                        # Diagnosis: kernel messages and Android's own account of
                        # crashes and shutdowns on the serial console.
                        vm.sh("echo 7 > /proc/sys/kernel/printk; (logcat -b all -v time -s RescueParty:* "
                              "ShutdownThread:* PowerManagerService:W AndroidRuntime:E init:* Zygote:* "
                              "SystemServer:E ActivityManager:W BootReceiver:* Watchdog:* DEBUG:F porty:* "
                              "PackageManager:W > /dev/kmsg 2>&1 &)", 30)
            if status == 0 and "1" in [line.strip() for line in text.split("\n")]:
                return vm.elapsed()
        if now - last_report >= 60:
            last_report = now
            log(f"{now / 60:.0f} min: {marks}; serial {vm.total} bytes; reboots {vm.reboots}")
            snap.progress(opts.work, f"booting, {now / 60:.0f} min, serial {vm.total // 1024} KiB")
    result["error"] = f"sys.boot_completed was not 1 after {vm.elapsed():.0f} s"
    return None


def run_checks(vm, opts, result):
    guest = result["guest"] = {}
    checks = result["checks"] = {}

    def run(key, command, timeout=180):
        status, text = vm.sh(command, timeout)
        guest[key] = text if status == 0 else f"[status {status}] {text}"
        log(f"guest {key}: {guest[key][:3000]}")
        return guest[key]

    def check(name, ok, detail):
        checks[name] = {"ok": bool(ok), "detail": str(detail)[:300]}
        log(f"{'PASS' if ok else 'FAIL'}  {name}: {str(detail)[:300]}")

    provisioned = run("device_provisioned", "settings get global device_provisioned").strip()
    setup = run("user_setup_complete", "settings get secure user_setup_complete").strip()
    check("device_provisioned", provisioned == "1", f"settings get global device_provisioned = {provisioned!r}")
    check("user_setup_complete", setup == "1", f"settings get secure user_setup_complete = {setup!r}")

    focus = run("focus", "dumpsys window | grep -e mCurrentFocus -e mFocusedApp")
    current = next((line.strip() for line in focus.split("\n") if "mCurrentFocus" in line), "")
    check("launcher_focused", "launcher" in current.lower(), current or "no mCurrentFocus line")

    # The crash buffer holds every Java crash ("Process: <name>, PID") and
    # native one (">>> <name> <<<") of this boot; the main and system
    # buffers hold ActivityManager's side of a crash dialog.
    wizard = run("wizard_crash", "logcat -b crash -d | grep -i -B4 -A24 -m1 -e 'Process: .*setupwizard' -e 'Process: .*provision'"
                                 " | cut -c1-260")
    stopping = run("keeps_stopping", "logcat -b all -d | grep -i -e 'keeps stopping' -e 'has stopped'"
                                     " -e 'FATAL EXCEPTION' -e 'Force finishing activity' -e 'Showing crash dialog'"
                                     " | cut -c1-240 | head -20")
    wizard_lines = [line for line in (wizard + "\n" + stopping).split("\n")
                    if "setupwizard" in line.lower() or "keeps stopping" in line.lower()]
    check("no_wizard_crash", not wizard_lines and not wizard.startswith("[status None]")
          and not stopping.startswith("[status None]"),
          wizard_lines[0] if wizard_lines else "nothing about a setup wizard in the crash buffer, no crash dialog")
    java_crashes = run("fatal_exceptions", "logcat -b crash -d | grep -c 'FATAL EXCEPTION'").strip()
    check("no_app_crash", java_crashes == "0", f"{java_crashes} FATAL EXCEPTION line(s) in the crash buffer")

    for key, command in FACTS:
        run(key, command)

    shot = result["screen"] = vm.screenshot("screen-final", show=True)
    log(f"screen: {shot}")
    check("screen_not_black", bool(shot) and shot["lit_percent"] >= opts.min_lit and shot["sampled_colours"] >= 64,
          f"{shot}; needs {opts.min_lit}% of the pixels lit and 64 colours")

    for i, command in enumerate(opts.guest_command):
        run(f"extra_{i}", command, 600)
    if opts.idle > 0:
        wait(vm, opts.idle)
        idle = result["screen_idle"] = vm.screenshot("screen-idle", show=True)
        log(f"screen after {opts.idle:.0f} s without input: {idle}")
        run("power", "dumpsys power | grep -e mWakefulness= -e mScreenOffTimeoutSetting -e mStayOn -e 'mIsPowered'"
                     "; settings get system screen_off_timeout; dmesg | grep -c 'PM: suspend entry'")
        run("focus_idle", "dumpsys window | grep -e mCurrentFocus -e mFocusedApp")
    return all(c["ok"] for c in checks.values())


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--qemu", required=True)
    ap.add_argument("--argv-file", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--boot-timeout", type=float, default=1800, help="seconds to wait for sys.boot_completed")
    ap.add_argument("--settle", type=float, default=60, help="seconds between sys.boot_completed=1 and the checks")
    ap.add_argument("--wake-lock", type=int, default=1,
                    help="1: take a kernel wake lock as soon as the shell answers, so the machine cannot suspend")
    ap.add_argument("--trace", type=int, default=0,
                    help="1: kernel messages and Android's crash and shutdown messages on the serial console")
    ap.add_argument("--idle", type=float, default=0,
                    help="seconds to leave the guest alone after the checks, then look at the screen again")
    ap.add_argument("--min-lit", type=float, default=20.0, help="percent of the screen that must not be black")
    ap.add_argument("--guest-command", action="append", default=[],
                    help="extra shell command to run in the guest after the checks (repeatable)")
    opts = ap.parse_args()

    os.makedirs(opts.work, exist_ok=True)
    opts.work = os.path.abspath(opts.work)
    with open(opts.argv_file, encoding="utf-8") as f:
        argv = [line.rstrip("\n") for line in f if line.rstrip("\n") != ""]

    result = {"mode": "provisioning", "booted": False, "passed": False, "milestones": {}}
    result_path = os.path.join(opts.work, "result.json")
    vm = snap.Machine(opts.qemu, argv, opts.work)
    log("QEMU started: " + " ".join(vm.args))
    try:
        booted = boot(vm, opts, result)
        result["reboots"] = list(vm.reboots)
        if booted is None:
            result["screen"] = vm.screenshot("screen-final", show=True)
            result["serial_tail"] = vm.tail(60)
            for line in result["serial_tail"]:
                print("    | " + line[:300], flush=True)
        else:
            result["booted"] = True
            result["booted_seconds"] = round(booted - vm.boot_started, 1)
            log(f"sys.boot_completed=1 after {result['booted_seconds']:.0f} s ({len(vm.reboots)} reboots before)")
            result["screen_booted"] = vm.screenshot("screen-booted")
            log(f"screen at sys.boot_completed: {result['screen_booted']}")
            snap.progress(opts.work, f"booted in {result['booted_seconds'] / 60:.1f} min, settling")
            wait(vm, opts.settle)
            result["passed"] = run_checks(vm, opts, result)
            result["reboots"] = list(vm.reboots)
    except Exception as e:  # the verdict must always be written
        result["error"] = f"{type(e).__name__}: {e}"
        log(f"error: {result['error']}")
    finally:
        vm.quit()
        snap.write_json(result_path, result)
    failed = [name for name, c in result.get("checks", {}).items() if not c["ok"]]
    log("result: " + json.dumps({k: v for k, v in result.items() if k != "guest"})[:4000])
    if result["passed"]:
        log("provisioning: all checks passed")
    else:
        log("provisioning: FAILED: " + (", ".join(failed) or result.get("error", "no result")))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
