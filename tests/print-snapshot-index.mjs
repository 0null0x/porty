// Prints the chunk index QEMU reads for "-incoming porty:<index>", built by
// the page's own code from a snapshot manifest, so that the native test
// feeds QEMU exactly what the browser would write (minus the URL: QEMU
// then looks for the chunks next to the index file).
// usage: node print-snapshot-index.mjs <snapshot/manifest.json> [build.json]
//   With build.json the manifest must also pass the page's checks.
// SPDX-License-Identifier: GPL-2.0-or-later
import { readFileSync } from 'node:fs';
import { checkSnapshot, snapshotIndex } from '../web/js/snapshot.js';

const [manifestPath, buildPath] = process.argv.slice(2);
const snap = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (buildPath) {
    const problems = checkSnapshot(snap, JSON.parse(readFileSync(buildPath, 'utf8')));
    if (problems.length) {
        console.error(`the page would not resume this snapshot: ${problems.join('; ')}`);
        process.exit(1);
    }
}
process.stdout.write(snapshotIndex(snap));
