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
//
// The same script also replaces one kernel module, ttm.ko, with a copy in
// which two bytes differ (TTM_FIX below): without that the guest's kernel
// panics as soon as Android collects stack traces.
//
// And it does what a setup wizard would have done (PROVISION below): the
// only one in the image crashes without Google's services.
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

// The kernel fix.  Android-x86 9.0-r2 draws through the fbdev emulation of
// bochs-drm: surfaceflinger maps /dev/graphics/fb0, and that mapping
// (bochsfb_mmap -> ttm_fbdev_mmap) uses TTM's vm_ops on a file that is not
// the DRM device.  When such a process forks, ttm_bo_vm_open() runs
//     WARN_ON(bo->bdev->dev_mapping != vma->vm_file->f_mapping);
// which is always true for an fbdev mapping.  Anywhere else that is a line
// in the log.  This kernel's do_invalid_op() was replaced by an SSE4/POPCNT
// emulator that never calls fixup_bug(), so the WARN's ud2 is an "invalid
// opcode" oops, and Android's init has set kernel.panic_on_oops=1: "Kernel
// panic - not syncing: Fatal exception", reboot.  surfaceflinger forks
// whenever debuggerd dumps its stack, which ActivityManager asks for after
// every "not responding" app and the Watchdog after 30 s: all the time in a
// guest that runs 50-100 times slower than a phone.
//
// The fix turns the WARN_ON's conditional jump into a 2-byte NOP, so that
// ttm_bo_vm_open() only takes its reference:
//     65c6: 48 39 8a e0 06 00 00   cmp  %rcx,0x6e0(%rdx)
//     65cd: 75 11                  jne  65e0   ->   66 90  (nop)
//     65cf: f0 ff 43 28            lock incl 0x28(%rbx)
// (.text starts at 0x70 in the file.)  /init has mounted the system image
// at /android/system when it sources the script and loads modules only
// afterwards (load_modules, later Android's own modprobe), so the copy,
// bind-mounted over the file, is the module the kernel gets.  The script
// touches nothing unless the file is exactly the one known here.
// Checked against the image by tests/boot-diet-image.sh --system, and by
// booting in .github/workflows/ttm-panic.yml.
export const TTM_FIX = {
    module: 'system/lib/modules/4.19.110-android-x86_64-g066cc1d/kernel/drivers/gpu/drm/ttm/ttm.ko',
    sha256: '25e53cd13eb8af090f0aef504085413ff3213da485337229d482ccb3d72d6536',
    offset: 0x70 + 0x65cd,
    bytes: [0x66, 0x90],
    patchedSha256: '1958d6138042f15e0b83369914962e7d0d041ac0e831ec44cadb8908b3166408',
};

// Provisioning: what stands between a first boot and the home screen.
//
// A new Android has Settings.Global.DEVICE_PROVISIONED = 0 and
// Settings.Secure.USER_SETUP_COMPLETE = 0 (SettingsProvider's defaults.xml:
// def_device_provisioned and def_user_setup_complete are false, and no
// property changes them).  The setup wizard, the HOME activity with the
// highest priority, sets both to 1 and disables itself; that is all AOSP's
// own wizard does (packages/apps/Provision, DefaultActivity.onCreate).
// Until then the home key and the notification shade stay off.
//
// Android-x86 9.0-r2 has no Provision app, only Google's SetupWizard, and
// the published image has none of Google's services: with SETUPWIZARD=0 the
// wizard still starts and dies in onCreate ("SecurityException: Failed to
// find provider com.google.settings", the provider of the removed
// GoogleServicesFramework), again and again: "Android Setup keeps
// stopping" over a black screen, for good.  So:
//
//   - hide: three packages are kept from PackageManagerService by binding
//     an empty directory over theirs (it skips a directory without an APK):
//     SetupWizard; AnalyticsService (org.android_x86.analytics, which
//     crashes without Play services' analytics, "RuntimeException: Stub!",
//     and has nobody to report to without a network); and Taskbar, the
//     second launcher: with two HOME activities of the same priority and no
//     preference, Android asks "Select a Home app" (ResolverActivity)
//     instead of showing one.  Launcher3 remains as the only launcher.
//   - settings: once Android has booted (sys.boot_completed=1, the trigger
//     Android-x86's own init.android_x86_64.rc uses for init.sh), init runs
//     "cmd settings put" for the two settings, which is what
//     /system/bin/settings does.  SystemUI and the window manager observe
//     both settings and follow.
//
// Not with setup=1 (the wizard was asked for).  Evidence: native boots in
// .github/workflows/provisioning.yml.
export const PROVISION = {
    hide: ['system/priv-app/SetupWizard', 'system/priv-app/AnalyticsService', 'system/priv-app/Taskbar'],
    settings: [
        ['global', 'device_provisioned', '1'], ['secure', 'user_setup_complete', '1'],
        // No window, transition or animator animations: every frame of one
        // is composed in software, and after a tap surfaceflinger took
        // almost all of the guest's CPU while Gallery got about 4% (input
        // probe, run 43909266297).  The developer options' "animation
        // scale" settings; WindowManager follows them at once.
        ['global', 'window_animation_scale', '0'], ['global', 'transition_animation_scale', '0'],
        ['global', 'animator_duration_scale', '0'],
    ],
};

const FIX_PATH = /^[A-Za-z0-9._/-]{1,200}$/;
const SETTING = /^[a-z0-9_]{1,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Which fixes a config gets: { ttm: false | TTM_FIX, provision: false |
 * PROVISION }.  The kernel fix not with gfx=vesa (nomodeset: bochs-drm never
 * drives the screen, nothing maps a TTM buffer) and not with ttmfix=0; the
 * provisioning not with setup=1.
 */
export function dietFixes(cfg) {
    return {
        ttm: cfg.ttmfix !== false && cfg.gfx !== 'vesa' ? TTM_FIX : false,
        provision: cfg.setup ? false : PROVISION,
    };
}

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

/** For the configuration line: " props: k=v k=v" and the fixes. */
export function describeDiet(cfg) {
    const props = dietProps(cfg);
    return (props.length ? ` props: ${props.map((p) => p.join('=')).join(' ')}` : ' props: none')
        + (dietFixes(cfg).ttm ? ' ttmfix' : '') + (dietFixes(cfg).provision ? ' provisioned' : '');
}

/** Shell lines that set the properties (empty: none to set). */
function propLines(props) {
    if (!props.length) {
        return [];
    }
    const drop = props.map(([key]) => `-e '/^${key.replace(/\./g, '\\.')}=/d'`).join(' ');
    const zygote64 = props.some(([key, value]) => key === 'ro.zygote' && value === 'zygote64');
    return [
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
    ];
}

/**
 * Shell lines that put a patched copy of a kernel module in its place (see
 * TTM_FIX).  The copy lives in the root tmpfs; every step is checked by
 * hash, and the original stays in place when anything is not as expected.
 */
function moduleFixLines(fix) {
    if (!fix) {
        return [];
    }
    const ok = FIX_PATH.test(fix.module) && !fix.module.includes('..') && SHA256.test(fix.sha256)
        && SHA256.test(fix.patchedSha256) && Number.isSafeInteger(fix.offset) && fix.offset >= 0
        && Array.isArray(fix.bytes) && fix.bytes.length > 0 && fix.bytes.length <= 16
        && fix.bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255);
    if (!ok) {
        throw new Error(`dietScript: bad module fix ${JSON.stringify(fix)}`);
    }
    const name = fix.module.split('/').pop();
    const octal = fix.bytes.map((b) => `\\${b.toString(8).padStart(3, '0')}`).join('');
    return [
        'porty_module()',
        '{',
        `\tporty_m=${fix.module}`,
        '\tif [ ! -f $porty_m ]; then',
        `\t\techo "porty: no ${name}, nothing to fix"`,
        '\t\treturn',
        '\tfi',
        `\tif [ "$(sha256sum < $porty_m | cut -c1-64)" != ${fix.sha256} ]; then`,
        `\t\techo "porty: ${name} is not the one known, left alone"`,
        '\t\treturn',
        '\tfi',
        `\tcat $porty_m > porty-${name}`,
        `\tprintf '${octal}' | dd of=porty-${name} bs=1 seek=${fix.offset} conv=notrunc 2>/dev/null`,
        `\tif [ "$(sha256sum < porty-${name} | cut -c1-64)" = ${fix.patchedSha256} ] \\`,
        `\t\t&& mount --bind porty-${name} $porty_m; then`,
        `\t\techo "porty: ${name} fixed (${fix.bytes.length} bytes at ${fix.offset})"`,
        '\telse',
        `\t\trm -f porty-${name}`,
        `\t\techo "porty: ${name} could not be fixed, left alone"`,
        '\tfi',
        '}',
        'porty_module',
    ];
}

/**
 * Shell lines that provision the device (see PROVISION): packages hidden
 * under an empty directory of the root tmpfs, and an action appended to
 * init.rc.  Sourcing the script twice changes nothing more.
 */
function provisionLines(provision) {
    if (!provision) {
        return [];
    }
    const { hide, settings } = provision;
    const ok = Array.isArray(hide) && hide.length <= 16
        && hide.every((dir) => typeof dir === 'string' && FIX_PATH.test(dir) && !dir.includes('..') && dir.startsWith('system/'))
        && Array.isArray(settings) && settings.length > 0 && settings.length <= 8
        && settings.every((item) => Array.isArray(item) && item.length === 3 && /^(global|secure|system)$/.test(item[0])
            && SETTING.test(item[1]) && SETTING.test(item[2]));
    if (!ok) {
        throw new Error(`dietScript: bad provisioning ${JSON.stringify(provision)}`);
    }
    const put = settings.map((item) => `cmd settings put ${item.join(' ')}`).join('; ');
    return [
        'porty_provision()',
        '{',
        '\tif [ ! -f init.rc ]; then',
        '\t\techo "porty: no init.rc, device not provisioned"',
        '\t\treturn',
        '\tfi',
        '\tporty_n=',
        '\tmkdir -p porty-empty',
        `\tfor porty_d in ${hide.join(' ')}; do`,
        '\t\tif [ -d $porty_d ] && mount --bind porty-empty $porty_d; then',
        '\t\t\tporty_n="$porty_n ${porty_d##*/}"',
        '\t\tfi',
        '\tdone',
        "\tif ! grep -q '^# porty: provisioning' init.rc; then",
        "\t\tcat >> init.rc <<'PORTY_EOF'",
        '',
        '# porty: provisioning (web/js/boot-diet.js)',
        'on property:sys.boot_completed=1',
        `    exec_background u:r:init:s0 -- /system/bin/sh -c "${put}"`,
        'PORTY_EOF',
        '\tfi',
        `\techo "porty: provisioning at boot_completed (${settings.length} settings), hidden:\${porty_n:- nothing}"`,
        '}',
        'porty_provision',
    ];
}

/**
 * The script for the initrd (busybox ash, sourced by /init from /android).
 * Lines for the same keys are removed first: init keeps the first value of
 * a "ro." property and the last of any other.
 * @param props  [[key, value]...]
 * @param fixes  { ttm: false | a module fix like TTM_FIX, provision: false | PROVISION }
 */
export function dietScript(props, fixes = {}) {
    for (const [key, value] of props) {
        if (!KEY.test(key) || !VALUE.test(value)) {
            throw new Error(`dietScript: bad property ${JSON.stringify([key, value])}`);
        }
    }
    return [
        '# Porty boot diet, written by the web page (web/js/boot-diet.js).',
        '# Sourced by /init in /android after ramdisk.img was unpacked there.',
        ...propLines(props),
        ...moduleFixLines(fixes.ttm),
        ...provisionLines(fixes.provision),
        '',
    ].join('\n');
}

/** The archive the page appends: /scripts (in case it is missing) and the script. */
export function dietArchive(props, fixes = {}) {
    return newcArchive([
        { name: 'scripts', mode: 0o040755 },
        { name: DIET_SCRIPT, mode: 0o100644, data: dietScript(props, fixes) },
    ]);
}

/** initrd.img with the diet script appended; unchanged when there is nothing to do. */
export function applyBootDiet(initrd, props, fixes = {}) {
    return props.length || fixes.ttm || fixes.provision ? appendInitramfs(initrd, dietArchive(props, fixes)) : initrd;
}
