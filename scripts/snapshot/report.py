#!/usr/bin/env python3
"""Summarise a snapshot run for the commit status and the job summary.

usage: report.py <work-dir> <snapshot-dir>
  <work-dir>/save/result.json, <work-dir>/restore/result.json (make-snapshot.py)
  <snapshot-dir>/manifest.json (pack-snapshot.py)

Prints one line for the commit status (at most 140 characters are used),
then Markdown for the job summary.  Never fails.  Standard library only.
"""

import json
import os
import sys


def load(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def mb(n):
    return f"{n / 1e6:.0f} MB"


def main():
    work, snap = sys.argv[1], sys.argv[2]
    save = load(os.path.join(work, "save", "result.json"))
    restore = load(os.path.join(work, "restore", "result.json"))
    manifest = load(os.path.join(snap, "manifest.json"))

    parts = []
    if not save:
        parts.append("QEMU was not started")
    elif save.get("booted"):
        parts.append(f"booted in {save['booted_seconds'] / 60:.1f} min")
    else:
        parts.append(f"not booted after {save.get('elapsed_seconds', 0) / 60:.0f} min")
    if save and save.get("error"):
        parts.append(str(save["error"])[:70])
    if manifest:
        packed = sum(c["size"] for c in manifest["chunks"])
        parts.append(f"{mb(manifest['uncompressed_size'])} raw, {mb(packed)} zlib, "
                     f"{len(manifest['chunks'])} chunks")
    elif save and save.get("saved"):
        parts.append(f"{mb(save.get('state_bytes', 0))} raw")
    if restore:
        parts.append("native restore ok" if restore.get("restored") else "native restore FAILED")
    print("; ".join(parts))

    out = []
    if save:
        out.append("### Boot")
        out.append("")
        marks = save.get("milestones", {})
        if marks:
            out.append("| milestone | seconds |")
            out.append("| --- | --- |")
            out.extend(f"| {k} | {v} |" for k, v in marks.items())
            out.append("")
        for key in ("screen_booted", "screen"):
            if save.get(key):
                out.append(f"- {key}: `{json.dumps(save[key])}`")
        guest = save.get("guest", {})
        for key in ("fingerprint", "focus", "clocksource", "dmesg_tsc", "cpu_model", "cpu_mhz",
                    "cpu_flags", "loadavg", "meminfo_before", "zero_fill", "zero_fill_mb",
                    "meminfo_after", "uptime", "date"):
            if key in guest:
                text = str(guest[key]).replace("\n", " / ")
                out.append(f"- guest {key}: `{text[:900]}`")
        if save.get("migrate"):
            out.append(f"- migration ({save.get('migrate_seconds')} s): `{json.dumps(save['migrate'])[:1500]}`")
        for key in ("status_before", "status_after", "error"):
            if save.get(key):
                out.append(f"- {key}: `{json.dumps(save[key])}`")
        machine = save.get("machine", {})
        for key in ("version", "ramblock", "migrate_capabilities", "block"):
            if machine.get(key):
                out += ["", f"<details><summary>{key}</summary>", "", "```", machine[key].rstrip(), "```", "", "</details>"]
        cpu = save.get("cpu")
        if cpu:
            out += ["", "<details><summary>guest CPU (QEMU's feature words)</summary>", "", "```json",
                    json.dumps(cpu, indent=1), "```", "", "</details>"]
        for key in ("serial_tail", "logcat_tail", "props", "ps"):
            if save.get(key):
                out += ["", f"<details><summary>{key}</summary>", "", "```"] + [str(x) for x in save[key]] + ["```", "", "</details>"]
    if manifest:
        packed = sum(c["size"] for c in manifest["chunks"])
        out += ["", "### Snapshot", "",
                f"- stream: {manifest['uncompressed_size']} bytes; compressed: {packed} bytes in "
                f"{len(manifest['chunks'])} chunks (largest {max(c['size'] for c in manifest['chunks'])})",
                f"- run state: {manifest.get('runstate')}; patches sha256 `{manifest['porty_patches_sha256']}`",
                f"- image manifest sha256 `{manifest['image_manifest_sha256']}`",
                "", "```", " ".join(manifest["argv"]), "```"]
    if restore:
        out += ["", "### Restore check (native)", "", "```json", json.dumps(restore, indent=1)[:4000], "```"]
    print("\n".join(out))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # the report must not fail the run
        print(f"report failed: {e}")
