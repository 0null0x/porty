// Boot diet: Android system properties that cut work out of the (always
// first) boot, set without rebuilding the image.
//
// How they get in.  Android-x86's initrd /init unpacks ramdisk.img into a
// tmpfs at /android, stays in that directory, and then sources every file
// in /scripts ("for s in `ls /scripts/* /src/scripts/*`; do test -e "$s" &&
// source $s; done").  Only after that it appends its own lines to
// default.prop (SETUPWIZARD=0, DPI=) and switches root.  The page appends a
// second, tiny cpio archive with one more script to initrd.img (see
// initramfs.js); the script rewrites default.prop, which Android's init
// reads before anything else (system/core/init/property_service.cpp,
// property_load_boot_defaults: /system/etc/prop.default, else /prop.default,
// else /default.prop).
//
// Sources for each property are AOSP pie-release; measurements are from
// Porty's boot tests of 2026-11-16 (docs/PLAN.md).
// Pure functions (no DOM).
// SPDX-License-Identifier: GPL-2.0-or-later

import { appendInitramfs, newcArchive } from './initramfs.js';

export const DIET_SCRIPT = 'scripts/99-porty';

const KEY = /^[A-Za-z0-9._-]{1,96}$/;
const VALUE = /^[A-Za-z0-9._-]{0,91}$/; // PROP_VALUE_MAX is 92 with the NUL

export const DIET_LEVELS = [
    // diet=0
    [],
    // diet=1 (default)
    [
        // bootanimation exits at once (cmds/bootanimation/BootAnimationUtil.cpp,
        // bootAnimationDisabled), instead of drawing frames through SwiftShader
        // on the guest's only CPU for the whole boot.  The screen stays black
        // until the launcher draws.
        ['debug.sf.nobootanimation', '1'],
        // First-boot dexopt (SystemServer "UpdatePackagesIfNeeded" ->
        // PackageManagerService.updatePackagesIfNeeded, REASON_FIRST_BOOT /
        // REASON_BOOT; filter from PackageManagerServiceCompilerMapping).
        // userdebug builds ship "quicken"/"verify", eng builds "extract"
        // (build/make/target/product/runtime_libart.mk).  With quicken,
        // dex2oat verified Chrome, GmsCore and three more apps for about 50
        // minutes of a boot test; extract only unpacks the dex files.
        ['pm.dexopt.first-boot', 'extract'],
        ['pm.dexopt.boot', 'extract'],
    ],
    // diet=2 (experiment): additionally a 64-bit-only Android, like AOSP's
    // core_64_bit_only.mk.  No 32-bit zygote, so system_server's
    // "SecondaryZygotePreload" (20 and 24 minutes in two boot tests, beside
    // everything else on one CPU) never runs.  32-bit-only apps cannot run.
    // Needs /init.zygote64.rc, which the script derives from
    // /init.zygote64_32.rc when the ramdisk has none.
    [
        ['ro.zygote', 'zygote64'],
        ['ro.product.cpu.abilist', 'x86_64'],
        ['ro.product.cpu.abilist32', ''],
    ],
];

/** "k=v,k=v" from the URL -> { props: [[k, v]...], rejected: n }. */
export function parseProps(raw) {
    const props = [];
    let rejected = 0;
    for (const item of (raw || '').split(',')) {
        if (item === '') {
            continue;
        }
        const eq = item.indexOf('=');
        const key = eq < 0 ? '' : item.slice(0, eq);
        const value = item.slice(eq + 1);
        if (KEY.test(key) && VALUE.test(value) && props.length < 32) {
            props.push([key, value]);
        } else {
            rejected += 1;
        }
    }
    return { props, rejected };
}

/**
 * The properties a config asks for, in order, each key once: the levels up
 * to cfg.diet, then cfg.props (which override).
 * @returns {[string, string][]}
 */
export function dietProps(cfg) {
    const level = Math.min(DIET_LEVELS.length - 1, Math.max(0, cfg.diet ?? 1));
    const merged = new Map();
    for (const [key, value] of [...DIET_LEVELS.slice(0, level + 1).flat(), ...(cfg.props || [])]) {
        merged.delete(key);
        merged.set(key, value);
    }
    return [...merged];
}

/** For the configuration line: " props: k=v k=v". */
export function describeDiet(cfg) {
    const props = dietProps(cfg);
    return props.length ? ` props: ${props.map((p) => p.join('=')).join(' ')}` : ' props: none';
}

/**
 * The script for the initrd (busybox ash, sourced by /init from /android).
 * Lines for the same keys are removed first: init keeps the first value of
 * a "ro." property and the last of any other.
 */
export function dietScript(props) {
    for (const [key, value] of props) {
        if (!KEY.test(key) || !VALUE.test(value)) {
            throw new Error(`dietScript: bad property ${JSON.stringify([key, value])}`);
        }
    }
    const drop = props.map(([key]) => `-e '/^${key.replace(/\./g, '\\.')}=/d'`).join(' ');
    const zygote64 = props.some(([key, value]) => key === 'ro.zygote' && value === 'zygote64');
    return [
        '# Porty boot diet, written by the web page (web/js/boot-diet.js).',
        '# Sourced by /init in /android after ramdisk.img was unpacked there.',
        'porty_diet()',
        '{',
        '\tporty_f=default.prop',
        '\t[ -e system/etc/prop.default ] && porty_f=system/etc/prop.default',
        '\tif [ ! -e $porty_f ]; then',
        '\t\techo "porty: no $porty_f, boot diet skipped"',
        '\t\treturn',
        '\tfi',
        `\tsed ${drop} $porty_f > porty.prop`,
        '\techo >> porty.prop',
        "\tcat >> porty.prop <<'PORTY_EOF'",
        ...props.map((p) => p.join('=')),
        'PORTY_EOF',
        '\tif [ $porty_f = default.prop ]; then',
        '\t\tcat porty.prop > default.prop',
        '\t\trm porty.prop',
        '\telse',
        '\t\tmount --bind porty.prop $porty_f',
        '\tfi',
        ...(zygote64 ? [
            '\tif [ ! -e init.zygote64.rc -a -e init.zygote64_32.rc ]; then',
            "\t\tsed '/^service zygote_secondary/,$d' init.zygote64_32.rc > init.zygote64.rc",
            '\t\tchmod 750 init.zygote64.rc',
            '\tfi',
        ] : []),
        `\techo "porty: boot diet, ${props.length} properties in $porty_f"`,
        '}',
        'porty_diet',
        '',
    ].join('\n');
}

/** The archive the page appends: /scripts (in case it is missing) and the script. */
export function dietArchive(props) {
    return newcArchive([
        { name: 'scripts', mode: 0o040755 },
        { name: DIET_SCRIPT, mode: 0o100644, data: dietScript(props) },
    ]);
}

/** initrd.img with the diet script appended; unchanged when there is nothing to set. */
export function applyBootDiet(initrd, props) {
    return props.length ? appendInitramfs(initrd, dietArchive(props)) : initrd;
}
