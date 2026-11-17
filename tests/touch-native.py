#!/usr/bin/env python3
"""Boot Android-x86 in a native QEMU with the page's touchscreen and check
that Android treats it as one.

Used by .github/workflows/touch-native.yml.  Starts the argument vector the
web page would use (tests/print-qemu-args.mjs, the page's initrd), lets the
guest settle as scripts/snapshot/make-snapshot.py does before it saves, and
then:

  - facts: the kernel's input devices and drivers, "getevent -lp" and
    "dumpsys input" (how Android classified each device and, for a touch
    screen, its display mapping);
  - raw events: "getevent -lt" on the touch screen while two fingers touch,
    move and lift (do ABS_MT_SLOT events reach user space, which needs the
    kernel's multitouch slots?), and "dumpsys input" while both are down
    (InputReader's last raw and cooked touch: how many pointers, where);
  - a finger tap on the Gallery icon of the home screen: Gallery opens;
  - finger swipes on Settings: it scrolls (how far, from the screenshots
    before and after: the vertical shift that lines them up);
  - on a long list (Developer options): a slow drag that rests before the
    finger lifts, with and without the page's resting reports (web/js/
    input.js, KEEP_MS), and a quick swipe: how far the list went;
  - no mouse pointer: SurfaceFlinger has no pointer sprite layer;
  - a two-finger spread on a picture in Gallery: it zooms.

Touches go in as the page sends them: with --inject fifo through the input
ring of ui/wasmfb.c (patch 0020; PORTY_INPUT_FIFO of the native build takes
"type:a:b:c" lines), with --inject qmp as QMP "mtt" events, the way QEMU's
own GTK display sends them (console_handle_touch_event).  With --pointer
(the page's touch=0) the same gestures go to the USB tablet as before.

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


gcpu = load("porty_guest_cpu_native", "guest-cpu-native.py")
prov = gcpu.prov
snap = gcpu.snap
log = snap.log

ABS_MAX = 0x7FFF
SLOTS = 10

# The ring's event types (ui/wasmfb.c, patches 0001 and 0020; web/js/input.js).
EV_ABS, EV_BTN = 1, 2
EV_TOUCH_DOWN, EV_TOUCH_MOVE, EV_TOUCH_UP = 5, 6, 7

FACTS = (
    ("kernel", "uname -a"),
    ("config", "zcat /proc/config.gz 2>/dev/null | grep -E 'VIRTIO|INPUT_MT|INPUT_EVDEV|HID_MULTITOUCH|USB_HID|INPUT_TOUCHSCREEN=' "
               "| head -40 || echo no /proc/config.gz"),
    ("virtio_drivers", "ls /sys/bus/virtio/drivers/ 2>&1 | tr '\\n' ' '; echo; for d in /sys/bus/virtio/devices/*; do "
                       "echo $d $(cat $d/device 2>/dev/null) $(readlink $d/driver | sed 's|.*/||'); done"),
    ("modules", "lsmod 2>/dev/null | grep -i -E 'virtio|input|hid|evdev' | head -20; "
                "ls /system/lib/modules/*/kernel/drivers/virtio/ 2>&1 | head; "
                "grep -c input_mt_init_slots /system/lib/modules/*/kernel/drivers/virtio/virtio_input.ko 2>&1; "
                "grep -E 'virtio_input|virtio-input' /system/lib/modules/*/modules.builtin 2>&1 | head -3"),
    ("kallsyms", "grep -E ' (virtinput_[a-z_]+|input_mt_init_slots)$' /proc/kallsyms | cut -c18- | head -20"),
    ("proc_devices", "cat /proc/bus/input/devices"),
    ("getevent_p", "getevent -lp 2>&1 | head -150"),
    ("dumpsys_input", "dumpsys input 2>&1 | head -260 | cut -c1-170"),
    ("idc", "ls /system/usr/idc /vendor/usr/idc /data/system/devices/idc 2>&1 | head -30"),
)


class Touch:
    """Fingers on the guest's screen, in the page's tablet coordinates (0..0x7fff)."""

    def __init__(self, vm, inject, fifo=None):
        self.vm = vm
        self.inject = inject
        self.fifo = fifo
        self.slots = [None] * SLOTS  # QMP mode: (tracking id, x, y) per active slot
        self.sent = 0
        self.last = None

    def _ring(self, *event):
        self.fifo.write(":".join(str(int(v)) for v in event) + "\n")
        self.fifo.flush()
        self.sent += 1

    def _qmp_frame(self, slot, kind):
        """console_handle_touch_event() of ui/console.c: every active slot, then a sync."""
        events = []
        for i in range(SLOTS):
            s = self.slots[i]
            if s is None:
                continue
            update = kind if i == slot else "update"
            if update == "end":
                events.append({"type": "mtt", "data": {"type": "end", "slot": i, "tracking-id": -1, "axis": "x", "value": 0}})
                self.slots[i] = None
                continue
            tid, x, y = s
            events += [
                {"type": "mtt", "data": {"type": update, "slot": i, "tracking-id": tid, "axis": "x", "value": 0}},
                {"type": "btn", "data": {"down": True, "button": "touch"}},
                {"type": "mtt", "data": {"type": "data", "slot": i, "tracking-id": tid, "axis": "x", "value": x}},
                {"type": "mtt", "data": {"type": "data", "slot": i, "tracking-id": tid, "axis": "y", "value": y}},
            ]
        if events:
            self.vm.qmp.cmd("input-send-event", {"events": events})
            self.sent += 1

    def down(self, slot, x, y):
        if self.inject == "fifo":
            self._ring(EV_TOUCH_DOWN, slot, x, y)
        elif self.inject == "pointer":
            self.vm.qmp.cmd("input-send-event", {"events": gcpu.abs_at(x / ABS_MAX, y / ABS_MAX)})
            self.vm.qmp.cmd("input-send-event", {"events": [{"type": "btn", "data": {"down": True, "button": "left"}}]})
        else:
            self.slots[slot] = (slot, x, y)
            self._qmp_frame(slot, "begin")

    def move(self, slot, x, y):
        if self.inject == "fifo":
            self._ring(EV_TOUCH_MOVE, slot, x, y)
        elif self.inject == "pointer":
            self.vm.qmp.cmd("input-send-event", {"events": gcpu.abs_at(x / ABS_MAX, y / ABS_MAX)})
        elif self.slots[slot] is not None:
            self.slots[slot] = (self.slots[slot][0], x, y)
            self._qmp_frame(slot, "update")

    def up(self, slot, x=None, y=None):
        if self.inject == "fifo":
            self._ring(EV_TOUCH_UP, slot, x or 0, y or 0)
        elif self.inject == "pointer":
            self.vm.qmp.cmd("input-send-event", {"events": [{"type": "btn", "data": {"down": False, "button": "left"}}]})
        elif self.slots[slot] is not None:
            self._qmp_frame(slot, "end")

    # gestures, in fractions of the screen
    @staticmethod
    def at(fx, fy):
        return max(0, min(ABS_MAX, round(fx * ABS_MAX))), max(0, min(ABS_MAX, round(fy * ABS_MAX)))

    def rest(self, slot, seconds, keep=True, every=0.1):
        """A finger rests; keep=True reports it now and then, to and fro by one
        unit, as the page does (web/js/input.js, keepReporting())."""
        end = time.monotonic() + seconds
        jitter = 0
        while time.monotonic() < end:
            time.sleep(every)
            if keep and self.inject in ("fifo", "qmp") and self.last is not None:
                jitter ^= 1
                x, y = self.last
                self.move(slot, x + jitter if x < ABS_MAX else x - jitter, y)

    def drag(self, fx0, fy0, fx1, fy1, steps=10, pause=0.25, rest=0.0, keep=True):
        """Down, moves, then optionally a rest before the lift."""
        x, y = self.at(fx0, fy0)
        self.down(0, x, y)
        for i in range(1, steps + 1):
            time.sleep(pause)
            x, y = self.at(fx0 + (fx1 - fx0) * i / steps, fy0 + (fy1 - fy0) * i / steps)
            self.move(0, x, y)
        self.last = (x, y)
        if rest:
            self.rest(0, rest, keep)
        self.up(0, x, y)

    def tap(self, fx, fy, hold=0.08):
        x, y = self.at(fx, fy)
        self.down(0, x, y)
        time.sleep(hold)
        self.up(0, x, y)

    def swipe(self, fx0, fy0, fx1, fy1, steps=12, pause=0.05):
        x, y = self.at(fx0, fy0)
        self.down(0, x, y)
        for i in range(1, steps + 1):
            time.sleep(pause)
            x, y = self.at(fx0 + (fx1 - fx0) * i / steps, fy0 + (fy1 - fy0) * i / steps)
            self.move(0, x, y)
        time.sleep(pause)
        self.up(0, x, y)

    def two(self, a0, b0, a1, b1, steps=8, pause=0.1, hold=None):
        """Two fingers from a0, b0 to a1, b1 (each (fx, fy)); hold(): called while both are down."""
        (ax, ay), (bx, by) = self.at(*a0), self.at(*b0)
        self.down(0, ax, ay)
        time.sleep(pause)
        self.down(1, bx, by)
        for i in range(1, steps + 1):
            time.sleep(pause)
            f = i / steps
            ax, ay = self.at(a0[0] + (a1[0] - a0[0]) * f, a0[1] + (a1[1] - a0[1]) * f)
            bx, by = self.at(b0[0] + (b1[0] - b0[0]) * f, b0[1] + (b1[1] - b0[1]) * f)
            self.move(0, ax, ay)
            self.move(1, bx, by)
        held = hold() if hold else None
        time.sleep(pause)
        self.up(1, bx, by)
        time.sleep(pause)
        self.up(0, ax, ay)
        return held


def ppm_rows(data):
    """Per-row signatures of a P6 PPM: the green channel summed over the middle columns."""
    head = data.split(b"\n", 3)
    width, height = map(int, head[1].split())
    pixels = head[3]
    rows = []
    for y in range(height):
        row = pixels[y * width * 3:(y + 1) * width * 3]
        rows.append(sum(row[x * 3 + 1] for x in range(24, width - 24, 3)))
    return rows


def vshift(a, b, top=90, bottom=740, limit=640):
    """How far the content moved up from screenshot a to b, in pixels, from
    the shift that lines up their rows best: (shift, error, error unshifted),
    or (None, ...) when no shift of up to `limit` lines them up (moved farther)."""
    if not a or not b:
        return None, -1, -1
    ra, rb = ppm_rows(a), ppm_rows(b)

    def err(s):
        lo, hi = max(top, top - s), min(bottom, bottom - s)
        if hi - lo < 100:
            return None
        return sum(abs(rb[y] - ra[y + s]) for y in range(lo, hi)) / (hi - lo)
    e0 = err(0)
    best, best_err = None, None
    for s in range(-limit, limit + 1):
        e = err(s)
        if e is not None and (best_err is None or e < best_err):
            best, best_err = s, e
    # A match must be close: much better than no shift, and small.
    if best_err is None or (best != 0 and best_err > 0.25 * max(e0, 1)) or best_err > 400:
        return None, round(best_err or -1, 1), round(e0 or -1, 1)
    return best, round(best_err, 1), round(e0, 1)


def shot_pair(vm, g, name):
    prov.wait(vm, 3)
    g.quiet(timeout=120)
    _, data = gcpu.screen_diff(vm, name, None)
    vm.screenshot(f"touch-{name}", show=True)
    return data


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--qemu", required=True)
    ap.add_argument("--argv-file", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--inject", choices=("fifo", "qmp", "pointer"), default="fifo")
    ap.add_argument("--cpu", default="")
    ap.add_argument("--query", default="")
    ap.add_argument("--boot-timeout", type=float, default=2400)
    ap.add_argument("--settle", type=float, default=150)
    ap.add_argument("--max-load", type=float, default=1.5)
    ap.add_argument("--timescale", type=int, default=8, help="the page's time dilation, set through gdb (1: none)")
    ap.add_argument("--launch-timeout", type=float, default=150)
    opts = ap.parse_args()
    opts.wake_lock = 1
    opts.trace = 0
    os.makedirs(opts.work, exist_ok=True)
    opts.work = os.path.abspath(opts.work)
    with open(opts.argv_file, encoding="utf-8") as f:
        argv = [line.rstrip("\n") for line in f if line.rstrip("\n") != ""]

    fifo_path = None
    if opts.inject == "fifo":
        fifo_path = os.path.join(opts.work, "input.fifo")
        if os.path.exists(fifo_path):
            os.unlink(fifo_path)
        os.mkfifo(fifo_path)
        os.environ["PORTY_INPUT_FIFO"] = fifo_path

    result = {"mode": "touch", "inject": opts.inject, "cpu": opts.cpu, "query": opts.query, "booted": False,
              "milestones": {}, "guest": {}, "checks": {}}
    vm = snap.Machine(opts.qemu, argv, opts.work)
    log("QEMU started: " + " ".join(vm.args))
    if opts.timescale > 1:
        result["timescale"] = gcpu.set_time_scale(vm, opts.timescale)
    g = gcpu.Guest(vm, "")
    fifo = None

    def run(key, command, timeout=240):
        status, text = vm.sh(command, timeout)
        result["guest"][key] = text if status == 0 else f"[status {status}] {text}"
        log(f"guest {key}:\n{result['guest'][key][:12000]}")
        return result["guest"][key]

    def check(name, ok, detail):
        result["checks"][name] = {"ok": bool(ok), "detail": str(detail)[:400]}
        log(f"{'PASS' if ok else 'FAIL'}  {name}: {str(detail)[:400]}")

    try:
        if fifo_path:
            # QEMU opened its end at start-up (O_RDWR), so this does not block.
            fifo = open(fifo_path, "w", encoding="ascii")
        touch = Touch(vm, opts.inject, fifo)
        booted = prov.boot(vm, opts, result)
        result["reboots"] = list(vm.reboots)
        if booted is None:
            result["serial_tail"] = vm.tail(60)
            for line in result["serial_tail"]:
                print("    | " + line[:300], flush=True)
            return 0
        result["booted"] = True
        result["booted_seconds"] = round(booted - vm.boot_started, 1)
        log(f"sys.boot_completed=1 after {result['booted_seconds']:.0f} s")
        gcpu.settle(vm, opts, result)
        run("screen_on", "settings put system screen_off_timeout 2147483647; svc power stayon true")
        run("shell", "renice -n -20 -p $$; logcat -b events -v epoch > /data/local/tmp/porty-ev.txt 2>&1 & echo started")
        for key, command in FACTS:
            run(key, command)
        guest = result["guest"]

        # --- what Android made of the devices --------------------------------
        din = guest.get("dumpsys_input", "")
        # Event Hub State: "    3: QEMU Virtio MultiTouch\n      Classes: 0x00000014"
        devices = re.findall(r"\n\s+-?\d+: ([^\n]+)\n\s+Classes: (0x[0-9a-f]+)", din)
        result["devices"] = devices
        if opts.inject != "pointer":
            touch_dev = [(n, c) for n, c in devices if "MultiTouch" in n]
            # 0x04 touch, 0x10 multitouch; not 0x08 cursor, not 0x80000000 external
            check("touchscreen_classes", touch_dev and int(touch_dev[0][1], 16) & 0x14 == 0x14
                  and not int(touch_dev[0][1], 16) & 0x80000008,
                  "; ".join(f"{n}: {c}" for n, c in devices))
            check("touchscreen_abs_mt", "ABS_MT_POSITION_X" in guest.get("getevent_p", "") and "ABS_MT_POSITION_Y" in guest.get("getevent_p", ""),
                  "getevent -lp lists ABS_MT_POSITION_X/Y" if "ABS_MT_POSITION_X" in guest.get("getevent_p", "") else "no ABS_MT_POSITION_X")
        reader = run("input_reader", "dumpsys input | sed -n '/Input Reader State/,/Input Dispatcher State/p' | "
                                     "grep -E 'Device [0-9]+:|Classes|Mapper|Mode|DeviceType|AssociatedDisplay|Viewport|"
                                     "logicalFrame|physicalFrame|deviceSize|SurfaceWidth|SurfaceHeight|XScale|YScale|"
                                     "Raw Touch Axes|X: min|Y: min|Slot|TrackingId|GestureMode|Orientation' | cut -c1-170")
        if opts.inject != "pointer":
            check("touchscreen_direct", re.search(r"Mode: direct|DeviceType: touchScreen", reader),
                  " | ".join(line.strip() for line in reader.split("\n") if re.search(r"Mode:|DeviceType|Viewport|SurfaceWidth|SurfaceHeight", line))[:400])
            # The PC's PS/2 mouse is always there (Android: a cursor device),
            # but nothing moves it; there must be no USB tablet.
            check("no_tablet", not any("Tablet" in n for n, _ in devices),
                  "cursor devices: " + (", ".join(n for n, c in devices if int(c, 16) & 0x08) or "none"))

        # --- raw events: do slots reach user space? --------------------------
        node = run("touch_node", "for d in /sys/class/input/event*; do n=$(cat $d/device/name); "
                                 "case \"$n\" in *[Tt]ouch*|*[Tt]ablet*) echo /dev/input/${d##*/} $n;; esac; done").split("\n")[0].split(" ")[0]
        if not node.startswith("/dev/input/"):
            node = ""
        # A count, so that getevent ends by itself and writes out what it has
        # (killed, it would lose its buffered output).
        run("getevent_start", f"getevent -lt -c 30 {node} > /data/local/tmp/porty-raw.txt 2>&1 & echo started", 60)
        prov.wait(vm, 2)
        g.sh("am start -n com.android.settings/.Settings > /dev/null 2>&1", 120)
        prov.wait(vm, 10)
        g.quiet(timeout=120)

        def hold():
            return run("held", "dumpsys input | sed -n '/Input Reader State/,/Input Dispatcher State/p' | "
                               "grep -A14 -E 'Last (Raw|Cooked) Touch' | cut -c1-240", 240)
        # Two fingers in the lower half of Settings (nothing there takes a long press).
        held = touch.two((0.3, 0.6), (0.7, 0.75), (0.35, 0.62), (0.65, 0.72), steps=4, pause=0.15, hold=hold)
        prov.wait(vm, 3)
        run("getevent_stop", "pkill getevent; sleep 1; wc -l < /data/local/tmp/porty-raw.txt")
        raw = run("raw_events", "grep -v -e '^add device' -e '^ *name:' -e '^could not' /data/local/tmp/porty-raw.txt | head -120 | cut -c1-120")
        slots_seen = sorted(set(re.findall(r"ABS_MT_SLOT\s+0*([0-9a-f]+)", raw)))
        tids = sorted(set(re.findall(r"ABS_MT_TRACKING_ID\s+([0-9a-f]+)", raw)))
        result["raw"] = {"slot_values": slots_seen, "tracking_ids": tids,
                         "syn_mt_report": raw.count("SYN_MT_REPORT"), "btn_touch": raw.count("BTN_TOUCH")}
        if opts.inject != "pointer":
            check("raw_mt_events", "ABS_MT_POSITION_X" in raw and len(slots_seen) >= 2 and len(tids) >= 2,
                  json.dumps(result["raw"]))
            counts = [int(n) for n in re.findall(r"pointerCount=(\d+)", held or "")]
            check("two_pointers", counts and max(counts) >= 2, f"pointerCount values while both fingers were down: {counts}")

        # --- a swipe scrolls Settings (top of its list first) -----------------
        g.sh("am force-stop com.android.settings; am start -n com.android.settings/.Settings > /dev/null 2>&1", 120)
        prov.wait(vm, 8)
        top = shot_pair(vm, g, "settings-top")
        # A picture with something in it for the pinch below: this screen.
        run("picture_taken", "mkdir -p /sdcard/Pictures; screencap -p /sdcard/Pictures/porty.png; ls -l /sdcard/Pictures/porty.png")
        touch.swipe(0.5, 0.8, 0.5, 0.35, steps=12, pause=0.25)  # a slow drag: the list follows the finger
        dragged = shot_pair(vm, g, "settings-dragged")
        drag_pct = gcpu.ppm_diff(dragged, top)
        touch.swipe(0.5, 0.35, 0.5, 0.85, steps=10, pause=0.25)
        back = shot_pair(vm, g, "settings-dragged-back")
        back_pct = gcpu.ppm_diff(back, top)
        touch.swipe(0.5, 0.8, 0.5, 0.4, steps=6, pause=0.03)    # a quick swipe: a fling
        flung = shot_pair(vm, g, "settings-flung")
        fling_pct = gcpu.ppm_diff(flung, top)
        result["scroll"] = {"drag_pct": drag_pct, "back_to_top_pct": back_pct, "fling_pct": fling_pct,
                            "drag_shift": vshift(top, dragged), "back_shift": vshift(top, back),
                            "fling_shift": vshift(top, flung)}
        moved = result["scroll"]["drag_shift"][0]
        check("swipe_scrolls", moved is not None and moved >= 100 and back_pct < 1.0, json.dumps(result["scroll"]))

        g.sh("input keyevent 3", 60)
        prov.wait(vm, 3)
        g.quiet(timeout=90)

        # --- no mouse pointer --------------------------------------------------
        sprites = run("sprites", "dumpsys SurfaceFlinger --list | grep -i -e sprite -e pointer | head -5; echo done")
        if opts.inject != "pointer":
            check("no_pointer_sprite", not re.search(r"(?i)sprite|pointer", sprites.replace("done", "")),
                  sprites.replace("\n", " | ")[:300])

        # --- a tap opens Gallery -----------------------------------------------
        g.sh("am force-stop com.android.gallery3d", 60)
        gcpu.dismiss_anr(vm)
        g.quiet(timeout=90)
        home = shot_pair(vm, g, "home")
        before = g.sh("grep -c 'am_activity_launch_time.*gallery3d' /data/local/tmp/porty-ev.txt", 30)[1].strip()
        seen = int(before) if before.isdigit() else 0
        t0 = time.monotonic()
        touch.tap(0.3125, 0.70625)
        drawn = None
        while time.monotonic() - t0 < opts.launch_timeout and vm.alive():
            prov.wait(vm, 2)
            count = g.sh("grep -c 'am_activity_launch_time.*gallery3d' /data/local/tmp/porty-ev.txt", 30)[1].strip()
            if count.isdigit() and int(count) > seen:
                drawn = round(time.monotonic() - t0, 1)
                break
        prov.wait(vm, 5)
        focus = g.focus()
        gallery = shot_pair(vm, g, "gallery")
        result["gallery"] = {"drawn_s": drawn, "focus": focus, "screen_changed_pct": gcpu.ppm_diff(gallery, home)}
        check("tap_opens_gallery", drawn is not None and "gallery" in focus.lower(), json.dumps(result["gallery"]))

        # --- two fingers spread on a picture: it zooms ------------------------
        if opts.inject != "pointer":
            pic = run("picture", ""
                                 "am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Pictures/porty.png "
                                 "> /dev/null 2>&1; sleep 3; content query --uri content://media/external/images/media "
                                 "--projection _id:_data 2>&1 | tail -3")
            ids = re.findall(r"_id=(\d+), _data=/storage/emulated/0/Pictures/porty.png", pic) or re.findall(r"_id=(\d+)", pic)
            uri = f"content://media/external/images/media/{ids[-1]}" if ids else "file:///sdcard/Pictures/porty.png"
            g.sh(f"am start -a android.intent.action.VIEW -t image/png -d {uri} -n com.android.gallery3d/.app.GalleryActivity "
                 "> /dev/null 2>&1", 120)
            prov.wait(vm, 15)
            photo = shot_pair(vm, g, "photo")
            touch.two((0.45, 0.45), (0.55, 0.55), (0.2, 0.25), (0.8, 0.8), steps=10, pause=0.12)
            zoomed = shot_pair(vm, g, "photo-zoomed")
            result["pinch"] = {"uri": uri, "focus": g.focus(), "changed_pct": gcpu.ppm_diff(zoomed, photo)}
            check("pinch_zooms", result["pinch"]["changed_pct"] >= 20, json.dumps(result["pinch"]))
            g.sh("input keyevent 3", 60)


        # --- the app drawer: a quick swipe up opens it, a tap starts Settings ---
        # (In the browser the tap on Settings in the drawer opened nothing,
        # three times, runs 44080618863, 44080633997, 44084324374.)
        g.sh("am force-stop com.android.settings; input keyevent 3", 60)
        prov.wait(vm, 3)
        g.quiet(timeout=90)
        home2 = shot_pair(vm, g, "home2")
        touch.swipe(0.5, 650 / 800, 0.5, 200 / 800, steps=6, pause=0.06)   # as the browser probe does
        drawer = shot_pair(vm, g, "drawer")
        dr = result["drawer"] = {"opened_pct": gcpu.ppm_diff(drawer, home2), "focus": g.focus()}
        for i in range(3):
            touch.tap(60 / 480, 375 / 800, hold=0.12)
            prov.wait(vm, 12)
            g.quiet(timeout=60)
            dr[f"tap{i + 1}_focus"] = g.focus()
            if "settings" in dr[f"tap{i + 1}_focus"].lower():
                break
        dr["raw_touch"] = run("drawer_raw_touch", "dumpsys input | sed -n '/Input Reader State/,/Input Dispatcher State/p' | "
                                                  "grep -A3 -E 'Last (Raw|Cooked) Touch' | cut -c1-200", 240)
        dr["resumed"] = run("drawer_resumed", "dumpsys activity activities | grep -e mResumedActivity -e 'state=' | head -6 | cut -c1-160")
        after = shot_pair(vm, g, "drawer-tapped")
        dr["tap_changed_pct"] = gcpu.ppm_diff(after, drawer)
        if "settings" not in dr.get("tap3_focus", dr.get("tap2_focus", dr.get("tap1_focus", ""))).lower():
            # Android's own injection at the same spot, for comparison.
            g.sh("input tap 60 375", 60)
            prov.wait(vm, 12)
            g.quiet(timeout=60)
            dr["input_tap_focus"] = g.focus()
            shot_pair(vm, g, "drawer-input-tap")
        opened = any("settings" in str(dr.get(f"tap{i}_focus", "")).lower() for i in (1, 2, 3))
        if opened:
            # The browser probe's next step, where its drags moved nothing
            # (44096770993, 44100096190): a drag on this Settings, opened from
            # the drawer rather than by am start, as the page sends it: eight
            # moves 150 ms apart, a rest of 1.5 s with reports, the lift.
            prov.wait(vm, 10)
            g.quiet(timeout=120)
            s0 = shot_pair(vm, g, "drawer-settings")
            # (getevent ends after 40 events, the down and the moves, so that
            # it writes them out; killed, it would lose them.)
            run("drawer_getevent_start", f"getevent -lt -c 40 {node} > /data/local/tmp/porty-raw2.txt 2>&1 & echo started", 60)
            prov.wait(vm, 2)
            touch.drag(0.5, 640 / 800, 0.5, 280 / 800, steps=8, pause=0.15, rest=1.5, keep=True)
            prov.wait(vm, 5)
            g.quiet(timeout=60)
            s1 = shot_pair(vm, g, "drawer-settings-dragged")
            dr["drag_shift"] = vshift(s0, s1)
            run("drawer_raw2", "cat /data/local/tmp/porty-raw2.txt | head -45", 60)
            run("drawer_touch_after", "dumpsys input | grep -E -A2 'Last (Raw|Cooked) Touch|TouchStates|TouchedWindows' | "
                                      "head -24 | cut -c1-180", 120)
            run("drawer_dispatch_log", "logcat -d -b main -b system | grep -E 'InputDispatcher|InputReader|Dropp|"
                                       "spent [0-9.]+ms' | tail -30 | cut -c1-200", 120)
        log("drawer: " + json.dumps({k: v for k, v in dr.items() if k not in ("raw_touch", "resumed")}))
        check("drawer_tap_opens_settings", opened, json.dumps({k: v for k, v in dr.items() if k not in ("raw_touch", "resumed")}))
        if opened:
            moved = dr["drag_shift"][0]
            check("drawer_settings_drag_scrolls", moved is not None and moved >= 100, json.dumps(dr["drag_shift"]))
        g.sh("input keyevent 3", 60)
        prov.wait(vm, 3)

        # --- a long list: resting before the lift, with and without reports ---
        # Developer options: Settings keeps the activity disabled until they
        # are switched on (Settings$DevelopmentSettingsDashboardActivity,
        # android:enabled="false"), so enable it; no "am start -W", which
        # waited for good on the activity that says they are off (run
        # 44036404159) and held up the shell for every later step.
        run("dev_options", "settings put global development_settings_enabled 1; am force-stop com.android.settings; "
                           "pm enable com.android.settings/.Settings\\$DevelopmentSettingsDashboardActivity 2>&1 | tail -1; "
                           "am start -n com.android.settings/.Settings\\$DevelopmentSettingsDashboardActivity 2>&1 | tail -2")
        prov.wait(vm, 10)
        fl_focus = g.focus()
        fl = {}
        s0 = shot_pair(vm, g, "dev-top")
        touch.drag(0.5, 0.75, 0.5, 0.45, steps=10, pause=0.25, rest=1.5, keep=True)
        s1 = shot_pair(vm, g, "dev-rest-kept")
        # (Developer options keep their title and the "On" bar fixed above row 140.)
        fl["drag_rest_kept"] = vshift(s0, s1, top=140)
        touch.drag(0.5, 0.75, 0.5, 0.45, steps=10, pause=0.25, rest=1.5, keep=False)
        s2 = shot_pair(vm, g, "dev-rest-silent")
        fl["drag_rest_silent"] = vshift(s1, s2, top=140)
        touch.drag(0.5, 0.75, 0.5, 0.45, steps=10, pause=0.25, rest=0, keep=False)
        s3 = shot_pair(vm, g, "dev-drag-lift")
        fl["drag_lift"] = vshift(s2, s3, top=140)
        touch.drag(0.5, 0.75, 0.5, 0.45, steps=4, pause=0.03, rest=0, keep=False)
        s4 = shot_pair(vm, g, "dev-swipe")
        fl["swipe"] = vshift(s3, s4, top=140)
        fl["finger_px"] = round(0.3 * 800)
        fl["focus"] = fl_focus
        result["fling"] = fl
        log("fling: " + json.dumps(fl))
        kept = fl["drag_rest_kept"][0]
        check("rest_then_lift_no_fling", kept is not None and 120 <= kept <= 300, json.dumps(fl))

        run("crashes", "logcat -b crash -d | grep -e 'Process: ' -e '>>> ' | cut -c1-200 | head -20")
        run("input_log", "logcat -d -s InputReader:* InputDispatcher:* EventHub:* | tail -40 | cut -c1-200")
        result["sent"] = touch.sent
    except Exception as e:  # the verdict must always be written
        result["error"] = f"{type(e).__name__}: {e}"
        log(f"error: {result['error']}")
    finally:
        if fifo:
            try:
                fifo.close()
            except OSError:
                pass
        vm.quit()
        snap.write_json(os.path.join(opts.work, "result.json"), result)
    failed = [k for k, c in result["checks"].items() if not c["ok"]]
    log(f"touch: {len(result['checks']) - len(failed)} of {len(result['checks'])} checks passed"
        + (f"; failed: {', '.join(failed)}" if failed else ""))
    print("PORTY_RESULT " + json.dumps({k: v for k, v in result.items() if k != "guest"})[:200000], flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
