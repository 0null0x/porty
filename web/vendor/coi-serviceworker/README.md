# coi-serviceworker

`../../coi-serviceworker.js` is a copy of
[coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) v0.1.7
(npm package `coi-serviceworker@0.1.7`), MIT licensed, see `LICENSE`, with
two additions marked "Porty": it loads `js/diskcache-sw.js` and lets that
answer the requests for disk and snapshot chunks from Cache Storage.

It has to be served from the site root (a service worker only controls pages
at or below its own path), which is why the file itself does not live in this
directory.
