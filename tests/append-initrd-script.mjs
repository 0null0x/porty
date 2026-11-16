// Development aid for .github/workflows/provisioning.yml: appends one more
// script to an initrd, the way the page appends scripts/99-porty.
// usage: node append-initrd-script.mjs <initrd-in> <initrd-out> <name> <script-file>
// SPDX-License-Identifier: GPL-2.0-or-later
import { readFileSync, writeFileSync } from 'node:fs';
import { appendInitramfs, newcArchive } from '../web/js/initramfs.js';

const [input, output, name, script] = process.argv.slice(2);
const archive = newcArchive([
    { name: 'scripts', mode: 0o040755 },
    { name: `scripts/${name}`, mode: 0o100644, data: new Uint8Array(readFileSync(script)) },
]);
writeFileSync(output, appendInitramfs(new Uint8Array(readFileSync(input)), archive));
console.log(`${output}: appended scripts/${name}`);
