# Benchmarks

Chromium worker against Node on the same server. Written by `scripts/ci.sh --record`.

| Test | Chromium ms | Node ms | Ratio |
|---|---|---|---|
| js: splat 512x512 r=14 | 536.3 | 493.4 | 1.09 |
| wasm: sphere minus sphere, 128 segments | 29.4 | 29.3 | 1 |
| wasm: sphere minus sphere, 256 segments | 98.6 | 102.3 | 0.96 |
| wasm: sphere minus sphere, 512 segments | 391 | 407.4 | 0.96 |
