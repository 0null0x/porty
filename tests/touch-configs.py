"""List the resources an APK has for a touchscreen qualifier (notouch,
stylus, finger), from its resources.arsc. Reads the files as data only.

usage: python3 -I touch_configs.py <apk or directory of apks> ...
"""
import os
import struct
import sys
import zipfile

TOUCH = {1: "notouch", 2: "stylus", 3: "finger"}


def string_pool(buf, off):
    """The strings of a ResStringPool chunk at off."""
    _type, hsize, _size = struct.unpack_from("<HHI", buf, off)
    count, _styles, flags, start, _sstart = struct.unpack_from("<IIIII", buf, off + 8)
    utf8 = bool(flags & (1 << 8))
    offsets = struct.unpack_from(f"<{count}I", buf, off + hsize)
    base = off + start
    out = []
    for o in offsets:
        p = base + o
        try:
            if utf8:
                n = buf[p]
                p += 2 if n & 0x80 else 1
                n = buf[p]
                if n & 0x80:
                    n = ((n & 0x7F) << 8) | buf[p + 1]
                    p += 2
                else:
                    p += 1
                out.append(buf[p:p + n].decode("utf-8", "replace"))
            else:
                (n,) = struct.unpack_from("<H", buf, p)
                p += 2
                if n & 0x8000:
                    (n2,) = struct.unpack_from("<H", buf, p)
                    n = ((n & 0x7FFF) << 16) | n2
                    p += 2
                out.append(buf[p:p + 2 * n].decode("utf-16-le", "replace"))
        except (IndexError, struct.error):
            out.append("?")
    return out


def scan(buf):
    """[(package, type, qualifier, [entry names])] for touchscreen configs."""
    found = []
    _t, hsize, size = struct.unpack_from("<HHI", buf, 0)
    off = hsize
    while off + 8 <= min(size, len(buf)):
        ctype, chsize, csize = struct.unpack_from("<HHI", buf, off)
        if csize < 8:
            break
        if ctype == 0x0200:  # package
            name = buf[off + 12:off + 12 + 256].decode("utf-16-le", "replace").split("\0")[0]
            type_off, = struct.unpack_from("<I", buf, off + 268)
            key_off, = struct.unpack_from("<I", buf, off + 276)
            types = string_pool(buf, off + type_off)
            keys = string_pool(buf, off + key_off)
            p = off + chsize
            end = off + csize
            while p + 8 <= end:
                t, th, ts = struct.unpack_from("<HHI", buf, p)
                if ts < 8:
                    break
                if t == 0x0201:  # a type for one configuration
                    tid = buf[p + 8]
                    count, entries_start = struct.unpack_from("<II", buf, p + 12)
                    cfg = p + 20
                    touch = buf[cfg + 13] if cfg + 13 < len(buf) else 0
                    if touch:
                        offsets = struct.unpack_from(f"<{count}I", buf, p + th)
                        names = []
                        for eo in offsets:
                            if eo == 0xFFFFFFFF:
                                continue
                            e = p + entries_start + eo
                            _esize, _eflags, key = struct.unpack_from("<HHI", buf, e)
                            names.append(keys[key] if key < len(keys) else "?")
                        tname = types[tid - 1] if 0 < tid <= len(types) else str(tid)
                        found.append((name, tname, TOUCH.get(touch, str(touch)), names))
                p += ts
        off += csize
    return found


def main():
    apks = []
    for arg in sys.argv[1:]:
        if os.path.isdir(arg):
            for root, _dirs, files in os.walk(arg):
                apks += [os.path.join(root, f) for f in files if f.endswith(".apk")]
        else:
            apks.append(arg)
    for apk in sorted(apks):
        try:
            with zipfile.ZipFile(apk) as z:
                if "resources.arsc" not in z.namelist():
                    continue
                buf = z.read("resources.arsc")
            hits = scan(buf)
        except Exception as e:  # a file this reader cannot follow
            print(f"{os.path.basename(apk)}: unreadable ({type(e).__name__}: {e})")
            continue
        for pkg, tname, q, names in hits:
            shown = ", ".join(names[:12]) + (f" (+{len(names) - 12})" if len(names) > 12 else "")
            print(f"{os.path.relpath(apk, sys.argv[1]) if os.path.isdir(sys.argv[1]) else apk}: {pkg} {tname}-{q}: {shown}")


if __name__ == "__main__":
    main()
