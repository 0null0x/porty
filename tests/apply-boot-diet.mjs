// Appends the boot-diet archive to an initrd file exactly as the web page
// does in memory (web/js/emulator.js), for tests/native-e2e.sh and
// tests/boot-diet-image.sh.
// usage: node apply-boot-diet.mjs <initrd-in> <initrd-out> [url-query]
// SPDX-License-Identifier: GPL-2.0-or-later
import { readFileSync, writeFileSync } from 'node:fs';
import { parseConfig } from '../web/js/config.js';
import { applyBootDiet, dietFixes, dietProps } from '../web/js/boot-diet.js';

const [input, output, query = ''] = process.argv.slice(2);
const cfg = parseConfig(query, { userAgent: 'node' });
const props = dietProps(cfg);
const fixes = dietFixes(cfg);
const before = new Uint8Array(readFileSync(input));
const after = applyBootDiet(before, props, fixes);
writeFileSync(output, after);
console.log(`${output}: ${before.length} -> ${after.length} bytes, ${props.map((p) => p.join('=')).join(' ') || 'no properties'}`
    + `, ttm.ko ${fixes.ttm ? 'fixed' : 'as shipped'}`);
