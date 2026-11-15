#!/usr/bin/env python3
"""Static file server for local testing of an assembled Porty site.

usage: serve.py <site-dir> [port] [--isolate]

Without --isolate no COOP/COEP headers are sent, exactly like GitHub Pages,
so coi-serviceworker has to do its job.  With --isolate the headers are sent
directly (what Netlify / Cloudflare Pages do with the _headers file).
SPDX-License-Identifier: GPL-2.0-or-later
"""
import functools
import http.server
import sys


class Handler(http.server.SimpleHTTPRequestHandler):
    isolate = False
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

    def log_message(self, *args):
        pass


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        sys.exit(__doc__)
    Handler.isolate = "--isolate" in sys.argv
    port = int(args[1]) if len(args) > 1 else 8080
    handler = functools.partial(Handler, directory=args[0])
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        print(f"serving {args[0]} at http://localhost:{port}/"
              f" ({'with' if Handler.isolate else 'without'} COOP/COEP headers)", flush=True)
        httpd.serve_forever()


if __name__ == "__main__":
    main()
