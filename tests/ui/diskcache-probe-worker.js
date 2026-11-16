// The worker of tests/ui/diskcache-probe.html: fetches each URL with a
// synchronous XMLHttpRequest, as QEMU's threads do (patches 0002 and 0012).
// SPDX-License-Identifier: GPL-2.0-or-later
onmessage = (e) => {
    const out = [];
    for (const url of e.data.urls) {
        const t = performance.now();
        try {
            const xhr = new XMLHttpRequest();
            xhr.open('GET', url, false);
            xhr.responseType = 'arraybuffer';
            xhr.send(null);
            out.push({ status: xhr.status, bytes: xhr.response ? xhr.response.byteLength : 0, ms: performance.now() - t });
        } catch (err) {
            out.push({ status: -1, bytes: 0, ms: performance.now() - t, error: String(err) });
        }
    }
    postMessage(out);
};
