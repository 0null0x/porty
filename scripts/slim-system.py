#!/usr/bin/env python3
"""Inspect and slim an Android system image (ext2/3/4) without root.

usage: slim-system.py <system.img> <remove-list> <report.json>

  1. walks the whole filesystem with debugfs (read-only) and prints what is
     in it: the top-level directories, every package under /app and
     /priv-app with its size, and the other big directories;
  2. removes the paths named in <remove-list> with "debugfs -w" (files with
     "rm", directories bottom-up with "rmdir"), and checks they are gone;
  3. lets e2fsck repair whatever the removal left behind, fills every free
     block with zeroes (debugfs only clears the bitmaps; the old contents
     would otherwise still be published and compressed) and requires a
     final "e2fsck -fn" to find nothing;
  4. writes <report.json>: what was removed, with sizes.

<remove-list>: one absolute path inside the image per line; "#" starts a
comment.  A path that does not exist is reported and skipped, so the list
can name alternatives.  Paths matching PROTECTED are refused: Android does
not boot without them (see the comments there).

Only e2fsprogs is needed (debugfs, dumpe2fs, e2fsck).  Run with python3 -I.
"""
import json
import os
import re
import subprocess
import sys

# Never removed, whatever the list says.  PackageManagerService throws at
# boot without exactly one package installer, without the shared-services
# and shared-library packages (ExtServices, ExtShared) and without a setup
# wizard or Provision to mark the device provisioned; the rest is the UI
# and the pieces every app needs.
PROTECTED = re.compile(
    r"^/(?:build\.prop|bin|xbin|etc|framework|lib|lib64|fonts|usr|vendor)(?:/|$)"
    r"|^/(?:app|priv-app)/[^/]*(?:"
    r"PackageInstaller|ExtServices|ExtShared|SystemUI|Settings|Launcher|"
    r"Provision|SetupWizard|WebView|webview|LatinIME|Shell|Telecom|TeleService|"
    r"TelephonyProvider|ContactsProvider|MediaProvider|DownloadProvider|"
    r"DocumentsUI|ExternalStorageProvider|InputDevices|KeyChain|FusedLocation|"
    r"DefaultContainerService|StatementService|CertInstaller|Taskbar"
    r")[^/]*(?:/|$)")

GOOGLE = re.compile(r"google|gms|gsf|phonesky|vending|velvet|chrome|youtube|gmail", re.I)

# The same moment for every run, so that a rebuild of the same input gives
# the same bytes (e2fsprogs honours this for the times it writes).
ENV = dict(os.environ, E2FSPROGS_FAKE_TIME="1500000000", LC_ALL="C")


def die(text):
    print(f"::error::slim-system: {text}", file=sys.stderr)
    sys.exit(1)


def run(argv, ok=(0,), **kw):
    proc = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          env=ENV, check=False, **kw)
    text = proc.stdout.decode("utf-8", "replace")
    if proc.returncode not in ok:
        sys.stderr.write(text[-4000:])
        die(f"{argv[0]} exited with status {proc.returncode}")
    return proc.returncode, text


def quote(path):
    if re.search(r'["\n\r]', path):
        die(f"unsupported character in path {path!r}")
    return f'"{path}"'


def debugfs(image, commands, write=False):
    """Run a batch of debugfs commands; returns one output block per command."""
    script = "".join(c + "\n" for c in commands).encode()
    argv = ["debugfs"] + (["-w"] if write else []) + ["-f", "-", image]
    _, text = run(argv, input=script)
    blocks, current = [], None
    for line in text.splitlines():
        if line.startswith("debugfs: "):
            current = []
            blocks.append(current)
        elif current is not None:
            current.append(line)
    if len(blocks) != len(commands):
        die(f"debugfs answered {len(blocks)} of {len(commands)} commands")
    return blocks


def walk(image, roots=("/",)):
    """{path: (kind, size)} for everything below roots; kind is d, f or l."""
    tree = {}
    level = [r for r in roots]
    for r in level:
        tree[r] = ("d", 0)
    while level:
        blocks = debugfs(image, [f"ls -p {quote(d)}" for d in level])
        following = []
        for parent, lines in zip(level, blocks):
            for line in lines:
                # /<inode>/<mode>/<uid>/<gid>/<name>/<size>/
                m = re.fullmatch(r"/(\d+)/(\d+)/\d+/\d+/(.*)/(\d*)/", line)
                if not m:
                    if line.strip():
                        die(f"cannot list {parent}: {line.strip()}")
                    continue
                inode, mode, name, size = int(m[1]), int(m[2], 8), m[3], m[4]
                if name in (".", "..") or inode == 0:
                    continue
                path = parent.rstrip("/") + "/" + name
                kind = {0o040000: "d", 0o100000: "f", 0o120000: "l"}.get(mode & 0o170000, "o")
                tree[path] = (kind, int(size or 0))
                if kind == "d" and name != "lost+found":
                    following.append(path)
        level = following
    return tree


def subtree(tree, top):
    prefix = top.rstrip("/") + "/"
    return [p for p in tree if p == top or p.startswith(prefix)]


def size_of(tree, top):
    return sum(tree[p][1] for p in subtree(tree, top) if tree[p][0] == "f")


def children(tree, top):
    prefix = top.rstrip("/") + "/"
    return sorted(p for p in tree
                  if p.startswith(prefix) and p != prefix and "/" not in p[len(prefix):])


def mb(n):
    return f"{n / 1048576:8.1f} MiB"


def inventory(tree, title):
    files = sum(1 for k, _ in tree.values() if k == "f")
    print(f"--- {title}: {files} files, {mb(size_of(tree, '/'))} of file data")
    for top in sorted(children(tree, "/"), key=lambda p: -size_of(tree, p)):
        print(f"  {mb(size_of(tree, top))}  {top}{'/' if tree[top][0] == 'd' else ''}")
    for group in ("/app", "/priv-app"):
        packages = children(tree, group)
        print(f"--- {group}: {len(packages)} packages, {mb(size_of(tree, group))}")
        for p in sorted(packages, key=lambda p: -size_of(tree, p)):
            mark = "  [google]" if GOOGLE.search(p) else ""
            odex = sum(tree[q][1] for q in subtree(tree, p)
                       if tree[q][0] == "f" and re.search(r"\.(odex|vdex|art)$", q))
            print(f"  {mb(size_of(tree, p))}  {p}{mark}"
                  + (f"  (of which odex/vdex {mb(odex).strip()})" if odex else ""))
    print("--- other directories of 8 MiB or more (two and three levels down)")
    seen = []
    for top in children(tree, "/"):
        if top in ("/app", "/priv-app") or tree[top][0] != "d":
            continue
        for sub in children(tree, top):
            for path in [sub] + children(tree, sub):
                if tree[path][0] == "d" and size_of(tree, path) >= 8 << 20:
                    seen.append(path)
    for path in sorted(seen, key=lambda p: -size_of(tree, p)):
        print(f"  {mb(size_of(tree, path))}  {path}/")
    print("--- configuration that names Google packages (left in place)")
    for path in sorted(tree):
        if path.startswith("/etc/") and tree[path][0] == "f" and GOOGLE.search(path):
            print(f"  {tree[path][1]:9d}  {path}")


def read_list(path):
    wanted = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.split("#", 1)[0].strip()
            if not line:
                continue
            if not line.startswith("/") or line.rstrip("/") == "" or "/../" in line + "/":
                die(f"bad entry in {path}: {line!r}")
            wanted.append(line.rstrip("/"))
    return wanted


def free_ranges(image):
    """(block size, [(first, last)]) from the block bitmaps, via dumpe2fs."""
    _, text = run(["dumpe2fs", image])
    m = re.search(r"^Block size:\s+(\d+)$", text, re.M)
    if not m:
        die("dumpe2fs did not print the block size")
    ranges = []
    for line in re.findall(r"^\s+Free blocks: (.*)$", text, re.M):
        for part in filter(None, (p.strip() for p in line.split(","))):
            first, _, last = part.partition("-")
            ranges.append((int(first), int(last or first)))
    return int(m[1]), ranges


def zero_free_blocks(image):
    block, ranges = free_ranges(image)
    zeroed = free = 0
    step = 4 << 20
    with open(image, "r+b") as f:
        size = f.seek(0, os.SEEK_END)
        for first, last in ranges:
            start, end = first * block, min((last + 1) * block, size)
            free += max(0, end - start)
            while start < end:
                n = min(step, end - start)
                f.seek(start)
                data = f.read(n)
                if data.count(0) != len(data):
                    f.seek(start)
                    f.write(bytes(len(data)))
                    zeroed += len(data)
                start += n
    return free, zeroed


def main():
    if len(sys.argv) != 4:
        die("usage: slim-system.py <system.img> <remove-list> <report.json>")
    image, list_path, report_path = sys.argv[1:]
    wanted = read_list(list_path)

    rc, text = run(["e2fsck", "-fn", image], ok=(0, 4))
    print(f"e2fsck -fn before any change: status {rc}"
          + ("" if rc == 0 else " (the image as shipped has inconsistencies)"))
    if rc:
        print(text[-1500:])

    tree = walk(image)
    if tree.get("/build.prop", ("", 0))[0] != "f" or not tree["/build.prop"][1]:
        die("no /build.prop at the root of the system image; the initrd would not accept it")
    inventory(tree, "system image as shipped")

    removed, absent, commands = [], [], []
    for top in wanted:
        if top not in tree:
            absent.append(top)
            continue
        if PROTECTED.search(top):
            die(f"{top} is protected: Android does not boot without it")
        paths = subtree(tree, top)
        # deepest first: files and links with rm, then the emptied directories
        for path in sorted(paths, key=lambda p: (-p.count("/"), p)):
            commands.append(("rmdir " if tree[path][0] == "d" else "rm ") + quote(path))
        removed.append({"path": top, "bytes": size_of(tree, top),
                        "files": sum(1 for p in paths if tree[p][0] != "d")})

    print(f"--- removing {len(removed)} of {len(wanted)} listed paths")
    for item in removed:
        print(f"  {mb(item['bytes'])}  {item['path']}  ({item['files']} files)")
    for path in absent:
        print(f"  not in this image: {path}")

    if commands:
        debugfs(image, commands, write=True)
    rc, text = run(["e2fsck", "-fy", image], ok=(0, 1))
    print(f"e2fsck -fy after the removal: status {rc}")
    if rc:
        print(text[-1500:])
    free, zeroed = zero_free_blocks(image)
    print(f"free space: {mb(free).strip()}, of which {mb(zeroed).strip()} held old data and was zeroed")
    rc, text = run(["e2fsck", "-fn", image], ok=(0, 4))
    if rc:
        sys.stderr.write(text[-4000:])
        die("the slimmed image does not pass e2fsck -fn")

    after = walk(image)
    for item in removed:
        if subtree(after, item["path"]):
            die(f"{item['path']} is still in the image after the removal")
    lost = sorted(set(tree) - set(after) - {p for i in removed for p in subtree(tree, i["path"])})
    if lost:
        die(f"paths that were not to be removed are gone: {lost[:5]}")
    if after.get("/build.prop") != tree["/build.prop"]:
        die("/build.prop changed")
    left = [p for g in ("/app", "/priv-app") for p in children(after, g) if GOOGLE.search(p)]
    print(f"--- slimmed image: {sum(1 for k, _ in after.values() if k == 'f')} files, "
          f"{mb(size_of(after, '/')).strip()} of file data "
          f"(was {mb(size_of(tree, '/')).strip()}); "
          f"{len(children(after, '/app')) + len(children(after, '/priv-app'))} packages")
    print("  Google-named packages left: " + (" ".join(left) if left else "none"))

    report = {
        "removed": removed,
        "removed_bytes": sum(i["bytes"] for i in removed),
        "files_before": sum(1 for k, _ in tree.values() if k == "f"),
        "files_after": sum(1 for k, _ in after.values() if k == "f"),
        "file_bytes_before": size_of(tree, "/"),
        "file_bytes_after": size_of(after, "/"),
    }
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
        f.write("\n")


if __name__ == "__main__":
    main()
