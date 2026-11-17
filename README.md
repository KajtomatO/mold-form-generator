# Mold Form Generator

A browser app for making silicone casting molds with less silicone. You give it an STL of your model. It makes a two-part plastic mold box for your 3D printer: a base that carries the model, and a cover whose inside follows the model at a set distance, 3 mm by default. You print both, join them, and pour silicone into the space between the model and the cover. The cured silicone, back in the cover, is your casting mold, and it took far less silicone than a plain box would.

Everything runs in your browser. The server only hands out the app's files; your models never leave your computer.

The version is in the header, after the name, such as `v0.1.0`. Hover over it to read whether it is a release, the beta or a local build, the date of its code, and its commit, which a bug report should name.

## Open it

- **On the web:** https://kajtomato.github.io/mold-form-generator/ is the newest release. https://kajtomato.github.io/mold-form-generator/beta/ is the newest work, marked BETA in the header, for trying changes before they are released; its "Stable version" link goes back to the release. `docs/RELEASING.md` says how both are published.
- **On the local network:** browse to `http://192.168.0.153:5173` (or the address of the computer that serves it). To set up or update that server, see `docs/DEPLOY.md`.

A release shows just its version, such as `v0.1.0`. The beta site shows `v0.2.0-beta+a1b2c3d` and the LAN server `v0.1.0-local+a1b2c3d`: the version with where it was built and the commit it was built from. The same text goes into each export's `README.txt`, `report.json` and `project.json`, so you can always tell which build made a mold.

## The app, from top to bottom

The view fills the window: drag to turn it, scroll to zoom, right-drag to pan. The status strip under it shows the file, its triangles and size, the mold box, the silicone, the clearance and how long the last rebuild took, with switches for Wireframe, Perspective, Section and Explode, and App memory: the memory the app holds for your model in the browser, as it stands. Hover over it to see where that memory is and what it leaves out, such as the rest of the browser and your other tabs. It turns amber while it reads 0.8 GB or more, which none of the example models reaches, and goes back to grey when a step's memory is freed, such as an export's once it ends. Reset, Undo (Ctrl+Z) and Redo (Ctrl+Shift+Z or Ctrl+Y) are in the header, beside the light and dark theme. Reset sets every setting back to its default, as one step that Undo takes back, and keeps the base face, the openings you moved and the vents you removed. A grey dot beside a setting means it is at its default. A changed setting has its name in blue and a curved arrow in place of the dot, which sets it back, as a double-click on its name or its slider does. Every section but Model, which has one setting, has a Reset at its top right while one of its settings is changed, and Advanced's heading says how many of its settings are changed. The sidebar on the right follows the order of the work:

1. **Model.** Open STL or project, or drop a file anywhere on the view. A model of half a million triangles or more asks first, and can be simplified (Large models, below). The app lists the flat faces the model could stand on, best first, and picks the first. Check it: choose another from the list, or Pick a face on the model. Plane tolerance sets how flat the face must be. A model with a second, slightly higher level under it, such as a pad, gets a "Use upper level" offer. Save project keeps your work as a `.moldproj` file (Ctrl+S).
2. **Base.** Mode: Glue in (A), where you print the model on its own and glue it into a shallow pocket, or Merged (B), where the model is built onto the base. Then the base's thickness (4 mm by default, 3 mm at least), the printer's layer height, and the pocket's depth (one layer, until you set it) and enlargement.
3. **Silicone.** The silicone thickness; the base layer, silicone over the whole base plate that joins every copy and every model in the file into one mold (as thick as the silicone until you set it, 0 for none); the wall draft that lets the silicone slide out; and the silicone's density. It shows how much silicone the mold takes, in ml and grams.
4. **Cover & joint.** The cover's wall and top, and the joint: a taper with a ridge on the base and a groove in the cover, with their clearances, and pry notches for levering the base out. It says how many strips of tape hold the cover down while the silicone is liquid. The Bolts group at its foot turns on four countersunk screws and hex nuts instead of most of the tape.
5. **Pour & funnel.** How many pour openings each model gets (parts of the file that overlap or touch are one model), their size, the vents, the funnel seat and the funnel. The openings are listed with their positions: type a position, or drag a ring on the cover's top in the view. Top view looks straight down. A ring turns red where an opening may not stand, and a drop there moves it to the nearest place that is valid. A dashed circle round each pour on the cover's top shows where its funnel's flange will rest; it turns red where a vent's ring is too near it, as that vent's mouth would be under the flange or less than the gap from its edge: 0.5 mm at the default Seat clearance and nozzle, where the ring then touches the dashes, and more past them. It is not something to drag.
6. **Grid.** Several copies of the model in one mold: columns, rows, the spacing between them and the distance to the edge, with the pitch they come to.
7. **Demold report.** An estimate, from the model's shape, of how the silicone comes off it: pulled out while the silicone stays in the cover, slid out of the cover first so it can stretch, or cut. It lists the first six places where the silicone holds, the places to cut first, each with a Show button that marks the place in the view; README.txt lists every place in words. It also says where air may stay.
8. **Advanced** (closed at first). Every other setting, grouped as above, plus the printer's bed size, nozzle and infill, and the quality of the mesh. At its foot: the developer pages, and the third-party licences.
9. **Export**, always at the foot. Export ZIP builds the mold at full detail, measures the clearance on the finished parts, and saves a ZIP named after your model. Cover, Base, Funnel and Fit test save one part each. A bar shows each step, with Cancel.

The Diagnostics card in the view lists what the app found: warnings, notes and errors, each with a Show button where it has a place. It moves to the top right when something needs your attention. Section cuts all the parts with one plane, so you can see the silicone's thickness; Explode moves the cover up and the base down.

## The export ZIP

- `cover.stl`: the cover, turned flat top down, ready to print.
- `base.stl`: the base, flat side down. In Mode B the model is part of it.
- `funnel.stl`: one funnel. Print one for each pour opening. Its flange rests flat on the cover's top, and the vents are kept clear of a flange that wide, so use funnels printed for this mold: one with a wider flange, such as a funnel from the beta before 2 mm became the default (4 mm), would rest on the vent beside each pour. A project saved before the funnel had a flange (v0.1.0) opens without one; at the default Seat clearance and nozzle, a Flange width of up to 1 mm still fits the cover printed from it (the notice gives the width for the project's own settings), while a wider one, such as the default 2 mm, moves the vents beside the pours, so print the cover again too.
- `model_oriented.stl` (Mode A): your model, turned so its flat face lies at the bottom, ready to print and glue in.
- `fit_test/` (when you tick "Add the fit-test pieces to the ZIP"): the joint's test pieces, with their own README.
- `README.txt`: how to print, join, seal, pour and demold this mold, with its own numbers: the tape, the silicone, the places to cut, the air, the warnings and every setting.
- `report.json` and `project.json`: every number of the export and every setting. Open the STL, then this ZIP or its `project.json`, to get the same mold back.

## The docs

- `docs/WORKFLOW.md`: the maker's whole workflow, from printing to recasting. Start here before your first mold.
- `docs/DEPLOY.md`: running the server, updating it, and running the tests.
- `docs/RELEASING.md`: the release and beta sites on GitHub Pages, and how a release is made.
- `docs/THIRD_PARTY.md`: the open-source software the app is built with, and their licences.
- `docs/REQUIREMENTS.md`: what was asked for, what was decided, and how each requirement is checked.
- `docs/PLAN.md`: how the app was built, milestone by milestone, with what was measured.
- `docs/BENCHMARKS.md`: measured timings.

## What only you can check

The app measures the geometry: the silicone thickness, the closed cavity, the openings at the high points, that the parts need no supports. These depend on your printer, your silicone and your hands, so test them before you rely on a mold. `docs/WORKFLOW.md` says how.

- **Print the fit test** (the Fit test button under Export, once a model is open) and set the clearances it gives you, then export the mold. With the bolts on, it adds a bolt coupon: fit a screw and a nut in it first.
- **Leak test:** fill the assembled mold with water before the first pour. The joint should stay dry.
- **Cure-inhibition test patch:** some print materials, glues, tapes and sealants stop silicone from curing where they touch it. Pour a small patch of your silicone onto printed scraps with your glue, tape, petroleum jelly and mold release first.
- **Mold release:** coat everything the silicone will touch with a release made for silicone before you close the mold for the pour. Without one, the silicone can stick to the printed plastic: the first test pour with a mold from this app was hard to demold.
- **A full pour,** from printing the model to a recast. Only that shows whether 3 mm of silicone holds up for you, how the pour fills, whether the seal holds, and whether the demold estimate is right.
- **In your slicer:** the parts need no supports in the poses they are saved in, and the base and pocket come out in whole layers.
- **A large model on your own computer:** open the largest STL you have; the question should show before anything loads. Simplify it, export, and print `model_oriented.stl`, which should be your full-detail file. Save the project and reopen it: it should not ask again (Large models, below).
- **How it feels on your screen:** whether the preview follows a slider quickly enough on your computer, whether dragging the openings' rings with your own mouse works well, whether the layout reads well, and whether any surface flickers while you turn the view (0.2.0 fixed the base's band round the cavity). The server's tests run on software graphics, so tell whoever runs it what feels slow or unclear.

## Troubleshooting

- **A big file:** past half a million triangles the app asks first, and can simplify it (see Large models, below). Loaded as it is, past 300,000 triangles the view draws a lighter copy, and Diagnostics says so. Past 2 million, merged mode and the glue-in pocket use a copy of 1 million triangles, as a warning under Mode says; the cover and `model_oriented.stl` still come from the whole mesh, and in merged mode the silicone thickness README.txt gives is measured round that copy, which the base carries. A 150 MB STL of 3 million triangles works, but takes the browser to about 2.3 to 2.5 GB of memory in Chromium and 2.9 to 3.0 GB in Firefox, so leave about 3.5 GB free and close other heavy tabs first (`docs/DEPLOY.md` has the figures). App memory in the status strip shows what the app holds as it works, 0.84 GB for that model's preview; a system monitor shows more, as it counts the browser's own memory too.
- **A mesh with holes (an open mesh):** the app still makes a cover and a glue-in base from its surface. Merged mode is off, with the reason under Mode, and the silicone thickness cannot be measured, so the status strip and README.txt say "unverified". To use merged mode, repair the mesh, for example with your slicer's repair, and open it again.
- **A model of several parts:** a file split into parts for multi-colour printing is fine. Parts that overlap or touch (within 0.05 mm) are one model, with one pour at its highest point, and Diagnostics says how many parts the file has and, for a closed mesh, by how much they overlap; the model's volume is that of the parts together, counted once where they overlap, also when the base face cuts through them. Parts that stand apart each get pours of their own. A project of such a file saved by an internal build before 1.0.1 (public versions start at 0.1.0) opens with its moved openings and removed vents reset, as those builds gave each part pours of its own, and Diagnostics says so.
- **A file that will not open:** an empty, cut-off or garbled STL, or a file that is no STL at all, says why under the file row, and the model on screen stays as it was. A file that looks cut off but still holds triangles opens with a warning. Export the STL again from the program that made it.
- **A project that will not open:** a damaged `.moldproj`, one from a newer version of the app, or one whose STL was changed says why under the file row, with what to do.
- **Chrome over plain http:** this is about the LAN server only; the web addresses above are HTTPS, where saving works as on any site. Firefox saves the STL and ZIP files without asking. Chrome has not been tried and may ask whether to keep or discard each file: choose Keep. Check with `diag.html` first (Advanced, Developer pages, Browser check). If Chrome blocks the files outright, `docs/DEPLOY.md` says what helps, or use Firefox.
- **The page looks old after an update:** the version in the header says which build you have. The LAN server serves the build `scripts/serve.sh` made when it was last started: restart it (see `docs/DEPLOY.md`), then reload the page. On the web, a new release shows within a few minutes of its tag; reload the page.

## Large models

A model of half a million triangles or more, or an STL of 125 MB or more, is a lot for a web page: in our tests a model that large took the browser to between 1.7 and 3.4 GB of memory, by how large it was, and can make the computer slow or close the page. So before the app reads such a file it asks, under the file row in the Model section, with the file's triangles and size. It counts them from the file's first bytes, so nothing has been read yet; a text STL's count is an estimate. A `.moldproj` is asked about once it is opened, before its model is handed over. The question offers three answers:

- **Simplify** makes a copy of the model with fewer triangles, 300,000 unless you type another count from 10,000 to 1,000,000 in the question, whose surface stays within 0.05 mm of your file's. That is finer than the 0.125 mm grid the mold is built on. The 0.05 mm is proved over the whole surface of your file, not only checked at its corners: where the copy would move the surface further with so few triangles, it keeps more, and its note says "Not 300,000". A shape that cannot keep to 0.05 mm everywhere, which is rare, gets the closest copy the app can make, and the note gives its figure. Making the copy takes from several seconds to a few minutes, by how large the model is: the busy line under the file row says which round of at most 12 it is in, with Cancel beside it. The mold is then made from the copy: the cover, the base, the openings, the reports, and in merged mode the model on the base. The safety margin round the model is widened by the copy's error, so the cavity holds your file too. `model_oriented.stl`, the model you print and glue in, is still your own file, with all its triangles (trimmed where the base face cuts it, as for any model), turned to stand on its base face, and the silicone thickness README.txt gives was checked to hold for it: measured on the copy, less the copy's error.
- **Load anyway** opens the file as it is.
- **Cancel** leaves the page as it was.

While the copy is on screen, the file row says "(simplified)", and a note under it says how far the copy lies from your file, with two buttons: **Use the original** opens your file again as it is, with all its triangles, keeping your settings, base face, moved openings and removed vents; and **Save simplified STL** saves the copy as `<name>-simplified.stl`. Diagnostics says the same. A model you loaded anyway past that size has a **Simplify…** button under the file row, which asks the same question and keeps your settings, base face, moved openings and removed vents; the undo history is cleared, as for any new model. Past App memory's amber figure its tooltip points to it.

Save project keeps your file and the copy in the `.moldproj`, so it opens again to the same mold without asking. To write `model_oriented.stl`, the export reads your file again from where you opened it, and Save project does the same: if you have moved, renamed or changed it since, they say so, and nothing is saved; open it again.

## Tuning the defaults

This part is for whoever builds and serves the app. Every setting's default, which the app starts with when the page is opened and which Reset puts back, is in `src/core/params/defaults.json`. To change one:

1. Edit its value in `src/core/params/defaults.json`. The file groups the settings as `src/core/params/schema.ts` does, which is not always the sidebar's way: Layer height shows under Base but is `print.layerHeight`, and Silicone thickness is `silicone.t`. To find a setting, search `schema.ts` for its name as the sidebar shows it: `layerHeight: num('Layer height', …)` under `print` is `print.layerHeight`. Values are in the units the sidebar shows, and Infill is a fraction: 0.05 for 5 percent. The labels, units and ranges are in `schema.ts` too. JSON has no comments, so where a value has a recorded reason, it is in a comment beside its row in `schema.ts`, or in `docs/PLAN.md` (the Parameters table and the milestone that set it).
2. Stop the running server (Ctrl+C in its terminal, or end its process; `docs/DEPLOY.md`, Update), then run `scripts/serve.sh` again, which builds the app and serves it.

The build checks the file before it builds anything. A setting that is missing, misspelt or given twice, a value of the wrong type, outside its range, not a whole number where one is needed, or not one of its options, and defaults that break a rule between settings, such as a funnel seat deeper than the top cap leaves room for, stop it with every problem listed by the setting's name and path, for example `Thickness (base.thickness) is 2 mm, but must be from 3 to 20 mm.` Nothing is built or served until they are fixed. The problems are in the terminal that ran `scripts/serve.sh`, or in `serve.log` if you started it with `nohup`. The GitHub Pages build and the test servers run the same check, and `scripts/ci.sh` runs it in its unit tests. The development server (`npx vite`) checks the file as it starts, so restart it after an edit.

An automatic setting, such as Pocket depth or Spacing, stays `null` in the file: null is what makes it follow its rule, and the rule stays in the code. A project file holds its own settings, so a project saved earlier opens as it was saved.

Many tests are pinned at the defaults, so after a change they fail on purpose and must be measured again: the schema's rows (`test/unit/params.test.ts`), the regression goldens (`test/regression/golden.ts`), the export byte checks (`test/unit/export.test.ts`) and the browser export's table of silicone in ml (`ML` in `e2e/export.spec.ts`), among others. This README and the Parameters table in `docs/PLAN.md` quote some defaults, such as the 3 mm of silicone: change them there too.

## The example models

`examples/` holds models to try the app with, which its tests use too. They are other people's work, shared on Printables under Creative Commons licences, about half of which allow no commercial use. `examples/SOURCES.md` names each one's author, its page and its licence, and says which were changed.

## Licence

The app is released under the MIT licence: see `LICENSE`. The example models in `examples/` are not covered by it: they belong to their authors and keep their own terms, as `examples/SOURCES.md` lists them. The software the app is built with keeps its own licences, which `docs/THIRD_PARTY.md` lists and the app links to as "Third-party licences" at the foot of the Advanced section.

The app's layout follows the conventions of BumpMesh, as the original requirements asked. BumpMesh is under the AGPL, so it was a layout reference only: nothing was copied from it.
