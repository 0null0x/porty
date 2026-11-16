#!/usr/bin/env python3
"""Boot Android-x86 in a native QEMU (TCG) and save the running machine.

Used by .github/workflows/snapshot.yml.  The browser build of QEMU cannot
boot Android in a reasonable time, but it can resume a machine that a native
QEMU built from the same source saved with "migrate file:..." (QEMU-Wasm,
examples/migration/README.md).

  make-snapshot.py save    --qemu BIN --argv-file ARGS --work DIR --state FILE
  make-snapshot.py restore --qemu BIN --argv-file ARGS --work DIR --state FILE

ARGS holds the argument vector the web page would use, one argument per line
(tests/print-qemu-args.mjs).  Only what has to differ natively is changed:
"-serial mon:stdio" becomes a UNIX socket this script talks to (with a log
file), and a QMP socket is added.  Neither is a device, so neither is part
of the saved machine.

save:    boots, waits on the serial root shell for sys.boot_completed=1,
         keeps the screen on, lets the guest settle, drops the page cache,
         zeroes free memory, then migrates to FILE and quits.
restore: starts QEMU with "-incoming file:FILE" and checks that the guest
         answers on the serial console (a check of the stream, natively).

Both write DIR/result.json and exit 0 only on success.  Standard library
only; run with "python3 -I".
"""

import argparse
import base64
import json
import os
import re
import select
import shutil
import socket
import struct
import subprocess
import sys
import time
import zlib

PROMPT = re.compile(rb"(?:console|android|x86_64|generic[_a-z0-9]*):/ [#$] ")


def log(text):
    print(f"[{time.strftime('%H:%M:%S')}] {text}", flush=True)


def ppm_to_png(ppm_path, png_path):
    """Convert a binary PPM (P6, maxval 255) to PNG.  Returns stats."""
    with open(ppm_path, "rb") as f:
        data = f.read()
    magic, dims, maxval, pixels = data.split(b"\n", 3)
    if magic != b"P6" or maxval != b"255":
        raise ValueError("not a P6/255 PPM")
    width, height = map(int, dims.split())
    if len(pixels) < width * height * 3:
        raise ValueError("truncated PPM")
    row = width * 3
    raw = b"".join(b"\0" + pixels[y * row:(y + 1) * row] for y in range(height))

    def chunk(kind, body):
        return (struct.pack(">I", len(body)) + kind + body
                + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF))

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    with open(png_path, "wb") as f:
        f.write(png)
    # Every 7th pixel is plenty to tell a black screen from a home screen.
    lit = 0
    colours = set()
    total = 0
    for i in range(0, width * height * 3, 21):
        px = pixels[i:i + 3]
        total += 1
        if px[0] > 24 or px[1] > 24 or px[2] > 24:
            lit += 1
        if len(colours) < 4096:
            colours.add(px)
    return {"width": width, "height": height,
            "lit_percent": round(100.0 * lit / max(total, 1), 1),
            "sampled_colours": len(colours)}


class Qmp:
    def __init__(self, path, timeout=60):
        deadline = time.monotonic() + timeout
        while True:
            try:
                self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                self.sock.connect(path)
                break
            except OSError:
                self.sock.close()
                if time.monotonic() > deadline:
                    raise
                time.sleep(0.2)
        self.buf = b""
        self.events = []
        greeting = self._read(30)
        if "QMP" not in greeting:
            raise RuntimeError(f"unexpected QMP greeting: {greeting}")
        self.cmd("qmp_capabilities")

    def _read(self, timeout):
        deadline = time.monotonic() + timeout
        while b"\n" not in self.buf:
            left = deadline - time.monotonic()
            if left <= 0:
                raise TimeoutError("QMP did not answer")
            ready, _, _ = select.select([self.sock], [], [], left)
            if ready:
                data = self.sock.recv(65536)
                if not data:
                    raise ConnectionError("QMP socket closed")
                self.buf += data
        line, self.buf = self.buf.split(b"\n", 1)
        return json.loads(line)

    def cmd(self, name, args=None, timeout=120):
        msg = {"execute": name}
        if args is not None:
            msg["arguments"] = args
        self.sock.sendall(json.dumps(msg).encode() + b"\n")
        while True:
            reply = self._read(timeout)
            if "event" in reply:
                self.events.append(reply)
                continue
            if "error" in reply:
                raise RuntimeError(f"QMP {name}: {reply['error'].get('desc', reply['error'])}")
            return reply.get("return")

    def hmp(self, line, timeout=120):
        return self.cmd("human-monitor-command", {"command-line": line}, timeout)


class Machine:
    """A QEMU process with its serial console and QMP on UNIX sockets."""

    def __init__(self, qemu, argv, work, extra=()):
        self.work = work
        self.serial_path = os.path.join(work, "serial.sock")
        self.qmp_path = os.path.join(work, "qmp.sock")
        self.serial_log = os.path.join(work, "serial.log")
        self.fb_prefix = os.path.join(work, "fb")
        for stale in (self.serial_path, self.qmp_path, self.fb_prefix + ".ppm"):
            if os.path.exists(stale):
                os.unlink(stale)

        args = list(argv)
        hits = [i for i in range(len(args) - 1)
                if args[i] == "-serial" and args[i + 1] == "mon:stdio"]
        if len(hits) != 1:
            raise SystemExit("expected exactly one '-serial mon:stdio' in the page's argv")
        i = hits[0]
        args[i:i + 2] = [
            "-chardev", f"socket,id=porty-serial,path={self.serial_path},server=on,wait=off,"
                        f"logfile={self.serial_log},logappend=off",
            "-serial", "chardev:porty-serial",
        ]
        for i, arg in enumerate(args):
            if arg == "-accel" and "kvm" in args[i + 1]:
                raise SystemExit("refusing to use KVM: the browser resumes into TCG")
        args += ["-monitor", "none", "-qmp", f"unix:{self.qmp_path},server=on,wait=off"]
        args += list(extra)
        self.args = args

        env = dict(os.environ, PORTY_FB_DUMP=self.fb_prefix)
        self.qemu_log = open(os.path.join(work, "qemu.log"), "ab")
        self.qemu_log.write(("argv: " + json.dumps([qemu] + args) + "\n").encode())
        self.qemu_log.flush()
        self.started = time.monotonic()
        self.proc = subprocess.Popen([qemu] + args, stdin=subprocess.DEVNULL,
                                     stdout=self.qemu_log, stderr=subprocess.STDOUT, env=env)
        try:
            self.qmp = Qmp(self.qmp_path)
            self.serial = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.serial.connect(self.serial_path)
        except Exception:
            self.kill()
            raise
        self.out = b""          # everything the guest printed since the last trim
        self.total = 0
        self.counter = 0

    def elapsed(self):
        return time.monotonic() - self.started

    def alive(self):
        return self.proc.poll() is None

    def pump(self, timeout):
        """Collect serial output for up to `timeout` seconds; True if any came."""
        ready, _, _ = select.select([self.serial], [], [], max(0.0, timeout))
        if not ready:
            return False
        try:
            data = self.serial.recv(65536)
        except OSError:
            data = b""
        if not data:
            time.sleep(min(timeout, 0.5))
            return False
        self.out += data
        self.total += len(data)
        # (Kept whole: sh() remembers offsets into it.  A boot prints well
        # under a megabyte.)
        return True

    def wait_for(self, pattern, timeout, start=0):
        deadline = time.monotonic() + timeout
        while True:
            m = pattern.search(self.out, start)
            if m:
                return m
            left = deadline - time.monotonic()
            if left <= 0 or not self.alive():
                return None
            self.pump(min(left, 1.0))

    def sh(self, command, timeout=60):
        """Run a command in the guest's serial root shell.

        Returns (status, output) or (None, partial output) on timeout.  The
        output is what the guest prints between two markers.  The markers
        are written with an octal escape (\\137 is "_"), so the terminal's
        and the shell's echo of the typed line, which the shell's line
        editor redraws when it is long, never contains them.
        """
        self.counter += 1
        n = self.counter
        start = len(self.out)
        self.serial.sendall(f"printf 'PORTY\\137B{n}\\n'; {command}; printf 'PORTY\\137E{n}:%s\\n' $?\n".encode())
        begin = self.wait_for(re.compile(rb"PORTY_B%d\r?\n" % n), timeout, start)
        if not begin:
            return None, ""
        end = self.wait_for(re.compile(rb"PORTY_E%d:(\d+)" % n), timeout, begin.end())
        text = self.out[begin.end():(end.start() if end else len(self.out))].decode("utf-8", "replace")
        return (int(end.group(1)) if end else None), text.replace("\r", "").strip()

    def tail(self, lines=40):
        text = self.out[-8192:].decode("utf-8", "replace").replace("\r", "")
        return text.split("\n")[-lines:]

    def screenshot(self, name, show=False):
        """Save the guest's screen as <name>.png; show=True also prints it
        to the log as base64 between marker lines (the log is the one thing
        every reader of a run can get at)."""
        src = self.fb_prefix + ".ppm"
        if not os.path.exists(src):
            return None
        keep = os.path.join(self.work, name + ".ppm")
        png = os.path.join(self.work, name + ".png")
        try:
            shutil.copyfile(src, keep)
            stats = ppm_to_png(keep, png)
            os.unlink(keep)
            if show:
                with open(png, "rb") as f:
                    text = base64.b64encode(f.read()).decode()
                print(f"-----BEGIN PNG {name}-----", flush=True)
                for i in range(0, len(text), 16000):
                    print(text[i:i + 16000], flush=True)
                print(f"-----END PNG {name}-----", flush=True)
            return stats
        except (OSError, ValueError) as e:
            log(f"screenshot {name}: {e}")
            return None

    def quit(self):
        try:
            self.qmp.cmd("quit", timeout=30)
        except Exception:
            pass
        try:
            self.proc.wait(timeout=60)
        except subprocess.TimeoutExpired:
            self.kill()

    def kill(self):
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait()


def write_json(path, value):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(value, f, indent=2)
        f.write("\n")
    os.replace(tmp, path)


def progress(work, text):
    with open(os.path.join(work, "progress.txt.tmp"), "w", encoding="utf-8") as f:
        f.write(text + "\n")
    os.replace(os.path.join(work, "progress.txt.tmp"), os.path.join(work, "progress.txt"))


def cpu_info(vm):
    """The guest CPU's CPUID feature words as QEMU computed them."""
    info = {}
    try:
        cpus = vm.qmp.cmd("query-cpus-fast")
        path = cpus[0]["qom-path"]
        info["qom_path"] = path
        info["qom_type"] = cpus[0].get("qom-type")
        for prop in ("feature-words", "filtered-features", "model-id", "vendor",
                     "family", "model", "stepping", "level", "xlevel", "tsc-frequency"):
            try:
                info[prop] = vm.qmp.cmd("qom-get", {"path": path, "property": prop})
            except RuntimeError as e:
                info[prop] = f"error: {e}"
    except Exception as e:  # diagnostics only
        info["error"] = str(e)
    return info


def machine_info(vm):
    out = {}
    for name, line in (("version", "info version"), ("ramblock", "info ramblock"),
                       ("migrate_capabilities", "info migrate_capabilities"),
                       ("migrate_parameters", "info migrate_parameters"),
                       ("block", "info block"), ("roms", "info roms"),
                       ("qtree", "info qtree"), ("mtree", "info mtree -f"),
                       ("status", "info status"), ("kvm", "info kvm")):
        try:
            out[name] = vm.qmp.hmp(line).replace("\r", "")
        except Exception as e:  # diagnostics only
            out[name] = f"error: {e}"
    return out


def do_save(opts, argv):
    work = opts.work
    result = {"mode": "save", "booted": False, "saved": False, "runstate": opts.runstate,
              "milestones": {}, "argv_native": None}
    result_path = os.path.join(work, "result.json")
    vm = Machine(opts.qemu, argv, work)
    result["argv_native"] = vm.args
    write_json(result_path, result)
    log("QEMU started: " + " ".join(vm.args))
    try:
        result["machine"] = machine_info(vm)
        result["cpu"] = cpu_info(vm)
        with open(os.path.join(work, "machine-info.txt"), "w", encoding="utf-8") as f:
            for key, text in result["machine"].items():
                f.write(f"===== {key} =====\n{text}\n")
                if key not in ("qtree", "mtree"):
                    print(f"===== {key} =====\n{text}", flush=True)
        print("===== cpu =====\n" + json.dumps(result["cpu"]), flush=True)
        del result["machine"]["qtree"], result["machine"]["mtree"]

        marks = result["milestones"]
        watch = (("first_output", re.compile(rb".")),
                 ("kernel", re.compile(rb"Linux version")),
                 ("android_found", re.compile(rb"found at /dev/")),
                 ("shell", PROMPT))
        shell = False
        awake = False
        booted = None
        last_probe = 0.0
        last_report = 0.0
        last_shot = 0.0
        while vm.elapsed() < opts.boot_timeout:
            if not vm.alive():
                result["error"] = f"QEMU exited with status {vm.proc.returncode} during boot"
                break
            vm.pump(2.0)
            now = vm.elapsed()
            for key, pattern in watch:
                if key not in marks and pattern.search(vm.out):
                    marks[key] = round(now, 1)
                    log(f"milestone {key} at {now:.0f} s")
            shell = shell or "shell" in marks
            # Without a prompt after ten minutes, type anyway once a minute.
            due = (shell and now - last_probe >= 10) or (not shell and now > 600 and now - last_probe >= 60)
            if due:
                last_probe = now
                status, text = vm.sh("getprop sys.boot_completed", timeout=45)
                if status is not None:
                    shell = True
                    marks.setdefault("shell", round(now, 1))
                    if not awake:
                        # Android-x86 suspends the machine (ACPI S3) when the
                        # screen times out, one minute after boot.  A kernel
                        # wake lock prevents that from the first moment, and
                        # stays in the saved machine: nobody is there to
                        # press a power button in the browser.
                        awake = True
                        code, out = vm.sh("echo porty > /sys/power/wake_lock && cat /sys/power/wake_lock", 30)
                        result["wake_lock"] = out if code == 0 else f"[status {code}] {out}"
                        log(f"wake lock: {result['wake_lock']}")
                if status == 0 and text == "1":
                    booted = vm.elapsed()
                    break
            if now - last_shot >= 300:
                last_shot = now
                shot = vm.screenshot("screen-progress")
                marks_text = ", ".join(f"{k} {v:.0f}s" for k, v in marks.items()) or "nothing yet"
                log(f"{now / 60:.0f} min: {marks_text}; screen {shot}; serial {vm.total} bytes")
            if now - last_report >= 30:
                last_report = now
                stage = "shell up" if shell else ("kernel" if "kernel" in marks else "firmware")
                progress(work, f"booting, {now / 60:.0f} min, {stage}, serial {vm.total // 1024} KiB")
                write_json(result_path, result)

        if booted is None:
            result.setdefault("error", f"sys.boot_completed was not 1 after {vm.elapsed():.0f} s")
            result["elapsed_seconds"] = round(vm.elapsed(), 1)
            result["screen"] = vm.screenshot("screen-final", show=True)
            if shell and vm.alive():
                for name, command in (("logcat_tail", "logcat -d -t 80"),
                                      ("props", "getprop | grep -e boot -e init.svc | head -60"),
                                      ("ps", "ps -A | tail -40"), ("uptime", "uptime")):
                    result[name] = vm.sh(command, timeout=120)[1].split("\n")
            result["serial_tail"] = vm.tail(60)
            return result

        result["booted"] = True
        result["booted_seconds"] = round(booted, 1)
        marks["boot_completed"] = round(booted, 1)
        log(f"sys.boot_completed=1 after {booted:.0f} s")
        progress(work, f"booted in {booted / 60:.1f} min, settling")
        result["screen_booted"] = vm.screenshot("screen-booted", show=True)

        guest = result["guest"] = {}

        def run(key, command, timeout=120):
            status, text = vm.sh(command, timeout)
            guest[key] = text if status == 0 else f"[status {status}] {text}"
            log(f"guest {key}: {guest[key][:1500]}")
            return status, text

        # Keep the display on: a sleeping screen would be saved black, and
        # nobody is there to wake it in the browser.
        run("screen_timeout", "settings put system screen_off_timeout 2147483647")
        run("stay_on", "svc power stayon true")

        # A device that is not provisioned has no home screen: the launcher
        # is not allowed to start until the setup wizard has finished.  With
        # SETUPWIZARD=0 the wizard should finish by itself; if it has not
        # (the slim image's wizard crashes without Google's services), do
        # its job here, so that the saved machine shows a home screen.
        run("provisioned", "settings get global device_provisioned; settings get secure user_setup_complete", 180)
        run("setup_crash", "logcat -b crash -d | grep -m1 -A6 'Process: com.google.android.setupwizard' | cut -c1-200", 180)
        run("home_candidates", "cmd package query-activities --brief -a android.intent.action.MAIN"
                               " -c android.intent.category.HOME | grep /", 180)
        if opts.provision and guest["provisioned"].split() != ["1", "1"]:
            guest["provision_workaround"] = True
            run("provision_1", "settings put global device_provisioned 1; settings put secure user_setup_complete 1", 180)
            run("provision_2", "pm disable-user --user 0 com.google.android.setupwizard", 180)
            launcher = [line.strip() for line in guest["home_candidates"].split("\n")
                        if "launcher3" in line.lower()]
            if launcher:
                run("provision_3", f"cmd package set-home-activity {launcher[0]}", 180)
            run("provision_4", "am start -a android.intent.action.MAIN -c android.intent.category.HOME", 180)
        else:
            guest["provision_workaround"] = False

        settle_end = time.monotonic() + opts.settle
        while time.monotonic() < settle_end and vm.alive():
            vm.pump(2.0)
        # Wait a little longer while the guest is still busy (first-boot work).
        for _ in range(12):
            status, text = vm.sh("cat /proc/loadavg", 30)
            guest["loadavg"] = text
            try:
                if float(text.split()[0]) < opts.max_load:
                    break
            except (ValueError, IndexError):
                pass
            end = time.monotonic() + 30
            while time.monotonic() < end and vm.alive():
                vm.pump(2.0)
        log(f"guest load: {guest.get('loadavg')}")

        run("wake", "input keyevent 224", 180)
        end = time.monotonic() + 10
        while time.monotonic() < end and vm.alive():
            vm.pump(2.0)

        run("fingerprint", "getprop ro.build.fingerprint")
        run("boot_completed", "getprop sys.boot_completed")
        run("clocksource", "cat /sys/devices/system/clocksource/clocksource0/current_clocksource")
        run("clocksources", "cat /sys/devices/system/clocksource/clocksource0/available_clocksource")
        run("dmesg_tsc", "dmesg | grep -i -e tsc -e clocksource | head -20")
        run("cpu_model", "grep -m1 'model name' /proc/cpuinfo")
        run("cpu_mhz", "grep -m1 MHz /proc/cpuinfo")
        run("cpu_flags", "grep -m1 flags /proc/cpuinfo")
        run("cmdline", "cat /proc/cmdline")
        run("data_mount", "grep ' /data ' /proc/mounts")
        run("uptime", "cat /proc/uptime")
        run("date", "date -u '+%Y-%m-%dT%H:%M:%SZ'")
        run("focus", "dumpsys window windows | grep -e mCurrentFocus -e mFocusedApp", 180)
        run("crashes", "logcat -b crash -d -t 30 | cut -c1-220", 180)
        run("home", "cmd package resolve-activity --brief -c android.intent.category.HOME -a android.intent.action.MAIN", 180)
        run("provisioned_after", "settings get global device_provisioned; settings get secure user_setup_complete", 180)
        run("suspends", "dmesg | grep -c 'PM: suspend entry'; dmesg | grep 'PM: suspend' | tail -4", 60)
        run("zygote_crashes", "logcat -b crash -d | grep -c 'No region space mem map';"
                              " getprop init.svc.zygote; getprop init.svc.zygote_secondary; getprop ro.zygote", 180)
        for i, command in enumerate(opts.guest_command):
            run(f"extra_{i}", command, 600)
        if opts.guest_command:
            end = time.monotonic() + 20
            while time.monotonic() < end and vm.alive():
                vm.pump(2.0)
            run("focus_after_extra", "dumpsys window windows | grep -e mCurrentFocus -e mFocusedApp", 180)
        run("meminfo_before", "head -7 /proc/meminfo")

        run("sync", "sync; echo 3 > /proc/sys/vm/drop_caches", 300)
        status, text = run("memfree_kb", "grep MemFree /proc/meminfo")
        m = re.search(r"(\d+) kB", text)
        free_mb = int(m.group(1)) // 1024 if m else 0
        fill_mb = free_mb - opts.zero_reserve
        if opts.zero_free and fill_mb >= 16 and "tmpfs" in guest.get("data_mount", ""):
            # Freed memory keeps its old contents and would be saved as data.
            # Fill most of it with zeros through the tmpfs /data and free it
            # again: QEMU stores an all-zero page as a few bytes.
            run("zero_fill", f"dd if=/dev/zero of=/data/local/tmp/.porty-zero bs=1048576 count={fill_mb} 2>&1 | tail -1;"
                             " rm -f /data/local/tmp/.porty-zero; sync", 900)
            guest["zero_fill_mb"] = fill_mb
        else:
            guest["zero_fill_mb"] = 0
        run("meminfo_after", "head -7 /proc/meminfo")
        run("boot_completed_after", "getprop sys.boot_completed")
        end = time.monotonic() + opts.pause
        while time.monotonic() < end and vm.alive():
            vm.pump(1.0)

        result["screen"] = vm.screenshot("screen-final", show=True)
        log(f"screen: {result['screen']}")
        if not vm.alive():
            result["error"] = f"QEMU exited with status {vm.proc.returncode} before the save"
            return result

        # --- save ---------------------------------------------------------
        progress(work, f"booted in {booted / 60:.1f} min, saving")
        if os.path.exists(opts.state):
            os.unlink(opts.state)
        # No rate limit, and a switch-over threshold large enough that QEMU
        # stops the guest and writes everything once instead of iterating
        # while the guest keeps dirtying pages.
        vm.qmp.cmd("migrate-set-parameters", {"max-bandwidth": 1 << 40, "downtime-limit": 2000000})
        if opts.runstate == "paused":
            vm.qmp.cmd("stop")
        result["status_before"] = vm.qmp.cmd("query-status")
        t0 = time.monotonic()
        vm.qmp.cmd("migrate", {"uri": "file:" + opts.state})
        info = {}
        while time.monotonic() - t0 < opts.save_timeout:
            info = vm.qmp.cmd("query-migrate")
            if info.get("status") in ("completed", "failed", "cancelled"):
                break
            if not vm.alive():
                break
            vm.pump(0.5)
        result["migrate"] = info
        result["migrate_seconds"] = round(time.monotonic() - t0, 1)
        try:
            result["status_after"] = vm.qmp.cmd("query-status")
            result["migrate_hmp"] = vm.qmp.hmp("info migrate").replace("\r", "")
        except Exception as e:  # diagnostics only
            result["status_after"] = str(e)
        if info.get("status") != "completed":
            result["error"] = f"migration ended as {info.get('status')}: {info.get('error-desc', '')}"
            return result
        result["saved"] = True
        result["state_bytes"] = os.path.getsize(opts.state)
        log(f"saved {result['state_bytes']} bytes in {result['migrate_seconds']} s")
        return result
    except Exception as e:
        result["error"] = f"{type(e).__name__}: {e}"
        result["serial_tail"] = vm.tail(60)
        return result
    finally:
        result.setdefault("elapsed_seconds", round(vm.elapsed(), 1))
        vm.quit()
        result["qemu_exit"] = vm.proc.returncode
        write_json(result_path, result)


def do_restore(opts, argv):
    work = opts.work
    result = {"mode": "restore", "restored": False}
    result_path = os.path.join(work, "result.json")
    vm = Machine(opts.qemu, argv, work, extra=["-incoming", "file:" + opts.state])
    try:
        status = {}
        t0 = time.monotonic()
        while time.monotonic() - t0 < opts.save_timeout and vm.alive():
            status = vm.qmp.cmd("query-status")
            if status.get("status") != "inmigrate":
                break
            vm.pump(0.5)
        result["load_seconds"] = round(time.monotonic() - t0, 1)
        result["status"] = status
        try:
            result["migrate"] = vm.qmp.cmd("query-migrate")
        except Exception as e:  # diagnostics only
            result["migrate"] = str(e)
        log(f"after load: {status}")
        if not vm.alive():
            result["error"] = f"QEMU exited with status {vm.proc.returncode} while loading"
            return result
        if status.get("status") == "paused":
            vm.qmp.cmd("cont")
            result["needed_cont"] = True
        elif status.get("status") != "running":
            result["error"] = f"unexpected run state after load: {status}"
            return result
        answers = {}
        for key, command in (("boot_completed", "getprop sys.boot_completed"),
                             ("uptime", "cat /proc/uptime"),
                             ("clocksource", "cat /sys/devices/system/clocksource/clocksource0/current_clocksource"),
                             ("focus", "dumpsys window windows | grep -e mCurrentFocus"),
                             ("date", "date -u '+%Y-%m-%dT%H:%M:%SZ'")):
            code, text = vm.sh(command, 240)
            answers[key] = text if code == 0 else f"[status {code}] {text}"
            log(f"guest {key}: {answers[key][:200]}")
        result["guest"] = answers
        # A key press makes the guest redraw, so there is a frame to dump.
        vm.sh("input keyevent 224", 180)
        end = time.monotonic() + 8
        while time.monotonic() < end and vm.alive():
            vm.pump(1.0)
        result["screen"] = vm.screenshot("screen-restored", show=True)
        result["restored"] = answers.get("boot_completed") == "1" and vm.alive()
        if not result["restored"]:
            result["error"] = "the restored guest did not answer on the serial console"
            result["serial_tail"] = vm.tail(40)
        return result
    except Exception as e:
        result["error"] = f"{type(e).__name__}: {e}"
        return result
    finally:
        vm.quit()
        result["qemu_exit"] = vm.proc.returncode
        write_json(result_path, result)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("mode", choices=("save", "restore"))
    ap.add_argument("--qemu", required=True)
    ap.add_argument("--argv-file", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--state", required=True)
    ap.add_argument("--boot-timeout", type=float, default=9000, help="seconds to wait for sys.boot_completed")
    ap.add_argument("--settle", type=float, default=90, help="seconds to let the guest settle after boot")
    ap.add_argument("--max-load", type=float, default=1.5, help="wait (up to 6 min more) for the load average to fall below this")
    ap.add_argument("--pause", type=float, default=8, help="seconds between the last guest command and the save")
    ap.add_argument("--save-timeout", type=float, default=1200)
    ap.add_argument("--runstate", choices=("running", "paused"), default="running",
                    help="running: the resumed guest starts by itself; paused: it waits for 'cont'")
    ap.add_argument("--zero-free", type=int, default=1, help="1: zero the guest's free memory before saving")
    ap.add_argument("--provision", type=int, default=1,
                    help="1: if Android's setup wizard did not finish, mark the device provisioned and start the launcher")
    ap.add_argument("--guest-command", action="append", default=[],
                    help="extra shell command to run in the guest before the save (repeatable)")
    ap.add_argument("--zero-reserve", type=int, default=96, help="MiB of free memory to leave alone")
    opts = ap.parse_args()

    os.makedirs(opts.work, exist_ok=True)
    opts.work = os.path.abspath(opts.work)
    opts.state = os.path.abspath(opts.state)
    if "," in opts.state or "," in opts.work:
        raise SystemExit("paths must not contain commas")
    with open(opts.argv_file, encoding="utf-8") as f:
        argv = [line.rstrip("\n") for line in f if line.rstrip("\n") != ""]

    result = do_save(opts, argv) if opts.mode == "save" else do_restore(opts, argv)
    ok = result.get("saved") if opts.mode == "save" else result.get("restored")
    summary = {k: v for k, v in result.items() if k not in ("machine", "cpu", "argv_native")}
    log("result: " + json.dumps(summary)[:6000])
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
