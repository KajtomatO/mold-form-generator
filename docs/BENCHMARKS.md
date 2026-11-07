# Benchmarks

Chromium worker against Node on the same server. Written by `scripts/ci.sh --record`.

| Test | Chromium ms | Node ms | Ratio |
|---|---|---|---|
| js: splat 512x512 r=14 | 537.2 | 492.5 | 1.09 |
| wasm: sphere minus sphere, 128 segments | 29.3 | 29.1 | 1.01 |
| wasm: sphere minus sphere, 256 segments | 101.1 | 103.6 | 0.98 |
| wasm: sphere minus sphere, 512 segments | 387.6 | 407 | 0.95 |

## Field stages

Node on the server, plan defaults at cell 0.125 mm. Written by `scripts/ci.sh --record`.

One tile, in ms. Sealed air runs at the 0.25 mm analysis cell.

| Model | Nodes | Raster | Dilate | Draft | Closing | Cavities | Sealed air | Total |
|---|---|---|---|---|---|---|---|---|
| benchy | 200566 | 104.7 | 25.1 | 3 | 17.5 | 0.4 | 50.7 | 201.6 |
| goddess | 276172 | 53 | 45.7 | 4.1 | 24 | 0.6 | 23.8 | 152 |
| vis35 | 675024 | 95.5 | 92.5 | 10.4 | 57.6 | 1.5 | 42.5 | 301.7 |
| jersey | 100111 | 7.3 | 12 | 1.5 | 8.5 | 0.2 | 3.6 | 33.2 |
| x8 | 742159 | 65.4 | 108 | 10.9 | 64.8 | 1.6 | 27.3 | 278.3 |
| barrel | 75625 | 12.5 | 10.7 | 1.1 | 6.5 | 0.2 | 5.2 | 36.2 |
| wolf | 898317 | 60.2 | 135.9 | 13.3 | 78.5 | 2 | 37.2 | 327.6 |

2 x 2 at auto spacing, in ms. Raster and dilate are per tile, so they are as above.

| Model | Nodes | Composite | Draft | Closing | Cavities | Wall check | Total |
|---|---|---|---|---|---|---|---|
| benchy | 782718 | 2.8 | 11.8 | 69.5 | 1.7 | 49.6 | 265.7 |
| goddess | 1081423 | 3.6 | 16.1 | 94.9 | 2.4 | 59.6 | 277.2 |
| vis35 | 2653709 | 9.5 | 39.5 | 264.1 | 6 | 166 | 677.3 |
| jersey | 387192 | 1.4 | 5.6 | 33.5 | 0.8 | 19.3 | 79.8 |
| x8 | 2935320 | 29 | 43.3 | 271.2 | 6.2 | 260.5 | 793.1 |
| barrel | 290521 | 1 | 4.4 | 24.8 | 0.7 | 15 | 69.5 |
| wolf | 3551545 | 12 | 53.1 | 368.7 | 7.8 | 245.2 | 885.5 |

Raster choice: clipping each triangle to each cell against the plan formula, in ms and ml. Clipping was chosen: it stays far inside the budget, needs no special case for vertical triangles, and lowers silicone with no loss of clearance, since the margin proof needs only an upper bound on what is inside the cell.

| Model | Clip ms | Corner ms | Clip ml | Corner ml | Saved |
|---|---|---|---|---|---|
| benchy | 105.6 | 134.1 | 42.82 | 43.06 | 0.6% |
| goddess | 53.5 | 51.5 | 117.67 | 117.81 | 0.1% |
| vis35 | 95 | 76.4 | 541.13 | 542.87 | 0.3% |
| jersey | 7.3 | 1.7 | 11.17 | 11.69 | 4.4% |
| x8 | 66.1 | 18.7 | 86.02 | 90.59 | 5.0% |
| barrel | 12.5 | 13.4 | 10.06 | 10.19 | 1.3% |
| wolf | 61 | 24.7 | 202.48 | 205.67 | 1.6% |
