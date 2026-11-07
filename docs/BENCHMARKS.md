# Benchmarks

Chromium worker against Node on the same server. Written by `scripts/ci.sh --record`.

| Test | Chromium ms | Node ms | Ratio |
|---|---|---|---|
| js: splat 512x512 r=14 | 543.5 | 493.5 | 1.1 |
| wasm: sphere minus sphere, 128 segments | 29.9 | 29.3 | 1.02 |
| wasm: sphere minus sphere, 256 segments | 98.3 | 102.4 | 0.96 |
| wasm: sphere minus sphere, 512 segments | 390.3 | 407.9 | 0.96 |

## Field stages

Node on the server, plan defaults at cell 0.125 mm. Written by `scripts/ci.sh --record`.

One tile, in ms. Sealed air runs at the 0.25 mm analysis cell.

| Model | Nodes | Raster | Dilate | Draft | Closing | Cavities | Sealed air | Total |
|---|---|---|---|---|---|---|---|---|
| benchy | 200566 | 103.4 | 24.6 | 2.9 | 17 | 0.4 | 51 | 199.5 |
| goddess | 276172 | 54.4 | 46.9 | 4.1 | 22.8 | 0.6 | 23.8 | 153.4 |
| vis35 | 675024 | 93.1 | 91.9 | 10.1 | 59.3 | 1.5 | 36.6 | 294.7 |
| jersey | 100111 | 7.2 | 11.7 | 1.5 | 8.3 | 0.2 | 2.7 | 31.6 |
| x8 | 742159 | 64.9 | 108.2 | 10.8 | 62.3 | 1.5 | 27 | 275.1 |
| barrel | 75625 | 12.4 | 10.8 | 1.2 | 6.4 | 0.2 | 5.2 | 36 |
| wolf | 898317 | 58.9 | 132.2 | 13.2 | 75 | 1.9 | 37.2 | 318.8 |

2 x 2 at auto spacing, in ms. Raster and dilate are per tile, so they are as above.

| Model | Nodes | Composite | Draft | Closing | Cavities | Wall check | Total |
|---|---|---|---|---|---|---|---|
| benchy | 782718 | 2.8 | 11.7 | 67 | 1.7 | 48.2 | 260.4 |
| goddess | 1081423 | 8.9 | 16.1 | 94.4 | 2.4 | 67.5 | 289.3 |
| vis35 | 2653709 | 9.8 | 39.5 | 267.6 | 5.9 | 157.5 | 662.5 |
| jersey | 387192 | 1.4 | 5.6 | 31.6 | 0.8 | 18.2 | 76.5 |
| x8 | 2935320 | 33 | 43.4 | 270.1 | 6.2 | 284.2 | 820.8 |
| barrel | 290521 | 1 | 4.4 | 24.2 | 0.7 | 14.7 | 68.2 |
| wolf | 3551545 | 12.4 | 52.8 | 386.3 | 7.7 | 250.6 | 910.1 |

Raster choice: clipping each triangle to each cell against the plan formula, in ms and ml. Clipping was chosen: it stays far inside the budget, needs no special case for vertical triangles, and lowers silicone with no loss of clearance, since the margin proof needs only an upper bound on what is inside the cell.

| Model | Clip ms | Corner ms | Clip ml | Corner ml | Saved |
|---|---|---|---|---|---|
| benchy | 103.6 | 129.8 | 42.82 | 43.06 | 0.6% |
| goddess | 52.8 | 50.4 | 117.67 | 117.81 | 0.1% |
| vis35 | 93.4 | 72.6 | 541.13 | 542.87 | 0.3% |
| jersey | 7.2 | 1.7 | 11.17 | 11.69 | 4.4% |
| x8 | 65.2 | 18.9 | 86.02 | 90.59 | 5.0% |
| barrel | 12.3 | 13.6 | 10.06 | 10.19 | 1.3% |
| wolf | 59.6 | 24.6 | 202.48 | 205.67 | 1.6% |

## Solid stages

Node on the server. Written by `scripts/ci.sh --full --record`, as it needs all 7 models.

Export: plan defaults at cell 0.125 and TIN tolerance 0.05, in ms, with one tile. minGap is the plan's `model.minGap(cover, 8)` against the full model, and an export will run it on a decimated copy (G4), so it is the worst case. Mode A and Mode B each include their share of the same plate and ridge, from the base body.

| Model | Nodes | TIN triangles | Field | TIN | Tool solid | Rim | Cover body | Base body | Mode A | Mode B | Cover STL | Base STL | minGap | Total |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| benchy | 200566 | 21872 | 147.7 | 63.4 | 31.1 | 0.9 | 94.5 | 3.2 | 250.2 | 736 | 16.7 | 14.2 | 29982.2 | 31340 |
| goddess | 276172 | 39408 | 127.7 | 98.5 | 59.3 | 0.2 | 161.1 | 3.1 | 8.2 | 71.7 | 15.5 | 0.7 | 4318.8 | 4864.8 |
| vis35 | 675024 | 44554 | 264.9 | 155.1 | 67.1 | 0.1 | 174.4 | 3.1 | 3 | 33.6 | 20 | 0.5 | 1533 | 2254.7 |
| jersey | 100111 | 6462 | 32 | 17.5 | 8.2 | 0 | 29.2 | 3 | 3 | 4 | 2.9 | 0.5 | 92 | 192.4 |
| x8 | 742159 | 60852 | 273.5 | 209.9 | 95.9 | 0.1 | 241.6 | 3.1 | 21.9 | 48.1 | 25.3 | 1.8 | 1703.8 | 2625 |
| barrel | 75625 | 11538 | 31.1 | 25.7 | 15.4 | 0.1 | 52.2 | 3.1 | 8.2 | 20 | 5.3 | 0.8 | 1884.8 | 2046.6 |
| wolf | 898317 | 74904 | 302.8 | 245.5 | 120.9 | 0.1 | 327.1 | 3.1 | 133.8 | 115.9 | 30.5 | 11.3 | 347.1 | 1638.2 |

Preview (tier T2): cell 0.5 and TIN tolerance 0.1, no minGap.

| Model | Nodes | TIN triangles | Field | TIN | Tool solid | Rim | Cover body | Base body | Mode A | Mode B | Cover STL | Base STL | minGap | Total |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| benchy | 14440 | 3882 | 31.5 | 8.6 | 4.9 | 0.9 | 20.6 | 3.1 | 249.1 | 733.7 | 2.5 | 13 | 0 | 1067.9 |
| goddess | 19360 | 6336 | 16 | 10.2 | 8.2 | 0.2 | 30.3 | 3.1 | 8.2 | 71.7 | 2.9 | 0.6 | 0 | 151.5 |
| vis35 | 45990 | 9330 | 24.5 | 21 | 12.3 | 0.1 | 40 | 3.1 | 3 | 33.9 | 3.8 | 0.4 | 0 | 142.1 |
| jersey | 7493 | 1150 | 2.9 | 1.9 | 1.4 | 0 | 9.2 | 3 | 3.1 | 4 | 0.7 | 0.7 | 0 | 27 |
| x8 | 49469 | 13488 | 22.2 | 26.2 | 18 | 0.1 | 55.8 | 3.1 | 21.9 | 48 | 5.7 | 1.7 | 0 | 202.6 |
| barrel | 5929 | 2126 | 4.1 | 3 | 2.6 | 0.1 | 13.7 | 3 | 8.2 | 20.3 | 1.2 | 0.7 | 0 | 56.9 |
| wolf | 59890 | 13802 | 19.7 | 29.1 | 18.9 | 0.1 | 62.2 | 3.1 | 134.5 | 116.1 | 5.9 | 11.1 | 0 | 400.6 |

Heaviest grids: TIN size and the stages it drives, in ms. The risk table asks for a warning above 1.5M triangles, and past that the tool builder raises its tolerance.

| Mold | Nodes | TIN triangles | Field | TIN | Tool solid | Cover body |
|---|---|---|---|---|---|---|
| wolf 3 x 3 | 7959805 | 673836 | 1735.5 | 3269.7 | 1948.5 | 2981.6 |
| x8 3 x 3 | 6579573 | 563376 | 1570.1 | 2734.3 | 1555.8 | 2321.5 |

## Openings

Written by `scripts/ci.sh --full --record`, as it needs all 7 models.

Plan defaults on the server, in Node, with Manifold's lazy booleans forced to run by a status check. Field is S3 to S6 for the export field, as Solid stages has it. A grid also builds the field of one tile on its own, which S7 places on: that is Tile field, and 0 for one tile, whose field is the same. Placement is S7 alone: the bodies, their peaks and the placement, with the composite checked, at the export cell, which a preview would run faster. Cut is S13, on a cached cover body: the batch difference of every cutter. T2b, a dragged opening, repeats it, so its last column is that estimate of under 200 ms.

| Mold | Openings | Copies | Cover triangles | Field ms | Tile field ms | Placement ms | Cut, export ms | Cut, preview ms | Cut, one more opening ms |
|---|---|---|---|---|---|---|---|---|---|
| benchy | 3 | 3 | 24430 | 149.9 | 0 | 77.6 | 34.7 | 18.9 | 35.1 |
| goddess | 4 | 4 | 42134 | 156.8 | 0 | 58.6 | 52.2 | 24.5 | 51.9 |
| vis35 | 3 | 3 | 47058 | 248.2 | 0 | 129.9 | 52.3 | 22.8 | 52.8 |
| jersey | 2 | 2 | 7496 | 28.6 | 0 | 25.8 | 15.4 | 11 | 15.9 |
| x8 | 17 | 17 | 63906 | 246.5 | 0 | 486.1 | 139.4 | 95.9 | 138.7 |
| barrel | 2 | 2 | 13376 | 30.7 | 0 | 17.3 | 19.8 | 11.6 | 20.2 |
| wolf | 3 | 3 | 80596 | 281.9 | 0 | 156.6 | 78.5 | 26.7 | 78.2 |
| x8 at 3 pours per body | 32 | 32 | 63906 | 247.4 | 0 | 510.3 | 226.4 | 174.9 | 225 |
| benchy 2 x 3 | 3 | 18 | 144712 | 324.8 | 148.2 | 190.3 | 219.8 | 114.6 | 219.7 |
| x8 3 x 3 | 17 | 153 | 582882 | 1759.1 | 248.9 | 1209.7 | 1451.7 | 965.2 | 1487 |

A drop of a dragged opening on the main thread. The first drop that snaps on a new placement space builds its distance map, which the main thread pays once after every rebuild: that is the first column, a drop on the box's corner. The second is the worst of 100 random drops over the box after it, on the same space.

| Model | Kind | Nodes | First drop, with the map, ms | Worst of 100 after it, ms |
|---|---|---|---|---|
| benchy | pour | 200566 | 11.8 | 2.1 |
| benchy | vent | 200566 | 9.4 | 1.7 |
| goddess | pour | 276172 | 16.2 | 4.5 |
| goddess | vent | 276172 | 14.5 | 3.3 |
| vis35 | pour | 675024 | 30.1 | 3.0 |
| vis35 | vent | 675024 | 30.4 | 1.1 |
| jersey | pour | 100111 | 4.4 | 0.5 |
| jersey | vent | 100111 | 4.4 | 0.2 |
| x8 | pour | 742159 | 31.8 | 6.9 |
| x8 | vent | 742159 | 31.9 | 3.6 |
| barrel | pour | 75625 | 3.9 | 1.7 |
| barrel | vent | 75625 | 3.9 | 0.8 |
| wolf | pour | 898317 | 43.4 | 10.7 |
| wolf | vent | 898317 | 43.8 | 9.1 |
