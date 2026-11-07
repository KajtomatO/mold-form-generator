# Casting Form Generator: implementation plan

## Context

The user pours silicone casting molds around 3D-printed models. A plain mold box wastes silicone. This browser-only app takes an STL and generates a printable two-part container (base and cover) whose cavity follows the model at a constant distance, so the pour uses as little silicone as a demoldable shape allows. The repo is empty apart from 7 example STLs in `examples/`, which become the regression set. Nothing is installed in the project yet, and there is no git repo.

Outcome: a local web app at `http://192.168.0.153:5173` that loads an STL, previews base and cover, and exports print-ready STLs in a ZIP, plus `docs/REQUIREMENTS.md`.

**How this plan was checked:** three research tracks and three design critics, each independently re-checked. Numbers come from in-memory runs on the 7 examples using rough code, in Node on the server. No client browser timing and no physical print exists yet.

## Please confirm when approving

These change or extend what you wrote, or correct what I told you earlier.

1. **Real default silicone is higher than the table I showed you.** The earlier table had no safety margin or wall draft. At plan defaults (estimates, in ml):

   | Model | Earlier table | Plan default |
   |---|---|---|
   | Benchy | 38 | 43 |
   | Goddess | 100 | 118 |
   | VIS-35 | 475 | 544 |
   | Jersey barrier | 9.5 | 11.8 |
   | Jersey x8 | 72 | 92 |
   | Barrel | 12 | 10.2 |
   | Wolf | 177 | 208 |

   Measured at M2, in the same order: 42.8, 117.7, 541, 11.2, 86.0, 10.1, 202. They come out lower than these estimates because the raster clips triangles to each cell, which G3 allowed.

   The earlier barrel figure was wrong: it counted the 3.4 ml sealed void as silicone. The margin is what guarantees at least 3 mm of silicone everywhere. Without it, the delivered thickness was only about 2.3 to 2.9 mm.
2. **Base stands 0.2 mm proud instead of exactly flush.** First-layer squish can make a printed base thinner than designed. If it ends up recessed, the cover wall lands on the table, tape stops loading the seal, and the seam opens under silicone pressure. Proud by one layer means the base always rests on the table. Tape still runs from the side walls across the base.
3. **"Simplify first" is met differently.** The cover never simplifies the mesh before offsetting. Rasterising the model at 0.125 mm already removes finer detail, and it copes with non-watertight input. Simplification is used only for display and for Manifold operations above 2M triangles, and the printed `model_oriented.stl` always comes from your original mesh.
4. **Small additions you did not ask for:**
   - 1 degree wall draft, so the silicone slides out
   - closing of plastic fins thinner than 1.2 mm
   - pry notches on the cover's bottom edge
   - 3 mm rounded plate corners
   - base default of 4 mm (your 3 mm stays the minimum)
   - Mode A as the default mode
   - automatic grid spacing that keeps a printable wall between models, until you type your own value
5. **One pour per body, not per cavity.** At defaults, `jersey-barriers-x8.stl` forms 2 connected cavities, because the plastic wall between rows is too thin to keep. Each of its 8 bodies still gets its own pour opening. Default 40 mm funnels would collide at its 22 mm pitch, so the app warns and suggests a smaller funnel.
6. **Cut from version 1 to keep the scope finishable.** None of these is something you asked for:
   - experimental mesh remesh repair
   - tunnel counting
   - dead-end well analysis
   - casting-phase air analysis
   - fill-time estimate and silicone material presets
   - strain estimate
   - autosave
   - sloped roofs over flat ceilings
   - top-down inset view (openings are dragged in 3D, with a top-view button and coordinate fields)
7. **Physical unknowns remain and only your test pours can settle them:** whether 3 mm holds up in use (no published source validates it), whether a top pour behaves as predicted, tape sealing, and resin or adhesive cure inhibition. The README tells users to do a test patch first.
8. **One early check needs you.** After M0, please open `diag.html` in your Chrome and report whether it prompts or blocks on saving STL and ZIP over plain http. I keep building either way and carry this as an open item until you answer.

## Decisions on record

| # | Decision |
|---|---|
| D1 | Cavity never narrows towards the base. No geometry primitives, no uniform-shell mode. |
| D2 | Silicone can slide out of the cover. Workflow: cut sprues, remove silicone with the model inside, cut or flex, take out the model, re-seat. The app reports for each model whether pulling in the cover is plausible and where cuts are likely. |
| D3 | First pour at the highest point, a 2 to 3 mm vent beside it and at each other significant peak. Extra pours take next-highest peaks, then spread around the centre. All are draggable. |
| D4 | Joint is a taper plus tongue and groove (ridge on the base, groove in the cover shelf). A printable fit-test piece is generated. |
| D5 | Adhesive tape in version 1. Optional FDM-friendly nuts and bolts as a later milestone, with nothing through the flat top. |
| D6 | Layer height setting (default 0.2 mm). Pocket depth defaults to one layer, any depth can be set, and the app warns if it is not whole layers. Enlargement stays 0.2 mm. |
| D7 | Served on plain `http://192.168.0.153:5173`, which is not a secure context. No SharedArrayBuffer, WebGPU, OPFS, service workers, Web Crypto, or `showSaveFilePicker`. |
| D8 | On approval: git init, commit docs, then build all milestones, committing each once tests pass. No Claude attribution in commit messages. Physical print checks are left to the user. |
| D9 | Silicone thickness default stays 3 mm, configurable. |

BumpMesh is AGPL. Follow its layout conventions, but write all CSS, markup and icons from scratch with our own palette.

## Terms

- **t**: silicone thickness.
- **Top envelope h(x,y)**: highest model surface in each XY column.
- **H(x,y)**: cavity ceiling height.
- **r_eff**: dilation radius including safety margin.
- **Tool**: the closed solid {0 <= z <= H} that gets subtracted from the cover.
- **Jacket**: the cured silicone.
- **Coordinates**: base plane z=0, cavity above, base from z=-Tb to 0.

## Architecture

### Stack (exact pins, lockfile committed)

| Package | Version | Role |
|---|---|---|
| manifold-3d | 3.5.4 | Serial WASM. Booleans, hull, CrossSection, `minGap`. |
| delatin | 0.2.0 | Height field to few triangles. No types, so add `delatin.d.ts`. |
| meshoptimizer | 1.3.0 | Weld and simplify for heavy inputs. |
| three | 0.187.0 | Rendering, main thread only. |
| three-mesh-bvh | 0.9.18 | Click-to-pick. |
| fflate | 0.8.3 | ZIP, called with `zipSync` inside a worker. |
| preact, @preact/signals | 10.29.8, 2.11.4 | Sidebar and store. Not Preact 11.2.0, which is one day old. |
| vite | 8.3.6 | `worker.format:'es'`, `oxc.jsx.importSource:'preact'`, `server.host` and `preview.host` true. All HTML pages listed in `build.rolldownOptions.input`. |
| typescript | 7.0.2 (fallback 6.0.3) | `tsc --noEmit` only. |
| @types/three | 0.187.0 | Types. |
| vitest | 5.1.0 | `pool:'forks'`, `maxWorkers:2`, explicit timeouts for `minGap` tests. |
| @playwright/test | 1.63.0 | Matches the Chromium 153 already cached in `~/.cache/ms-playwright`, so no download is needed. Fallback is 1.65.0 via the install script. |

### Repository layout

```
docs/      REQUIREMENTS.md PLAN.md WORKFLOW.md DEPLOY.md BENCHMARKS.md THIRD_PARTY.md
scripts/   install.sh serve.sh ci.sh
examples/  the 7 STLs
index.html diag.html bench.html pipeline.html
src/core/  pure TS, no DOM, no three, Manifold injected as a parameter
  params/ stl/ mesh/ base/ field/ solid/ parts/ analysis/ report/
src/workers/ protocol.ts field.worker.ts solid.worker.ts
src/app/   pipeline.ts jobGate.ts stages.ts store.ts history.ts project.ts download.ts testHooks.ts
src/view/  scene materials heightPreview section explode openingsGizmo picking overlays theme
src/ui/    App Header Sidebar/* StatusStrip DiagnosticsCard PartsList SliderRow ExportBox
test/      fixtures/ unit/ regression/
e2e/       lan-spike app export pipeline specs
```

Critical files: `src/core/field/dilate.ts`, `src/core/parts/rim.ts`, `src/core/parts/cover.ts`, `src/app/jobGate.ts`, `src/core/analysis/demold.ts`.

Static checks enforced by tests:
- `src/core` compiles without DOM types.
- `three` is imported only under `src/view`.
- `new Manifold` appears only in the arena.
- A grep over `src` rejects `crypto.subtle`, `randomUUID`, `navigator.storage`, `navigator.gpu`, `navigator.clipboard`, `serviceWorker`, `showSaveFilePicker` and `SharedArrayBuffer`.

### Workers

- **field.worker**: long-lived, pure JS. Parse, weld, raster, dilate, tile, condition, peaks, intervals, analyses.
- **solid.worker**: Manifold plus meshoptimizer. Import validation, footprint, tool, cover, base, funnel. Disposable. A fresh instance runs each export and is terminated afterwards.
- Main holds the input arrays, so a respawned worker can always be re-fed.

Rules:
- **Bootstrap:** attach a queueing `onmessage` before any await, post `ready` after WASM setup, then drain the queue. A 20 s init timeout gives an inline error.
- **JobGate, one per worker:** holds one desired target state as full stage keys. The job is derived at dispatch by comparing that target with what the worker has cached, attaching inputs for missing stages. A `{t:'miss',stage}` reply triggers a re-send.
- **Accepting results:** a result is applied only if its model-and-plane key is current and its sequence number is newer than what is on screen. Results that are older than the latest request still show, with an out-of-date badge, so a continuous drag gives feedback.
- **Terminating:** a job is killed only when a newer request waits and it has exceeded `max(8 s, 4 x rolling median)`. Export is killed only by Cancel.
- **Crashes:** `memory access out of bounds` or any non-ManifoldError marks the worker dead. Respawn, retry once with coarser cells, then show an inline error.
- **Memory:** every Manifold goes through `withArena`. Heap is read from `instance.exports.memory` via `instantiateWasm` (confirmed in M0). Recycle between jobs above 1.5 GB. Only tool, cover body, base body, funnel and model stay cached.

### Pipeline stages

| Stage | Key inputs |
|---|---|
| S1 parsed, audited, decimated copy for `minGap` | file bytes |
| S2 oriented soup, footprint | plane choice, tolerance, minIsland |
| S3 raster (preview, final) | S2, cell |
| S4 envelope | S3, t, printMargin, cellFinal |
| S5 composite | S4, nx, ny, spacing |
| S6 conditioned | S5, closeWidth, draft |
| S7 peaks, placement on a single tile, replicated | single-tile field, shells, pour, vent, pins |
| S8 intervals | S2, analysisCell |
| S9 geometry reports | S6, S7, S8 |
| S10 rim, box (pure, main) | analytic bounds, joint, Tb, wall, edge, cap |
| S11 tool | S6, TIN tolerance |
| S12 cover body | S11, S10 |
| S13 cover final | S12, openings, seat |
| S14 base body | S10, Tb, taper, relief, ridge |
| S15 base final | S14, mode, footprint, resolved pocket depth, grid |
| S16 funnel | funnel, seat, pour diameter |

Silicone density, tape and printer numbers are computed on main from S9 metrics. The dependency table is declared as data, and the test that checks invalidation is generated from it.

### Preview tiers

| Tier | Trigger | Work | Target |
|---|---|---|---|
| T0 | camera, visibility, section, explode, marker move and validation | main thread | one frame |
| T1 | t, spacing, draft slider | preview-cell dilate, tile, condition. Upload to R32F texture and displace a fixed grid in the vertex shader (CPU update as fallback). Rebuild box and base proxies from S10. Update box size. | under 150 ms per job; browser timing is unmeasured so far |
| T2 | any geometry change, 400 ms debounce | real booleans from the preview-cell field at 0.1 mm TIN tolerance | about 2 s typical (estimate, re-derived in M5 from measured stages) |
| T2b | opening drag on cached cover body | subtract cylinders | under 200 ms including transfer (estimate) |
| T3 | export | final cell, `minGap`, ZIP | progress bar and Cancel, no fixed target |

Box and rim come from analytic bounds, so preview and export have the same outer dimensions. Budgets adapt on slow machines, and a test flag freezes them so tests stay deterministic. `bench.html` measures the user's machine, and all geometry runs on the client.

## Parameters

Units are mm unless noted. Every value is editable; rarely used ones sit in a collapsed Advanced section.

| Group | Parameter (default, range) |
|---|---|
| Base | mode glue or merged (glue); `thickness` Tb (4, 3 to 20); `pocketDepth` (one layer until edited, stored with an edited flag; 0.05 to 2); `pocketEnlarge` (0.2, 0 to 1); `planeTol` (auto 0.05 to 0.2, 0.01 to 1); `minIsland` mm2 (5, 0 to 100); `cornerRadius` (3); `bedRelief` height and run (0.4, 0.3) |
| Silicone | `t` (3, 1 to 20; warns under 3, advises 4 to 5 when H exceeds 100); `wallDraftDeg` (1, 0 to 5); `closeWidth` (1.2, 0 to 5); `density` g/cm3 (1.1); `printMargin` (layer/2) |
| Cover | `wall` (3); `topCap` (5, 3 to 30); `topChamfer` (0.4) |
| Joint | `taperDeg` (15, 5 to 30); `taperClearance` cT per side (0.10); `landInner` s1, `landOuter` s2 (2, 2; min 0.8); `ridgeWidth` (1.6); `ridgeHeight` (1.2); `ridgeDraftDeg` (10); `grooveClearance` cG per side (0.25, always at least cT + 0.15 at default); `grooveExtraDepth` (0.3); `baseProud` (0.2, one layer); pry notches on (12 x 1.2) |
| Pour | `perModel` (1, 1 to 16, per body); `diameter` (10, 4 to 30); `minLand` (1.5) |
| Vents | enabled; `diameter` (2.5, 2 to 6); `persistence` (t/2) |
| Seat | enabled; `depth` ds (3, 1 to 10); `halfAngleDeg` (30, 10 to 45) |
| Funnel | generate; `topDiameter` (40); `height` (30); `neckHeight` (10); `wall` (1.2); `tipWall` (0.86); `seatClearance` (0.10) |
| Grid | `nx`, `ny` (1, 1, up to 20); `spacing` between model bounding boxes (auto: 2 r_eff + 2 Hmax tan(draft) + a wall of 2 lines plus 1.2 mm, or the closing span plus a cell if wider, + 3 cells of rounding, editable, 0 to 100); `edge`, distance from model bounding box to the outer box (auto minimum, 0 to 100) |
| Print | `layerHeight` (0.2); `nozzle` (0.4); bed X, Y, Z (220, 220, 250); infill (0.35); density (1.24); tape strip N (10) |
| Quality | `cellFinal` (0.125, 0.05 to 0.5); `cellPreview` (auto `max(0.5, L/1024)`); `analysisCell` (0.25); `tinTolFinal` (0.05); `tinTolPreview` (0.1) |
| Reports | `minVolumeMl` (0.05); underside persistence (0.3) |

Hard cross-parameter rules, each giving an inline error and covered by a fuzz test:
- `ds <= topCap - 1`
- funnel top >= pour diameter + 2 x wall
- tool domain inside the rebate at z=-2
- ring radii clamped to be non-negative

## Geometry construction

### G1. Import

1. Binary if `size == 84+50n`, else ASCII if it starts with `solid`, else binary with a clamped count and a warning. `3dbenchy.stl` is binary despite a `solid` header; the barrel is the only ASCII example. Own byte parser, positions only.
2. Reject non-finite values. Drop triangles with two identical corners (Benchy loses 552). Keep collinear triangles with three distinct corners: Benchy has 11, and dropping them opens 29 edges so Manifold refuses the mesh.
3. Exact weld, then compact the vertex buffer. Compacting is required before simplify.
4. Edge audit: open, non-manifold, misoriented.
5. `new Manifold(mesh)`; on `NotManifold`, `Mesh.merge()` at a tolerance of 0.002 mm and retry. The library's default tolerance only closes seams one float step wide. All 7 examples pass on the first try.
6. Last resort is soup mode: cover and Mode A still work from the raster, Mode B is disabled, and a warning covers missing top surfaces. The soup-mode pocket is the footprint mask plus a direct triangle contour at z=d. An inverted open mesh is flipped by signed volume, base detection tries both sides of a face, a flat-rimmed hole can be offered as the base, and connected pieces are reported as unverified bodies. M4 must filter out detached fragments when placing pours.
7. `decompose()` before any simplify. Negative total volume: flip. Negative shell inside a positive one: void, recorded (barrel, +7,489 and -3,432 mm3). Sum of shells versus union detects overlaps. Negative genus alone is not an error (x8 is -7).
8. Above 2M triangles, simplify for the Manifold path only, with the measured error shown as a warning in Mode B. Above 300k, use `simplifySloppy` for the display proxy. Mode A's `model_oriented.stl` always comes from the original soup.

### G2. Model-base detection

1. Area-weighted normal histogram at 1.5 degree bins, top 8 candidates.
2. Support plane is the extreme vertex along the outward normal. Non-support ledges are rejected, except near-support levels within the slider tolerance (1 mm, its maximum). A deeper ledge is kept when what lies beyond it is stray, at most 2% of its area, and then gets the below-plane warning and trim. Real steps start at 13.6% on the examples.
3. Membership by vertex distance to the plane, not by normal. Score by area projected onto the plane. This handles disconnected faces such as legs.
4. **User confirmation is the default**, because a big flat top is also a support plane. Ranked candidates are listed, and click-to-pick highlights all coplanar triangles.
5. Small islands under `minIsland` are dropped and listed in Diagnostics with their areas (wolf has 9 components, 3 above the threshold). `minIsland` filters the footprint only, and detection uses a fixed 2 mm2 floor. If the filter leaves no footprint at all, a warning says so.
6. Two-level bases: VIS-35 has a 361 mm2 pad at z=0 and a 764 mm2 face at z=0.41. Selecting z=0 warns that a film of silicone will enter a 0.41 mm gap. One click on "Use upper level" moves the plane to z=0.41 and trims the pad with `trimByPlane` in both modes. A level that lies entirely inside enclosed holes of the footprint is a recess that silicone cannot reach, so it gets an info note and no trim offer: Benchy at z=0.30 (the lettering, 78.1 mm2) and wolf at 0.917 mm above its base (108.5 mm2).
7. Vertices below the plane beyond tolerance cause a warning. The raster clips them. Mode B and `model_oriented.stl` trim them. Soup mode shows an inline error asking for another plane.
8. Only rotations and translations, with a test that every transform has determinant +1.

Footprint: `CrossSection.ofPolygons`, then `offset(+0.01).offset(-0.01)` to close T-junction gaps, drop small islands, keep real holes.

### G3. Top envelope and dilation

Conservative raster per cell: `h_c = min(triMaxZ, max(plane z at the 4 cell corners))`, clipped to z >= 0. A vertical triangle uses `triMaxZ`. Try clipping the triangle to the cell in M2 if timing allows, since it is tighter on faceted models.

Dilation: `H = max over sources (h_c + sqrt(r_eff^2 - d^2))` for d <= r_eff, using the sector-domination pruned splat, which matched brute force. Cost follows r/cell, so cells are set in mm. A brute-force reference stays in tests.

### G4. Safety margin

`r_eff = t + 2.13*cellFinal + printMargin`, plus a vertical raise of `tinTol`. At defaults that is 3.366 and 0.05. The 2.13 comes from the worst case for the distance between a source point and the grid nodes around it.

Measured by `model.minGap(cover, 8)` on all 7 in tests. Each export runs `minGap` with the model decimated to at most 60k triangles and reports `gap - error`. If that is below t, raise r_eff by the deficit plus 0.05, rebuild once, and report it. The status strip shows measured clearance.

### G5. Conditioning

Order matters: **draft first, then closing.** The other order leaves plastic blades up to 20 mm tall on real files.
- Draft: `H_d(x) = max_u [H(u) - |x-u|/tan(alpha)]`, by a two-pass chamfer. Up to 8% less widening off-axis, acceptable. Measured silicone cost 1.00 to 1.08x.
- Closing: grayscale, square element of side `closeWidth`.

Both only raise H, so clearance and nesting are preserved.

### G6. Grid

Pitch = model XY size + spacing, snapped to a multiple of `cellFinal`; the UI shows the effective pitch. Tiles are max-composited at integer offsets. Overlaps merge into one cavity naturally. Pockets, Mode B unions and openings use the same snapped positions. A preview cell may not divide the snapped pitch, so a preview field can sit up to one preview cell per tile wider than export (x8: 125.0 against 124.75). The pitch shown in the UI and used for placing parts always comes from a plan at `cellFinal`, and wall warnings are not read from a coarse preview. Measure the minimum plastic wall on the conditioned composite, and warn below 2 lines plus margin, showing the spacing needed. Node cap 16M: raise the cell and warn.

### G7. Closed tool

Clamp nodes to a floor at z=-1, add `tinTol` to nodes above 0, run Delatin, add a boundary ring at z=-2 with vertical walls, close the bottom with a fan from one centre vertex, and assert `NoError` and positive volume. No trim at z=0: the surface passes through z=0 inside the rebate volume, so there are no coplanar faces. For displaying the silicone part, trim it at z=0.

### G8. Rim, derived and never entered directly

Analytic bounds, independent of cell size, per side: `D = max over vertices (v.x + r_eff + (v.z + r_eff)*tan(alpha)) + 0.5`, unioned over tiles. `Hmax = max v.z + r_eff + tinTol`.

| Offset from D | Value at defaults | Meaning |
|---|---|---|
| e1 = s1 | 2 | groove inner wall |
| e2 = e1 + cG | 2.25 | ridge inner wall |
| e3 = e2 + rw | 3.85 | ridge outer wall |
| e4 = e3 + cG | 4.1 | groove outer wall |
| e5 = e4 + s2 | 6.1 | base top outline |

- Base top half: `B = max(D + e5, modelHalf + edge - (cT + (Tb-proud)*tan(tau) + wall))`. Extra width goes to the outer land.
- Rebate half at z <= 0: `B + cT - z*tan(tau)`.
- Outer box half: `O = B + cT + (Tb-proud)*tan(tau) + wall`.
- `Zt = max(Hmax + cap, rh + gx + cap)`. Dragging openings never resizes the box.
- `edge` is a minimum: below the derived value the app uses the derived one and shows "edge raised from X to Y". Rim offsets come from the cavity, so ridge and groove cannot hit it. A check on the H mask confirms this.

### G9. Cover

```
block     = hull of box rings, z from -Tb+proud to Zt, top edges chamfered
rebate    = hull of rounded rects, half B+cT at z=0, half B+cT+(Tb+1)*tan(tau) at z=-Tb-1
groove    = outer frustum minus inner frustum, z in [-0.5, rh+gx],
            outer D+e4 shrinking upward by tan(ridgeDraft), inner D+e1 growing upward
notches   = 2 boxes at mid long sides, through the wall, height pryHeight above the bottom
coverBody = difference(block, rebate, groove, tool, notches)
coverFinal= coverBody minus bores minus seats
```

Seating: the shelf at z=0 is the axial stop and the taper centres the base. cG is larger than cT so the ridge is never first contact. If print error binds the taper first, standoff is `(e - c)/tan(angle)` and the wedge becomes the seal. The ridge is a labyrinth, not the primary seal, because leakage follows the cube of the gap. `WORKFLOW.md` says Vaseline in the groove helps, as one maker's tongue-and-groove still leaked without sealant.

**Print pose is a rotation, not a reflection: `(x, -y, Zt - z)`.** A plain `z -> Zt - z` would export a mirrored cavity that passes every other check. Flat top on the bed. Cavity, rebate and groove all widen upward, so only the seat cone overhangs, at 30 degrees from vertical.

### G10. Base

```
plate  = hull of rings: half B at z=0; half B+(Tb-reliefH)*tan(tau) at z=-Tb+reliefH;
         that value minus reliefRun at z=-Tb
ridge  = outer frustum minus inner frustum, z in [-0.5, rh], outer D+e3 shrinking, inner D+e2 growing
Mode A = plate + ridge - pocket, one per tile
         pocket = extrude(offset(footprint union slice(model, z=d), enlarge, Round)), z in [-d, +1]
Mode B = plate + ridge + tiled models + stubs
         stub = extrude(footprint offset -0.05), z in [-0.4, planeTol+0.05]
```

Mode B fills the barrel's void via `union(decompose())`, and this is reported. Mode A also exports `model_oriented.stl` with its flat face at z=0. Print pose is `z + Tb`, flat underside on the bed. Warn if Tb or the pocket is not whole layers.

### G11. Openings

- **Pour bore:** cylinder from `zb - 0.5` to `Zt - ds + 0.01`, where `zb = min H over the disc`. Valid only if `zb >= 1`. It removes only plastic above H, so it can never touch the model.
- **Long bores:** length is `Zt - H(o)`. Warn when a vent exceeds L/d of 40 or a pour bore exceeds 60 mm.
- **Seat:** cone from bore radius at `Zt - ds` widening to `Zt`, extended past it. Never a counterbore, which would need supports and would form a locking head. `WORKFLOW.md` states that without a funnel the sprue is cut at the seat floor.
- **Vent:** straight cylinder with a 0.3 mm mouth chamfer, placed on a circle outside the seat at the point maximising H.

### G12. Funnel and fit test

**Funnel:** revolved profile printed wide rim down, with every wall within 45 degrees of vertical. Spigot is a frustum matching the seat, offset by `seatClearance`. Neck outer diameter equals the spigot's wide end, so there is no flat ledge. Throat is `pour diameter - 2*tipWall`. One STL in the ZIP, with the quantity in the README.

**Fit-test piece:** uses the real cover and base builders with a 20 x 20 x 6 box tool, about 40 mm square, with a pour bore, seat and vent, so it also works as a leak test. Variants first step cT with cG held generous, then step cG, at 0.1 mm per step, marked by edge notches. The README explains how to read the result.

## Analyses

- **Peaks:** quantise H to 0.01 mm, sweep descending with union-find, and output a merge tree of leaves with height, persistence, saddle and air volume. Ripple gives 167 to 3,977 births per run, so the persistence filter is mandatory.
- **Plateaus:** connected cells within 0.2 mm of the peak with slope under 2 degrees and area at least 50 mm2. The opening goes at the pole of inaccessibility on the highest component, with ties broken towards its centroid. Expected flagged: jersey, x8, barrel.
- **Placement** runs on a single tile, per body, then replicates and validates against the composite:
  1. Pour at the body's highest point.
  2. Vent beside it.
  3. A vent at every other leaf with persistence >= `vent.persistence`. Wolf gets a 147 mm vent this way, with a long-bore warning, and auto vents can be deleted.
  4. Extra pours replace vents at next-highest leaves, then spread on a circle around the body's footprint centroid (radius 0.35 x shorter footprint extent, at least seat plus land), snapped to the local maximum within 5 mm. On a shortfall the UI states placed versus requested.
  5. Dragged openings are pinned, and are flagged if a change makes them invalid.
- **Drag validation** (sync on main):
  - Hard: min H over the disc >= 1; land between bores and seats >= `minLand`; seat inside the top by at least `wall`.
  - Soft: long bore, not at the peak, funnel collision.
  - An invalid drop snaps to the nearest valid position.
  - A leaf is covered if an opening sits in its basin above the saddle and within t/2 of the peak.
- **Intervals:** per column at `analysisCell`, sorted crossings with signed winding. Neighbouring intervals connect only if they overlap by at least one cell, which is what separates the barrel void.
- **Air traps:**
  - Ceiling leaves.
  - Underside pockets, where the top bound is the model, persistence >= 0.3 mm and volume >= 0.05 ml. Benchy has one at about 0.53 ml. Top vents cannot reach these, so the report suggests a brushed first coat, tilt or a vacuum cycle.
  - Sealed domains above the volume filter, labelled harmless (barrel, 3.43 ml).
  - All results note that the model assumes a slowly rising level.
- **Demold report, per model** (no mesh genus anywhere):
  - Shells and footprints from interval components.
  - Base loop lock is one shell with 2 or more footprints (wolf yes, x8 no).
  - Silicone components are under-plug (floor to model) and sandwiched (model to model).
  - Cut hints come from both classes above `minVolumeMl` and from each loop lock, with centroid and suggested seam.
  - Verdict: `plausible` means no lock and both classes under 1 ml; `cut-required` means a lock, or sandwiched silicone touching 2 or more mouths; otherwise `jacket-out`.
  - Any non-plausible verdict must carry a hint. Every verdict is labelled an estimate and states the D2 workflow.
- **Silicone volume:** `integral of H dA - exterior model volume x tiles - sealed air + bores`, in ml and g. Excludes the barrel void and the air inside an inverted cup.
- **Cover lift:** `rho g integral (Zf - H) dA`, compared with estimated cover weight. Clamp advice is `max(2 x lift, 10 N)` in tape strips, shown in Cover & joint.
- **Printability warnings:** box over bed (VIS-35 at about 230 mm), plastic mass (wolf about 2 kg solid), non-whole layers, ridge narrower than 2 lines, thin walls between tiles, funnel collisions, and in Mode B the model's own overhangs need supports, reported by area (these are excluded from the plate's overhang audit).

## GUI

**Skeleton (BumpMesh conventions, own stylesheet):** 48 px header, viewport fills the rest, no page scroll, 380 px right sidebar with a collapse tab, 28 px status strip under the viewport. The whole viewport is the STL and project drop target. Slider rows use `112px 1fr 56px` with units in the label, double-click reset, and wheel stepping with Shift x10 and Ctrl x0.1. Native `title` tooltips. Dark default with a light theme, set by an inline head script before paint.

**Own palette:**

| Token | Dark | Light |
|---|---|---|
| bg | `#101418` | `#f2f4f7` |
| panel | `#171c22` | `#ffffff` |
| panel-2 | `#1f262e` | `#e8ecf1` |
| line | `#303a45` | `#ccd4dd` |
| slider track | `#6f7d8c` | `#7c8a99` |
| ink | `#e6ebf0` | `#141a21` |
| ink-2 | `#93a1b0` | `#56616e` |
| accent | `#3ea6ff` with `#0b1218` text | `#0b62c4` with white text |
| warn | `#f59e0b` on `#2a2316` | `#8a5300` on `#fbf1dd` |

Part colours: model `#b9b4a7`, silicone `#2dd4bf`, cover neutral at 35% opacity, base `#6b7280`, funnel `#94a3b8`. Orange and yellow are reserved for selection. Sliders get a visible focus ring.

**Sidebar in workflow order:**
1. Model (load, candidates, pick face, tolerance, use upper level)
2. Base (mode, thickness, pocket, layer height)
3. Silicone (t, draft, ml and g)
4. Cover & joint (wall, cap, taper, clearances, ridge, notches, clamp advice)
5. Pour & funnel (counts, diameters, opening rows with coordinates and pin state, seat, funnel)
6. Grid (nx, ny, spacing, edge, effective pitch)
7. Demold report
8. Advanced (collapsed)
9. Export, sticky at the bottom: Export ZIP primary, then Cover, Base, Funnel, Fit-test, with an inline stage bar and Cancel

**Viewport:**
- Status strip: file, triangles, size, box, silicone ml, clearance (measured or nominal), rebuild ms, then toggles for Wireframe, Perspective, Section, Explode, then a controls hint.
- Diagnostics card: floating, bottom-left when OK and top-right on warnings. One-sentence rows with a Show toggle that adds a 3D marker. Problems also appear inline under the relevant control. No `alert()`.
- Section view: one clipping plane, X, Y, Z snap, Flip, drag handle, stencil caps per closed part, built from the MIT three.js `webgl_clipping_stencil` technique with `stencil:true`, plus our own hatch.
- Exploded view slider, part rows with eye and opacity.
- Opening drag: markers dragged on plane `z=Zt` with a top-view button and coordinate fields. Pour, vent and invalid-state markers; dragging one moves it across all grid tiles.
- Software-renderer warning card if the renderer string shows SwiftShader or llvmpipe.

**State:** undo and redo with Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y (snapshots, sliders grouped at 400 ms). Project file `.moldproj`: zip of `project.json` (schemaVersion, params, plane, pins) and original STL bytes.

**Export ZIP:** `cover.stl`, `base.stl`, `funnel.stl`, `model_oriented.stl` (Mode A), optional `fit_test/`, `README.txt` (workflow, parameters, reports, measured clearance, sprue rule, cure-inhibition test patch), `report.json`, `project.json`. Binary STLs in print pose, with headers that never start with `solid`. Saved by Blob and anchor, revoked after 10 s.

## Milestones

Each milestone ends with its checks green, then a commit with no Claude attribution. `scripts/ci.sh` is the quick suite (typecheck, unit, smoke e2e, under about 8 minutes). `scripts/ci.sh --full` runs all 7 models in the background before each milestone commit, and soak tests only at M5 and M11. Playwright uses `workers:1`, explicit timeouts, `channel:'chromium'`, swiftshader args, ports 5183 and 5184 with `dist-ci`, and `reuseExistingServer:false`, against the LAN IP. The user's server stays on 5173 from `dist`. `BENCHMARKS.md` is written only with `--record`.

**Golden numbers:** state their parameters, and are frozen in M2 after review. A later change over 5% fails until reviewed. Independent oracles at no margin are closed forms: cup 72.595, inverted cup 45.497, mushroom 75.188, block 49.050 ml. (The plan's earlier figures were 0.5 mm voxel measurements, which read low.)

### M0: Repo, docs, install, spike

Deliver:
- `git init` on `main`, then `.gitignore`, `docs/REQUIREMENTS.md`, `docs/PLAN.md`, `examples/`.
- `scripts/install.sh`: Node 24+ check, `npm ci`, `npx playwright install chromium`, with `WITH_SYSTEM_DEPS=1` as the only sudo path. No system package is needed on this server because the libraries and browser are already present.
- `scripts/serve.sh`: build, then `vite preview --host 0.0.0.0 --port 5173 --strictPort`.
- `diag.html`, `bench.html`.

`docs/REQUIREMENTS.md` contains: glossary; original text verbatim; a table of requirements R01 to R30 with status (kept, changed, dropped, answered), governing decision and verifying test; D1 to D9 with old-to-new text; derived rules; constraints; workflow; out of scope; assumptions awaiting confirmation; verification matrix.

Checks (dev and preview, LAN IP):
- `install.sh` runs twice with exit 0.
- `tsc --noEmit` passes with three and Preact types.
- Vitest: Manifold loads in Node, cube minus sphere within 0.5%.
- Playwright: `isSecureContext === false`, `typeof SharedArrayBuffer === 'undefined'`; a worker that receives 3 jobs before WASM is ready answers all, with correct boolean volume; WebGL2 with stencil, vertex-shader `texelFetch` on R32F draws, screenshot not blank; Blob downloads of `.stl` and `.zip` arrive byte-identical; IndexedDB and ArrayBuffer transfer work; heap reading is recorded.
- Chromium-to-Node timing ratio recorded.

User: open `diag.html` from your computer, save the test files, say whether Chrome prompts or blocks, and run `bench.html`. I start `serve.sh` and give you the URL. Workarounds go in `DEPLOY.md`. Building continues regardless, and this stays an open item in each report until answered.

### M1: Import and base detection

Checks:
- Parse and weld match the expected triangle counts. Benchy parses as binary and loses 552. A large ASCII fixture also passes.
- All 7 validate with 0 open edges. Fixtures with an open mesh, inverted mesh, overlapping shells and large missing cap reach the expected result.
- Barrel +7,489 and -3,432 within 1%, x8 8 bodies, no error for negative genus.
- Top candidate is -z on all 7. Goddess plane z=-1.98, 1183 mm2. VIS-35 selects z=0, 361 mm2, and reports the 0.41 level.
- Footprints: wolf 3 above the filter (2497, 160, 152 within 3%) with islands listed, x8 8, Benchy 2. Polygon area within 2% of projected.
- A fixture with a spike below the plane gives the warning and the trim. All transforms have determinant +1.
- Arena test: wrap Manifold API handles and assert no leaks. One builder run 50 times shows flat heap.

### M2: Field

Checks:
- Dilation equals brute force within 1e-4 on 3 synthetic and 2 real fields.
- Silicone at t=3, no margin, no draft, no closing, cell 0.25, within 5%: Benchy 39.8, Goddess 103, VIS-35 485, jersey 10.3, x8 79.3, barrel 9.0, wolf 186. Barrel void excluded. At these settings r/cell is exactly 12, which adds one row of cliff to straight walls. At t=2.9999, x8 and jersey fall about 8% and 7.5% below these figures. Plan defaults are not affected, because their r/cell is 26.93.
- Oracle fixtures within 2% of their closed forms at the export cell, and 1% at cell 0.05.
- Vertex test on all 7: `H(v_xy) >= v_z + r_nominal` with margin on. Needle at a cell corner is covered.
- Draft and closing never lower H. Closing is idempotent on the final field within 0.01. Draft on a known cliff within 10%.
- Grid composite equals independent tile evaluation. Pitch is a multiple of `cellFinal`. Spacing 0 merges.
- Cavities at defaults: x8 2, others 1. x8 with no margin and no closing: 8. Bodies: x8 8.
- VIS-35 2x1 with spacing 10 warns of a thin wall. Goddess 2x1 with spacing 10 reports merged tiles, because closing fills that wall, and at spacing 11 it warns of a thin wall. Auto spacing passes.
- Timing recorded; fail above 5 s on any example at 0.125 mm.

### M3: Tool, cover, base, joint, poses, fit-test

Checks, all 7 at defaults in Mode A and B, plus the parameter matrix on jersey, barrel and wolf (t 1, 5, 10; Tb 3; pocket 0.1 with enlarge 0.4; edge 30):
- Status `NoError`, positive volume. Cover and base are one body.
- **`model.minGap(cover, 8) >= t`.** At most t+0.6 with draft 0. Silicone at most 1.25x the M2 number.
- `intersection(cover, base)` volume about 0. Ridge to cover gap at least `cG*cos(ridgeDraft) - 0.005`. Base-to-rebate gap equals `cT*cos(tau)` within 0.01.
- **Closed volume:** `union(cover, base)` with the plate top raised 0.01 for real overlap has exactly one negative shell per cavity, volume within 2% of expected and containing a probe point, plus the groove residual at its computed volume. Negative control: a slot through the wall must change that list.
- Land at z=0 is at least s1. Proud equals the set value. Flat top: slice just below `Zt` equals full box area. Box dimensions equal the formula. Edge 30 gives `O = half + 30`, edge 1 shows the raised message.
- Nesting: cavity slices at 12 levels nested, difference under 1 mm2.
- Overhang audit in print pose: 0 steeper than 45 degrees on plate, ridge and cover, with tolerance for exact 45 degree chamfers. Mode B model overhang reported separately.
- **Reassembly:** re-parse exported STLs, un-pose them, and assert `minGap(model, cover) >= t` and zero cover-base intersection on Benchy and an L-shaped fixture. Negative control: a mirrored cover must fail.
- STL round trip: 0 open edges, volume within 0.1%. Mode B on x8 is 1 body. Barrel void reported. VIS-35 with "use upper level": solid area at +0.02 is about 1128 mm2. Mode A pocket volume within 2%.
- Grid 2x3 Benchy, 3x3 jersey, Goddess 2x1 and VIS-35 2x1 pass the same set, or report a merge.
- Fit-test variants build with the real code. Per-stage timing table recorded for M5 budgets.

User: fit-test piece available on `diag.html` for an early printer check.

Measured at M3, where a check above reads differently on the real solids:
- **Mirrored cover on Benchy:** a plain z flip reflects the cavity in y, and Benchy is symmetric in y to well within its margin. Its gap stays 3.2178, the same as the true cover, and such a cover would fit. So on Benchy the z flip is caught by comparing surfaces, and a reflection in x fails by gap. The L-shaped fixture fails by gap and by intersection, as planned.
- **Sealed recesses in Mode B:** besides the barrel's void, the plate closes off recesses in the model's own underside: Benchy's 8 letters and wolf's 13. Silicone cannot reach those either, so Mode B fills them too and reports the sum, which matches G2.6's level figures within 3%. Otherwise they would be extra negative shells in the closed-volume list.
- **Ridge gap:** `cG*cos(ridgeDraft)` holds until it passes `grooveExtraDepth`, at cG of about 0.305. Past that, the groove's roof is the nearer face, so the check takes the smaller of the two. Defaults are not affected.
- **Flat top:** just below `Zt` the section is the box less the chamfer left at that height. Under the chamfer it is the full box area. Both are checked.
- **minGap search length:** 8 mm cannot see t=10, so the check uses `max(8, t + 0.7)`. A grid uses `t + 0.7` per tile, which gives the same pass or fail, since minGap is the smaller of the true gap and the search length.
- **Corners:** rebate and plate corners move with their sides, as a true offset. With a fixed radius, as a plain reading of G9 and G10 gives, a corner's slant is steeper than the sides, and at 15 degrees the gap there is `0.934*cT` against `0.966*cT`. That passes at the default but fails the 0.01 limit at cT 0.4.
- **Slack in D:** the 0.5 mm covers a source half a cell past its vertex plus one cell for the surface to come down through z=0, which is 1.5 cells. So at an export cell above 1/3 mm the slack follows the cell. Defaults are not affected.
- **Mode B crumbs:** a flat underside on the plate's top can leave a sheet with no volume (VIS-35 on its upper level). Shells under 0.001 mm3 are dropped, so they do not count as bodies.
- **Corner radius:** the rings' corners follow the plate's, so a large radius would bring the groove's inner wall inside s1 at D's corner, and at last open it into the cavity (jersey at 15 mm), while the plate's corner cut into the outer land. G8 says that cannot happen, so the radius gives way to the room between D and B, 6.1 mm at defaults, with an info message. Up to that radius every land holds, to within the chords of the corner polygon (2.4 microns at s1 = 2).
- **Groove depth:** `grooveExtraDepth <= 0` is an added cross-parameter error. At 0 the ridge meets the groove's roof, holds the base off the shelf, and splits the one groove void in two.
- **Feet under `minIsland`:** when the filter leaves no footprint, Mode A's pocket comes from the model's section at z=d alone, and Mode B's stubs come from the islands, or feet within planeTol above the plate would print loose. A model with neither a footprint nor a section at z=d gets no pocket and a warning.
- **Groove series:** the taper fits first, so a groove pair cannot seat on a printer that needs a looser taper than it was built with. So the groove series is built at the taper clearance on `diag.html`, and the user downloads it again once the taper series has given that value. Its cG starts at `max(0.25, cT + 0.15)`.
- **Float32 in STL files:** where two walls of a solid pass within a float step, a reader welds their edges into one with 4 faces (wolf's Mode A base has 2, VIS-35's Mode B base 3). The exporter moves the corners of just those edges one float step apart, so all 21 parts at defaults read back with 0 open, 0 non-manifold and 0 misoriented edges. The round trip checks all three.
- **Mode B model overhang:** read off the final merged part, so a recess it filled has no ceiling left to count. Benchy's reported figure drops by 78 mm2 per copy and wolf's by 109 mm2, which are their sealed recesses.
- **Clearance goldens:** minGap at draft 1 and draft 0 are golden numbers at 1%, since `>= t` alone would let the margin run out unnoticed.

### M4: Peaks, placement, openings, funnel

Checks:
- Every body has at least 1 pour. x8 at `perModel=3` gives 24 valid pours. Grid 2x3 Benchy at spacing 10 and at 0 (merged) gives 6 pours and at least 6 vents, with the void opened.
- Pour at the root peak within 1 mm, except plateau cases. Plateau flags: jersey, x8, barrel yes; wolf, Goddess, Benchy, VIS-35 no.
- Wolf gets its long vent with a warning. A synthetic fixture with known persistence checks the threshold, because real leaves sit too close to it (Benchy's second leaf is about 1.3 to 1.6 against 1.5).
- Validator: disc off the cavity rejected, overlapping seats rejected, tile-to-tile seat collision detected, snap gives a valid position on 100 random drops per model.
- **After bores:** only the groove residual remains as a negative shell. Slice just below `Zt` equals box area minus seat areas. Bore length matches `Zt - H(o)` within 0.1. Overhang audit shows only the seat cone.
- Parameter matrix: pour 6 and 20, seat depth at its limit. Cross-parameter errors shown.
- Funnel: closed, 1 body, no intersection when seated, seat gap equals `seatClearance` within 0.02, overhang audit passes, throat narrower than bore, collision warning on x8.
- Bore subtraction timing recorded on the real covers.

Measured at M4, where a check above reads differently on the real solids:
- **Births:** the plan's 167 to 3,977 could not be reproduced. The quantised sweep keeps 1 to 16 leaves on the conditioned tile (Benchy 4, Goddess 4, VIS-35 4, jersey 1, x8 16, barrel 1, wolf 2) and starts 4 to 206 basins, most of them births on a flat level that fold away. The bare field at cell 0.25, with no draft or closing, gives 1 to 35 leaves and 1 to 66 basins. Those earlier figures came from rough code with no saved source, and the likeliest difference is that they did not quantise. The filter stays mandatory all the same: Benchy, Goddess, VIS-35 and x8 all have leaves under the limit.
- **Benchy's leaves:** the root, then 3.23, then 1.47 against the limit of 1.5, so it gets one leaf vent, at the 3.23 leaf (30.3, 0), whose bore is 25.7 mm. The 1.47 leaf is what the plan calls its second leaf. As the plan says, the threshold is tested on a fixture with a known persistence instead (`towers`, at 1.2 to 2.5).
- **Plateau limit on the barrel:** its lid is 0.202 mm under its rim, so a plain comparison against 0.2 misses the one plateau it has, and the rim alone is 34 mm2. The drop from the peak is counted in the sweep's 0.01 mm steps, so the limit is 0.2 rounded to a step: a drop under 0.205 passes, at any height, and the lid's does. Rounding each height to its own step first, as M4 first did, moves that limit between 0.200 and 0.210 with the peak's height, so the barrel would pass only for 80% of the heights its rim could have. Flags then come out as the plan says.
- **Flat peaks:** a flat face of the model dilates to many nodes of exactly one height, such as Benchy's chimney rim (1,780 nodes, 28 mm2) or VIS-35's top (612). The sweep breaks that tie by node index, so it put the peak, and the opening there, on the first corner of the flat, where a pour's disc hangs off it. A leaf now goes to the pole of the flat of nodes at its exact height, as a plateau's opening does, and only of nodes at its own body's ceiling. That moved Benchy's pour 1.1 mm and VIS-35's 2.3 mm along their tops, still at their peaks' height, and the M4 goldens with them: the silicone in the bores goes from 0.457 to 0.389 ml on Benchy, 0.329 to 0.2745 on VIS-35 and 1.705 to 1.573 on x8, where the longest bore goes from 6.2 to 7.75 mm, a vent beside the broken barrier's pour.
- **x8's bodies are not all alike:** its 4 barriers at negative x are broken ones (6,532 to 7,748 mm3 against 7,964 for a whole one). So 7 of the 8 bodies have a plateau, which is the plan's "x8 yes", and the top row's broken one has none: its flat tops are split by a 9 mm dip, and the two ends' are 30 and 35 mm2, under the plateau's 50. Its peak is the flat at one end, and its pour goes at that flat's pole, so on the peak and within the plan's 1 mm, with its bore's floor 1.8 mm under the top. The first node of that flat is the barrier's corner, where a disc does not fit, and snapped from there the pour's bore ran 20 mm down the flank. The other end gets a vent.
- **Per body:** each body gets a field of its own, conditioned alone, and its peaks and plateau come from that. A leaf must also reach the real ceiling within a plateau's drop of its height, and moves to that part of a flat top if another body covers the rest. Validation is always on the composite. One-body models skip this, as the tile field is already theirs. x8's whole barriers get exactly the lone jersey's plateau.
- **Fragments:** connected pieces that are not bodies are voids, pieces under 5 mm2 of surface, and pieces with no peak at the ceiling. Benchy with its base removed comes apart into 9 pieces, of which 8 are its letters under the hull, so it stays one body with one pour. x8 with its bases removed keeps all 8. A cavity left with no opening, around a crumb away from everything, or a body too thin for a pour's disc, still gets a pour, or a vent if only that fits, or an error, because R11 allows no sealed cavity.
- **Covered:** a leaf's way to the opening counts too. Taken literally, the plan's rule lets an opening on one peak cover the root across any saddle, since every leaf is in the root's basin and x8's bodies are equally high. So every saddle between them must also be within t/2 of the peak.
- **zb:** the minimum runs over the disc and one square's diagonal past its rim, as the surface between nodes falls to the lowest corner of its square. With the bare disc, a bore's flat end on a steep wall can stand above the surface and leave a sliver of plastic, which prints as a 90 degree overhang. It makes the 1 mm rule 0.18 mm stricter at the export cell.
- **Bore length:** H is the field's, so the length is read on the solids at the node nearest the opening's centre, where the TIN keeps its tolerance and the ceiling is H plus the raise within it. Exactly at the centre, between nodes on a steep slope, the TIN can sit lower than any interpolation of the nodes: 0.24 mm at a vent on the barrel's rim at t = 1. The length placement reports, which drives the long-bore warnings, is checked against the solid at each copy's own centre, within 0.1 plus that 0.24.
- **Spread:** a circle of 8.2 mm around a 49 mm barrier leaves no valid spot within 5 mm of it once the first pour and its vent are placed, as both sit on the same top. So a spot goes on along the same line while the body's ceiling lasts, and only then to the nearest valid place over the body itself: inside its extent, on a ceiling of its own that no other body's stands above. A body's own ceiling reaches a few mm past it into the trench between two barriers, and a pour there bores down to the trench's floor. Most of x8's 24 pours at `perModel=3` end up on the top this way. One stands on the foot of a broken barrier, 0.3 mm inside its extent, as that top has room for two pours and a vent only.
- **First pour moved:** when an earlier body's opening takes a first pour's place, or its disc does not fit there, it goes to the highest valid spot over its own body, nearest the place it belonged on a tie, and not to the nearest valid spot anywhere.
- **Snap:** it closes in on the edge of the valid ground from the ring it hit, back along the same line by one step, so it lands within 0.004 mm of that edge along the line. Closing in from the drop, as it first did, spent most of its halvings far off the valid ground. Against a scan by `checkOpening` alone at its 0.25 mm step, each of 12 random snaps on each of the 7 models is the nearest valid place to within that step.
- **Drops on the main thread:** the first drop that snaps on a new placement space builds its distance map, which the main thread pays once after each rebuild: 3.9 to 43.8 ms at the export cell, wolf the most, where the 100 random drops after it take at most 10.7 ms. `docs/BENCHMARKS.md` records the two apart, and M5 and M8 budgets must use the first figure. The table M4 first recorded had only the second, on a space placement had already filled.
- **Funnel:** `height` is from the flat top to the rim, including the neck. The spigot is the seat's cone moved up the axis by `seatClearance / sin(half angle)`, 0.2 mm at defaults, so its tip's outer radius is the bore's and its faces lie `seatClearance` from the seat's. Measured gap at defaults is 0.0998, from the facets of the 48-gon. The plan's rule on the top diameter is necessary but not enough, so these are errors as well: top under the neck, cone past 45 degrees, no throat, no spigot, no cone and a wall that does not fit. A funnel without a seat is one too. The rules are `crossParameterErrors` in `params/rules.ts`. A fuzz draws random sets until 300 have passed the rules, about half the draws, and each of those 300 builds a sound funnel. The other two plan rules stay where they were, in `toolDiagnostics` and `deriveRim`.
- **Barrel at pour 20:** there is no room for the vent beside it, as the 11.73 mm seat, the land and the mouth reach past the 14.8 mm cavity. It says so, with one warning, and that is all it says. The pour's disc covers the barrel's leaf, so no air is left without a way out. The parameter matrix pins what placement says in each of its cases, and that no peak is left uncovered.
- **x8 at pour 20:** seats 23.5 mm wide on 22 mm rows have to stagger. A first pour whose pole is taken moves along its barrier's top, by the rule above, and all 8 get theirs, with only the funnel warning. Placed at the nearest valid spot anywhere, as M4 first did, the 7th slid down its barrier's far flank and left the 8th no room. The plan's matrix does not name x8 there.
- **T2b:** cutting every opening again on a cached cover body takes 16 to 139 ms at defaults on one tile, within the plan's estimate of 200 ms before transfer. It takes 225 ms for x8 at 3 pours per body, 220 ms for a 2 x 3 Benchy and 1.5 s for a 3 x 3 x8 (153 cutters). A preview's cut is about 1.5 to 3 times faster. M5 has to weigh those grids. `docs/BENCHMARKS.md` has the table.

### M5: Worker pipeline

Delivers `pipeline.html` and the `?test=1` hook: job log, `idle()` promise, geometry hash, `worldToScreen`, `setCamera`, budget freeze.

Checks (Playwright, LAN IP):
- A burst of 50 t changes coalesces and ends on the last value. Results are monotonic and the badge clears.
- Change t while busy, then drag an opening: final hash equals a fresh build. Load file B with a job from A in flight: A's result is rejected. T2b straight after a recycle triggers a `miss` and recovers.
- Forced over-budget job terminates, respawns and recovers. Injected out-of-bounds recovers once and then gives a clean error.
- Invalidation table test generated from the declared graph.
- Soak: 100 rebuilds on Benchy and x8 with flat heap after warm-up.
- Budgets derived from the M3 table times the M0 ratio, with T1 and T2 measured here.

Measured at M5, where a rule above reads differently on the real pipeline:
- **Stage table:** `src/app/stages.ts` declares, per stage, every parameter the stage's own code reads, and a stage's key hashes those with the keys of the stages it builds on. The plan's column is shorter than what the code reads: the preview cell's rule reads the grid's counts, so S3 does; the padded domain and the auto pitch read the draft, the closing, the nozzle and the export's TIN tolerance, so S5 does; placement validates against the box and the top, so S7 builds on S10 and also reads t (the cover drop and the vents' persistence, t / 2) and the plane tolerance; S10's bounds come from the oriented mesh, so it builds on S2; S11 reads the preview or the export tolerance by tier; S13 has the drag as an input. S10 is pure, as the plan says, but runs in field.worker and not on main: the analytic bounds read every vertex of the oriented mesh, which only field.worker holds, so the rim and box reach main with the field. A change that moves only the rim, such as the wall or the base's thickness, therefore runs a field job, which sends the preview field again (4 bytes a node: 0.03 to 0.24 MB on one tile of the examples) and places the openings again, as S7 validates against the box. The report and print values the plan computes on main from S9 belong to S9, and the analysis cell to S8, so every schema parameter maps to a stage. Besides the generated invalidation test, a second test runs the real stages from nothing for a change of each of the schema's 65 parameters on jersey, and any output that changes must be one the table says that parameter reaches.
- **S3 independent of t:** the raster covers the model's own box, and the envelope a domain padded by the radius only. S5 copies them into the plan's padded tile at whole-node offsets, so moving t does not raster again and moving the draft or the closing does not dilate again. The fields are those buildField makes, and the regression goldens are untouched.
- **S1 and S2 across both workers:** parsing, welding, base detection and orienting are pure and run in field.worker; the import and the footprint need Manifold and run in solid.worker. Field.worker does not wait for the import: it starts on the welded mesh, and only if the import flips or recomposes the mesh, or falls back to soup mode, does it send the new mesh under a new key, and S2 runs again. No example changes, so this is tested on a box wound inside out and one with a missing triangle. On the inside-out box S2 finds no face to stand on until the import has flipped it, so a field job sends the parsed model ahead of a failure on the user's input, which the import needs, and a changed import clears the error, as a change of the user's does. Before this the inside-out box stayed on "no flat face" for good. The error does show until the import lands.
- **Preview cell:** `max(0.5, L / 1024)` with L the longer of nx times the model's X size and ny times its Y size, spacing left out. The plan did not define L.
- **The worker's cache is what it said:** the gate keeps no view of its own. A respawned or recycled worker has said nothing until its ready message, so a job sent before that is derived from the old worker's report and misses, and the miss reply, which carries the true contents, sends it again with the inputs. That is the plan's rule taken literally, and it is what makes "T2b straight after a recycle triggers a miss": clearing the view on respawn would send the inputs at once and never miss.
- **Revisions:** every change the pipeline makes itself also takes a new revision, so its results are newer than what shows: the retry at a coarser cell, a changed import, and the cell growing on a slow machine. Without it, the retry's results were rejected as not newer, and the gate asked again forever.
- **Debounce:** T2's 400 ms count from the change, when the keys move, and not from the field's arrival. Counted from the arrival, as M5 first did, every T2 went T1 and placement later than it had to: 475 ms after the change of t on x8 in Node, against 402 ms now.
- **Crashes:** any error other than ManifoldError, StlError or the pipeline's own InlineError marks the worker dead. The retry doubles the preview cell, and the cell stays doubled for that model until the next load. A crash at the doubled cell gives the inline error at once, and the next change tries again, at that cell, so each change of the user's costs at most one crash once the cell is doubled. The one retry is counted by the cell and not by revision: counted by revision, as M5 first did, the revisions the pipeline makes itself granted a new retry each time, and with budgets live a crash on every attempt looped for good. The crash's factor is kept apart from the slow machine's, below, and the cell is their product, so the tuning can never undo the doubling.
- **Slow machines:** the tuning reads T1 only at the preview cell in use, and only a new sample can move the cell, one step per window of 5 samples. A step starts the window again. M5 first asked on every update with the same median, which moved the cell 1, 1.46, 2 before any sample at 1.46 existed, and on a fast machine shrank a doubled cell back to 1 within a few updates.
- **Bootstrap:** a worker that posts its boot error, or has not said ready 20 s after it was started, fails the job it holds with that reason, inline. The gate keeps the failure, so the next job goes to a fresh worker with 20 s of its own, never to one that will not reply. Before this, a worker that failed at page load, with the first file picked later, took the job and never answered.
- **T1** (the change of t until the field is on main) is 1.4 to 9.9 ms on single tiles in Chromium and 2 to 11 ms in Firefox, 12 to 16 ms on Benchy 2 x 3 and 49 to 57 ms on x8 3 x 3, against the target of 150. Firefox on the server draws WebGL in software on its main thread, which holds the field's message back by a frame: Benchy's T1 goes from about 6 to 72 ms, and Benchy 2 x 3's to 181. So T1 is measured with the page not drawing. Chromium draws in its GPU process and is not affected, and the user's Firefox on Windows draws on the GPU. `docs/BENCHMARKS.md` has the table under Pipeline.
- **T2** is 31 to 330 ms on single tiles in both browsers, well inside "about 2 s". The heaviest grids are not: Benchy 2 x 3 takes 1.92 to 2.07 s and x8 3 x 3 2.23 to 2.53 s, as Node does with the same code (1.96 and 2.46 s).
- **Budgets:** twice what Node takes, times the M0 ratio, plus 50 ms for the job. T1, T2 and the full cut come from the M3 and M4 tables at the preview cell, per model. M5 first took the larger of that and the plan's target, so the plan's 2 s set T2's budget on all 7 models and a 6 times slower Benchy would have passed; the plan's figures are now upper limits that a single model must also meet, and no floor. Benchy's T2 budget is 660 ms, jersey's 109. A drag step has no row in those tables, and a grid's T2 none at the preview cell, so those come from Node rows in the Pipeline table, measured by the same steps on the same code in Node. The rows are fixed: the check reads them as recorded, and only `--record` measures them again, so a slower pipeline fails rather than moving its own budget, as it did when M5 first measured Node at test time. Node's T1 is no budget, as its worker shares main's thread, so grids are held to the plan's 150 ms. Each figure is the median of three, a drag step's of six, and a drag's first step is held apart: it also cuts every other opening, so its budget is the full cut's.
- **T2b on grids:** during a drag, solid.worker cuts only the dragged opening's copies into the cover already cut for all the others, which it holds for as long as that drag lasts, on top of the plan's five cached solids, and frees on the drop or any other job. The solid is the same, but not its triangles: on x8 3 x 3 the two agree in volume to 1e-8, and differ as sets of triangles. So the drop pins the opening, places again, and cuts all openings in one batch, which makes the end the same as a fresh build. The first step of a drag also cuts the rest: 1.06 to 1.15 s on x8 3 x 3 against 0.90 to 0.98 s for the full cut, 140 to 150 ms on Benchy 2 x 3, and 13 to 115 ms on single tiles. Each step after it takes 214 to 232 ms on x8 3 x 3, 68 to 73 on Benchy 2 x 3 and 7 to 25 on single tiles. The plan's 200 ms holds on every single tile, first steps included, and on x8 3 x 3 a drag step runs 1.07 to 1.16 times over it, with the out-of-date badge until the cut lands. A test holds the shown cover to one cut of all the openings with the dragged one moved, by volume and by what lies in one and not the other, and counts that the others are cut once per drag.
- **Distance map:** field.worker builds the placement space's distance map and fit boxes (`primeSpace`, a new export in `validate.ts` that does what the first snap did) and transfers them with S7, so a drop on main never builds it.
- **Extrude and revolve leak:** the soak found the WASM heap growing by about 96 KB per rebuild of Benchy in Mode A, 52 to 62 MB over 90 rebuilds. manifold-3d 3.5.4's `CrossSection.extrude` and `revolve` hand `this._ToPolygons()` to the raw call and never free it, so each pocket leaked its whole outline. The arena now makes those two calls itself and frees the outline, and core's three uses go through it. The calls and their arguments are the same, so no geometry or golden changes, and the static test now refuses the library's own extrude and revolve outside the arena. Afterwards the 90 rebuilds after warm-up grow solid.worker's used heap by 0 on Benchy and 256 KB on x8, the same in Chromium and in Firefox, against a limit of 512 KB; in Node the reading wanders by up to 192 KB as free holes come and go. M5 first wrote 128 KB here for both, which the x8 run did not bear out. That limit sees a leak of about 6 KB per rebuild: a negative control that keeps one 1,000-point section per rebuild grows the heap by 1.66 MB. Smaller leaks are heap.test's to catch, on the builders. Main's JS heap and buffers, read in Chromium after a collection, grow by 0.50 MB on Benchy and 0.44 MB on x8 over the same rebuilds, against 2 MB allowed; the job log, the events and the timings, which grew for the whole session, now keep their last 2,000 entries, and the timings start again on each load. Field.worker's heap is not read: it holds only the current model's stages, under their keys.
- **T3** runs in a fresh solid worker that builds its own export field, as minGap's one raise of the margin rebuilds from the field, and is terminated when it answers. Openings stay where the preview put them or the user dragged them, with their depth and validity read off the export field. minGap runs on the model decimated to at most 60,000 triangles, against all tiles at once. Its files are byte for byte the same in Chromium, Firefox and Node on jersey. Only a crash of the engine or the worker (a WebAssembly RuntimeError, a RangeError, or the worker's own error event) gets the one retry at twice the export cell, which widens the margin and with it the cavity and box, and says so. Any other error is a fault and is shown as it is, among them the export's own check that its field fits the rim. M6 adds the README, report and project files and the UI.
- **Wall warnings:** following G6, neither T1 nor T2 shows the wall check: field.worker passes on only the plan's own diagnostics, and the export reports the wall from the export field. On VIS-35 2 x 1 the preview cell under-reports rather than over-reports: at spacing 10 its field sees no thin wall, which the export field does, and at spacing 9 both report the merge. So a thin wall shows only at export until M6 gives it a place, for instance a wall check at the export cell in field.worker.
- **Test time:** the soak and the timing test measure the workers, which the dev server serves just as the build does, so they run on the build in Chromium and in Firefox and not on the dev server. With all three projects `scripts/ci.sh --full` took 16.6 minutes against the 14 allowed; this file's tests take 3.8 minutes in Chromium and 2.5 in Firefox. Every other M5 test runs in all three projects. Without a display, Firefox has no WebGL, and pipeline.html built its 3D view regardless, so every pipeline test in Firefox waited out its time limit. The page now leaves the view out with `draw=0`, which the tests use where the browser cannot draw, and only the view's own test skips there.
- **Geometry hash:** the parts are hashed as sets of triangles, so the hash follows the geometry and not the order its faces are listed in. A Manifold instance that has built other molds first lists jersey's cover in the same order as a fresh one, so this is a margin rather than a need. All 7 examples give Node's field, openings, cover and base hash in Chromium and in Firefox.

### M6: App shell, preview and export (first usable version)

Delivers the full layout, load, base confirmation, all sidebar sections, T1 and T2 preview, part visibility, export ZIP and individual parts, and the fit-test export.

Checks:
- All 7 loaded by a real `drop` event with DataTransfer. Base confirmation works. Status strip correct.
- Schema-driven test: every parameter has a control. Double-click reset and wheel stepping work. Mode, grid and pour count update geometry.
- T1: dragging t from 3 to 6 changes box size and pixels before any solid job ends.
- Pocket follows layer height at 0.1, 0.2 and 0.3, and stops once edited.
- Export ZIP on all 7, plus Mode B and a 2x3 grid: unzip, parse, 0 open edges, volumes match Node within 0.1%, reassembly check, measured clearance at least t, README has the workflow and sprue rule. Cancel leaves no download and the UI recovers. Fit-test ZIP has the right variants. `model_oriented.stl` triangle count equals input minus degenerates.
- Layout assertions: header 48, sidebar 380, status at least 28, no row with `scrollWidth > clientWidth`, Export visible, no page scroll. No console errors. No request to any non-LAN host.
- **Builder review:** named PNGs at a fixed camera at 1366x768 and 1920x1080 in both themes, opened with the Read tool before commit, with what was checked noted.

User: does it look right and feel responsive. Share rebuild ms from the status strip.

Measured at M6, where a rule above reads differently in the app. M6 is built in two runs: M6a, the shell and live preview, which these notes cover, and M6b, the export.
- **Wall check at the export cell:** G6 keeps the wall warnings off the coarse preview, and M5 left them to the export. Once the preview has settled on a grid, the pipeline builds the export's own field, as T3 does before any raise of the margin, and its wall check, and shows the result in Diagnostics marked as checked at the export cell. It runs in a second field.worker, spawned for the check and terminated by any newer change or by its own answer, and not in the preview's own field.worker as first planned: a worker's synchronous job can only be stopped by ending the worker, and ending that one would throw away its stage cache, so the next change would parse and orient the model again. `idle()` does not wait for it. On x8 3 x 3 it takes 1.50 to 1.55 s in Node, 1.38 s in Chromium and 1.62 s in Firefox, and finds a thinnest wall of 2.50 mm. Goddess 2 x 1 at spacing 10 merges and at 11 is too thin, as M2 measured, and VIS-35 2 x 1 at spacing 10 now warns before export.
- **G2.6 before T2:** the two-level warning needs the footprint, which needs Manifold, so solid.worker reports the levels with the footprint as an output of S2. It rides in the import's job, so a load still takes two solid jobs, and the pipeline counts it as part of what shows: the badge stays up until it is in. "Use upper level" is offered only from a report for the plane on screen, and the plane choice carries the offset of the level it offered, which S2 stands on. Only that report knows which level silicone can reach: S2 first took the level with the most area, which on the barrel's +Z face is a sealed recess at 0.20 mm (129 mm², none of it exposed) and not the 0.50 mm level offered (40 mm² exposed). A named level that a changed tolerance no longer finds leaves the model on the plane itself, with a warning. Choosing the plane already chosen is no change, so it keeps the pins and removed vents.
- **Candidates' triangles on main:** the hover highlight needs the triangles of every candidate, not only the chosen one, so S2 sends them all. A pick that lands inside a ranked plane lights that whole plane, as `candidateFromPick` takes it; anywhere else the highlight is the triangles within the plane tolerance of the hovered one's plane and facing its way. Picking runs on a BVH of the mesh the pipeline holds, built on the first hover, never on the display proxy, so a picked index is a real triangle.
- **Display proxy:** made with the import in solid.worker, which has meshoptimizer. No example passes 300k triangles (Benchy has 225,154), so a unit test covers it on a closed box of 307,200.
- **Silicone figure:** S9 arrives with M7, so the sidebar and status strip show the plan's volume on the preview field: the integral of H with the preview's TIN raise, less the model above the plane per tile, plus the bores, and no sealed air yet. S2 now also gives the model's volume above the plane. At defaults it reads, in ml, Benchy 43.32, Goddess 118.39, VIS-35 530.02, jersey 11.53, x8 89.52, barrel 10.52, wolf 207.41, labelled as from the preview. Against M3's export-cell figures with M4's bores added that is +0.45%, +0.37%, -2.07%, +1.71%, +2.39%, +2.53% and +2.02%; M6a first wrote "within 2.5%", which the barrel misses. The gap is the preview's own cell and TIN raise (0.5 mm against 0.125, and 0.1 against 0.05): at the export's, the same sum gives the barrel 10.269 against 10.256 and jersey 11.359 against 11.340, within 0.2%. `test/unit/derived.test.ts` pins the seven figures at 0.1%, holds them within 3% of M3's, and the barrel and jersey within 0.5% at the export's cell and raise.
- **Box:** the status strip's box is the cover's outer box O by the height from the base's underside to the flat top, `Zt + Tb`, and the browser test compares it with `deriveRim(moldBounds(...))` run in Node. T1 shows the cover and base as plain boxes from the rim (O from `-Tb + proud` to `Zt`, B from `-Tb` to 0) until a cover or base built on that same rim arrives; the pipeline now keeps the rim key each part was built on.
- **Clearance** reads "≥ t, planned" until an export measures it, which is M6b's. The plan's word was "nominal"; the review found it, "export cell" and "minGap" opaque to a maker, so the strip, the Grid section and the Diagnostics card now say "planned" and "full export detail".
- **Diagnostics' places:** core's diagnostics carry no location, and M6a leaves core as it is, so the Show toggle reads the place from the "at (x, y)" that every message about an opening, a peak or a cavity already names, on the first tile.
- **Advice on t:** the parameter table's warning under 3 mm and advice of 4 to 5 mm above 100 mm of cavity had no code, so the app gives them under the t slider. VIS-35, at 134 mm, gets the advice.
- **Typed entries:** a parameter with no minimum in the schema took a typed 0, and a preview cell of 0 crashed field.worker, which then counted as an engine crash and doubled the cell until the next load; a layer of 0 made the pocket that follows it 0 deep. The controls now refuse 0 where it means nothing, with a floor of their own in `src/ui/layout.ts` (cells 0.05, layer 0.05, the pocket's own minimum, nozzle 0.1, wall 0.4, TIN tolerances 0.01), the schema is unchanged, field.worker answers a cell that is not above 0 with an inline error and no retry, and a pocket following a layer outside the pocket's range of 0.05 to 2 mm is a cross-parameter error.
- **Wheel:** a row's slider or number box steps on the wheel only once it has focus. Over any box the pointer passed, it ate the wheel, so scrolling the sidebar down to the lower sections stepped every box that scrolled under the pointer.
- **Clicks and drops:** only a press and release on the canvas pick a face, so a click on a card over the model, such as a part's eye, never picks what lies behind it. A drop anywhere on the page loads the file, where the browser would otherwise open or save it. A file that does not parse says why under Open STL, with no parts card and no badge. Leaving the page with a model loaded asks first, through the browser's own prompt (not `alert()`), since nothing is saved until M9, and the developer pages at the foot of Advanced open in a tab of their own. Advanced's summary counts the rows inside with a note, as it is closed by default.
- **Test time:** `scripts/ci.sh` takes 5.9 minutes and `--full` 17.6, against about 8 and 18. The app's 14 smoke tests run in all three projects; the drop of all seven and the timed wall check run only with `CFG_FULL=1`, on the build in Chromium and in Firefox, as the dev server serves the same code. The review screenshots run only with `CFG_SHOTS=1`.
- **Overflow check:** "no element with scrollWidth > clientWidth" measures boxes that have a client width. By the CSSOM spec an inline box has a clientWidth of 0, and Firefox still gives such a span its text's scrollWidth, so 57 unit labels failed a check over every element there and none in Chromium.

### M7: Analyses and diagnostics

Checks:
- Synthetic: ring and block with hole `cut-required` with two mouths; mushroom `jacket-out` with hint at the stem; arch has loop lock and a hint between the legs; inverted cup sealed domain 130.5 within 3%.
- Real: sealed domains barrel 3.43 within 3%, others 0; Benchy underside 0.53 ml within 25%; tiny hits filtered; loop flag wolf and Benchy yes, x8 no.
- Verdicts: jersey and x8 `plausible`; wolf `cut-required`; Goddess and VIS-35 not plausible. Any non-plausible verdict carries a hint.
- Lift on an analytic box within 2%. Clamp advice at least 10 N, with strip count shown. VIS-35 warns on default bed. Pocket 0.1 at 0.2 layers warns.
- UI: wolf shows `cut-required`, and its Show toggle changes pixels at the hint. Screenshots reviewed.

### M8: Section, explode, opening drag, undo

Checks:
- Section snaps and Flip change pixels. Patch sampling by hue at a known cut shows cover, silicone and model caps. Soup-mode fixture shows a no-cap note.
- Explode runs no worker job.
- Drag a pour and a vent in 3D using `worldToScreen`: store updates, invalid drop snaps, pin survives a t change, T2b result arrives, and all grid copies move.
- 20-edit undo and redo returns identical params and geometry hash. Grouping holds. Keyboard shortcuts work. Esc leaves pick mode.

User: drag feel with a real mouse and GPU.

### M9: Project files

Checks: save, reload and load give identical params and identical STL hashes. The pocket edited flag survives reload and undo. Schema migration works from a fixture. Corrupt project gives an inline error.

User: print the fit-test piece, tune clearances, leak test, and check pocket depth in the slicer.

### M10: Nuts and bolts (optional toggle)

Geometry: countersunk bolts up through the base into hex nuts slid into side slots in the cover's corners. Parameters: size (M2.5, M3, M4; default M3), length, count fixed at 4, hole and nut clearances, minimum wall. Base countersink at 45 degrees on the bed side. Cover slot enters from the nearer side wall, with a short bridge ceiling in print pose and a one-layer membrane over the bolt hole that the bolt pokes through. Hole depth comes from bolt length and may never reach `Zt`. The seal stays inside the bolts, so the outer land grows automatically. Parameters appear in the schema only from this milestone.

Checks: required edge distance computed; bolt axes coincide within 1e-3; hole and slot at least `minWall` from the cavity, or a collision warning (fixture); membrane equals one layer; bridge length warning; nothing reaches `Zt`; no collision with pry notches; overhang audit passes except listed bridge faces; all M3 and M4 joint checks still pass with bolts on.

User: print, fasten, leak test.

### M11: Hardening and docs

Checks:
- Synthetic 3M-triangle STL imports, previews and exports. Peak RSS sampled from `/proc` under 3 GB.
- Open-mesh fixture exports a Mode A base in soup mode with correct pocket volume. Mode B simplified geometry shows its error warning.
- 5 MB ASCII, wrong count header and non-STL file give inline errors.
- 300-rebuild soak on two models. Parameter fuzz with cross-rule checks. Full suite on all 7.
- `WORKFLOW.md` (the D2 sequence, sprue cut, sealing, vacuum note, cure inhibition, recommending Mode A for multi-footprint models), `DEPLOY.md`, `THIRD_PARTY.md` written.
- Licence scan with `npm ls --all --long --json`: no GPL or AGPL in shipped code.
- Every R-id maps to a test or a named user check.

User: full end-to-end pour, from model print to recast.

## Verification end to end

1. `scripts/install.sh`, then `scripts/ci.sh --full`: typecheck, Vitest on all 7, Playwright over the LAN IP on software WebGL.
2. The core guarantees are measured directly on your files: silicone thickness at least t by `minGap`, closed volume by shell list with a negative control, never-narrowing by slices, no mirror by reassembling exported STLs, no supports by overhang audit.
3. Screenshots reviewed by me at each GUI milestone.
4. `scripts/serve.sh`, then you browse to `http://192.168.0.153:5173`, load each example, and export.
5. Only you can verify: Chrome download behaviour, real GPU feel, printed fit, leaks, and the real pour.

## Main risks

| Risk | Detected by | Response |
|---|---|---|
| Vite, worker and WASM setup fails | M0 spike in dev and preview | Adjust config, version fallbacks |
| Client slower than server, or low memory | `bench.html`, live stage timings | Adaptive cells; export still works |
| Chrome blocks saves over http | `diag.html` by the user | `DEPLOY.md`: keep prompt, tunnel or browser flag |
| Manifold accepts bad input silently | M1 fixtures | Volume sign, decompose, sum versus union |
| Heap growth | M5 soak with flat-heap check | Disposable workers, arena, recycle |
| TIN breaks clearance | `minGap` in M3 and at each export | Automatic margin raise and rebuild |
| TIN triangle count explodes on grids and cliffs | M3 logging | Raise tolerance, warn above 1.5M |
| Missing top surface makes the cavity too low | M1 audit | Warn, disable Mode B, mark clearance unverified |
| Interval analysis misclassifies thin walls | M7 synthetics and barrel | Finer cell, volume filter |
| Joint leaks from warp, stair steps or wicking | Fit-test leak check by the user | Tune clearances, Vaseline or glue bead |
| Silicone or demold behaves differently than estimated | User pours only | Verdicts labelled estimates, workflow always shown |
| Delatin unmaintained | Pinned and tested | Vendor it (ISC) |
| AGPL contamination | Review rule, licence scan | Own code only |
