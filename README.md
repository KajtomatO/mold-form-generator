# Casting Form Generator

A browser app that takes an STL and generates a printable base and cover for pouring a silicone casting mold, using as little silicone as a demoldable shape allows. All geometry runs in your browser, and the server only hands out files.

- `docs/REQUIREMENTS.md`: requirements and decisions
- `docs/PLAN.md`: how it is built, milestone by milestone

## Run it

```sh
scripts/install.sh   # Node 24+ required; no root needed
scripts/serve.sh     # then browse to http://<server-ip>:5173
```

## Check your printer

The app's Fit test button, and `http://<server-ip>:5173/diag.html`, download fit-test pieces: small molds with the real joint, for finding the clearances that suit your printer and for a leak test. The README in the ZIP says how to read the result. Both build the groove pairs at the taper clearance set, so set the one you find and download again. With the bolts on, the Fit test button adds a bolt coupon: a corner of the base with one countersunk hole and a corner of the cover with one nut slot, at the clearances set.

Port 5173 serves the last build, so a server started before you updated has an old page without this button. Stop it and run `scripts/serve.sh` again, which rebuilds first.

## Use it

`http://<server-ip>:5173/` is the app. Drop an STL on the view, or open one, and check the base face it found: the ranked candidates are listed with the best one chosen, and you can pick another face on the model. The preview follows every change: the silicone surface and the box first, then the real cover and base. The status strip shows the size, the box, the silicone and how long the last rebuild took.

An STL is read before it replaces the model on screen: one that is empty, cut short in the middle of a triangle, garbled or not an STL at all says why under the file row, naming the file, and the model on screen stays as it was. A binary STL whose header counts more triangles than it holds opens with what it holds, and a text STL with no `endsolid` line at its end opens too; both say so, as the file may be cut off. A mesh with holes still gets a cover and a glue-in base (soup mode): merged mode is then off, with the reason under Mode, and the silicone thickness stays as planned, as no export can measure it without a closed model, which the status strip and README.txt say. A model past 300,000 triangles is drawn from a lighter copy, which Diagnostics says. Past 2 million (the app was tried on 3 million, a 150 MB file), merged mode and the glue-in pocket use a copy of 1 million triangles, with the error that costs said under Mode; the cover and model_oriented.stl come from the whole mesh.

Save project, beside Open in the Model section, saves `<model>.moldproj`: a ZIP of your STL exactly as you loaded it and `project.json` with every setting, the base face, the openings you moved and the vents you removed. Open STL or project, or a drop anywhere on the view, opens it again as it was, with its name above the STL's; the undo history starts afresh, as for any new file. `project.json` records the STL's SHA-256 (the same as `sha256sum` gives), so a file whose STL was changed or damaged says so instead of opening. A ZIP from Export ZIP, or the `project.json` inside it, opens too, as settings for the model already loaded: all of them when it was saved for that model, only the parameters when it was saved for another, as one step you can undo. A project file the app cannot use, from an older or newer version or damaged, and a file that is neither an STL nor a project, says why under the file row, with what to do instead, and leaves your model as it was. When the model has changes that no file holds, opening another STL or project asks first, in the Model section: save, then open; open without saving; or cancel. Ctrl+S saves the project and Ctrl+O opens a file. A project keeps the settings, the base face and the openings, not the view (camera, section, explode, parts shown) nor the Export box's options. Leaving the page asks first only when something changed since the last save, open or Export ZIP.

Export ZIP, at the foot of the sidebar, builds the mold at full detail, measures the silicone clearance on the finished parts, and saves a ZIP named after the model: the cover, the base, the funnel, your model turned onto its base face (in glue mode), a README.txt on printing, pouring and demolding, and report.json and project.json with every number and setting. The buttons under it save the cover, the base or the funnel alone, or the fit-test pieces with your clearances; an option puts those pieces in the ZIP as well. A bar shows each step, with Cancel. After an export the status strip shows the clearance it measured, for as long as nothing changes the mold.

The Demold report, after Grid, estimates from the model's shape how the silicone comes off it: pulled out while the silicone stays in the cover, out of the cover first so it can stretch, or cut, with the places it holds and where to cut each one, which Show marks in the view. It lists where air may stay, such as a pocket under the model that no vent in the top reaches. Cover & joint says how much tape holds the cover down against the liquid silicone, and Diagnostics warns of a part larger than the bed and estimates the plastic. README.txt in the ZIP carries all of it.

Instead of most of the tape, the Bolts group at the foot of Cover & joint holds the base on with four countersunk screws, M2.5, M3 or M4: they go up through the base's corners into hex nuts pushed, corner first, into slots in the cover's side walls, with nothing through the flat top and nothing that needs supports. Turned on, it shows the size, the length (auto takes the shortest standard screw that passes the nut by two threads), the clearances of the holes and of the nut slots, and the least wall round them; the box grows as much as the holes and their walls need, and says by how much; on a model too low for the bolts the flat top is raised too, and says so. Each slot's ceiling prints as a short bridge, with one layer of plastic left across the end of the bolt hole so the bridge prints whole: it lies between the hole and the nut, and the screw pushes through it the first time, before it reaches the nut. Cover & joint then lists the screws and nuts to buy and says whether four are enough for the box, or where tape still goes across the middle of a long side, or that the length chosen does not fit. Warnings under the controls say when a screw is too short to pass the nut or too long for the cover, when the base is too thin over the countersinks, or when a hole would come too near the cavity, the groove or the outside, each with what to change. README.txt then has the parts list, when to fit the nuts and how tight to turn the screws, and its demold steps unscrew them; the fit test adds a small coupon of base and cover with one bolt, at the clearances set, to try the screw and nut on your printer first.

To look inside, tick Section in the status strip: one plane cuts every part, X, Y and Z set its direction, Flip keeps the other side, and the slider or the handle in the view moves it; each closed part's cut face is filled in its own colour, so the silicone's thickness shows. Air that no silicone reaches, such as a hollow inside the model or lettering recessed into its underside, which the base plate closes off, is left unfilled. Explode moves the cover up and the base down. The rings on the cover's top are the pour openings and vents: drag one in the view, on any copy of a grid, to move that opening on all of them, or type its position under Pour & funnel, where Top view looks straight down. A ring turns red where the opening may not stand, with the reason beside the pointer, and a drop there moves it to the nearest place that is valid; Esc puts it back. Undo and redo are in the header, or Ctrl+Z, and Ctrl+Shift+Z or Ctrl+Y.

`pipeline.html`, `diag.html` and `bench.html` are linked from the Advanced section: a bare page for the worker pipeline, the browser check with the fit-test download, and the benchmark.

## Test it

```sh
scripts/ci.sh         # typecheck, unit tests, browser smoke tests
scripts/ci.sh --full  # everything, on all example models
scripts/ci.sh --soak  # the long runs: 300 rebuilds, 3 million triangles, the large parameter fuzz
scripts/ci.sh --full --record  # also rewrites docs/BENCHMARKS.md
```

The soak needs about 3 GB free for its browser and is run before a release rather than before every commit; its 3 million triangle STL is generated by the test, in the system's temporary folder, and deleted after.

Browser tests run against the LAN address on purpose, because `127.0.0.1` counts as a secure context and would hide problems that only appear over plain http. Set `CFG_LAN_IP` if this machine's address is not `192.168.0.153`.

They run in Chromium and Firefox. `CFG_SHOTS=1` adds the review screenshots of the app, written to `test-results/shots` or to `CFG_SHOTS_DIR`. Firefox has no WebGL without a display, so its WebGL tests skip themselves unless `xvfb` is installed, and `scripts/ci.sh` says so when that happens. `WITH_SYSTEM_DEPS=1 scripts/install.sh` installs it, using sudo.
