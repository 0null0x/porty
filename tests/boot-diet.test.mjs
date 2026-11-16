// node tests/boot-diet.test.mjs   (also run by tests/unit.test.mjs)
// The newc cpio encoder, the boot-diet script and their URL parameters.
// SPDX-License-Identifier: GPL-2.0-or-later
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { parseConfig } from '../web/js/config.js';
import {
    DIET_LEVELS, DIET_SCRIPT, PROVISION, TTM_FIX, applyBootDiet, describeDiet, dietArchive, dietFixes, dietProps, dietScript,
    parseProps,
} from '../web/js/boot-diet.js';
import { appendInitramfs, appendOffset, newcArchive, parseNewc } from '../web/js/initramfs.js';

const ascii = (bytes) => Buffer.from(bytes).toString('latin1');
const have = (tool) => spawnSync(tool, ['--help'], { stdio: 'ignore' }).error === undefined;

// --- newc encoder: byte for byte ------------------------------------------------
{
    const one = newcArchive([{ name: 'a', mode: 0o100644, data: 'hi\n' }]);
    assert.equal(ascii(one),
        // magic  ino      mode     uid      gid      nlink    mtime    filesize
        '070701' + '00000001' + '000081A4' + '00000000' + '00000000' + '00000001' + '00000000' + '00000003' +
        // devmajor devminor rdevmajor rdevminor namesize check, then name + NUL (header + name: 112, aligned)
        '00000000' + '00000000' + '00000000' + '00000000' + '00000002' + '00000000' + 'a\0' +
        'hi\n\0' + // data, padded to four bytes
        '070701' + '00000000' + '00000000' + '00000000' + '00000000' + '00000001' + '00000000' + '00000000' +
        '00000000' + '00000000' + '00000000' + '00000000' + '0000000B' + '00000000' + 'TRAILER!!!\0' + '\0\0\0');
    assert.equal(one.length, 112 + 4 + 124);

    // header + name + NUL is padded on its own: 113 and 114 bytes both become 116
    assert.equal(newcArchive([{ name: 'ab', mode: 0o100644, data: 'x' }]).length, 116 + 4 + 124);
    assert.equal(ascii(newcArchive([{ name: 'abc', mode: 0o100644, data: 'wxyz' }])).slice(110, 126), 'abc\0\0\0wxyz070701');
    // directories: nlink 2, no data; inode numbers count up
    const two = ascii(newcArchive([{ name: 'd', mode: 0o040755 }, { name: 'd/f', mode: 0o100600, data: new Uint8Array([1, 2]) }]));
    assert.equal(two.slice(0, 62), '070701' + '00000001' + '000041ED' + '00000000' + '00000000' + '00000002' + '00000000' + '00000000');
    assert.equal(two.slice(112, 112 + 22), '070701' + '00000002' + '00008180');
    assert.throws(() => newcArchive([{ name: '/abs', mode: 0o100644 }]));
    assert.throws(() => newcArchive([{ name: 'sp ace', mode: 0o100644 }]));

    const back = parseNewc(newcArchive([{ name: 'd', mode: 0o040755 }, { name: 'd/f', mode: 0o100600, data: 'body!' }]));
    assert.deepEqual(back.entries.map((e) => [e.name, e.mode, ascii(e.data)]), [['d', 0o040755, ''], ['d/f', 0o100600, 'body!']]);
    assert.throws(() => parseNewc(new Uint8Array(200)));
}

// --- appending to an existing initrd -----------------------------------------------
{
    const archive = dietArchive([['a.b', '1']]);
    for (let extra = 0; extra < 4; extra++) {
        // a gzip initrd of any length: the kernel wants the next archive on a 4-byte boundary
        const gz = gzipSync(Buffer.from(newcArchive([{ name: 'init', mode: 0o100755, data: 'x' }])));
        const size = gz.length + extra;
        const padded = new Uint8Array(size);
        padded.set(gz);
        const out = appendInitramfs(padded, archive);
        const at = appendOffset(size);
        assert.equal(at % 4, 0);
        assert.ok(at >= size && at - size < 4);
        assert.deepEqual([...out.subarray(0, size)], [...padded], 'the original initrd is untouched');
        assert.ok(out.subarray(size, at).every((b) => b === 0), 'only NUL padding in between');
        const parsed = parseNewc(out, at);
        assert.equal(parsed.end, out.length, 'the archive ends the initrd');
        assert.deepEqual(parsed.entries.map((e) => e.name), ['scripts', DIET_SCRIPT]);
    }
}

// --- URL parameters ---------------------------------------------------------------------
{
    const dflt = parseConfig('', {});
    assert.equal(dflt.diet, 1);
    assert.deepEqual(dietProps(dflt), [
        ['debug.sf.nobootanimation', '1'], ['pm.dexopt.first-boot', 'extract'], ['pm.dexopt.boot', 'extract']]);
    assert.equal(describeDiet(dflt), ' props: debug.sf.nobootanimation=1 pm.dexopt.first-boot=extract pm.dexopt.boot=extract ttmfix provisioned');
    // the screen must come on: never the quiescent boot
    assert.ok(DIET_LEVELS.flat().every(([k]) => !/quiescent/.test(k)));

    const off = parseConfig('?diet=0', {});
    assert.deepEqual(dietProps(off), []);
    assert.equal(describeDiet(off), ' props: none ttmfix provisioned');
    assert.equal(describeDiet(parseConfig('?diet=0&ttmfix=0&setup=1', {})), ' props: none');
    assert.equal(describeDiet(parseConfig('?diet=0&ttmfix=0', {})), ' props: none provisioned');
    assert.deepEqual(dietProps(parseConfig('?diet=0&props=a.b=c', {})), [['a.b', 'c']]);
    assert.equal(parseConfig('?diet=7', {}).diet, 2);
    assert.deepEqual(dietProps(parseConfig('?diet=2', {})).slice(3), [
        ['ro.zygote', 'zygote64'], ['ro.product.cpu.abilist', 'x86_64'], ['ro.product.cpu.abilist32', '']]);

    // props add and override; an overridden key moves to the end, once
    const more = parseConfig('?props=config.disable_cameraservice=1,debug.sf.nobootanimation=0,x-y_z.9=', {});
    assert.deepEqual(dietProps(more), [
        ['pm.dexopt.first-boot', 'extract'], ['pm.dexopt.boot', 'extract'],
        ['config.disable_cameraservice', '1'], ['debug.sf.nobootanimation', '0'], ['x-y_z.9', '']]);
    assert.equal(more.propsRejected, 0);

    // strict: nothing that could leave the property file or the script's here-document
    const evil = parseConfig('?props=' + encodeURIComponent(
        'ok=1,a=b c,a b=c,=v,novalue,a=$(reboot),a=`x`,a="q",PORTY_EOF,a=b\nPORTY_EOF\nreboot,k=v;w,a/b=c,a=b=c,' +
        `long=${'v'.repeat(92)},${'k'.repeat(97)}=v,last=91${'v'.repeat(89)}`), {});
    assert.deepEqual(evil.props.map((p) => p[0]), ['ok', 'last']);
    assert.equal(evil.propsRejected, 14);
    assert.equal(parseProps(Array.from({ length: 40 }, (_, i) => `k${i}=v`).join(',')).props.length, 32);
    assert.deepEqual(parseProps(null), { props: [], rejected: 0 });
    assert.throws(() => dietScript([['a', 'b\nreboot']]));
    assert.throws(() => dietScript([['a b', 'c']]));
}

// --- the script ------------------------------------------------------------------------
{
    const props = dietProps(parseConfig('?diet=2', {}));
    const script = dietScript(props);
    assert.match(script, /sed -e '\/\^debug\\\.sf\\\.nobootanimation=\/d' -e '\/\^pm\\\.dexopt\\\.first-boot=\/d' /);
    assert.match(script, /<<'PORTY_EOF'\ndebug\.sf\.nobootanimation=1\npm\.dexopt\.first-boot=extract\npm\.dexopt\.boot=extract\nro\.zygote=zygote64\nro\.product\.cpu\.abilist=x86_64\nro\.product\.cpu\.abilist32=\nPORTY_EOF\n/);
    assert.ok(!dietScript(dietProps(parseConfig('', {}))).includes('zygote'));

    const initrd = new Uint8Array([0x1f, 0x8b, 8, 0, 0]);
    assert.equal(applyBootDiet(initrd, []), initrd, 'diet=0 leaves the initrd alone');
    const out = applyBootDiet(initrd, props);
    const { entries } = parseNewc(out, 8);
    assert.equal(ascii(entries[1].data), script);
    assert.deepEqual(entries.map((e) => e.mode), [0o040755, 0o100644]);

    // GNU cpio reads the archive
    if (have('cpio')) {
        const list = spawnSync('cpio', ['-t', '--quiet'], { input: Buffer.from(dietArchive(props)) });
        assert.equal(list.status, 0, String(list.stderr));
        assert.equal(String(list.stdout), `scripts\n${DIET_SCRIPT}\n`);
    } else {
        console.log('boot-diet: no cpio here, skipped the cpio cross-check');
    }

    // Run it the way Android-x86's /init does: sourced, in the directory that
    // holds the unpacked ramdisk.
    const shell = have('busybox') ? ['busybox', 'sh'] : ['sh'];
    const dir = mkdtempSync(path.join(tmpdir(), 'porty-diet-'));
    try {
        // no newline at the end, an "ro." value to replace, a look-alike key to keep
        writeFileSync(path.join(dir, 'default.prop'),
            'ro.zygote=zygote64_32\npm.dexopt.first-boot=quicken\npm.dexopt.bootX=keep\nro.debuggable=1', { mode: 0o600 });
        writeFileSync(path.join(dir, 'init.zygote64_32.rc'),
            'service zygote /system/bin/app_process64\n    class main\n\nservice zygote_secondary /system/bin/app_process32\n    class main\n');
        writeFileSync(path.join(dir, 'script'), script);
        const run = spawnSync(shell[0], [...shell.slice(1), '-c',
            '. ./script; echo "ro.setupwizard.mode=DISABLED" >> default.prop'], { cwd: dir });
        assert.equal(run.status, 0, String(run.stderr));
        assert.equal(String(run.stdout), 'porty: boot diet, 6 properties in default.prop\n');
        // (busybox sed keeps the missing last newline, GNU sed adds one: allow an empty line)
        assert.equal(readFileSync(path.join(dir, 'default.prop'), 'utf8').replace(/\n\n/g, '\n'),
            'pm.dexopt.bootX=keep\nro.debuggable=1\n' + props.map((p) => p.join('=')).join('\n') +
            '\nro.setupwizard.mode=DISABLED\n');
        assert.equal(readFileSync(path.join(dir, 'init.zygote64.rc'), 'utf8'),
            'service zygote /system/bin/app_process64\n    class main\n\n');
        assert.ok(!existsSync(path.join(dir, 'porty.prop')));

        // a ramdisk without default.prop: say so, change nothing
        rmSync(path.join(dir, 'default.prop'));
        const none = spawnSync(shell[0], [...shell.slice(1), '-c', '. ./script'], { cwd: dir });
        assert.equal(String(none.stdout), 'porty: no default.prop, boot diet skipped\n');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

// --- the kernel module fix (ttm.ko) -----------------------------------------------------
{
    // On by default, also without any property; off with gfx=vesa and ttmfix=0.
    assert.equal(parseConfig('', {}).ttmfix, true);
    assert.equal(dietFixes(parseConfig('', {})).ttm, TTM_FIX);
    assert.equal(dietFixes(parseConfig('?diet=0', {})).ttm, TTM_FIX);
    assert.equal(dietFixes(parseConfig('?ttmfix=0', {})).ttm, false);
    assert.equal(dietFixes(parseConfig('?gfx=vesa', {})).ttm, false);
    assert.equal(describeDiet(parseConfig('?gfx=vesa', {})).includes('ttmfix'), false);

    // What is known about the module: the jne of ttm_bo_vm_open's WARN_ON
    // (0x65cd in .text, which starts at 0x70 in the file) becomes "66 90".
    assert.equal(TTM_FIX.offset, 26173);
    assert.deepEqual(TTM_FIX.bytes, [0x66, 0x90]);
    assert.match(TTM_FIX.module, /^system\/lib\/modules\/4\.19\.110-android-x86_64-g066cc1d\/kernel\/drivers\/gpu\/drm\/ttm\/ttm\.ko$/);
    assert.match(TTM_FIX.sha256, /^[0-9a-f]{64}$/);
    assert.match(TTM_FIX.patchedSha256, /^[0-9a-f]{64}$/);
    assert.notEqual(TTM_FIX.sha256, TTM_FIX.patchedSha256);

    // The script: the properties' part is unchanged, the fix follows it.
    const props = dietProps(parseConfig('', {}));
    const plain = dietScript(props);
    assert.equal(dietScript(props, { ttm: false }), plain);
    assert.ok(!plain.includes('porty_module'));
    const fixed = dietScript(props, { ttm: TTM_FIX });
    assert.ok(fixed.startsWith(plain.slice(0, -1)), 'the fix is appended to the script');
    assert.match(fixed, /\n\tprintf '\\146\\220' \| dd of=porty-ttm\.ko bs=1 seek=26173 conv=notrunc 2>\/dev\/null\n/);
    assert.match(fixed, /&& mount --bind porty-ttm\.ko \$porty_m; then\n/);
    assert.ok(dietScript([], { ttm: TTM_FIX }).includes('porty_module') && !dietScript([], { ttm: TTM_FIX }).includes('porty_diet'));

    // An initrd gets the archive for the fix alone, too.
    const initrd = new Uint8Array([0x1f, 0x8b, 8, 0, 0]);
    assert.equal(applyBootDiet(initrd, [], { ttm: false }), initrd);
    const withFix = applyBootDiet(initrd, [], { ttm: TTM_FIX });
    assert.equal(ascii(parseNewc(withFix, 8).entries[1].data), dietScript([], { ttm: TTM_FIX }));
    assert.equal(ascii(parseNewc(dietArchive(props, { ttm: TTM_FIX }), 0).entries[1].data), fixed);

    // Nothing from outside ends up in the script.
    for (const bad of [{ module: 'a b' }, { module: '../x' }, { module: 'a;reboot' }, { sha256: 'xyz' },
        { patchedSha256: '$(reboot)' }, { offset: -1 }, { offset: 1.5 }, { offset: '1; reboot' }, { bytes: [] },
        { bytes: [256] }, { bytes: ['7'] }, { bytes: new Array(17).fill(0) }]) {
        assert.throws(() => dietScript([], { ttm: { ...TTM_FIX, ...bad } }), /bad module fix/, JSON.stringify(bad));
    }

    // Run it like /init does, against a stand-in module: 64 KiB of noise
    // with the jne at the real offset.  "mount" is a shell function here
    // (binding needs root); it records what it was asked to do.
    const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
    const module = new Uint8Array(40000).map((_, i) => (i * 7 + 3) % 256);
    module.set([0x48, 0x39, 0x8a, 0xe0, 0x06, 0x00, 0x00, 0x75, 0x11, 0xf0, 0xff, 0x43, 0x28], TTM_FIX.offset - 7);
    const patched = module.slice();
    patched.set(TTM_FIX.bytes, TTM_FIX.offset);
    const fix = { ...TTM_FIX, sha256: sha256(module), patchedSha256: sha256(patched) };
    const shell = have('busybox') ? ['busybox', 'sh'] : ['sh'];
    const dir = mkdtempSync(path.join(tmpdir(), 'porty-ttm-'));
    const run = (script) => spawnSync(shell[0], [...shell.slice(1), '-c',
        'mount() { echo "mount $*" >> mounts; }; . ./script'], { cwd: dir, input: '' , env: { ...process.env } });
    try {
        const file = path.join(dir, fix.module);
        writeFileSync(path.join(dir, 'default.prop'), 'ro.debuggable=1\n');

        // no module at all (the native tests' tiny guest): say so
        writeFileSync(path.join(dir, 'script'), dietScript([], { ttm: fix }));
        let out = run();
        assert.equal(out.status, 0, String(out.stderr));
        assert.equal(String(out.stdout), 'porty: no ttm.ko, nothing to fix\n');

        // the module that is known: a copy with the two bytes changed, bound over it
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, module);
        writeFileSync(path.join(dir, 'script'), dietScript(props, { ttm: fix }));
        out = run();
        assert.equal(out.status, 0, String(out.stderr));
        assert.equal(String(out.stdout),
            'porty: boot diet, 3 properties in default.prop\nporty: ttm.ko fixed (2 bytes at 26173)\n');
        assert.equal(readFileSync(path.join(dir, 'mounts'), 'utf8'), `mount --bind porty-ttm.ko ${fix.module}\n`);
        const copy = readFileSync(path.join(dir, 'porty-ttm.ko'));
        assert.equal(copy.length, module.length);
        const changed = [...copy].map((b, i) => (b === module[i] ? -1 : i)).filter((i) => i >= 0);
        assert.deepEqual(changed, [26173, 26174]);
        assert.deepEqual([...copy.subarray(26173, 26175)], [0x66, 0x90]);
        assert.deepEqual([...readFileSync(file)], [...module], 'the shipped file itself is not written to');

        // any other module (another build, a changed image): left alone
        rmSync(path.join(dir, 'mounts'));
        rmSync(path.join(dir, 'porty-ttm.ko'));
        const other = module.slice();
        other[100] ^= 1;
        writeFileSync(file, other);
        writeFileSync(path.join(dir, 'script'), dietScript([], { ttm: fix }));
        out = run();
        assert.equal(String(out.stdout), 'porty: ttm.ko is not the one known, left alone\n');
        assert.ok(!existsSync(path.join(dir, 'mounts')) && !existsSync(path.join(dir, 'porty-ttm.ko')));

        // the patch did not give the expected file: no bind, no copy left
        writeFileSync(file, module);
        writeFileSync(path.join(dir, 'script'), dietScript([], { ttm: { ...fix, patchedSha256: sha256(module) } }));
        out = run();
        assert.equal(String(out.stdout), 'porty: ttm.ko could not be fixed, left alone\n');
        assert.ok(!existsSync(path.join(dir, 'mounts')) && !existsSync(path.join(dir, 'porty-ttm.ko')));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

// --- provisioning: no setup wizard, the device marked as set up --------------------------
{
    // On by default, whatever the diet; off when the wizard is asked for.
    assert.equal(dietFixes(parseConfig('', {})).provision, PROVISION);
    assert.equal(dietFixes(parseConfig('?diet=0&ttmfix=0&gfx=vesa', {})).provision, PROVISION);
    assert.equal(dietFixes(parseConfig('?setup=1', {})).provision, false);
    assert.deepEqual(PROVISION.hide,
        ['system/priv-app/SetupWizard', 'system/priv-app/AnalyticsService', 'system/priv-app/Taskbar']);
    assert.deepEqual(PROVISION.settings, [['global', 'device_provisioned', '1'], ['secure', 'user_setup_complete', '1'],
        ['global', 'window_animation_scale', '0'], ['global', 'transition_animation_scale', '0'],
        ['global', 'animator_duration_scale', '0']]);

    // The script: after the properties and the module fix; alone, too.
    const props = dietProps(parseConfig('', {}));
    const before = dietScript(props, { ttm: TTM_FIX });
    const script = dietScript(props, { ttm: TTM_FIX, provision: PROVISION });
    assert.equal(dietScript(props, { ttm: TTM_FIX, provision: false }), before);
    assert.ok(script.startsWith(before.slice(0, -1)), 'provisioning is appended to the script');
    const action = '\n# porty: provisioning (web/js/boot-diet.js)\non property:sys.boot_completed=1\n' +
        '    exec_background u:r:init:s0 -- /system/bin/sh -c "cmd settings put global device_provisioned 1; ' +
        'cmd settings put secure user_setup_complete 1; cmd settings put global window_animation_scale 0; ' +
        'cmd settings put global transition_animation_scale 0; cmd settings put global animator_duration_scale 0"\n';
    assert.ok(script.includes(`<<'PORTY_EOF'\n${action}PORTY_EOF\n`));
    const alone = dietScript([], { provision: PROVISION });
    assert.ok(alone.includes('porty_provision') && !alone.includes('porty_diet') && !alone.includes('porty_module'));
    const initrd = new Uint8Array([0x1f, 0x8b, 8, 0, 0]);
    assert.equal(applyBootDiet(initrd, [], { ttm: false, provision: false }), initrd);
    assert.equal(ascii(parseNewc(applyBootDiet(initrd, [], { provision: PROVISION }), 8).entries[1].data), alone);

    // Nothing from outside ends up in the script.
    for (const bad of [{ hide: ['system/a b'] }, { hide: ['system/../x'] }, { hide: ['data/app'] }, { hide: ['system/a;reboot'] },
        { hide: 'system/app' }, { hide: new Array(17).fill('system/app/X') }, { settings: [] },
        { settings: [['global', 'a', '1; reboot']] }, { settings: [['global', 'a b', '1']] }, { settings: [['x', 'a', '1']] },
        { settings: [['global', 'a', '$(reboot)']] }, { settings: [['global', 'a']] }, { settings: [['global', 'a"', '1']] }]) {
        assert.throws(() => dietScript([], { provision: { ...PROVISION, ...bad } }), /bad provisioning/, JSON.stringify(bad));
    }

    // Run it like /init does, in a stand-in for the unpacked ramdisk with the
    // system image at ./system.  "mount" is a shell function here (binding
    // needs root); it records what it was asked to do.
    const shell = have('busybox') ? ['busybox', 'sh'] : ['sh'];
    const dir = mkdtempSync(path.join(tmpdir(), 'porty-provision-'));
    const run = () => spawnSync(shell[0], [...shell.slice(1), '-c',
        'mount() { echo "mount $*" >> mounts; }; . ./script'], { cwd: dir, input: '' });
    try {
        writeFileSync(path.join(dir, 'script'), alone);

        // no init.rc (the native tests' tiny guest): say so, touch nothing
        mkdirSync(path.join(dir, 'system/priv-app/SetupWizard'), { recursive: true });
        let out = run();
        assert.equal(out.status, 0, String(out.stderr));
        assert.equal(String(out.stdout), 'porty: no init.rc, device not provisioned\n');
        assert.ok(!existsSync(path.join(dir, 'mounts')) && !existsSync(path.join(dir, 'porty-empty')));

        // the image: the wizard and the taskbar are there, the analytics service is not
        const rc = 'import /init.environ.rc\n\non property:sys.boot_completed=1\n    bootchart stop\n';
        writeFileSync(path.join(dir, 'init.rc'), rc);
        mkdirSync(path.join(dir, 'system/priv-app/Taskbar'));
        writeFileSync(path.join(dir, 'system/priv-app/AnalyticsService'), 'a file, not a package directory');
        out = run();
        assert.equal(out.status, 0, String(out.stderr));
        assert.equal(String(out.stdout), 'porty: provisioning at boot_completed (5 settings), hidden: SetupWizard Taskbar\n');
        assert.equal(readFileSync(path.join(dir, 'mounts'), 'utf8'),
            'mount --bind porty-empty system/priv-app/SetupWizard\nmount --bind porty-empty system/priv-app/Taskbar\n');
        assert.deepEqual(readdirSync(path.join(dir, 'porty-empty')), []);
        assert.equal(readFileSync(path.join(dir, 'init.rc'), 'utf8'), rc + action);

        // sourced again: init.rc gets the action once
        out = run();
        assert.equal(readFileSync(path.join(dir, 'init.rc'), 'utf8'), rc + action);

        // an image without any of the packages: only the settings
        rmSync(path.join(dir, 'system'), { recursive: true });
        writeFileSync(path.join(dir, 'init.rc'), rc);
        out = run();
        assert.equal(String(out.stdout), 'porty: provisioning at boot_completed (5 settings), hidden: nothing\n');
        assert.equal(readFileSync(path.join(dir, 'init.rc'), 'utf8'), rc + action);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

console.log('boot-diet: all checks passed');
