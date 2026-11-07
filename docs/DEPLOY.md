# Deployment

The app is served on the local network over plain http. All geometry runs in the visitor's browser, and the server only hands out files.

```sh
scripts/serve.sh    # builds, then serves on port 5173
```

Browse to `http://192.168.0.153:5173`.

## Client measured so far

From `bench.html` on 2026-11-07, on the user's machine: Firefox 158 on Windows, 16 logical cores.

| Test | User's Firefox (ms) | Server Chromium (ms) | Server is slower by |
|---|---|---|---|
| js: splat 512x512 r=14 | 284 | 536.3 | 1.9x |
| wasm: sphere minus sphere, 128 segments | 17 | 29.4 | 1.7x |
| wasm: sphere minus sphere, 256 segments | 56 | 98.6 | 1.8x |
| wasm: sphere minus sphere, 512 segments | 218 | 391 | 1.8x |

Manifold's WASM booted in 9 ms. Firefox does not report device memory, so the app can't read how much RAM the client has. It has to adapt from measured stage timings instead.

## Saving files over plain http

The user confirmed on 2026-11-07 that Firefox 158 saves STL and ZIP files from `diag.html` without a problem. Chrome has not been tried. Chromium's source suggests it may ask to keep or discard these files on an http address, so if you use Chrome, check `diag.html` first.
