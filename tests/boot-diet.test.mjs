// node tests/boot-diet.test.mjs   (also run by tests/unit.test.mjs)
// The newc cpio encoder, the boot-diet script and their URL parameters.
// SPDX-License-Identifier: GPL-2.0-or-later
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { parseConfig } from '../web/js/config.js';
import {
    DIET_LEVELS, DIET_SCRIPT, applyBootDiet, describeDiet, dietArchive, dietProps, dietScript, parseProps,
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
    assert.equal(describeDiet(dflt), ' props: debug.sf.nobootanimation=1 pm.dexopt.first-boot=extract pm.dexopt.boot=extract');
    // the screen must come on: never the quiescent boot
    assert.ok(DIET_LEVELS.flat().every(([k]) => !/quiescent/.test(k)));

    const off = parseConfig('?diet=0', {});
    assert.deepEqual(dietProps(off), []);
    assert.equal(describeDiet(off), ' props: none');
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

console.log('boot-diet: all checks passed');
