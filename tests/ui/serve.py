#!/usr/bin/env python3
"""Static file server for local testing of an assembled Porty site.

usage: serve.py <site-dir> [port] [--isolate] [--log=<file>] [--mbps=<n>]

Without --isolate no COOP/COEP headers are sent, exactly like GitHub Pages,
so coi-serviceworker has to do its job.  With --isolate the headers are sent
directly (what Netlify / Cloudflare Pages do with the _headers file).

--log=<file> appends one line per answered GET, "<unix time> <status>
<bytes> <path>": what really reached the server, whatever caches sit in the
browser.  --mbps=<n> limits all downloads together to n Mbit/s, so that a
test on localhost pays for its downloads as a visitor would.
SPDX-License-Identifier: GPL-2.0-or-later
"""
import functools
import http.server
import sys
import threading
import time


class Throttle:
    """All responses share one line of `mbps` Mbit/s."""

    def __init__(self, mbps):
        self.rate = mbps * 1e6 / 8  # bytes per second
        self.lock = threading.Lock()
        self.free_at = 0.0

    def wait(self, count):
        with self.lock:
            now = time.monotonic()
            start = max(now, self.free_at)
            self.free_at = start + count / self.rate
            delay = self.free_at - now
        if delay > 0:
            time.sleep(delay)


class Handler(http.server.SimpleHTTPRequestHandler):
    isolate = False
    log_file = None
    log_lock = threading.Lock()
    throttle = None
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".wasm": "application/wasm",
        ".bin": "application/octet-stream",
    }

    def end_headers(self):
        if self.isolate:
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cache-Control", "max-age=600")
        super().end_headers()

    def copyfile(self, source, outputfile):
        if not self.throttle:
            return super().copyfile(source, outputfile)
        while True:
            block = source.read(65536)
            if not block:
                return None
            self.throttle.wait(len(block))
            outputfile.write(block)

    def log_request(self, code="-", size="-"):
        self.sent_status = getattr(code, "value", code)

    def send_header(self, keyword, value):
        if keyword.lower() == "content-length":
            self.sent_length = value
        super().send_header(keyword, value)

    def do_GET(self):
        self.sent_status, self.sent_length = "-", "0"
        try:
            super().do_GET()
        finally:
            if self.log_file:
                with self.log_lock:
                    with open(self.log_file, "a", encoding="utf-8") as f:
                        f.write(f"{time.time():.3f} {self.sent_status} {self.sent_length} {self.path}\n")

    def log_message(self, *args):
        pass


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        sys.exit(__doc__)
    Handler.isolate = "--isolate" in sys.argv
    for option in sys.argv[1:]:
        if option.startswith("--log="):
            Handler.log_file = option[6:]
        elif option.startswith("--mbps=") and float(option[7:]) > 0:
            Handler.throttle = Throttle(float(option[7:]))
    port = int(args[1]) if len(args) > 1 else 8080
    handler = functools.partial(Handler, directory=args[0])
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        print(f"serving {args[0]} at http://localhost:{port}/"
              f" ({'with' if Handler.isolate else 'without'} COOP/COEP headers)", flush=True)
        httpd.serve_forever()


if __name__ == "__main__":
    main()
