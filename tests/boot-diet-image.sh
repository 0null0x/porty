#!/usr/bin/env bash
# Checks, on a prepared image (scripts/prepare-image.sh), what the boot diet
# (web/js/boot-diet.js) relies on, without booting:
#
#   - initrd.img is one gzip cpio archive whose /init sources /scripts/*
#     from /android after unpacking the ramdisk, and has a /scripts directory;
#   - ramdisk.img has default.prop as a regular file;
#   - the initrd with the page's archive appended still unpacks archive by
#     archive, and the appended script, sourced where /init sources it,
#     rewrites the real default.prop.
#
# It also prints the facts a reader needs to judge the property set: the
# lines of default.prop for the keys the diet sets, the zygote .rc files in
# the ramdisk and, with --system, the matching lines of /system/build.prop
# and whether /system/etc/prop.default exists (needs debugfs, qemu-img or
# unsquashfs depending on the disk format, and room for the unpacked system
# image).
#
# usage: tests/boot-diet-image.sh <image-dir> <empty-work-dir> [--system]
set -euo pipefail

image="${1:?usage: boot-diet-image.sh <image-dir> <empty-work-dir> [--system]}"
work="${2:?usage: boot-diet-image.sh <image-dir> <empty-work-dir> [--system]}"
with_system="${3:-}"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for tool in cpio gzip node busybox; do
    command -v "$tool" >/dev/null || { echo "missing $tool" >&2; exit 2; }
done
mkdir -p "$work"
[[ -z "$(ls -A "$work")" ]] || { echo "$work must be empty" >&2; exit 2; }
image="$(cd "$image" && pwd)"; work="$(cd "$work" && pwd)"
mkdir "$work"/{initrd,ramdisk,combined}

fail=0
pass() { echo "PASS  $1"; }
bad() { echo "FAIL  $1"; fail=1; }
check() { # <description> <command...>
    local what="$1"; shift
    if "$@" >/dev/null 2>&1; then pass "$what"; else bad "$what"; fi
}
keys='debug\.sf\.nobootanimation|pm\.dexopt\.|ro\.zygote|ro\.product\.cpu\.abilist|dalvik\.vm\.dex2oat-filter|ro\.setupwizard|ro\.sf\.lcd_density'

# No device nodes or ownership: this runs without root.
unpack() { ( cd "$1" && cpio -i -d -m --quiet --no-absolute-filenames --nonmatching 'dev/*' 2>/dev/null ) || true; }

# --- the initrd as shipped ------------------------------------------------------
gzip -dc "$image/initrd.img" | unpack "$work/initrd"
check "initrd.img is a single gzip stream" gzip -t "$image/initrd.img"
check "initrd has /init and a /scripts directory" test -f "$work/initrd/init" -a -d "$work/initrd/scripts"
echo "    /scripts: $(cd "$work/initrd/scripts" 2>/dev/null && echo *)"
# shellcheck disable=SC2016  # literal text of Android-x86's init
{
    check "/init unpacks the ramdisk in /android" grep -q -x 'cd /android' "$work/initrd/init"
    check "/init sources /scripts/* (and /src/scripts/*)" \
        grep -q -F 'for s in `ls /scripts/* /src/scripts/*`; do' "$work/initrd/init"
    check "/init sources with 'test -e \"\$s\" && source \$s'" grep -q -F 'test -e "$s" && source $s' "$work/initrd/init"
    check "/init appends to default.prop itself (SETUPWIZARD=0)" \
        grep -q -F 'echo "ro.setupwizard.mode=DISABLED" >> default.prop' "$work/initrd/init"
}
cd_line="$(grep -n -x 'cd /android' "$work/initrd/init" | head -1 | cut -d: -f1)"
loop_line="$(grep -n -F 'ls /scripts/*' "$work/initrd/init" | head -1 | cut -d: -f1)"
switch_line="$(grep -n 'switch_root' "$work/initrd/init" | head -1 | cut -d: -f1)"
if (( ${cd_line:-0} > 0 && cd_line < ${loop_line:-0} && loop_line < ${switch_line:-0} )); then
    pass "order in /init: cd /android (line $cd_line), scripts (line $loop_line), switch_root (line $switch_line)"
else
    bad "order in /init: cd ${cd_line:-?}, scripts ${loop_line:-?}, switch_root ${switch_line:-?}"
fi

# --- the Android ramdisk --------------------------------------------------------
gzip -dc "$image/ramdisk.img" | unpack "$work/ramdisk"
if [[ -f "$work/ramdisk/default.prop" && ! -L "$work/ramdisk/default.prop" ]]; then
    pass "ramdisk has default.prop as a regular file ($(wc -l < "$work/ramdisk/default.prop") lines)"
else
    bad "ramdisk default.prop: $(ls -l "$work/ramdisk/default.prop" 2>&1)"
fi
echo "    property files in the ramdisk: $(find "$work/ramdisk" -maxdepth 1 -name '*prop*' -printf '%f (%y) ')"
echo "    zygote rc files in the ramdisk: $(find "$work/ramdisk" -maxdepth 1 -name 'init.zygote*.rc' -printf '%f ')"
echo "    default.prop, the lines for keys the diet touches:"
grep -E "^($keys)" "$work/ramdisk/default.prop" | sed 's/^/        /' || echo "        (none)"

# --- what the page builds -----------------------------------------------------------
for level in 1 2; do
    out="$work/initrd-diet$level.img"
    node "$repo/tests/apply-boot-diet.mjs" "$image/initrd.img" "$out" "?diet=$level" | sed 's/^/    /'
    size="$(stat -c %s "$image/initrd.img")"
    at=$(( (size + 3) / 4 * 4 ))
    check "diet=$level: the shipped initrd is the start of the new one" cmp -s -n "$size" "$image/initrd.img" "$out"
    # The kernel's order: the gzip archive, NUL padding, then the plain archive.
    rm -rf "$work/combined"; mkdir "$work/combined"
    gzip -dc "$image/initrd.img" | unpack "$work/combined"
    tail -c "+$(( at + 1 ))" "$out" | unpack "$work/combined"
    check "diet=$level: the appended archive adds /scripts/99-porty" test -f "$work/combined/scripts/99-porty"
    echo "    ls sorts it $(cd "$work/combined" && busybox ls scripts/* | tr '\n' ' ')"
    # Source it like /init does, in a copy of the unpacked ramdisk.
    rm -rf "$work/android"; cp -a "$work/ramdisk" "$work/android"
    # shellcheck disable=SC2016
    said="$(cd "$work/android" && busybox sh -c 'for s in `ls "$1"/scripts/*`; do test -e "$s" && source $s; done' sh "$work/combined" 2>&1)" || true
    echo "    the scripts printed: $said"
    if [[ "$said" == *"porty: boot diet, "*" properties in default.prop"* ]]; then
        pass "diet=$level: the script ran against the real ramdisk"
    else
        bad "diet=$level: script output"
    fi
    echo "    default.prop afterwards, the lines for keys the diet touches:"
    grep -E "^($keys)" "$work/android/default.prop" | sed 's/^/        /' || true
    if [[ "$(grep -c '^pm\.dexopt\.first-boot=' "$work/android/default.prop")" == 1 ]] \
        && grep -q -x 'pm.dexopt.first-boot=extract' "$work/android/default.prop" \
        && grep -q -x 'debug.sf.nobootanimation=1' "$work/android/default.prop"; then
        pass "diet=$level: default.prop has each property once, with the new value"
    else
        bad "diet=$level: default.prop not as expected"
    fi
    # Provisioning (boot-diet.js, PROVISION) and no ANR dumps (ANR_TRACES):
    # two more actions at the end of the real init.rc, in that order.
    if [[ "$said" == *"porty: provisioning at boot_completed (5 settings), hidden: nothing"* ]] \
        && [[ "$said" == *"porty: no ANR dumps after the boot (dalvik.vm.stack-trace-dir=/proc/porty-no-anr-traces)"* ]] \
        && [[ "$(grep -c '^# porty: provisioning' "$work/android/init.rc")" == 1 ]] \
        && [[ "$(grep -c '^# porty: no ANR dumps' "$work/android/init.rc")" == 1 ]] \
        && [[ "$(tail -n 7 "$work/android/init.rc" | head -n 1)" == "# porty: provisioning (web/js/boot-diet.js)" ]] \
        && [[ "$(tail -n 6 "$work/android/init.rc" | head -n 1)" == "on property:sys.boot_completed=1" ]] \
        && tail -n 5 "$work/android/init.rc" | head -n 1 | grep -q -F 'exec_background u:r:init:s0 -- /system/bin/sh -c "cmd settings put global device_provisioned 1; cmd settings put secure user_setup_complete 1; cmd settings put global window_animation_scale 0; cmd settings put global transition_animation_scale 0; cmd settings put global animator_duration_scale 0"' \
        && [[ "$(tail -n 3 "$work/android/init.rc" | head -n 1)" == "# porty: no ANR dumps (web/js/boot-diet.js)" ]] \
        && [[ "$(tail -n 2 "$work/android/init.rc" | head -n 1)" == "on property:sys.boot_completed=1" ]] \
        && [[ "$(tail -n 1 "$work/android/init.rc")" == "    setprop dalvik.vm.stack-trace-dir /proc/porty-no-anr-traces" ]]; then
        pass "diet=$level: init.rc ends with the provisioning action and the ANR action ($(wc -l < "$work/ramdisk/init.rc") lines before)"
    else
        bad "diet=$level: init.rc not as expected: $(tail -n 8 "$work/android/init.rc")"
    fi
    if [[ "$level" == 2 ]]; then
        check "diet=2: /init.zygote64.rc exists afterwards" test -s "$work/android/init.zygote64.rc"
        if grep -q 'zygote_secondary\|app_process32' "$work/android/init.zygote64.rc" 2>/dev/null; then
            bad "diet=2: init.zygote64.rc still starts a 32-bit zygote"
        else
            pass "diet=2: init.zygote64.rc starts no 32-bit zygote"
        fi
        sed 's/^/        /' "$work/android/init.zygote64.rc" 2>/dev/null || true
    fi
done

# --- /system (optional, slow) -------------------------------------------------------
if [[ "$with_system" == --system ]]; then
    PATH="$PATH:/usr/sbin:/sbin"   # e2fsprogs
    # The disk is either the ISO's system.sfs or a qcow2 of the ext4 system
    # image (image/manifest.json, disk.format).
    disk_dir="$(grep -o '"dir": "[^"]*' "$image/manifest.json" | cut -d'"' -f4)"
    if grep -q '"format": "qcow2"' "$image/manifest.json"; then reader=qemu-img; else reader=unsquashfs; fi
    if command -v "$reader" >/dev/null && command -v debugfs >/dev/null; then
        mkdir "$work/sfs"
        find "$image/$disk_dir" -name '*.bin' -print0 | sort -z | xargs -0 cat > "$work/system.disk"
        if [[ "$reader" == qemu-img ]]; then
            qemu-img convert -f qcow2 -O raw "$work/system.disk" "$work/sfs/system.img"
            echo "    the system disk is a qcow2 image of system.img, $(stat -c %s "$work/sfs/system.img") bytes"
        else
            unsquashfs -n -f -d "$work/sfs" "$work/system.disk" >/dev/null
            find "$work/sfs" -maxdepth 1 -type f -printf '    system.sfs holds %f, %s bytes\n'
        fi
        rm -f "$work/system.disk"
        if [[ -f "$work/sfs/system.img" ]]; then
            echo "    /system/etc/prop.default: $(debugfs -R 'stat /etc/prop.default' "$work/sfs/system.img" 2>&1 | grep -E 'Type:|not found' | head -1)"
            echo "    /system/build.prop, the lines for keys the diet touches:"
            debugfs -R 'cat /build.prop' "$work/sfs/system.img" 2>/dev/null | grep -E "^($keys)" | sed 's/^/        /' || echo "        (none)"
            echo "    /system/framework architectures: $(debugfs -R 'ls -p /framework' "$work/sfs/system.img" 2>/dev/null | cut -d/ -f6 | grep -E '^(x86|x86_64|arm|arm64|oat)$' | tr '\n' ' ')"

            # The kernel module fix (boot-diet.js, TTM_FIX): the module the
            # image ships must be the one the page knows, and the page's
            # script, sourced like /init sources it (in /android, with the
            # system image at ./system), must put the patched copy over it.
            # "mount" is a shell function here: binding needs root.
            read -r ttm_path ttm_sha ttm_patched ttm_offset < <(node --input-type=module -e "
                import { TTM_FIX as f } from '$repo/web/js/boot-diet.js';
                console.log(f.module, f.sha256, f.patchedSha256, f.offset);")
            mkdir -p "$work/android/$(dirname "$ttm_path")"
            debugfs -R "dump /${ttm_path#system/} $work/android/$ttm_path" "$work/sfs/system.img" >/dev/null 2>&1 || true
            if [[ "$(sha256sum < "$work/android/$ttm_path" | cut -c1-64)" == "$ttm_sha" ]]; then
                pass "ttm fix: the image's ttm.ko is the one the page knows ($(stat -c %s "$work/android/$ttm_path") bytes)"
            else
                bad "ttm fix: /$ttm_path is not the module the page knows (sha256 $(sha256sum < "$work/android/$ttm_path" | cut -c1-64))"
            fi
            # Provisioning (boot-diet.js, PROVISION): the packages the page
            # hides are directories of the image; the script binds an empty
            # one over each and adds its action to init.rc only once.
            hide="$(node --input-type=module -e "
                import { PROVISION as p } from '$repo/web/js/boot-diet.js';
                console.log(p.hide.join(' '));")"
            want_mounts=""
            for dir in $hide; do
                if debugfs -R "stat /${dir#system/}" "$work/sfs/system.img" 2>/dev/null | grep -q 'Type: directory'; then
                    pass "provisioning: /$dir is a directory of the image ($(debugfs -R "ls -p /${dir#system/}" "$work/sfs/system.img" 2>/dev/null | cut -d/ -f6 | grep -v '^\.*$' | tr '\n' ' '))"
                    mkdir -p "$work/android/$dir"
                    want_mounts+="mount --bind porty-empty $dir"$'\n'
                else
                    bad "provisioning: the image has no directory /$dir"
                fi
            done
            echo "    the ramdisk's sh and cmd come from the image: $(debugfs -R 'stat /bin/cmd' "$work/sfs/system.img" 2>/dev/null | grep -o 'Type: [a-z]*' | head -1), exec_background in init: $(grep -c -a exec_background "$work/ramdisk/init")"
            # shellcheck disable=SC2016
            said="$(cd "$work/android" && busybox sh -c 'mount() { echo "mount $*"; }; for s in `ls "$1"/scripts/*`; do test -e "$s" && source $s; done' sh "$work/combined" 2>&1)" || true
            echo "    the scripts printed: $said"
            if [[ "$said" == *"mount --bind porty-ttm.ko $ttm_path"*"porty: ttm.ko fixed (2 bytes at $ttm_offset)"* ]] \
                && [[ "$(sha256sum < "$work/android/porty-ttm.ko" | cut -c1-64)" == "$ttm_patched" ]]; then
                pass "ttm fix: the script binds a copy with the expected hash over the module"
            else
                bad "ttm fix: script output or the patched copy"
            fi
            if [[ "$(grep '^mount --bind porty-empty ' <<<"$said")"$'\n' == "$want_mounts" ]] \
                && [[ "$said" == *"porty: provisioning at boot_completed (5 settings), hidden: SetupWizard AnalyticsService Taskbar"* ]] \
                && [[ -d "$work/android/porty-empty" && -z "$(ls -A "$work/android/porty-empty")" ]] \
                && [[ "$(grep -c '^# porty: provisioning' "$work/android/init.rc")" == 1 ]]; then
                pass "provisioning: the script binds an empty directory over the three packages; init.rc has the action once"
            else
                bad "provisioning: script output or init.rc"
            fi
            if command -v objdump >/dev/null; then
                before="$(objdump -d --disassemble=ttm_bo_vm_open "$work/android/$ttm_path" | grep -c -E '\sjne\s' || true)"
                after="$(objdump -d --disassemble=ttm_bo_vm_open "$work/android/porty-ttm.ko" | grep -c -E '\sjne\s' || true)"
                echo "    ttm_bo_vm_open in the patched copy:"
                objdump -d --disassemble=ttm_bo_vm_open "$work/android/porty-ttm.ko" | sed -n '/<ttm_bo_vm_open>:/,/^$/p' | sed 's/^/        /'
                if [[ "$before" == 1 && "$after" == 0 ]]; then
                    pass "ttm fix: ttm_bo_vm_open no longer branches to its WARN_ON (jne: $before before, $after after)"
                else
                    bad "ttm fix: jne in ttm_bo_vm_open: $before before, $after after"
                fi
            else
                echo "SKIP  ttm fix: no objdump to disassemble ttm_bo_vm_open"
            fi
        else
            echo "    no system.img inside system.sfs; build.prop not inspected"
        fi
        rm -rf "$work/sfs"
    else
        echo "SKIP  /system inspection: needs $reader and debugfs"
    fi
fi

[[ "$fail" == 0 ]] && echo "boot-diet-image: all checks passed"
exit "$fail"
