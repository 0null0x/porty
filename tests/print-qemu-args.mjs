// Prints the QEMU argv the web page would use, one argument per line, so
// that tests/native-e2e.sh exercises exactly what the browser will run.
// usage: node print-qemu-args.mjs <manifest.json> <image-dir> <bios-dir> [url-query]
// SPDX-License-Identifier: GPL-2.0-or-later
import { readFileSync } from 'node:fs';
import { parseConfig } from '../web/js/config.js';
import { buildQemuArgs } from '../web/js/qemu-args.js';

const [manifestPath, imageDir, biosDir, query = ''] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const cfg = parseConfig(query, { userAgent: 'node' });
const args = buildQemuArgs(cfg, manifest, {
    bios: biosDir,
    kernel: `${imageDir}/${manifest.kernel.file}`,
    initrd: `${imageDir}/${manifest.initrd.file}`,
    ramdisk: `${imageDir}/${manifest.ramdisk.file}`,
    diskUrl: `${imageDir}/${manifest.disk.dir}`,
});
process.stdout.write(args.join('\n') + '\n');
