# Casting Form Generator

A browser app for making silicone casting molds with less silicone. You give it an STL of your model. It makes a two-part plastic mold box for your 3D printer: a base that carries the model, and a cover whose inside follows the model at a set distance, 3 mm by default. You print both, join them, and pour silicone into the space between the model and the cover. The cured silicone, back in the cover, is your casting mold, and it took far less silicone than a plain box would.

Everything runs in your browser. The server only hands out the app's files; your models never leave your computer.

Version 1.0.1.

## Open it

Browse to `http://192.168.0.153:5173` (or the address of the computer that serves it). To set up or update that server, see `docs/DEPLOY.md`.

## The app, from top to bottom

The view fills the window: drag to turn it, scroll to zoom, right-drag to pan. The status strip under it shows the file, its triangles and size, the mold box, the silicone, the clearance and how long the last rebuild took, with switches for Wireframe, Perspective, Section and Explode. Undo and redo are in the header (Ctrl+Z, and Ctrl+Shift+Z or Ctrl+Y), beside the light and dark theme. The sidebar on the right follows the order of the work:

1. **Model.** Open STL or project, or drop a file anywhere on the view. The app lists the flat faces the model could stand on, best first, and picks the first. Check it: choose another from the list, or Pick a face on the model. Plane tolerance sets how flat the face must be. A model with a second, slightly higher level under it, such as a pad, gets a "Use upper level" offer. Save project keeps your work as a `.moldproj` file (Ctrl+S).
2. **Base.** Mode: Glue in (A), where you print the model on its own and glue it into a shallow pocket, or Merged (B), where the model is built onto the base. Then the base's thickness (4 mm by default, 3 mm at least), the printer's layer height, and the pocket's depth (one layer, until you set it) and enlargement.
3. **Silicone.** The silicone thickness, the wall draft that lets the silicone slide out, and the silicone's density. It shows how much silicone the mold takes, in ml and grams.
4. **Cover & joint.** The cover's wall and top, and the joint: a taper with a ridge on the base and a groove in the cover, with their clearances, and pry notches for levering the base out. It says how many strips of tape hold the cover down while the silicone is liquid. The Bolts group at its foot turns on four countersunk screws and hex nuts instead of most of the tape.
5. **Pour & funnel.** How many pour openings each model gets (parts of the file that overlap or touch are one model), their size, the vents, the funnel seat and the funnel. The openings are listed with their positions: type a position, or drag a ring on the cover's top in the view. Top view looks straight down. A ring turns red where an opening may not stand, and a drop there moves it to the nearest place that is valid.
6. **Grid.** Several copies of the model in one mold: columns, rows, the spacing between them and the distance to the edge, with the pitch they come to.
7. **Demold report.** An estimate, from the model's shape, of how the silicone comes off it: pulled out while the silicone stays in the cover, slid out of the cover first so it can stretch, or cut. It lists the first six places where the silicone holds, the places to cut first, each with a Show button that marks the place in the view; README.txt lists every place in words. It also says where air may stay.
8. **Advanced** (closed at first). Every other setting, grouped as above, plus the printer's bed size, nozzle and infill, and the quality of the mesh. At its foot: the developer pages, and the third-party licences.
9. **Export**, always at the foot. Export ZIP builds the mold at full detail, measures the clearance on the finished parts, and saves a ZIP named after your model. Cover, Base, Funnel and Fit test save one part each. A bar shows each step, with Cancel.

The Diagnostics card in the view lists what the app found: warnings, notes and errors, each with a Show button where it has a place. It moves to the top right when something needs your attention. Section cuts all the parts with one plane, so you can see the silicone's thickness; Explode moves the cover up and the base down.

## The export ZIP

- `cover.stl`: the cover, turned flat top down, ready to print.
- `base.stl`: the base, flat side down. In Mode B the model is part of it.
- `funnel.stl`: one funnel. Print one for each pour opening.
- `model_oriented.stl` (Mode A): your model, turned so its flat face lies at the bottom, ready to print and glue in.
- `fit_test/` (when you tick "Add the fit-test pieces to the ZIP"): the joint's test pieces, with their own README.
- `README.txt`: how to print, join, seal, pour and demold this mold, with its own numbers: the tape, the silicone, the places to cut, the air, the warnings and every setting.
- `report.json` and `project.json`: every number of the export and every setting. Open the STL, then this ZIP or its `project.json`, to get the same mold back.

## The docs

- `docs/WORKFLOW.md`: the maker's whole workflow, from printing to recasting. Start here before your first mold.
- `docs/DEPLOY.md`: running the server, updating it, and running the tests.
- `docs/THIRD_PARTY.md`: the open-source software the app is built with, and their licences.
- `docs/REQUIREMENTS.md`: what was asked for, what was decided, and how each requirement is checked.
- `docs/PLAN.md`: how the app was built, milestone by milestone, with what was measured.
- `docs/BENCHMARKS.md`: measured timings.

## What only you can check

The app measures the geometry: the silicone thickness, the closed cavity, the openings at the high points, that the parts need no supports. These depend on your printer, your silicone and your hands, so test them before you rely on a mold. `docs/WORKFLOW.md` says how.

- **Print the fit test** (the Fit test button under Export, once a model is open) and set the clearances it gives you, then export the mold. With the bolts on, it adds a bolt coupon: fit a screw and a nut in it first.
- **Leak test:** fill the assembled mold with water before the first pour. The joint should stay dry.
- **Cure-inhibition test patch:** some print materials, glues, tapes and sealants stop silicone from curing where they touch it. Pour a small patch of your silicone onto printed scraps with your glue, tape and petroleum jelly first.
- **A full pour,** from printing the model to a recast. Only that shows whether 3 mm of silicone holds up for you, how the pour fills, whether the seal holds, and whether the demold estimate is right.
- **In your slicer:** the parts need no supports in the poses they are saved in, and the base and pocket come out in whole layers.
- **How it feels on your screen:** whether the preview follows a slider quickly enough on your computer, whether dragging the openings' rings with your own mouse works well, and whether the layout reads well. The server's tests run on software graphics, so tell whoever runs it what feels slow or unclear.

## Troubleshooting

- **A big file:** past 300,000 triangles the view draws a lighter copy, and Diagnostics says so. Past 2 million, merged mode and the glue-in pocket use a copy of 1 million triangles, with the error that costs said under Mode; the cover and `model_oriented.stl` still come from the whole mesh. A 150 MB STL of 3 million triangles works, but takes the browser to about 2.3 to 2.5 GB of memory in Chromium and 2.9 to 3.0 GB in Firefox, so leave about 3.5 GB free and close other heavy tabs first (`docs/DEPLOY.md` has the figures).
- **A mesh with holes (an open mesh):** the app still makes a cover and a glue-in base from its surface. Merged mode is off, with the reason under Mode, and the silicone thickness cannot be measured, so the status strip and README.txt say "unverified". To use merged mode, repair the mesh, for example with your slicer's repair, and open it again.
- **A model of several parts:** a file split into parts for multi-colour printing is fine. Parts that overlap or touch (within 0.05 mm) are one model, with one pour at its highest point, and Diagnostics says how many parts the file has and, for a closed mesh, by how much they overlap; the model's volume is that of the parts together, counted once where they overlap, also when the base face cuts through them. Parts that stand apart each get pours of their own. A project saved by version 1.0.0 of such a file opens with its moved openings and removed vents reset, as 1.0.0 gave each part pours of its own, and Diagnostics says so.
- **A file that will not open:** an empty, cut-off or garbled STL, or a file that is no STL at all, says why under the file row, and the model on screen stays as it was. A file that looks cut off but still holds triangles opens with a warning. Export the STL again from the program that made it.
- **A project that will not open:** a damaged `.moldproj`, one from a newer version of the app, or one whose STL was changed says why under the file row, with what to do.
- **Chrome over plain http:** Firefox saves the STL and ZIP files without asking. Chrome has not been tried and may ask whether to keep or discard each file: choose Keep. Check with `diag.html` first (Advanced, Developer pages, Browser check). If Chrome blocks the files outright, `docs/DEPLOY.md` says what helps, or use Firefox.
- **The page looks old after an update:** the server serves the build `scripts/serve.sh` made when it was last started. Restart it (see `docs/DEPLOY.md`), then reload the page.

## Licence

No licence has been chosen for this project yet: that is its owner's decision. The software it is built with keeps its own licences, which `docs/THIRD_PARTY.md` lists and the app links to as "Third-party licences" at the foot of the Advanced section.

The app's layout follows the conventions of BumpMesh, as the original requirements asked. BumpMesh is under the AGPL, so it was a layout reference only: nothing was copied from it.
